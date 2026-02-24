# Incident: New Group Unresponsive After Registration

**Date:** 2026-02-22
**Severity:** Service degradation (single group affected)
**Resolution:** Service restart triggered message recovery

## Timeline

| Time | Event |
|------|-------|
| 05:09 | User creates "Jarvis-Agenda" WhatsApp group, adds bot |
| 05:11 | Main agent registers group via IPC (`requiresTrigger: false`) |
| 05:16:03 | User sends "Whats on the menu" in group — stored in DB |
| 05:16:04 | Message loop logs "New messages count: 1" — **last log entry** |
| 05:16–05:27 | Process alive (PID responsive) but zero log output, no container spawned |
| 05:27 | Manual restart — recovery finds and processes the message successfully |

## Evidence

1. **Message stored correctly** — DB has the message with `is_bot_message=0`, correct JID
2. **Message loop saw it** — "New messages count: 1" logged, `lastTimestamp` advanced to 05:16:03
3. **Cursor never advanced** — `lastAgentTimestamp` has no entry for `120363408061625012@g.us`, confirming `processGroupMessages` never reached line 155 (cursor advancement)
4. **No container spawned** — No docker container for jarvis-agenda, no container logs created
5. **No errors** — Neither `nanoclaw.log` nor `nanoclaw.error.log` contain errors at 05:16
6. **Process alive but idle** — PID responsive (`State: S sleeping`), main container still running in idle-wait

## Root Cause Analysis

The message loop correctly detected the message and called `queue.enqueueMessageCheck()`, which fires `processGroupMessages` asynchronously via `runForGroup`. However, `processGroupMessages` never advanced the cursor, meaning it returned before line 155.

**Two factors combined to cause the outage:**

### 1. `processGroupMessages` silently failed (primary)

The function was called but exited early without logging. The cursor was never set, confirming it returned before line 155. The most likely failure point is `getMessagesSince` returning empty at line 141, or a transient issue with `findChannel`. Both early-return paths either use `console.log` (not the pino logger) or return silently:

```typescript
// Line 131-133: uses console.log — may not appear in logs depending on buffering
if (!channel) {
  console.log(`Warning: no channel owns JID ${chatJid}, skipping messages`);
  return true;
}

// Line 141: returns silently with no logging at all
if (missedMessages.length === 0) return true;
```

These silent returns make it impossible to diagnose what happened.

### 2. WhatsApp connection dropped silently (contributing)

After 05:16, no new messages were received or stored. The log file was not written to for over an hour. The message loop was running but found nothing because WhatsApp stopped delivering messages. The Baileys `connection.update` handler never fired with `connection: 'close'`, so no reconnection occurred. The "Closing session: SessionEntry" crypto dumps at 05:10 suggest the connection was already unstable.

### 3. No safety nets caught the failure

- No health check / watchdog to detect the stalled state
- No timeout on `setTyping` (line 176) — if WhatsApp socket was dead, `sock.sendPresenceUpdate` could hang forever, blocking `processGroupMessages`
- No periodic re-check of unprocessed messages outside of startup recovery

## Recommendations

### Immediate fixes

1. **Add logging to all early returns in `processGroupMessages`** — Replace `console.log` with `logger.warn` and add a log for the empty-messages case:

```typescript
if (!channel) {
  logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
  return true;
}
// ...
if (missedMessages.length === 0) {
  logger.debug({ chatJid }, 'No pending messages found');
  return true;
}
```

2. **Add timeout to `setTyping`** — Prevent a dead WebSocket from blocking the entire processing pipeline:

```typescript
async setTyping(jid: string, isTyping: boolean): Promise<void> {
  try {
    const status = isTyping ? 'composing' : 'paused';
    await Promise.race([
      this.sock.sendPresenceUpdate(status, jid),
      new Promise((_, reject) => setTimeout(() => reject(new Error('typing timeout')), 5000)),
    ]);
  } catch (err) {
    logger.debug({ jid, err }, 'Failed to update typing status');
  }
}
```

3. **Replace `console.log` warnings with `logger.warn`** — Three instances in `index.ts` (lines 132, 345, 548) use `console.log` for warnings that should use the structured logger.

### Resilience improvements

4. **Add periodic recovery check** — Run `recoverPendingMessages()` every N minutes (not just on startup) to catch messages stuck by transient failures.

5. **Add WhatsApp connection watchdog** — If no `messages.upsert` events arrive for an extended period and the message loop finds no new messages, proactively check and reconnect the WhatsApp socket.

6. **Add message loop heartbeat** — Log a periodic heartbeat (e.g., every 5 minutes) confirming the loop is alive and the WhatsApp connection is healthy, even when there are no messages to process.

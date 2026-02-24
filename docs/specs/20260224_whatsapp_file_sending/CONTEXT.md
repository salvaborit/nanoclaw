# WhatsApp File Sending — Research Context

**Date:** 2026-02-24
**Scope:** How to allow the container agent to send files back through WhatsApp.

---

## Current Architecture — How Messages Flow Today

### Inbound path (WhatsApp → container)
1. Baileys (`@whiskeysockets/baileys` v7 RC) fires `messages.upsert` in `src/channels/whatsapp.ts`
2. `WhatsAppChannel` extracts text content (conversation, extendedTextMessage, imageMessage/videoMessage captions)
3. Content is stored in SQLite via `src/db.ts` and emitted to `src/index.ts` via `onMessage` callback
4. `src/index.ts` formats a prompt and passes it to `runContainerAgent()` in `src/container-runner.ts`
5. Input JSON is written to the container's stdin; the container process runs

### Outbound path (container → WhatsApp) — text only today
1. The container's MCP server (`container/agent-runner/src/ipc-mcp-stdio.ts`) exposes a `send_message` tool
2. `send_message` writes a JSON file to `/workspace/ipc/messages/{timestamp}.json` with `{ type: "message", chatJid, text, ... }`
3. `src/ipc.ts` polls that directory every 1 second (`IPC_POLL_INTERVAL`)
4. IPC watcher reads the file, verifies authorization (group can only send to its own JID), then calls `deps.sendMessage(jid, text)`
5. `deps.sendMessage` is the `WhatsAppChannel.sendMessage()` method
6. `WhatsAppChannel.sendMessage()` calls `this.sock.sendMessage(jid, { text: prefixed })` — text only

### Key abstraction points
- `Channel` interface (`src/types.ts` line 82): defines `sendMessage(jid, text): Promise<void>` — text-only today
- `routeOutbound()` in `src/router.ts`: finds a channel and calls `sendMessage` — text-only
- `IpcDeps` interface (`src/ipc.ts` line 17): `sendMessage: (jid: string, text: string) => Promise<void>` — text-only

---

## WhatsApp Library File-Sending Capabilities

Library: `@whiskeysockets/baileys` v7.0.0-rc.9

### `sendMessage` API

The Baileys `WASocket.sendMessage(jid, content, options?)` method accepts `AnyMessageContent`, which includes `AnyMediaMessageContent`:

```typescript
// Image
{ image: WAMediaUpload; caption?: string; jpegThumbnail?: string; width?: number; height?: number; }

// Video
{ video: WAMediaUpload; caption?: string; gifPlayback?: boolean; ptv?: boolean; }

// Audio / Voice note
{ audio: WAMediaUpload; ptt?: boolean; seconds?: number; }

// Document (any file type)
{ document: WAMediaUpload; mimetype: string; fileName?: string; caption?: string; }

// Sticker
{ sticker: WAMediaUpload; isAnimated?: boolean; }
```

### `WAMediaUpload` type — three accepted forms
```typescript
type WAMediaUpload = Buffer | { stream: Readable } | { url: URL | string };
```

A file on disk is easiest to send as a Buffer (`fs.readFileSync(path)`) or a stream (`fs.createReadStream(path)`).

### Format support confirmed in Baileys source (`lib/Utils/messages.js`)
| Media type | Default mimetype |
|-----------|-----------------|
| `image`   | `image/jpeg` (override with `mimetype:`) |
| `video`   | `video/mp4` |
| `audio`   | `audio/ogg; codecs=opus` |
| `sticker` | `image/webp` |
| `document`| `application/pdf` (default; set `mimetype:` to override) |

Documents accept any mimetype — this is the universal fallback for arbitrary file types (PDFs, ZIPs, spreadsheets, code files, etc.).

### Size limits
Baileys reads `maxContentLengthBytes` from the WhatsApp media connection response (dynamic per session). WhatsApp's practical enforced limits are:
- Images: ~16 MB
- Videos/Audio: ~16 MB (voice notes) to ~64 MB (regular video)
- Documents: ~100 MB
These limits are imposed by WhatsApp servers, not Baileys itself. Confidence: **likely** (based on WhatsApp policy documentation; not validated against Baileys v7 directly).

### Thumbnail computation
Baileys auto-computes JPEG thumbnails for images and video, and audio duration for audio messages, when not manually provided.

---

## Container Mount Points and File Access

From `src/container-runner.ts` — `buildVolumeMounts()`:

| Container path | Host path | RW | Available to |
|---|---|---|---|
| `/workspace/group` | `groups/{folder}/` | RW | All groups |
| `/workspace/global` | `groups/global/` | RO | Non-main groups |
| `/workspace/project` | project root | RW | Main group only |
| `/workspace/extra/*` | per `additionalMounts` | configurable | Groups with mounts configured |
| `/workspace/ipc` | `data/ipc/{folder}/` | RW | All groups (their namespace only) |
| `/home/node/.claude` | `data/sessions/{folder}/.claude/` | RW | All groups |
| `/app/src` | `container/agent-runner/src/` | RO | All groups |

The agent can write files to `/workspace/group/` (permanent group storage) or anywhere in writable mounts. Files the agent creates in `/workspace/group/` persist on the host at `groups/{folder}/`.

Files in `additionalMounts` (e.g., `/workspace/extra/tasks/`) are accessible read-only by default and can have any host path allowed by the mount allowlist at `~/.config/nanoclaw/mount-allowlist.json`.

**Key implication:** The agent can write a file to `/workspace/group/outbox/` (or similar) and include the path in an IPC message. The host already knows the host-side path (`groups/{folder}/outbox/`) and can read and send it.

---

## IPC Mechanism Analysis

### Current IPC message format (text only)
```json
{
  "type": "message",
  "chatJid": "120363336345536173@g.us",
  "text": "Hello world",
  "sender": "Researcher",
  "groupFolder": "my-group",
  "timestamp": "2026-02-24T00:00:00.000Z"
}
```

### How IPC is processed in `src/ipc.ts`
- `startIpcWatcher()` polls `data/ipc/{groupFolder}/messages/*.json` every 1 second
- For `type === "message"`: checks `data.chatJid && data.text`, then calls `deps.sendMessage(data.chatJid, data.text)`
- Authorization: non-main groups can only send to their own registered JID
- File is deleted after processing; errors are moved to `data/ipc/errors/`

### What needs to change for file sending
The IPC message type, the IPC watcher, and the `WhatsAppChannel` all need to be extended. The `Channel` interface also needs a new method (or a generalized content parameter).

---

## Proposed Integration Points

### Option A — Extend existing `send_message` MCP tool (simplest)

Add optional fields to the existing IPC message schema:

```json
{
  "type": "message",
  "chatJid": "...",
  "text": null,
  "filePath": "/workspace/group/outbox/report.pdf",
  "fileName": "report.pdf",
  "mimeType": "application/pdf",
  "caption": "Here is your report"
}
```

The host resolves the container path `/workspace/group/...` to the host path `groups/{folder}/...` using the known mount mapping.

**Pros:** Minimal surface area change — one new IPC type, one new WhatsApp send call.
**Cons:** `filePath` is a container-internal path; host must translate it.

### Option B — Add a dedicated `send_file` MCP tool (cleaner)

Add a new MCP tool `send_file` to `ipc-mcp-stdio.ts` that writes a new IPC type `file`:

```typescript
server.tool('send_file', '...', {
  file_path: z.string().describe('Absolute path to file inside container (e.g. /workspace/group/report.pdf)'),
  file_name: z.string().optional(),
  mime_type: z.string().optional().describe('MIME type; auto-detected from extension if omitted'),
  caption: z.string().optional(),
}, async (args) => {
  writeIpcFile(MESSAGES_DIR, {
    type: 'file',
    chatJid,
    groupFolder,
    filePath: args.file_path,
    fileName: args.file_name,
    mimeType: args.mime_type,
    caption: args.caption,
    timestamp: new Date().toISOString(),
  });
  return { content: [{ type: 'text', text: 'File queued for sending.' }] };
});
```

**Pros:** Explicit, discoverable, separates text and file concerns, easier to validate.
**Cons:** Adds a new MCP tool and new IPC type handler.

### IPC watcher changes (`src/ipc.ts`)
Add a `file` case alongside the existing `message` case:

```typescript
if (data.type === 'file' && data.chatJid && data.filePath) {
  // Path translation: /workspace/group/... → groups/{folder}/...
  const hostPath = resolveContainerPath(data.filePath, sourceGroup);
  if (hostPath && fs.existsSync(hostPath)) {
    await deps.sendFile(data.chatJid, hostPath, {
      fileName: data.fileName,
      mimeType: data.mimeType,
      caption: data.caption,
    });
  }
}
```

`resolveContainerPath` maps `/workspace/group/` → `groups/{folder}/` and `/workspace/extra/{name}/` → the configured host path. This translation must be done from the host, since the host knows the mount mapping but the container does not know host paths.

### `IpcDeps` interface changes (`src/ipc.ts`)
```typescript
export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendFile: (jid: string, hostPath: string, opts: { fileName?: string; mimeType?: string; caption?: string }) => Promise<void>;
  // ...existing deps
}
```

### `Channel` interface changes (`src/types.ts`)
```typescript
export interface Channel {
  sendMessage(jid: string, text: string): Promise<void>;
  sendFile?(jid: string, filePath: string, opts: FileMessageOptions): Promise<void>;
  // ...
}
```

Making `sendFile` optional (?) preserves compatibility with non-WhatsApp channels (Discord, Telegram) that may not yet support it.

### `WhatsAppChannel` changes (`src/channels/whatsapp.ts`)
Add `sendFile()` method:

```typescript
async sendFile(jid: string, filePath: string, opts: {
  fileName?: string;
  mimeType?: string;
  caption?: string;
}): Promise<void> {
  const buffer = fs.readFileSync(filePath);
  const mime = opts.mimeType || guessMimeType(filePath);
  const mediaType = classifyMediaType(mime); // 'image' | 'video' | 'audio' | 'document'

  let content: AnyMediaMessageContent;
  if (mediaType === 'image') {
    content = { image: buffer, caption: opts.caption };
  } else if (mediaType === 'video') {
    content = { video: buffer, caption: opts.caption };
  } else if (mediaType === 'audio') {
    content = { audio: buffer, ptt: false };
  } else {
    content = { document: buffer, mimetype: mime, fileName: opts.fileName || path.basename(filePath), caption: opts.caption };
  }

  await this.sock.sendMessage(jid, content);
}
```

For large files, replace `fs.readFileSync` with `{ stream: fs.createReadStream(filePath) }` to avoid loading the full file into memory.

---

## Constraints and Limitations

1. **Path translation required.** Container paths (`/workspace/group/`) must be translated to host paths. The mapping is deterministic (container-runner knows both sides) but the IPC watcher currently has no mount map. Mount info would need to be passed to the IPC watcher — or a simpler convention like "files must be in `/workspace/group/outbox/`" could avoid needing full translation.

2. **Security: arbitrary host path access.** If the agent can write any `filePath` into an IPC message, a compromised agent could reference paths outside its mount (e.g., `/workspace/group/../../other-group/secrets`). The host must canonicalize and validate the resolved path is within the group's allowed directories before reading it.

3. **File size.** WhatsApp enforces limits server-side (~100 MB for documents). Very large files will be rejected by WhatsApp. No pre-check exists in the current codebase.

4. **MIME detection.** Node.js stdlib has no native MIME detection. Either add the `mime-types` npm package (already in Baileys' own deps) or implement a small extension-to-MIME lookup.

5. **Streaming vs buffering.** For files > a few MB, `fs.readFileSync` into a Buffer is memory-inefficient. Baileys accepts `{ stream: Readable }` — prefer streaming for large files.

6. **No queuing/retry for files.** The existing `outgoingQueue` in `WhatsAppChannel` only handles text. File sends during a disconnection would silently fail unless a parallel queue is added.

7. **No inbound file support.** The current inbound path (`messages.upsert` handler) already receives `imageMessage`, `videoMessage`, etc. but only extracts captions (text). Downloading and passing file content to the agent is a separate, larger effort.

8. **Non-WhatsApp channels.** Discord and Telegram channels (if they exist) would need their own `sendFile` implementations. The `Channel` interface change should make `sendFile` optional to avoid breaking them.

---

## Open Questions

1. **Path translation strategy:** Should the IPC message carry a container-relative path (`/workspace/group/report.pdf`) and the host translate it, or should the agent only be allowed to reference paths under a designated "outbox" subdirectory (e.g., `/workspace/group/outbox/`) to simplify and harden security?

2. **Outbox cleanup:** Who deletes the file after sending? The host (IPC watcher) or the agent? Leaving cleanup to the agent avoids host complexity but risks leftover files if the agent doesn't clean up.

3. **MIME type detection:** Add `mime-types` to host dependencies, or use a hand-rolled extension map? The `mime` package is already a transitive dep of Baileys.

4. **File size limit enforcement:** Should the host validate file size before calling `sendMessage`, or let WhatsApp reject it and log the error?

5. **Queueing during disconnects:** Should file messages be queued like text messages? Queuing requires storing the file path (not the buffer) and re-reading on flush.

6. **Inbound files (future):** When a user sends an image or PDF to a registered group, should the agent receive the file content, a description, or just a notice that a file was received? This is out of scope for this feature but architecturally relevant.

7. **Agent tool description:** How should the `send_file` tool instruct the agent about where to save files before sending? The agent needs to know it must write the file to a writable mount first, then call `send_file` with the path.

---

## File Reference Map

| File | Relevance |
|---|---|
| `src/channels/whatsapp.ts` | Add `sendFile()` method here |
| `src/ipc.ts` | Add `file` IPC type handler; extend `IpcDeps` |
| `src/types.ts` | Extend `Channel` interface with optional `sendFile` |
| `src/router.ts` | Minimal change — may add `routeOutboundFile()` helper |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Add `send_file` MCP tool |
| `src/container-runner.ts` | No changes needed (mounts already configured) |
| `src/config.ts` | No changes needed |
| `src/db.ts` | No changes needed (no file tracking required initially) |

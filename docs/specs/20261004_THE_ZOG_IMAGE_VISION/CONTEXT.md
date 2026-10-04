# CONTEXT — Why "The ZOG" replied "No veo la imagen" to an image (Oct 2026)

Diagnosis cycle. READ-ONLY research. "Did we lobotomize its image reading?"
Short answer: **No — vision is not broken or mis-modelled. There is a real,
pre-existing architectural gap: images are dropped when they arrive while the
group's container is already running (the "piping" / follow-up path).** ZOG is
the most-active group, so it hits this path constantly.

## Group identity & model config (certain)

- Group folder: `zog`. JID `120363189316244153@g.us`, display name **"The ZOG"**.
  Source: `store/messages.db` → `registered_groups`; `groups/zog/`.
- Effective model: **`claude-sonnet-4-6`** — pinned in
  `data/sessions/zog/.claude/settings.json` (mtime Aug 18 22:49, set by commit
  `c164055`). Sonnet 4.6 **supports image vision**.
- `container_config` = `{"additionalMounts":[{"hostPath":"/home/sborit/zog",
  "containerPath":"zog","readonly":false}]}` — **no `model` key** (correct; that
  field is inert per CLAUDE.md anyway).
- NOTE: `data/nanoclaw.db` is a stale stub (only a `test` table). The live state
  DB is `store/messages.db` (`STORE_DIR`, `src/config.ts:38`; `src/db.ts:162`).
- So the model-fallback failure mode from the August vice-city cycle
  (`docs/specs/20260818_VICE_CITY_IMAGE_VISION/`) does **not** apply here — ZOG
  has a valid vision-capable model pinned. In that August cycle **ZOG was the
  working control group**.

## Is vision code present & wired? (certain) — YES

Full ingestion → container pipeline exists:
- `src/channels/whatsapp.ts:210` — downloads image, calls `processImage()`.
- `src/image.ts` — `processImage()` resizes (max 1024px, JPEG q85), saves to
  `groups/zog/attachments/`, injects `[Image: attachments/<file>.jpg]` marker
  into the message text. `parseImageReferences()` scans text for that marker.
- `src/index.ts:208,259,372` — `processMessages` extracts `imageAttachments` and
  passes them to the container run.
- `container/agent-runner/src/index.ts:366-378` — on query start, reads each
  file from `/workspace/group/<relativePath>`, base64-encodes, and
  `stream.pushMultimodal([{type:'image', source:{type:'base64',...}}])`.

Image handling is channel-level, not per-group; nothing branches on the group.

## Smoking-gun evidence (certain)

1. `store/messages.db` messages for the ZOG JID, in order, show:
   `[Image: attachments/img-1791089031398-h709.jpg]` (the sent image) →
   then the bot's replies **"No veo la imagen. Qué es?"** and
   **"No veo la imagen y no acuerdo..."**.
   → The text marker reached the agent; the image bytes did not.
2. The file is real and valid: `groups/zog/attachments/img-1791089031398-h709.jpg`,
   96,658 bytes, mtime Oct 4 04:43 → `processImage` ran fine. Ingestion works.
3. `groups/zog/logs/container-2026-10-04T03-32-56-864Z.log` = **TIMEOUT, exit 137,
   duration 1,884,619 ms (~31 min)** — ZOG runs long-lived containers that stay
   active across many messages. `logs/nanoclaw.log` shows messages being
   "Piped ... to active container" for ZOG.

## ROOT CAUSE (certain, high confidence)

There are two dispatch paths and **only one carries images**:

- COLD START (`src/index.ts` `processMessages`, ~L188-259): extracts
  `imageAttachments` → container-runner → agent-runner `runQuery` start →
  `pushMultimodal`. Images work. ✅
- FOLLOW-UP / PIPING (`src/index.ts` `startMessageLoop`, L464-487): when a
  container is **already active** for the group, new messages are sent with:
  ```
  const formatted = formatMessages(messagesToSend, TIMEZONE);  // TEXT ONLY
  queue.sendMessage(chatJid, formatted);
  ```
  `parseImageReferences` is never called here and `imageAttachments` are never
  forwarded. ❌
- `GroupQueue.sendMessage` (`src/group-queue.ts:159-176`) writes an IPC payload
  of exactly `{ type: 'message', text }` — **no image field**.
- Container side: `drainIpcInput()` (`container/agent-runner/src/index.ts:298-323`)
  only reads `data.text` and pushes it via `stream.push(text)` (L394-397). No
  multimodal path for follow-ups.

So any image that arrives while the group's container is mid-run reaches the
model as the literal string `[Image: attachments/....jpg]` with zero pixels
attached → the model truthfully says it cannot see it.

Why ZOG specifically: it is a high-traffic group with ~31-minute live containers,
so most messages (including this image) land on the piping path, not cold start.
Earlier images that "worked" were cold-start (or in quieter groups). Nothing was
recently regressed to cause this — it is a latent gap in the follow-up path that
has existed since image-vision was added (merge `89752b1`).

## Ranked likely root causes

1. **Follow-up/piping path drops image bytes (text-only IPC).** Confidence: HIGH.
   Fix: in the piping branch (`src/index.ts` ~L472-474) call
   `parseImageReferences(messagesToSend)` and, when non-empty, forward the
   attachments through `queue.sendMessage` as a structured payload
   (e.g. `{type:'message', text, imageAttachments}`); extend
   `GroupQueue.sendMessage` + container `drainIpcInput` to base64-load those
   files and `stream.pushMultimodal(...)` just like the cold-start path does.
   (One concrete fix: unify the follow-up IPC payload with the cold-start image
   handling so both paths push multimodal blocks.)
2. **Container readFileSync of the image failed inside the container.**
   Confidence: LOW. Would log `Failed to load image: <path>` in the per-group
   container log; the cold-start path is also structurally fine and the mount
   (`/workspace/group` ← `groups/zog`) is present. Not supported by evidence but
   not fully ruled out for the specific run (see Gaps).
3. **Model lost vision via fallback (the August failure mode).** Confidence: LOW
   (effectively ruled out). ZOG is explicitly pinned to `claude-sonnet-4-6`,
   which has vision; settings.json unchanged since Aug 18.

## Gaps / unknowns

- I could not isolate the exact container run that handled the Oct 4 04:43 image
  in `logs/nanoclaw.log` (213 MB file) to read a definitive "Piping messages to
  active container" line for that specific timestamp, nor confirm whether a fresh
  container spawned at ~04:48 also received it text-only. The DB sequence +
  architecture make the piping path the overwhelming explanation, but a targeted
  grep of nanoclaw.log around 04:43-04:48 would make it airtight.
- No per-group container log was written covering 04:43 (latest per-group log is
  the 03:32 timeout), consistent with the image being piped into an already-live
  container rather than triggering a new logged run.
- Whether to also set an idle/close policy so images always cold-start is a
  design decision for the planner, not established here.

---

## Airtight confirmation (log grep, 2026-10-04)

**Observable log signature of the two paths** (in `logs/nanoclaw.log`):
- **Cold start** = `Processing messages` + `Spawning container agent` (new container).
- **Piping / follow-up** = `New messages` → `IPC message sent` with **no** preceding `Spawning container agent` (routed to the already-live container).
- (Note: the phrase "Piped to active container" does NOT appear in nanoclaw.log; the real signature is `IPC message sent` with no spawn.)

**The ZOG session = PID 51223.** Its only cold-start spawn in this window:
```
[04:18:11.694] Processing messages   group: "The ZOG"  messageCount: 2
[04:18:11.702] Spawning container agent  containerName: "nanoclaw-zog-1791087491699"
```
From 04:18:11 through 04:57+, PID 51223 logs **no further `Processing messages` and no further `Spawning container agent`** — every later message is `New messages` → `IPC message sent` (sourceGroup "zog").

**The image** (`attachments/img-1791089031398-h709.jpg`, file mtime 04:43) lands here:
```
[04:43:53.108] New messages           (PID 51223)  <- image arrives
[04:46:29.249] New messages
[04:47:29.352] New messages
[04:47:37.893] IPC message sent
[04:47:39.089] Agent output: 19 chars  group: "The ZOG"   <- "No veo la imagen" reply
```
The container was still alive (continuous IPC traffic 04:19→04:57, zero respawns). Therefore the image **provably took the piping/IPC path**, which forwards text only — confirming the root cause with no remaining doubt. The last flagged gap is closed.

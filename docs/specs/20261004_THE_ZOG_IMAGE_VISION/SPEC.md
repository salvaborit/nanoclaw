# Implementation Plan: Carry images through the follow-up / IPC (piping) path

Scope: standard

## Problem (from CONTEXT.md)
Images arriving while a group's container is already running take the piping/IPC
path, which forwards **text only**. The cold-start path works. Fix: thread image
attachments through the IPC path end-to-end so follow-up images reach the model as
pixels, mirroring cold start exactly (same `parseImageReferences` → same
`/workspace/group/<relativePath>` base64 load → same `stream.pushMultimodal(...)`).

## Confirmed facts from the code (anchors for the engineer)
- **Cold-start image load** lives in `container/agent-runner/src/index.ts` `runQuery`
  (lines ~365-380): for each `containerInput.imageAttachments`, `fs.readFileSync(path.join('/workspace/group', img.relativePath)).toString('base64')`, build
  `{ type:'image', source:{ type:'base64', media_type: img.mediaType, data } }`, then
  `stream.pushMultimodal(blocks)`. The prompt text is pushed separately first
  (`stream.push(prompt)` line 363). We mirror this ordering (text message, then an
  image-only multimodal message).
- **Host piping branch**: `src/index.ts` lines ~470-491. `parseImageReferences` is
  already imported (line 61) and already used by cold start (line 208). `messagesToSend`
  is `NewMessage[]` — the exact input type `parseImageReferences` expects (it reads
  `msg.content`), identical to cold start's `missedMessages`.
- **Host IPC write**: `GroupQueue.sendMessage` (`src/group-queue.ts` 160-178) writes
  `JSON.stringify({ type: 'message', text })` to `DATA_DIR/ipc/<groupFolder>/input/`.
- **Container IPC read has TWO consumption points**, both via `drainIpcInput()`
  (`container/agent-runner/src/index.ts` 298-324, returns `string[]`):
  1. **During an active query** — `pollIpcDuringQuery` (385-401) → `stream.push(text)`.
     **This is the path the ZOG image provably took** (continuous IPC traffic, query live).
  2. **Between queries** — `waitForIpcMessage` (330-346) joins to a string → becomes the
     next query's `prompt` (main loop 583-590), which only loads
     `containerInput.imageAttachments` — so between-query images are also dropped.
  3. **Initial pending drain** — `main()` line 549 `drainIpcInput()` folds pending IPC
     into the first prompt (text only today).
  A complete fix covers all three; (1) is the reported bug, (2) and (3) are the twin
  latent gaps closed for free since they share `drainIpcInput`.
- **Mount parity (verified, no divergence):** the group folder mounts at
  `/workspace/group` for every run (`src/container-runner.ts` 180-191) and the IPC dir
  (`resolveGroupIpcPath`) mounts at `/workspace/ipc` (line 258-265). Both dispatch paths
  use the **same already-running container**, so `/workspace/group/attachments/<file>.jpg`
  and the `attachments/<file>.jpg` relativePath format are identical to cold start. The
  image file is reachable on the piping path exactly as on cold start.

## Steps

1. **Extend the host IPC payload** — `src/group-queue.ts`, `sendMessage`.
   - Change signature to `sendMessage(groupJid: string, text: string, imageAttachments?: ImageAttachment[]): boolean`.
   - Import the type: `import type { ImageAttachment } from './image.js';`.
   - Write payload: `JSON.stringify({ type: 'message', text, ...(imageAttachments && imageAttachments.length > 0 && { imageAttachments }) })`.
   - Acceptance: existing 2-arg callers still compile; when `imageAttachments` is
     non-empty the written JSON contains an `imageAttachments` array of
     `{relativePath, mediaType}`; when empty/undefined the payload is byte-identical to
     today (`{type,text}` only — backward compatible with old containers).

2. **Forward attachments from the piping branch** — `src/index.ts` ~470-491.
   - After `const formatted = formatMessages(messagesToSend, TIMEZONE);` add
     `const imageAttachments = parseImageReferences(messagesToSend);` (reuse the
     already-imported helper — do not invent a new scan).
   - Change the call to `queue.sendMessage(chatJid, formatted, imageAttachments)`.
   - Acceptance: a piped batch whose messages contain `[Image: attachments/...]` markers
     produces a `sendMessage` call whose third arg matches cold-start's
     `parseImageReferences(missedMessages)` output for the same messages.
   - Depends on: Step 1.

3. **Container: shared image-block loader + structured IPC messages** —
   `container/agent-runner/src/index.ts`.
   - 3a. Add interface `interface IpcMessage { text: string; imageAttachments?: Array<{ relativePath: string; mediaType: string }>; }`.
   - 3b. Extract the cold-start load loop (lines ~366-379) into
     `function loadImageBlocks(imageAttachments: Array<{relativePath:string;mediaType:string}>): ContentBlock[]`
     — same `path.join('/workspace/group', relativePath)`, same base64 read, same
     `{type:'image', source:{type:'base64', media_type, data}}`, same
     `log('Failed to load image: ...')` on readFileSync failure. Reuse it in the
     cold-start block so behavior is unchanged there.
   - 3c. Change `drainIpcInput()` return type from `string[]` to `IpcMessage[]`: for each
     file where `data.type === 'message' && data.text`, push
     `{ text: data.text, ...(Array.isArray(data.imageAttachments) && { imageAttachments: data.imageAttachments }) }`.
     (Old text-only payloads yield `{text}` — no regression.)
   - 3d. Add `function pushIpcMessage(stream: MessageStream, msg: IpcMessage): void` that
     mirrors cold start: `stream.push(msg.text);` then
     `if (msg.imageAttachments?.length) { const blocks = loadImageBlocks(msg.imageAttachments); if (blocks.length) stream.pushMultimodal(blocks); }`.
   - Acceptance: `drainIpcInput` returns objects; `loadImageBlocks` produces the same
     block shape the cold-start path produced before the refactor (verify by reading the
     diff — cold-start output unchanged).

4. **Container: feed images at both IPC consumption points** — same file.
   - 4a. `pollIpcDuringQuery` (during-query, the ZOG path): replace
     `for (const text of messages) { ...; stream.push(text); }` with
     `for (const msg of messages) { log('Piping IPC message into active query (' + msg.text.length + ' chars)'); pushIpcMessage(stream, msg); }`.
   - 4b. `waitForIpcMessage` (between-query): change its resolve type to
     `IpcMessage[] | null`; when `drainIpcInput()` returns a non-empty array, resolve with
     the array (instead of joining to a string).
   - 4c. Main loop (~583-590): when `nextMessage` is a non-null `IpcMessage[]`, set
     `prompt = nextMessage.map(m => m.text).join('\n')` and collect
     `const followupImages = nextMessage.flatMap(m => m.imageAttachments ?? [])`; pass
     `followupImages` to the next `runQuery`.
   - 4d. Initial pending drain (~549-553): `drainIpcInput()` now returns `IpcMessage[]`;
     fold `pending.map(p => p.text)` into the prompt as today AND collect their
     `imageAttachments` into the first query's image set.
   - 4e. Thread images into `runQuery`: add parameter
     `initialImages?: Array<{relativePath:string;mediaType:string}>` and load from
     `initialImages ?? containerInput.imageAttachments` at query start (the cold-start
     load block). First query passes `containerInput.imageAttachments` combined with any
     initial pending images (4d); subsequent queries pass `followupImages` (4c).
   - Acceptance: an image delivered via IPC during a live query is base64-loaded from
     `/workspace/group/attachments/...` and pushed via `pushMultimodal`; an image
     delivered between queries reaches the next `runQuery` and is loaded the same way; a
     text-only IPC message still pushes plain text with no image blocks.
   - Depends on: Step 3.

5. **Rebuild the container image** — `container/agent-runner` changed, so the running
   image is stale until rebuilt. Run `./container/build.sh`. If COPY steps serve stale
   agent-runner files (buildkit cache caveat in CLAUDE.md), prune the builder then
   re-run. Restart the service (`systemctl --user restart nanoclaw`) so new containers
   use the new image.
   - Acceptance: a fresh container run logs the agent-runner from the new build (no
     `Failed to load image` for a valid attachment on the piping path).
   - Depends on: Steps 3-4.

## Test Criteria
- [ ] `npm run build` compiles (host TS + agent-runner TS) with no type errors.
- [ ] `npm test` (vitest) green, including existing `src/group-queue.test.ts` 2-arg
      `sendMessage` calls (backward compat) and `src/image.test.ts`.
- [ ] New unit test (`src/group-queue.test.ts`): `sendMessage(jid, 'hi', [{relativePath:'attachments/x.jpg', mediaType:'image/jpeg'}])` writes a payload whose parsed JSON has `type:'message'`, `text:'hi'`, and `imageAttachments` equal to the passed array; and `sendMessage(jid, 'hi')` writes `{type,text}` with **no** `imageAttachments` key (byte-identical to pre-change).
- [ ] New unit test (host): the piping-branch forwarding — `parseImageReferences` over a
      `messagesToSend` batch containing `[Image: attachments/a.jpg]` returns
      `[{relativePath:'attachments/a.jpg', mediaType:'image/jpeg'}]`, i.e. the value handed to `sendMessage` (regression guard that cold-start and piping derive identical attachments from the same messages).
- [ ] Regression: text-only follow-up (no image marker) sends `{type,text}` with no image
      field and the container pushes plain text (no multimodal message).

## Verification Plan
No `DEPLOY.md` at project root → **local verification only** (no tiered endpoint plan; NanoClaw has no HTTP surface). The verifier should:
1. `npm run build` + `npm test` (see Test Criteria).
2. `./container/build.sh` (rebuild; prune builder if the agent-runner change isn't
   reflected), then restart the service.
3. **End-to-end (the actual bug):** with a group container already running (warm — send
   one text message first so the container is live), send an image to that group and
   confirm the model describes the image contents (not "No veo la imagen"). Confirm the
   per-group container log shows the IPC image being loaded and pushed
   (`Piping IPC message into active query`, no `Failed to load image`), proving pixels
   reached the model on the piping path.
4. Sanity: cold-start image (first message to an idle group) still works (no regression
   to the path that already worked).

## Risks
- **Two consumption points, one shared drain.** `drainIpcInput`'s return-type change
  touches both `pollIpcDuringQuery` and `waitForIpcMessage` plus the initial drain in
  `main()`. Missing any one re-introduces the gap in that window. Mitigation: Step 4
  enumerates all three; the end-to-end test exercises the during-query window
  specifically.
- **Stale container image.** Forgetting `./container/build.sh` (or the buildkit COPY
  cache) means the host sends `imageAttachments` but the old agent-runner ignores it —
  silently still broken. Mitigation: Step 5 + verification step 2 (prune-and-rebuild
  fallback), and the log assertion in E2E.
- **Deploy-window skew (benign).** New host + old in-flight container: the extra
  `imageAttachments` field is ignored (old `drainIpcInput` keys off `data.text`), so no
  crash — just the pre-existing drop until that container recycles. New container + old
  host: host never sets the field; fine. No coordinated restart required beyond Step 5.
- **Block ordering is a mirror, not an invention.** Follow-ups push a text message then
  an image-only `pushMultimodal` message — exactly cold start's two-message shape — so
  the model sees the same structure it already handles. Reversible if a combined
  text+image block is later preferred.

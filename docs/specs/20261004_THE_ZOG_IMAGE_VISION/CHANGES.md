# CHANGES — Carry images through the follow-up / IPC (piping) path

## Changes Implemented

### Files Modified
- `src/group-queue.ts` — `sendMessage` now accepts an optional
  `imageAttachments?: ImageAttachment[]` third arg; adds `imageAttachments` to
  the IPC JSON payload **only when the array is non-empty**. Imports the
  `ImageAttachment` type from `./image.js`.
- `src/index.ts` (piping branch, ~L472) — after `formatMessages(messagesToSend, …)`
  it now calls the already-imported `parseImageReferences(messagesToSend)` and
  passes the result as the third arg to `queue.sendMessage(chatJid, formatted,
  imageAttachments)`, mirroring the cold-start path (L208).
- `container/agent-runner/src/index.ts` — threaded images through all three IPC
  consumption windows via a shared loader (details below).
- `src/group-queue.test.ts` — 3 new tests (payload with/without/empty images).
- `src/image.test.ts` — 1 new regression-guard test (cold-start vs piping derive
  identical attachments from the same batch).

### agent-runner changes (detail)
- Added `interface IpcMessage { text: string; imageAttachments?: Array<{relativePath:string; mediaType:string}>; }`.
- Extracted the cold-start base64 image-load loop into
  `loadImageBlocks(imageAttachments)` → `ContentBlock[]` (same
  `path.join('/workspace/group', relativePath)`, same `readFileSync().toString('base64')`,
  same `{type:'image', source:{type:'base64', media_type, data}}` block, same
  `Failed to load image:` log on failure). Cold-start now calls this helper, so
  its behavior is unchanged.
- Added `pushIpcMessage(stream, msg)` mirroring cold start: `stream.push(msg.text)`
  then, when `msg.imageAttachments?.length`, `stream.pushMultimodal(loadImageBlocks(...))`.
- `drainIpcInput()` return type changed `string[]` → `IpcMessage[]`; each
  `{type:'message', text}` file now yields `{ text, …(Array.isArray(imageAttachments) && {imageAttachments}) }`.
- Wired all three consumption points:
  1. **During-query** (`pollIpcDuringQuery`, the ZOG bug): iterates `IpcMessage[]`
     and calls `pushIpcMessage` (was `stream.push(text)`).
  2. **Between-query** (`waitForIpcMessage`): resolves `IpcMessage[] | null`
     (was `string | null`); the main loop sets
     `prompt = nextMessage.map(m => m.text).join('\n')` and
     `initialImages = nextMessage.flatMap(m => m.imageAttachments ?? [])`.
  3. **Initial pending drain** (`main()`): folds `pending.map(p => p.text)` into
     the prompt (as before) AND collects `pending.flatMap(p => p.imageAttachments ?? [])`
     into the first query's images.
- `runQuery` gained an `initialImages?` param; it loads
  `initialImages ?? containerInput.imageAttachments` through `loadImageBlocks`.
  The first query receives `containerInput.imageAttachments ++ pending images`;
  subsequent queries receive the follow-up batch's images.

### Models/Schemas Affected
- IPC message payload (host→container): `{type, text}` →
  `{type, text, imageAttachments?}`. The new field is optional and omitted when
  empty, so old payloads and old containers remain compatible (see Deviations →
  none; see SPEC Risks → deploy-window skew is benign).

### Endpoints Affected
NanoClaw has no HTTP surface. The affected "endpoint" is the follow-up/piping
dispatch path (`src/index.ts startMessageLoop` → `GroupQueue.sendMessage` →
container `drainIpcInput`). Images arriving while a group's container is already
running now reach the model as pixels, matching cold start.

### Deviations from Plan
- None in the original plan. All five code steps (1–4e) implemented as specified.
  Step 5 (container rebuild + service restart) is intentionally deferred to the
  verifier per the orchestrator's instruction — see note below.

### `/code-review medium` fixes (4 findings)
1. **MUST FIX (correctness) — caption-less image dropped.** `drainIpcInput`'s
   guard was `data.type === 'message' && data.text`, which discarded a message
   (and its `imageAttachments`) whenever `text` was empty/missing — the common
   case for this cycle (WhatsApp images with no caption). Changed the guard to
   keep a message with text **or** a non-empty `imageAttachments`, and normalized
   `text` to `''` when absent. Correspondingly, `pushIpcMessage` now skips the
   text block entirely when `msg.text` is empty, so a caption-less image produces
   an image push with **no** empty user turn before it. Tests added:
   `src/image.test.ts` (parse of a marker-only message) and
   `src/group-queue.test.ts` (`sendMessage(jid, '', images)` still carries
   `imageAttachments`).
2. **SHOULD FIX (useless test).** Replaced the tautological "cold-start vs
   piping" test (which called `parseImageReferences` twice on identical input)
   with a wiring-invariant test that reads `src/index.ts` and asserts cold start
   parses `missedMessages`, piping parses `messagesToSend`, and piping forwards
   the result as the 3rd arg to `queue.sendMessage(chatJid, formatted,
   imageAttachments)`. It fails if either call site is removed or wired to a
   different batch/parser — genuinely protecting the invariant.
3. **SHOULD FIX (dead dual source).** Removed `runQuery`'s
   `initialImages ?? containerInput.imageAttachments` fallback. `runQuery` now
   takes `initialMessages: IpcMessage[]` and pushes each via `pushIpcMessage`;
   it never reads `containerInput.imageAttachments` directly, eliminating the
   unreachable fallback and the `??`→`||` double-send footgun. `main()` builds
   the first query's single message (folded prompt + its images) and passes the
   drained `IpcMessage[]` straight through on follow-ups.
4. **JUDGMENT (asymmetry) — FIXED.** The between-query path previously flattened
   all texts and all images into one trailing block, losing per-message
   text↔image association. Now that `runQuery` iterates `pushIpcMessage` over the
   drained `IpcMessage[]`, the between-query path pushes per-message exactly like
   the during-query path — symmetric, and cheap (no new structure; reuses the
   shared `pushIpcMessage`). Note: the **initial pending-drain** (messages that
   arrived before the container started) still folds its text into the first
   prompt by design — that preserves the pre-existing "initial prompt" behavior;
   its images are collected into the first message.

## Required follow-up (verifier)
`container/agent-runner/src/index.ts` changed, so the running container image is
stale until rebuilt. The verifier must run `./container/build.sh` (prune the
buildkit builder first if the agent-runner change isn't reflected — see CLAUDE.md
"Container Build Cache") and then `systemctl --user restart nanoclaw` so new
containers use the new image. Until then the host sends `imageAttachments` but an
old agent-runner ignores it (no crash, just the pre-existing drop).

## Test Results
- `npm run build` (host `tsc`): **PASS**, no type errors.
- `npx vitest run` (full suite): **280 passed / 20 files** (after the review
  fixes). Includes the new tests and the existing 2-arg `sendMessage`
  backward-compat tests.
- `src/group-queue.test.ts`: payload carries `imageAttachments` when present;
  omits the key when the arg is absent; omits it when the array is empty;
  carries `imageAttachments` even when the caption text is empty.
- `src/image.test.ts`: parses a caption-less (marker-only) image; wiring-invariant
  tests that cold start and piping use the same parser over their respective
  batches and that piping forwards the result to `sendMessage`.
- agent-runner `tsc`: the agent-runner tree has no `node_modules` installed in
  this checkout (SDK/MCP deps are installed at container build time), so a direct
  `tsc` there reports only missing-module / implicit-any-from-untyped-import
  errors — none referencing the changed code. Verified the changed file bundles
  cleanly with `esbuild` (deps externalized), confirming the edits parse and are
  structurally sound. Full type-check happens during `./container/build.sh`.

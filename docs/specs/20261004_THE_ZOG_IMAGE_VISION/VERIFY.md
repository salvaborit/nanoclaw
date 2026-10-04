# VERIFY — Carry images through the follow-up / IPC (piping) path

## Verification Report

### Environment
- Target: **local**
- Deploy strategy: direct/local. NanoClaw has no HTTP surface — no tiered endpoint
  plan. Verification is build + test + container-image gate only.
- Service restart: **NOT performed** (human-gated, out of scope — see below).

### Check 1 — Host build (`npm run build`)
**Verdict: PASS**

```
$ npm run build
> nanoclaw@1.2.26 build
> tsc
EXIT=0
```
Host TypeScript (`tsc`) compiled with no type errors. Confirms `src/group-queue.ts`,
`src/index.ts`, and the test files type-check against the real host deps.

Files carrying the change (git diff --stat HEAD):
```
 container/agent-runner/src/index.ts | 129 +++++++++++++++---------
 src/group-queue.test.ts             |  90 +++++++++++++++++
 src/group-queue.ts                  |  18 ++-
 src/image.test.ts                   |  42 +++++-
 src/index.ts                        |   3 +-
```

### Check 2 — Test suite (`npx vitest run`)
**Verdict: PASS**

```
 Test Files  20 passed (20)
      Tests  280 passed (280)
   Duration  3.96s
EXIT=0
```
280/280 passing across 20 files — matches the expected ~280. Includes the changed
suites: `src/group-queue.test.ts` (17 tests — payload with/without/empty images,
empty-caption image still carried, 2-arg backward-compat) and `src/image.test.ts`
(11 tests — caption-less marker parse, wiring-invariant guard).

The `FATAL: Container runtime failed to start` banner printed to stderr is the
**expected log line** emitted by `src/container-runtime.test.ts > ensureContainerRuntimeRunning
> throws when docker info fails` — that test asserts the failure behavior and
**passed** (it is counted in the 280). Not a failure.

### Check 3 — Container build (`./container/build.sh`) — the key gate
**Verdict: PASS**

This is the only place `container/agent-runner/src/index.ts` is compiled/bundled
against its real dependencies (the checkout has no `node_modules` for agent-runner).
The Dockerfile step `[8/12] RUN npm run build` runs `tsc` over the changed source
against the installed SDK/MCP deps.

Fresh (not CACHED) execution of the relevant layers — proves no stale buildkit COPY
cache; builder prune was NOT needed:
```
#11 [ 7/12] COPY agent-runner/ ./              DONE 0.1s   (fresh)
#12 [ 8/12] RUN npm run build
#12 0.502 > nanoclaw-agent-runner@1.0.0 build
#12 0.502 > tsc
#12 DONE 3.3s                                              (tsc clean, no errors)
#17 writing image sha256:ee1ea762f923...  DONE
naming to docker.io/library/nanoclaw-agent:latest DONE
Build complete!
EXIT=0
```

**New agent-runner confirmed in the image** (not stale):
- Image ID advanced `78ab40b91b3a` (old) → `ee1ea762f923` (new).
- Source in image contains the new symbols (8 marker hits for
  `loadImageBlocks` / `pushIpcMessage` / `interface IpcMessage` /
  `Piping IPC message into active query`):
  ```
  $ docker run --rm --entrypoint sh nanoclaw-agent:latest \
      -c "grep -c '...markers...' /app/src/index.ts"
  8
  ```
- Compiled output `/app/dist/index.js` present and contains the new helpers
  (6 marker hits for `loadImageBlocks` / `pushIpcMessage`).

Because `COPY agent-runner/` and `RUN npm run build` both ran fresh and `tsc`
exited clean, the changed agent-runner (shared `loadImageBlocks`, `pushIpcMessage`,
`IpcMessage`-typed `drainIpcInput`, and all three IPC consumption windows) compiles
and bundles correctly and is baked into `nanoclaw-agent:latest`.

### Code-Level Checks (summary)
- Build: **PASS** — `tsc` EXIT=0, no type errors.
- Lint: **SKIPPED** — no separate lint step configured (`tsc` is the type gate).
- Tests: **PASS** — 280 passed, 0 failed.
- Container build: **PASS** — image rebuilt, new agent-runner present and type-checked.

### Failure Summary
None. No implementation bugs or architectural issues found.

| # | Area | Classification | Detail |
|---|------|----------------|--------|
| — | —    | —              | No failures |

### Verdict
**PASS** — 0 implementation bugs, 0 architectural issues.
All three required checks pass: host build clean, 280/280 tests green, and the
container image rebuilt with the new agent-runner compiled and bundled (fresh COPY +
clean `tsc`, confirmed present in both `/app/src` and `/app/dist`).

### Remaining human-gated validation (NOT performed here — out of scope)
These two steps touch the live service / require a physical device and were
intentionally left for the human per the orchestrator's instruction:
1. **Service restart** — `systemctl --user restart nanoclaw` so running/new
   containers pick up `nanoclaw-agent:latest`. (NanoClaw service was NOT restarted
   or stopped during verification.)
2. **Real phone end-to-end (the actual ZOG bug)** — with a group container already
   warm (send a text first), send an image from WhatsApp and confirm the model
   describes the image contents (not "No veo la imagen"), and that the per-group
   container log shows `Piping IPC message into active query` with no
   `Failed to load image`. Requires the user to send an image from their phone.

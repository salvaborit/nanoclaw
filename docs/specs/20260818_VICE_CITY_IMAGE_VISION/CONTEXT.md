# CONTEXT — Why vice-city-2's Jarvis can't read images (ZOG can)

**Date:** 2026-08-18 · **Type:** diagnosis (research-only)

## Symptom
Group **Vice city 2** replied "No puedo ver la imagen…" to an image. The same
assistant reads images fine in **The ZOG**. Both are WhatsApp groups.

## What the code does (identical for every group)
Image handling is **channel-level, not per-group**:
- `src/channels/whatsapp.ts:211` — on any image message, downloads + `processImage()`
  (resize→jpeg, writes `groups/{folder}/attachments/img-*.jpg`, injects a
  `[Image: attachments/…]` marker into the message text).
- `src/image.ts:parseImageReferences` — scans message text for those markers.
- `src/index.ts:208,372` — passes them as `imageAttachments` to the container.
- `container/agent-runner/src/index.ts:365-380` — reads each file, base64-encodes,
  `stream.pushMultimodal([{type:'image',…}])`.

None of this branches on the group. So the difference is **not** in image handling.

## The only per-group difference: the model
`registered_groups.container_config` (store/messages.db):
- **vice-city-2:** `{"model":"claude-sonnet-4-6", "additionalMounts":[…]}`
- **zog:** `{"additionalMounts":[…]}` (no model)

`data/sessions/{group}/.claude/settings.json`:
- **vice-city-2:** **no `model` key**
- **zog:** `"model": "claude-sonnet-4-5"`

### The `container_config.model` field is inert (nobody reads it)
- `ContainerConfig` type (`src/types.ts:30`) has **no `model` field**.
- `grep -rin model src/ container/agent-runner/src/` → **zero** hits in query options.
- `query()` options (`container/agent-runner/src/index.ts:436-474`) never set `model`;
  it relies on `settingSources: ['project','user']` → the SDK reads `model` from the
  mounted `settings.json` only.
- The committed `container/agent-runner/dist/index.js:349` DOES contain
  `model: containerInput.model || undefined`, but it's **dead**: the container
  entrypoint recompiles from `/app/src` at runtime (`npx tsc → /tmp/dist`,
  Dockerfile:62), and the live source has no such line. So neither
  `container_config.model` nor `containerInput.model` reaches the SDK.
- Also `claude-sonnet-4-6` is **not a valid NanoClaw model id** (valid:
  `claude-opus-4-5`, `claude-sonnet-4-5`, `claude-haiku-4-5`).

### Effective model
- **zog** → `claude-sonnet-4-5` (explicit, vision-capable) → reads images ✅
- **vice-city-2** → **no model set anywhere valid** → SDK/gateway default model,
  whose vision behavior through the OneCLI gateway differs → "no puedo ver la imagen" ✗

## Fix (recommended)
Mirror ZOG: set `"model": "claude-sonnet-4-5"` in
`data/sessions/vice-city-2/.claude/settings.json`, and drop the inert `model` key
from vice-city-2's `container_config` to avoid future confusion. No rebuild needed
(settings.json is read fresh each run); next container spawn picks it up.

## Confidence
- Config discrepancy + inert field: **certain** (grep + type + entrypoint verified).
- That the SDK default specifically drops vision (vs. Sonnet 4.5 keeping it): **inferred**
  — consistent with all evidence, but the container log captures only a summary, not
  agent stdout, so it isn't directly observed. Pinning the same known-good model as ZOG
  removes the variable regardless.

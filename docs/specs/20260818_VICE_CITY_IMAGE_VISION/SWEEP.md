# SWEEP — model config across all groups (2026-08-18)

Reminder: `container_config.model` is **inert** (never read). Effective model =
`data/sessions/{group}/.claude/settings.json` `model` key, else SDK/gateway default.
The gateway default is what broke vision in vice-city-2.

| Group | container_config.model (inert) | settings.json model (effective) | Verdict |
|---|---|---|---|
| zog | — | claude-sonnet-4-5 | ✅ known-good (reference) |
| vice-city-2 | ~~removed~~ | claude-sonnet-4-5 | ✅ fixed this cycle |
| main | claude-opus-4-6 | claude-opus-4-5 | ⚠️ B: inert key only |
| dmitris-2 | claude-sonnet-4-6 | claude-opus-4-5 | ⚠️ B: inert key only |
| ventas-dimitris | claude-sonnet-4-6 | claude-opus-4-5 | ⚠️ B: inert key only |
| jarvis-agenda | claude-sonnet-4-6 | **(none)** | ❌ A: runs on default |
| purpl-bot | claude-sonnet-4-6 | **(none)** | ❌ A: runs on default |
| cencoclaw | — | **(none)** | ❌ A: runs on default |
| zellyt-bot | — | **(none)** | ❌ A: runs on default |
| prueba-tech-acc | — | claude-sonnet-4-6 | ❓ C: model-id validity? |
| yonita-trolls | — | claude-sonnet-4-6 | ❓ C: model-id validity? |
| dimitris-claw | — | claude-sonnet-5 | ❓ C: model-id validity? |

## Categories
- **A — same functional bug as vice-city-2** (no effective valid model → gateway
  default → vision breaks the moment they get an image): `jarvis-agenda`, `purpl-bot`,
  `cencoclaw`, `zellyt-bot`.
- **B — cosmetic only** (effective model is a valid `4-5`; just carry a leftover inert
  `model` in container_config): `main`, `dmitris-2`, `ventas-dimitris`.
- **C — model-id validity unknown**: `claude-sonnet-4-6` / `claude-opus-4-6` are not in
  CLAUDE.md's valid list (`claude-opus-4-5`, `claude-sonnet-4-5`, `claude-haiku-4-5`).
  If the OneCLI gateway does NOT recognize `claude-sonnet-4-6`, then `prueba-tech-acc`
  and `yonita-trolls` are ALSO silently on the default (latent vision bug), and the
  inert `4-6` keys in B are doubly meaningless. `claude-sonnet-5` may or may not be
  valid for the gateway. Needs the owner to confirm what the gateway accepts.

## Resolution (applied 2026-08-18)
- **CLAUDE.md model list is STALE.** Authoritative source (claude-api skill) confirms
  Sonnet tier by recency: `claude-sonnet-5` (newest) → **`claude-sonnet-4-6`
  (2nd-newest)** → `claude-sonnet-4-5` (old). So `claude-sonnet-4-6` is a real, valid
  model — it was just parked in the inert `container_config` field.
- Owner chose **second-to-newest = `claude-sonnet-4-6`** for the assistant groups.
- **settings.json set to `claude-sonnet-4-6`:** jarvis-agenda, purpl-bot, cencoclaw,
  zellyt-bot (Category A fix), and vice-city-2 (bumped off the old 4-5).
- **Inert `container_config.model` removed** from all 5 that carried it (jarvis-agenda,
  main, dmitris-2, ventas-dimitris, purpl-bot) via `json_remove`.
- **Left as-is (not broken, deliberate — flagged for owner):** `zog` still on
  `claude-sonnet-4-5` (old); opus groups `main`/`dmitris-2`/`ventas-dimitris` on
  `claude-opus-4-5` (deliberate higher tier; 2nd-newest opus would be `claude-opus-4-7`);
  `dimitris-claw` on `claude-sonnet-5` (newest).
- Every group now pins a valid model explicitly; none runs on the gateway default.

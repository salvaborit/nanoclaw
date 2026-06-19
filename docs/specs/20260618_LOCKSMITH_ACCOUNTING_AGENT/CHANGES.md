# CHANGES — Locksmith Accounting Agent (Chunks A + B + C)

Scope of this implementation: SPEC.md Chunks **A** (foundations), **B**
(skill + group config), and **C** (registration). Chunk D (smoke +
scheduler bootstrap verification) is intentionally NOT done here and is
left to the orchestrator-driven manual smoke test.

User-locked overrides applied (override SPEC.md where they differ):

- Default reply language: **English** (SPEC.md defaulted to Spanish).
- Owner-query allowlist: anyone in the group (no JID check for trial).
- Model: `claude-sonnet-4-6` (SPEC.md suggested `claude-sonnet-4-5`).
- Branch: `develop` (unchanged — already checked out).

---

## Files Modified

- `container/Dockerfile` — appended `jq` and `sqlite3` to the existing
  `apt-get install -y` package list (only this single chunk of lines
  changed). Required so the agent can run SQLite via `Bash` and manipulate
  `pending.jsonl` via `jq -s`.

## Files Created

- `container/skills/locksmith-ledger/SKILL.md` — instruction-only container
  skill (synced into every container run). Provides Bash recipes for:
  schema init (idempotent `CREATE TABLE IF NOT EXISTS` + indices, PRAGMA
  `user_version=1`), insert confirmed job, append `awaiting` pending row,
  list awaiting rows (by reporter), edit pending row's extracted fields,
  mark pending status (`confirmed` / `rejected`) via safe `jq -s` + temp
  file + `mv`, malformed-line skip pattern, weekly / monthly / previous-
  month / since-date totals, last-N markdown table, payment-method
  breakdown, provider normalization (with `ml` / `mobile` aliases),
  YAML cut-rule lookup (`yq` + awk fallback), per-job cut calculation,
  stale-pending check, scheduler bootstrap (IPC task creation JSON for
  weekly `0 18 * * 0` and monthly `0 18 1 * *`), English + Spanish
  confirmation markdown templates, weekly summary template, owner-query
  intent table. Model: mirrors `container/skills/sales/SKILL.md` structure
  — instruction-only, operational reference, no executable code files.

- `groups/prueba-tech-acc/CLAUDE.md` — per-group behavioral instructions.
  States explicit auto-process mode (every message processed, no `@Jarvis`
  trigger). Language: English default, mirror only if the sender clearly
  writes in another language. Defines the three-step per-message flow:
  (1) read pending and resolve if applicable, (2) classify (job report /
  owner query / silent), (3) bootstrap scheduler on first invocation.
  Documents the confirmation-only-by-reporter rule, the owner-query no-
  allowlist policy for the trial, the cut-snapshot-at-insert invariant.
  Defers all mechanics to the `locksmith-ledger` skill.

- `data/sessions/prueba-tech-acc/.claude/settings.json` — pre-creates the
  group's session settings with `{"model": "claude-sonnet-4-6"}` so the
  model is set on the first container run. Shape matches existing
  precedent (`data/sessions/ventas-dimitris/.claude/settings.json` uses
  the same `{"model": "..."}` field).

## Host-Side Artifacts Created (outside the repo)

- `/home/sborit/locksmiths/aldo-cavanna/` — directory.
- `/home/sborit/locksmiths/aldo-cavanna/pending.jsonl` — empty file (so
  `jq -s` on the host doesn't choke before the first job).
- `/home/sborit/locksmiths/locksmiths.yaml` — config per SPEC.md §4 with
  Aldo's data (`name: Aldo Cavanna`, `slug: aldo-cavanna`,
  `group_jid: REPLACE_AFTER_REGISTRATION`,
  `group_folder: prueba-tech-acc`, `currency: USD`, cut_rules: 35% for
  `mobile_locksmith`, 30% default).

The SQLite DB at
`/home/sborit/locksmiths/aldo-cavanna/ledger.sqlite` was **not** created —
per spec, the agent will init it idempotently on the first job
confirmation.

---

## Models / Schemas Affected

This is a new feature with no impact on existing models or schemas.
The new SQLite schema (created by the agent on first write, defined in
`container/skills/locksmith-ledger/SKILL.md`) introduces one table:

- **`jobs`** (new) — see SPEC.md §3. Columns: `id`, `ticket`, `customer`,
  `phone`, `address`, `description`, `notes`, `provider`,
  `provider_normalized`, `total_amount`, `cash_amount`, `zelle_amount`,
  `cashapp_amount`, `square_amount`, `cut_percent` (snapshot),
  `cut_amount` (snapshot), `job_timestamp`, `message_id`,
  `reported_by_jid`, `reported_by_name`, `confirmed_at`, `created_at`.
  Indices on `job_timestamp`, `provider_normalized`, `message_id`.

The new `pending.jsonl` line schema (SPEC.md §5.4) is documented in the
skill. No existing JSONL files are touched.

## Endpoints Affected

NanoClaw is not an HTTP service; the equivalent here is the per-message
routing pipeline. No `src/` code was modified. Effects on the message
pipeline:

### Direct
- `Prueba tech acc` WhatsApp group (once registered in Chunk C) — every
  message will be processed by the agent because the registration in
  Chunk C will set `requiresTrigger: false`. The behavior is defined
  entirely by `groups/prueba-tech-acc/CLAUDE.md` and the
  `locksmith-ledger` skill.

### Transitive
- None. No shared core code, no other group's behavior, and no other
  channel is affected. The Dockerfile change adds two CLI tools (`jq`,
  `sqlite3`) to every container, but they only run when the agent
  invokes them via `Bash` — no other group exercises them today.

---

## Commands Run

```bash
# A1 — verify Dockerfile state (read), then edit
# (Edit applied to container/Dockerfile)

# A2 — prune builder, then rebuild
docker buildx prune -f
./container/build.sh                  # ran in background, exited 0

# A2 — verify new tools in the image
docker run --rm --entrypoint sqlite3 nanoclaw-agent:latest --version
#   → 3.40.1 ...
docker run --rm --entrypoint jq nanoclaw-agent:latest --version
#   → jq-1.6

# A3 — host seed
mkdir -p /home/sborit/locksmiths/aldo-cavanna
touch /home/sborit/locksmiths/aldo-cavanna/pending.jsonl
# Wrote /home/sborit/locksmiths/locksmiths.yaml via Write tool.
python3 -c 'import yaml; print(yaml.safe_load(open("/home/sborit/locksmiths/locksmiths.yaml")))'
#   → parses cleanly

# B1, B2, B3 — file writes only (no commands)

# B3 — validate JSON
python3 -c 'import json; print(json.load(open("/home/sborit/prj/nanoclaw/data/sessions/prueba-tech-acc/.claude/settings.json")))'
#   → {'model': 'claude-sonnet-4-6'}
```

Build log saved at `/tmp/nanoclaw-build.log` for this session (not
checked in). Final image: `nanoclaw-agent:latest` (digest
`sha256:31cf479a22dde037f3096d0058be31a2af759458b5d3f673746550a747b211c9`).

`docker buildx` was available on this host, so the spec's fallback
(`docker builder prune -f`) was not needed.

`docker run --rm <image> sqlite3 --version` (the SPEC.md command form)
does not work because the image has a custom `ENTRYPOINT`
(`/app/entrypoint.sh`) that expects a JSON payload on stdin. The
`--entrypoint sqlite3` override is what actually reaches the binary.
This is documented here so the verifier doesn't waste time on the
plain form.

---

## Deviations from SPEC.md

1. **Reply language default → English**, not Spanish (SPEC.md §9 and
   §5.2 default to Spanish). Reason: user-locked override. The skill
   carries both the English and Spanish confirmation-markdown templates;
   the agent mirrors the sender's language when it's clearly non-English.

2. **Model → `claude-sonnet-4-6`** instead of SPEC.md §10's
   `claude-sonnet-4-5`. Reason: user-locked override. No other config
   depends on the choice.

3. **Owner-query allowlist → none for the trial.** SPEC.md §6 already
   marks this as the trial behavior and §16 R3 flags it for post-trial
   hardening. The group `CLAUDE.md` makes the no-allowlist policy
   explicit.

4. **`docker run` verification commands** in CHANGES use
   `--entrypoint sqlite3` / `--entrypoint jq` instead of the bare
   `docker run --rm <image> sqlite3 --version` written in SPEC.md §11.
   The image has a custom entrypoint that swallows the CLI args
   otherwise; this is a verification-command fix only, not a behavior
   deviation.

5. **`group_jid` placeholder in `locksmiths.yaml`** kept as
   `REPLACE_AFTER_REGISTRATION` per SPEC.md §4. Will be filled in
   during Chunk C after JID capture.

No other deviations.

---

## Notes for Verifier / Next-Step Engineer

- The container build cache was pruned with `docker buildx prune -f`
  before the rebuild, per `CLAUDE.md`'s warning that `--no-cache` alone
  is insufficient. If the verifier rebuilds later for any reason, they
  should do the same — otherwise the `apt-get install jq sqlite3` layer
  may not actually re-run.
- `nanoclaw-agent:latest` image digest:
  `sha256:31cf479a22dde037f3096d0058be31a2af759458b5d3f673746550a747b211c9`.
- The host folder `/home/sborit/locksmiths/` is mount-allowlist-OK
  (CONTEXT.md §3 — `/home/sborit` is allowed read-write). No allowlist
  edit is required when Chunk C registers the group with
  `additionalMounts`.
- `pending.jsonl` is currently empty. The skill's `jq -s '.' "$PENDING"`
  recipe returns `[]` on an empty file, which is what the mutation
  pipeline expects.
- `data/sessions/prueba-tech-acc/.claude/settings.json` only contains
  `{"model": "claude-sonnet-4-6"}`. The existing
  `data/sessions/ventas-dimitris/.claude/settings.json` adds an `env`
  block with `CLAUDE_CODE_*` flags. Those flags appear unrelated to the
  locksmith feature and the user did not request them — leaving them
  off keeps the trial diff minimal. They can be added later if the
  verifier finds they're required for agent-teams or auto-memory
  behavior that the trial actually needs.
- The skill writes the schema with `PRAGMA user_version = 1` so a
  future migration path is open without breaking existing rows.
- The skill's INSERT recipe uses `sed "s/'/''/g"` for SQL string
  escaping. Test that with quote-bearing customer names during T1/T2
  smoke. If problematic, swap to `sqlite3 ... -bail` with `.parameter`
  binding (more invasive, but safer).
- The skill warns about malformed lines in `pending.jsonl` (R5 in
  SPEC.md §16). The agent should never abort on a malformed line — log
  a warning and skip.
- Chunk C is now done (see Chunk C section below). Only Chunk D (live
  smoke + scheduler bootstrap verification in the WhatsApp group) is
  outstanding.
- The image already has `jq` and `sqlite3` baked in — no second rebuild
  needed before Chunk D.

---

## Chunk C — Registration

Confirmed inputs from the orchestrator:

- **Group JID:** `120363408992576888@g.us`
- **Group name:** `Prueba tech acc`
- **Folder slug:** `prueba-tech-acc`
- **Branch:** `develop`
- **Model:** `claude-sonnet-4-6` (already in
  `data/sessions/prueba-tech-acc/.claude/settings.json` from Chunk B3)

### Files Created (Chunk C)

- `scripts/register-prueba-tech-acc.ts` — registration script. Mirrors
  the structure of `scripts/register-zellyt-bot.ts` /
  `scripts/register-yonita-trolls.ts`: imports `setRegisteredGroup` and
  `initDatabase` from `../src/db.js`, types the row as
  `RegisteredGroup`. JID is hardcoded (no CLI arg) since it is
  confirmed. Key fields:
  - `name: 'Prueba tech acc'`
  - `folder: 'prueba-tech-acc'`
  - `trigger: '@Jarvis'` (carried forward from peer scripts; ignored at
    runtime because `requiresTrigger: false`)
  - `requiresTrigger: false` — **always-on mode** for the locksmith
    accounting agent
  - `isMain: false`
  - `containerConfig.additionalMounts`: one entry —
    `{ hostPath: '/home/sborit/locksmiths', containerPath: 'locksmiths', readonly: false }`
    (matches the spec §2 mount and the existing mount-allowlist policy).

### Files Modified (Chunk C — outside the repo)

- `/home/sborit/locksmiths/locksmiths.yaml` — replaced the placeholder
  `group_jid: REPLACE_AFTER_REGISTRATION` with
  `group_jid: 120363408992576888@g.us`. Everything else untouched.

### Commands Run (Chunk C)

```bash
# C3 — registration
npx tsx scripts/register-prueba-tech-acc.ts
# stdout:
#   Registered Prueba tech acc group:
#     JID: 120363408992576888@g.us
#     Folder: groups/prueba-tech-acc/
#     Trigger: auto (requiresTrigger=false)
#     Model: claude-sonnet-4-6
#     Mount: /home/sborit/locksmiths -> /workspace/extra/locksmiths (rw)

# C4 — DB row verification
sqlite3 /home/sborit/prj/nanoclaw/store/messages.db \
  "SELECT jid, name, folder, requires_trigger, container_config \
   FROM registered_groups WHERE folder='prueba-tech-acc';"
# stdout:
#   120363408992576888@g.us|Prueba tech acc|prueba-tech-acc|0|{"additionalMounts":[{"hostPath":"/home/sborit/locksmiths","containerPath":"locksmiths","readonly":false}]}
# → requires_trigger=0 (false) ✓
# → container_config JSON has the /home/sborit/locksmiths mount with readonly:false ✓

# C5 — restart
systemctl --user restart nanoclaw
sleep 3
systemctl --user status nanoclaw --no-pager | head -20
# Status: ● nanoclaw.service - NanoClaw Personal Assistant
#         Active: active (running) since Fri 2026-06-19 02:39:19 UTC

# C6 — log tail post-restart
tail -n 50 /home/sborit/prj/nanoclaw/logs/nanoclaw.log
# Clean startup: "Connected to WhatsApp", "Scheduler loop started",
# "IPC watcher started (per-group namespaces)",
# "NanoClaw running (trigger: @Jarvis)". No errors.

grep -E "prueba-tech-acc|120363408992576888|Prueba tech acc" \
  /home/sborit/prj/nanoclaw/logs/nanoclaw.log
# (no matches — expected: the group is loaded lazily on first inbound
#  message. Recovery only logs groups with pending unprocessed messages,
#  and Prueba tech acc has none yet. Registration is in the DB and will
#  be picked up the moment a message arrives.)
```

### Acceptance (Chunk C)

- [x] `scripts/register-prueba-tech-acc.ts` exists, mirrors
  `register-zellyt-bot.ts` structure, `requiresTrigger: false`, correct
  `additionalMounts`.
- [x] Row in `registered_groups` for JID `120363408992576888@g.us` with
  `requires_trigger=0` and `additionalMounts` containing
  `/home/sborit/locksmiths` rw.
- [x] `locksmiths.yaml` `group_jid` filled in with the real JID.
- [x] `systemctl --user restart nanoclaw` succeeds, service is
  `active (running)` after restart.
- [x] Log tail post-restart shows clean startup with no errors related
  to the new group.

### Deviations from Plan (Chunk C)

1. **JID hardcoded inside the script** rather than passed as a CLI
   argument. SPEC.md §10 and the two reference scripts
   (`register-zellyt-bot.ts`, `register-yonita-trolls.ts`) accept the
   JID as `process.argv[2]`. Reason: orchestrator confirmed the JID
   (`120363408992576888@g.us`) up front, so passing it as an argv each
   time the script is rerun adds no value. The script remains
   editable, idempotent (`setRegisteredGroup` upserts), and runnable
   with a bare `npx tsx scripts/register-prueba-tech-acc.ts`. This is a
   minor ergonomic deviation, not a behavioral one — the row written
   to the DB is identical to what the argv form would produce.

2. **`isMain: false` set explicitly.** The peer scripts omit it (the
   field is optional in `RegisteredGroup`). Reason: orchestrator
   prompt called it out as required. The runtime treats absent and
   `false` identically, so this is also ergonomic — explicit > implicit
   for an always-on, non-main accounting group.

No other deviations. The script's shape, imports, exit conventions,
and console output mirror `register-zellyt-bot.ts` /
`register-yonita-trolls.ts`.

### What Chunk D Still Needs (unchanged from earlier)

- D1: send a test job report in the group → expect §5.2 markdown +
  new `awaiting` row in `pending.jsonl`.
- D2: send `confirmar` from the reporter → expect one-line ACK + row
  in `ledger.sqlite` with correct snapshot `cut_percent`/`cut_amount`.
- D3: verify scheduler bootstrap — two cron rows
  (`0 18 * * 0` weekly, `0 18 1 * *` monthly) in
  `scheduled_tasks WHERE group_folder='prueba-tech-acc'`.
- D4: smoke the cron without waiting via a one-off IPC task scheduled
  for `now+2min`.

### Amendment 2026-06-19 — cut percentages inverted

User corrected the business rule mid-trial. Previous SPEC said **35%
Mobile Locksmith / 30% default**; corrected to **30% Mobile Locksmith
/ 35% default**.

By coincidence, `~/locksmiths/locksmiths.yaml` was already written
with the corrected values (30% ML / 35% default), so the three jobs
already in `ledger.sqlite` (napaula amorillo $100, Renzo Travis $245,
Elena $400 — all Mobile Locksmith) have the correct snapshot
`cut_percent=30` / `cut_amount=30/73.50/120`. No data fix needed.

Doc/template fixes applied:
- `container/skills/locksmith-ledger/SKILL.md:548-549` — weekly summary
  template percent labels flipped to `(30%)` / `(35%)`.
- `docs/specs/20260618_LOCKSMITH_ACCOUNTING_AGENT/SPEC.md` —
  YAML example (§4), provider-normalization examples (§4), Spanish
  weekly summary template (§7), and verification scenarios T1/T3/T4
  all flipped to the corrected percentages.
- `~/locksmiths/locksmiths.yaml` — no change needed (already correct).

Group `CLAUDE.md` had no hardcoded percent labels — clean.

### Chunk D progress so far

Smoke ran organically as soon as the group went live:
- The first incoming non-job message (`asdf`) was correctly classified
  as silent — agent produced `<internal>…</internal>` output, router
  stripped it, nothing sent. Confirmed: silent-on-noise works.
- Three job reports were extracted, confirmed by reporter, and landed
  in `~/locksmiths/aldo-cavanna/ledger.sqlite` with snapshot cuts at
  30% Mobile Locksmith. `pending.jsonl` shows the corresponding
  `confirmed` rows with `resolved_at` timestamps. Full extract +
  confirm + ledger-write flow works end-to-end.
- Scheduler bootstrap (D3) and cron smoke (D4) still pending —
  haven't checked `scheduled_tasks` yet.

Non-blocking observations from the live run:
- 3 core dumps from `/app/.../vendor/ripgrep/arm64-linux/rg` at 04:21.
  Agent SDK falls back to non-ripgrep search; no functional impact
  observed. Worth filing separately if it recurs.
- Transient WhatsApp stream-503 + reconnect at 04:20:58 — recovered
  in ~5s, no message loss.
- `OneCLI gateway not reachable` warning is informational — credential
  proxy on `:25000` with `authMode: oauth` is the active path.

### Amendment 2026-06-19 — confirmation gate dropped, ACK flow

User-locked behavioral change: the "please confirm" prompt-and-wait flow is
gone. The agent now acts directly on the message it just read.

#### New flow summary

- **Complete job** (all required fields present) → INSERT into `jobs`
  immediately + send one-line ACK. No confirmation step.
- **Incomplete job** (missing `total_amount` / `customer` / `provider` /
  payment breakdown) → do NOT insert. Append an `awaiting_details` row to
  `pending.jsonl` with `partial_extracted` + `missing_fields`, ask only for
  what's missing in one line.
- **Follow-up message** routes to one of three paths picked by the agent:
  (A) resolves an open `awaiting_details` → merge + INSERT + ACK + mark
  `completed`; (B) updates an already-stored recent job → UPDATE + recompute
  cut if total/provider changed + `✏️ UPDATED / ...` ACK; (C) treat as a
  brand-new job.

Required fields for the gate (skill-enforced):

1. `total_amount` numeric, > 0
2. `customer` non-empty
3. `provider` non-empty (raw text; skill normalizes)
4. `cash + zelle + cashapp + square == total_amount` within $0.01

ACK template (English/Spanish — same shape):

```
✅ ACK / {customer} / ${total} / {provider} / {payment_breakdown}
```

UPDATE ACK:

```
✏️ UPDATED / {customer} / ${total} / {provider} / {payment_breakdown}
```

`{payment_breakdown}` is the list of non-zero methods joined with ` + `
(e.g. `cash $100 + zelle $80`). Currency: integer when whole, two decimals
otherwise. Provider in the ACK is the raw original text, not the normalized
slug.

Pending statuses (new):
- `awaiting_details` — open, waiting for the missing fields.
- `completed` — merged and inserted; `resolved_at` set.
- `cancelled` — manual-only; no auto-cancel recipe in this trial.

#### Files edited

- `groups/prueba-tech-acc/CLAUDE.md` — replaced section 2a (job report
  handling) with the required-fields gate + INSERT/ACK or
  `awaiting_details`/ask split. Replaced "Confirmation rules (hard
  constraints)" with "Follow-up rules" (paths A/B/C) plus a new "Hard
  constraints" section. Sections 2b (owner query), 2c (silent), and 3
  (summaries on-demand) preserved. Language default still English; mirror
  Spanish.
- `container/skills/locksmith-ledger/SKILL.md` — replaced the "Confirmation
  protocol" / confirmation-markdown templates with an **ACK protocol**:
  required-fields gate, Path 1 (INSERT + ACK) with quote-safe
  `sqlite3 -cmd ".parameter set ..."` parameterized inserts, Path 2
  (`awaiting_details` row + one-liner ask), follow-up resolution recipes
  (pending merge via `jq -s`, UPDATE recipes with cut recomputation),
  new pending statuses (`awaiting_details` / `completed` / `cancelled`),
  pending row shape, English + Spanish single-line ACK templates,
  `✏️ UPDATED` template, and `❓ ...` ask phrasing. Dropped the markdown
  confirmation prompt blocks. Preserved: schema (idempotent),
  provider-normalization recipe, YAML cut-rule lookup, weekly/monthly
  summary templates (on-demand only), owner-query intents table, "do NOT
  auto-create cron tasks" rule. Note: the `jobs.confirmed_at` column name
  is kept (no schema migration) — it's now documented as a legacy name
  meaning "insert timestamp".
- `docs/specs/20260618_LOCKSMITH_ACCOUNTING_AGENT/SPEC.md` — added a new
  "Amendments" block at the top describing the 2026-06-19 (2) change.
  Replaced §5 ("Confirmation Protocol") with **§5 "ACK Protocol (no
  confirmation gate)"** (subsections 5.1 detection, 5.2 required-fields
  gate, 5.3 complete-job INSERT + ACK, 5.4 missing-fields path, 5.5
  follow-up resolution, 5.6 reporter identification, 5.7 pending statuses).
  Updated §14 verification scenarios T1/T2/T3/T4 to expect direct ACK
  (no confirm step). Replaced T5 (rejection) with **T5 Cancellation —
  out of trial scope**. Replaced T6 (corrections then confirm) with
  **T6 Corrections via follow-up update**. Adjusted T7 (restart survival)
  to use `awaiting_details` status. Removed T8 (wrong-sender confirm —
  no gate, no allowlist). Added **T14** (incomplete extract → ask) and
  **T15** (follow-up resolves pending). T16 cut-snapshot kept. T15
  (was: weekly cron) removed (out of scope per prior amendment). T9–T13
  unchanged.

#### Data impact

- The **12 existing rows** in `~/locksmiths/aldo-cavanna/ledger.sqlite`
  are untouched. No schema migration, no row edits.
- The existing rows in `pending.jsonl` (with legacy `confirmed` / `rejected`
  statuses) are also untouched. They remain as historical audit data. New
  rows from this point forward use `awaiting_details` / `completed` /
  `cancelled` only.
- The `jobs.confirmed_at` column is preserved as-is; the skill now documents
  it as "insert timestamp" (legacy name, no behavioral change).

#### Deviations from instructions

None. The implementation followed the locked decisions exactly.

#### TODOs / out of trial scope

- **Cancellation / soft-delete is unspecified.** If the locksmith says
  "cancel that" or "olvidalo", the agent has no automatic recipe. The
  operator must handle ad-hoc via direct SQL or manual `jq` on
  `pending.jsonl`. Future iteration may formalize this: e.g. add a
  `cancelled_at` column to `jobs` for soft-deletion of already-inserted
  rows, and a `cancelled` recipe for unresolved `awaiting_details` rows.

#### What is NOT done (intentional)

- No `npm run build` — pure data/docs/skill change.
- No service restart — the new skill is synced into the container on next
  spawn; the prior container was already killed.
- No container rebuild — the Dockerfile is unchanged.
- No commit.

---

### Amendment 2026-06-19 — cash-kept settlement model

User-locked business rule clarification: cash collected by the locksmith
stays with the locksmith (he pockets it on the spot). Non-cash payments
(Zelle / CashApp / Square) go to the boss. The actual settlement is
`net_owed_by_boss = SUM(cut_amount) - SUM(cash_amount)`. If negative,
the locksmith owes the boss. User preference (verbatim): "verbalize all
of this, expliciting the amount the locksmith already has in cash.
everything of the sort is better left said explicitly."

#### Business rule summary

- **Cash → locksmith** (kept on the spot, off-book to the boss).
- **Zelle / CashApp / Square → boss** (received directly by the boss).
- **Settlement when the boss pays the locksmith:**
  `net = SUM(cut_amount) - SUM(cash_amount)` over the period.
  - `net > 0` → boss owes locksmith.
  - `net < 0` → locksmith owes boss (cash collected exceeded his cut).
- **Always verbalize both numbers** (earned cut AND cash kept) before
  stating the net — never lump them.

#### Files edited

- `container/skills/locksmith-ledger/SKILL.md`
  - ACK templates: added cash-kept clause (`— you keep ${cash} cash` /
    `— te quedas con ${cash} en efectivo`) appended only when
    `cash_amount > 0`. Same rule for the `✏️ UPDATED` ACK.
  - Added a per-job math note (settlement is portfolio-wide, never
    per-job; no per-job "you owe boss"/"boss owes you" callouts).
  - Weekly + monthly summary templates: appended the three-line
    settlement block (`Cut earned`, `Cash already kept`, `Net the boss
    owes`). Spanish mirror included. Negative-net case documented with
    the exact wording.
  - New "Settlement math — canonical SQL recipe" section with the
    single query returning `earned`, `cash_kept`, `net` and shell
    recipes for "this week", "this month", "previous month", and
    "since DATE" windows (binding via `.parameter set`).
  - Owner-query intent table reshaped to distinguish three intents:
    settlement/owed (three-line block), earned cut only (just
    `SUM(cut_amount)`), cash kept (just `SUM(cash_amount)`). Added
    explicit disambiguation rule.

- `groups/prueba-tech-acc/CLAUDE.md`
  - Per-message flow (Section 2a): documented the cash-kept clause
    appended to the ACK when `cash > 0`; clean ACK when `cash == 0`.
    Included Spanish mirror.
  - Owner query rules: added the settlement-vs-earned-vs-cash-kept
    distinction with examples. Added the explicit policy line: "When
    discussing money owed, always state both numbers (earned cut AND
    cash already kept) before stating the net — be explicit, never
    lump them." Documented the negative-net case wording.

- `docs/specs/20260618_LOCKSMITH_ACCOUNTING_AGENT/SPEC.md`
  - Added top-of-file `Amendment 2026-06-19 (3) — cash-kept settlement
    model` block documenting the formula, ACK clause, three-line summary
    block, negative case, owner-query distinctions, canonical SQL, and
    portfolio-not-per-job rule.
  - T1 expected ACK updated to include `— you keep $100 cash` (T1 has
    cash $100 + zelle $80).
  - T9 (owner weekly query) reshaped: expected response is the
    three-line settlement block, not a single `SUM(cut_amount)`.
    Includes negative-case wording reference.
  - T17 added — cash-kept ACK present when `cash > 0`.
  - T18 added — no cash-kept callout when `cash == 0`.
  - T19 added — negative-net case uses the "Cash collected exceeds cut
    by $X — Aldo owes boss $X" wording.
  - T20 added — earned-only query (no "owed"/"debo" keyword) returns
    just the cut total, not the three-line block.

#### Data impact

- **No schema changes.** No new columns, no migrations, no backfill.
  The math is derived from the existing `cut_amount` and `cash_amount`
  columns at read time.
- The 12 existing rows in `~/locksmiths/aldo-cavanna/ledger.sqlite` are
  not affected. The new settlement math is computed over the same
  columns; running the canonical settlement query against the existing
  data immediately yields a correct `earned / cash_kept / net` triple.
- No `pending.jsonl` schema change.

#### Verification — exact negative-case wording

The negative-net summary line in the skill must read **exactly**:

```
Cash collected exceeds cut by $X — Aldo owes boss $X
```

(Em dash `—` between the two clauses. `$X` is the absolute difference
and identical in both halves.) Spanish:

```
El efectivo cobrado supera al corte por $X — Aldo le debe al dueño $X
```

T1's expected ACK in SPEC.md was updated to include `— you keep $100
cash` because the T1 example pays $100 cash + $80 zelle. Confirmed.

#### What is NOT done (intentional)

- No `npm run build` — pure data/docs/skill change.
- No service restart — the new skill is synced into the container on
  next spawn; the prior container was already killed.
- No container rebuild — Dockerfile unchanged.
- No commit.

#### Deviations from instructions

None. All eight locked decisions applied verbatim.

---

### Amendment 2026-06-19 — scheduler bootstrap dropped

Per user feedback ("on demand only for now"), the auto-creation of
weekly/monthly cron tasks is dropped from trial scope. Summaries are
produced only when the owner explicitly asks.

Doc/template fixes applied:
- `groups/prueba-tech-acc/CLAUDE.md` — Section 3 replaced from
  "Scheduler bootstrap (first invocation only)" with "Summaries — on
  demand only" (explicit "do NOT create scheduled cron tasks").
- `container/skills/locksmith-ledger/SKILL.md:576+` — "Scheduler
  bootstrap" section replaced with "Scheduling — do NOT auto-create
  cron tasks". Weekly/monthly markdown templates kept (still used
  on-demand). "Previous-month totals (for the monthly cron)" relabeled
  to "for on-demand monthly summaries".
- No DB rows to clean up — the agent never created any (the bootstrap
  never fired anyway).

Verification scenarios T1–T13 in SPEC.md remain valid. The cron-related
ones (would have been T14/T15 if listed) are simply out of trial scope
now.

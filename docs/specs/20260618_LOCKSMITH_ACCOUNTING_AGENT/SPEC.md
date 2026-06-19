# SPEC: Locksmith Accounting Agent (Aldo Cavanna trial)

Spec for the `Prueba tech acc` WhatsApp group. Companion to [CONTEXT.md](CONTEXT.md). Branch: `develop`.

---

## Amendments

### Amendment 2026-06-19 (3) — cash-kept settlement model

Business reality (locked):

- **Cash collected by the locksmith stays with the locksmith.** He pockets
  it on the spot. The boss never sees it.
- **Non-cash payments (Zelle / CashApp / Square) go straight to the boss.**
- Therefore the settlement when the boss pays the locksmith is:

  ```
  net_owed_by_boss = SUM(cut_amount) - SUM(cash_amount)
  ```

  - `net > 0` → boss owes locksmith that amount.
  - `net < 0` → locksmith collected more cash than his cut; locksmith
    owes boss the difference.

No schema change — the math is derived from existing `cut_amount` and
`cash_amount` columns.

**Per-job ACK.** When `cash_amount > 0`, append `— you keep $X cash` to
the ACK (Spanish: `— te quedas con $X en efectivo`). When `cash_amount
== 0`, do NOT append the clause. Same rule for the `✏️ UPDATED` ACK.

**Summaries (weekly / monthly, on-demand).** Both templates end with a
three-line settlement block:

```
• Cut earned this {period}: ${earned}
• Cash already kept by Aldo: ${cash_kept}
• Net the boss owes Aldo: ${net}
```

Negative-net case: replace the third line with the explicit phrasing
`• Cash collected exceeds cut by $X — Aldo owes boss $X` (absolute
value; both numbers identical and positive). Spanish mirror:
`• El efectivo cobrado supera al corte por $X — Aldo le debe al dueño $X`.

**Owner queries.** The "what do I owe Aldo" / "cuánto le debo" intent
and its variants answer with the three-line block (NOT just
`SUM(cut_amount)`). Distinguish:

- "earned cut" / "cut total" → just `SUM(cut_amount)`.
- "what do I owe" / "settlement" / "cuánto le debo" → three-line block.
- "cash kept" / "how much cash does Aldo have" → just `SUM(cash_amount)`.

**Canonical SQL** (returns all three numbers in one query):

```sql
SELECT
  COALESCE(SUM(cut_amount),  0) AS earned,
  COALESCE(SUM(cash_amount), 0) AS cash_kept,
  COALESCE(SUM(cut_amount) - SUM(cash_amount), 0) AS net
FROM jobs
WHERE job_timestamp >= :period_start
  AND job_timestamp <  :period_end;
```

**Per-job math note.** The settlement is **portfolio-wide, not per-job**
— no `net_owed` column on `jobs`. Always recompute on demand. Per-job
ACK only mentions the cash-kept clause when present; no per-job "you owe
boss $X" or "boss owes you $X" callouts.

See §5 (ACK template update), §6 (owner queries reshaped), §7 (summary
template update), and §14 (T1 expected updated; T9 reshaped; T17–T20
added) below.

### Amendment 2026-06-19 (2) — Confirmation gate dropped, ACK flow

The confirmation gate is gone. Behavior now:

- Job message with **all required fields** (`total_amount` > 0, `customer`,
  `provider`, payment breakdown summing to total within $0.01) → INSERT
  directly into `jobs` + send a one-line `✅ ACK / ...`. No "please confirm"
  prompt.
- Job message with **missing required fields** → do NOT insert. Append an
  `awaiting_details` row to `pending.jsonl` with `partial_extracted` and
  `missing_fields`, and ask only for what is missing in one line.
- Follow-up messages either (a) resolve an open `awaiting_details` row (merge
  + insert + ACK + mark `completed`), (b) update an already-stored recent
  job (UPDATE + recompute cut if total/provider changed + `✏️ UPDATED` ACK),
  or (c) are treated as a brand-new job.
- Pending statuses: `awaiting_details`, `completed`, `cancelled` (manual
  only — no auto-cancel recipe in trial scope).
- Legacy statuses (`awaiting`, `confirmed`, `rejected`) on existing pending
  rows remain as historical audit data; no new rows use them.
- No reporter allowlist — any sender in the group can act (trial is
  single-locksmith).

See revised §5 (ACK protocol) and §14 (verification scenarios) below.

### Amendment 2026-06-19 — scheduler bootstrap dropped

Auto-creation of weekly/monthly cron tasks is out of trial scope. Summaries
run on explicit request only.

### Amendment 2026-06-19 — cut percentages corrected

Mobile Locksmith = 30%, other providers = 35% (originally inverted in early
draft).

---

## 1. Overview

Add a per-group accounting agent for the `Prueba tech acc` WhatsApp group, scoped to a single locksmith (Aldo Cavanna) for the trial. Jarvis auto-processes every message (no `@Jarvis` trigger). On each message it does one of four things: (a) extract a completed-job report and reply with a parsed summary asking the **original sender** to confirm; (b) recognize a confirmation/edit/rejection from the original reporter and write/update the ledger; (c) answer an owner query against the ledger; (d) stay silent. Storage is SQLite at `~/locksmiths/aldo-cavanna/ledger.sqlite`, mounted into the container at `/workspace/extra/locksmiths/aldo-cavanna/ledger.sqlite`. Pending confirmations survive container restarts via `~/locksmiths/aldo-cavanna/pending.jsonl`. The owner asks queries in the same group. Cut rules live in `~/locksmiths/locksmiths.yaml`. Weekly (Sun 18:00) and monthly (1st 18:00) summaries are posted via cron tasks the agent self-creates on first invocation. The only shared-core code change is adding `sqlite3` to the container Dockerfile; everything else is data / per-group config.

---

## 2. Architecture

Per-message flow:

```
WhatsApp msg arrives (Prueba tech acc)
        │
        ▼
src/index.ts trigger gate
  requiresTrigger=false ⇒ bypass @Jarvis check
        │
        ▼
runContainerAgent() spawns or reuses container
  mounts: groups/prueba-tech-acc/, data/sessions/prueba-tech-acc/,
          /home/sborit/locksmiths → /workspace/extra/locksmiths (rw)
        │
        ▼
Agent reads (auto-loaded):
  /workspace/group/CLAUDE.md            (behavior)
  container skill: locksmith-ledger     (recipes)
        │
        ▼
Agent FIRST action every turn:
  1. cat /workspace/extra/locksmiths/aldo-cavanna/pending.jsonl
  2. Check: does this incoming msg resolve any `awaiting` pending row?
     (sender_jid == reporter_jid AND msg is confirm/edit/reject)
        │
   ┌────┴──────────────────────────────────────────────┐
   │                                                    │
   ▼                                                    ▼
Resolves a pending?                            Not a pending resolution
  → confirm:  INSERT into jobs, mark           Classify message:
              pending row 'confirmed'           a) Job report? (heuristic:
  → edit:     update pending fields,               total + 1 of {customer,
              re-prompt for confirm                ticket, address})
  → reject:   mark pending 'rejected',          b) Owner query?
              do NOT insert                     c) Neither → silent
  → ACK in group                                   │
                                                   ▼
                                            a) Extract → reply
                                                w/ markdown summary →
                                                append to pending.jsonl
                                                (status: awaiting)
                                            b) Run SQL → reply w/ result
                                            c) Return no output
        │
        ▼
On first invocation in this group:
  Check via IPC list if locksmith weekly+monthly cron tasks exist.
  If not, create them (IPC create_task).
```

Confirmation-survival design: container can die before locksmith replies (30-min idle timeout). Pending state is held on the **host-mounted** `pending.jsonl`, not in the agent's session memory. Any subsequent message in the group spawns a new container which reads `pending.jsonl` on its very first step.

---

## 3. SQLite Schema

The agent creates the DB idempotently on first write. Schema (executed via `sqlite3` CLI from the container skill recipes):

```sql
PRAGMA user_version = 1;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS jobs (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket               TEXT,
  customer             TEXT,
  phone                TEXT,
  address              TEXT,
  description          TEXT,
  notes                TEXT,
  provider             TEXT NOT NULL,                 -- as reported (free text)
  provider_normalized  TEXT NOT NULL,                 -- canonical key (see §4)
  total_amount         REAL NOT NULL CHECK (total_amount >= 0),
  cash_amount          REAL NOT NULL DEFAULT 0 CHECK (cash_amount >= 0),
  zelle_amount         REAL NOT NULL DEFAULT 0 CHECK (zelle_amount >= 0),
  cashapp_amount       REAL NOT NULL DEFAULT 0 CHECK (cashapp_amount >= 0),
  square_amount        REAL NOT NULL DEFAULT 0 CHECK (square_amount >= 0),
  cut_percent          REAL NOT NULL,                 -- snapshot at insert time
  cut_amount           REAL NOT NULL,                 -- total_amount * cut_percent/100
  job_timestamp        TEXT NOT NULL,                 -- ISO8601, from WA msg ts
  message_id           TEXT,                          -- WhatsApp source msg id
  reported_by_jid      TEXT NOT NULL,                 -- sender JID of the report
  reported_by_name     TEXT,                          -- sender display name
  confirmed_at         TEXT NOT NULL,                 -- ISO8601
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS jobs_ts_idx
  ON jobs (job_timestamp);
CREATE INDEX IF NOT EXISTS jobs_provider_idx
  ON jobs (provider_normalized);
CREATE INDEX IF NOT EXISTS jobs_message_id_idx
  ON jobs (message_id);
```

Notes:
- `cut_percent`/`cut_amount` are **snapshotted at insert** so retroactively editing `locksmiths.yaml` does not change historical books.
- Payment-method sum integrity is enforced by the agent (not a CHECK constraint), tolerance $0.01.
- `summaries` table is **not** created — summaries are computed on the fly from `jobs`.
- Idempotency: `sqlite3 ... <<'SQL' CREATE TABLE IF NOT EXISTS ... SQL` is safe to run on every insert.

---

## 4. `locksmiths.yaml` Schema

Location: `~/locksmiths/locksmiths.yaml` → in container: `/workspace/extra/locksmiths/locksmiths.yaml`. Editable on host by the owner.

```yaml
version: 1
locksmiths:
  - name: Aldo Cavanna
    slug: aldo-cavanna
    group_jid: REPLACE_AFTER_REGISTRATION   # 120363...@g.us
    group_folder: prueba-tech-acc
    currency: USD
    # First matching rule wins. Default rule must use "*".
    cut_rules:
      - provider_match: mobile_locksmith
        cut_percent: 30
      - provider_match: "*"
        cut_percent: 35
```

### Provider normalization rule

Free-text `provider` from the message is normalized as follows before matching against `provider_match`:

1. Lowercase.
2. Strip leading/trailing whitespace.
3. Replace any run of non-alphanumeric characters with a single `_`.
4. Trim leading/trailing `_`.
5. Apply alias map:
   - `ml`, `mobile`, `mobilelocksmith`, `mobile_locksmith` → `mobile_locksmith`
   - everything else → keep result of steps 1-4.

Examples:
- `"Mobile Locksmith"` → `mobile_locksmith` → matches rule 1 → 30%
- `"ML"` → `mobile_locksmith` → matches rule 1 → 30%
- `"Google Ads"` → `google_ads` → matches `"*"` → 35%
- `"Yelp"` → `yelp` → matches `"*"` → 35%

The normalized value is stored in `jobs.provider_normalized`. The raw value is stored in `jobs.provider`.

`provider_match: "*"` is the default; exactly one default rule is required and must appear last.

---

## 5. ACK Protocol (no confirmation gate)

### 5.1 Job-report detection (conservative)

The agent treats an incoming message as a job report when it describes a
completed job — typically containing a numeric total AND/OR at least one of
{customer, ticket, address, provider}.

Pure chatter / greetings / photos / ambiguous noise → silent.

### 5.2 Required-fields gate

A job is **accounting-complete** and goes directly into `jobs` only if ALL
of:

1. `total_amount` — numeric, > 0.
2. `customer` — non-empty.
3. `provider` — non-empty (raw text; the skill normalizes).
4. Payment breakdown — `cash_amount + zelle_amount + cashapp_amount + square_amount == total_amount`
   within $0.01.

Optional (stored as null/empty if absent): `ticket`, `phone`, `address`,
`description`, `notes`.

### 5.3 Complete-job path: INSERT + ACK

When the gate passes:

1. Init the ledger schema if needed.
2. Snapshot `cut_percent` / `cut_amount` from the current YAML
   (Mobile Locksmith aliases → 30%, otherwise default 35%).
3. INSERT into `jobs`.
4. Reply with the one-line **ACK**:

```
✅ ACK / {customer} / ${total} / {provider} / {payment_breakdown}
```

`{payment_breakdown}` lists non-zero methods only, joined with ` + `:

- `zelle $245`
- `cash $100 + zelle $80`
- `cash $40 + zelle $50 + cashapp $30 + square $60`

Currency: `$<int>` if total is whole, `$<n>.<dd>` otherwise. Provider in the
ACK is the **raw original text** (e.g. "Mobile Locksmith", "Yelp"), not the
normalized slug.

Spanish mirror: same one-line shape (the form is universal).

### 5.4 Missing-fields path: `awaiting_details` + one-liner ask

When the gate fails:

1. Do NOT insert into `jobs`.
2. Append a row to `pending.jsonl` with:

```json
{
  "id": "<msg-id>",
  "status": "awaiting_details",
  "reporter_jid": "<jid-if-available>",
  "reporter_name": "<name>",
  "partial_extracted": { /* what was extracted so far */ },
  "missing_fields": ["customer", "provider"],
  "created_at": "<iso>",
  "resolved_at": null
}
```

3. Reply with one line, asking ONLY for what is missing. Examples:
   - Missing total: `❓ Total amount? (and payment method breakdown if mixed)`
   - Missing customer: `❓ Customer name?`
   - Missing breakdown (have total): `❓ How was the $180 paid? (cash / zelle / cashapp / square or mix)`
   - Missing provider: `❓ Provider? (Mobile Locksmith / other)`
   - Several missing: `❓ Missing: customer, total amount, provider.`

### 5.5 Follow-up resolution

When a message is not a complete new job, the agent picks the matching path:

**A. Resolves a pending `awaiting_details`.** Reporter sent the missing
info (or a clear subset of it). Merge into `partial_extracted`, re-evaluate
the gate. If complete → INSERT + ACK + mark pending `completed` with
`resolved_at`. If still incomplete → update fields + re-ask only what
remains. Prefer the **most recent** open row for that reporter; if multiple
are open and ambiguous, ask which one.

**B. Updates an already-stored recent job.** Signals: explicit reference
("the one for Juan", "el último"), ticket number match, or a clear
value-correction phrasing on a value from the most recent job. Action:
UPDATE the target row (ticket match preferred, else most-recent). If
`total_amount` or `provider` changed, recompute and update `cut_percent` +
`cut_amount` against the **current** YAML. Re-ACK with the **UPDATE**
prefix:

```
✏️ UPDATED / {customer} / ${total} / {provider} / {payment_breakdown}
```

**C. Looks like a new job.** Re-enter §5.2 / §5.3 / §5.4.

### 5.6 Reporter identification

Use `sender_jid` as the primary key for matching against
`reporter_jid` in pending rows. Fall back to `sender_name` if JID is
missing. No allowlist — any group member's messages are accepted.

### 5.7 Pending statuses & audit

- `awaiting_details` — open, asked for missing info.
- `completed` — merged + inserted; `resolved_at` set.
- `cancelled` — out of trial scope; if the operator says "cancel that",
  handle ad-hoc (manual SQL/jq), do NOT implement an auto-cancel recipe.

All pending rows remain on disk forever as audit trail. Legacy
`awaiting` / `confirmed` / `rejected` rows from the prior design are not
touched.

---

## 6. Owner Queries

The agent detects owner-query intent purely by text content (the owner is in the same group; no sender allowlist for the trial — see Risks §16).

| Intent | Trigger keywords (any language) | SQL | Response |
|---|---|---|---|
| Weekly owed | "owe", "debo", "esta semana", "this week" + "aldo" | `SELECT SUM(cut_amount), COUNT(*), SUM(total_amount) FROM jobs WHERE job_timestamp >= date('now','weekday 0','-7 days')` | "Esta semana Aldo hizo N trabajos (revenue $X). Le debes $Y." |
| Monthly owed | "this month", "este mes" | `... WHERE job_timestamp >= date('now','start of month')` | Same shape, monthly window. |
| Since-date owed | "since YYYY-MM-DD", "desde YYYY-MM-DD" | `... WHERE job_timestamp >= '<date>'` | Same shape, custom window. |
| Job count | "how many", "cuántos" | `SELECT COUNT(*) FROM jobs WHERE ...` | "Aldo hizo N trabajos en {window}." |
| Last N jobs | "last N", "últimos N" | `SELECT * FROM jobs ORDER BY job_timestamp DESC LIMIT N` | Markdown table: ticket, customer, total, cut, fecha. |
| Payment-method breakdown | "breakdown", "desglose", "por método" | `SELECT SUM(cash_amount), SUM(zelle_amount), SUM(cashapp_amount), SUM(square_amount) FROM jobs WHERE ...` | Markdown bullet list per method with totals and percentages. |

Generic response format for weekly-owed (used as template):

```
📊 Aldo — semana del {start} al {end}
• Trabajos:   {N}
• Revenue:    ${total}
• Por método:
   - Efectivo: ${cash}
   - Zelle:    ${zelle}
   - CashApp:  ${cashapp}
   - Square:   ${square}
• Corte Aldo: ${cut_total}  (ML: ${cut_ml}, otros: ${cut_other})
• Le debes:   ${owed}
```

Ambiguous queries → ask for clarification, do not guess.

---

## 7. Weekly + Monthly Summary Format

Posted by the cron task. Same SQL family as §6 but agent-initiated.

### Weekly (Sunday 18:00 local, cron `0 18 * * 0`)

```
🧾 Resumen semanal — Aldo Cavanna
Período: {YYYY-MM-DD} → {YYYY-MM-DD}

• Trabajos: {N}
• Revenue total: ${total}
• Por método de pago:
   - Efectivo: ${cash} ({cash_pct}%)
   - Zelle:    ${zelle} ({zelle_pct}%)
   - CashApp:  ${cashapp} ({cashapp_pct}%)
   - Square:   ${square} ({square_pct}%)

• Corte locksmith (Aldo):
   - Mobile Locksmith (30%): ${cut_ml}
   - Otros (35%):            ${cut_other}
   - Total corte:            ${cut_total}

• Lo que el dueño le debe a Aldo esta semana: ${owed}

{if stale pending exist:}
⚠️ Trabajos sin confirmar (>7 días): {list ticket/customer}
```

### Monthly (1st of month 18:00, cron `0 18 1 * *`)

Same layout, swap "semanal" → "mensual" and the period to the **previous calendar month**. SQL window: `job_timestamp >= date('now','start of month','-1 month') AND job_timestamp < date('now','start of month')`.

---

## 8. Container Skill — `container/skills/locksmith-ledger/SKILL.md`

Instruction-only skill. Synced automatically on every container run. Loaded by the agent SDK as a normal Claude Code skill.

### Required content

```markdown
---
name: locksmith-ledger
description: Read/write the per-locksmith SQLite ledger for the Prueba tech acc group.
  Use whenever extracting, confirming, or summarizing locksmith jobs. Provides Bash
  recipes for schema init, insert, update, list pending, totals, and cut calculation.
---

# locksmith-ledger

## File locations (Aldo Cavanna trial)

- Ledger: `/workspace/extra/locksmiths/aldo-cavanna/ledger.sqlite`
- Config: `/workspace/extra/locksmiths/locksmiths.yaml`
- Pending: `/workspace/extra/locksmiths/aldo-cavanna/pending.jsonl`

## Schema (idempotent — safe to run every time)

[CREATE TABLE statements from §3]

Run via:

    sqlite3 /workspace/extra/locksmiths/aldo-cavanna/ledger.sqlite <<'SQL'
    [statements]
    SQL

## Recipes

### Init the DB (safe on every write)
[bash recipe]

### Insert a confirmed job
[bash recipe with parameter substitution]

### List awaiting pending rows
    jq -c 'select(.status=="awaiting")' /workspace/extra/locksmiths/aldo-cavanna/pending.jsonl

### Update pending status (rewrite file)
    jq -c '... | if .id=="X" then .status="confirmed" else . end ...' ...

### Weekly totals
[bash recipe with SQL from §6]

### Cut calculation
Read `cut_rules` from YAML (via `yq` or grep-based parsing) and apply first-match.
If yq is unavailable, parse YAML with awk fallback (provide one-liner).

## Provider normalization
[steps from §4]

## Confirmation protocol
[reference §5]

## Tone
Concise. Reply in the same language as the incoming message. No emojis except the section headers in §5/§7 markdown.
```

The skill is purely operational documentation — no executable code files.

---

## 9. Group `CLAUDE.md` — `groups/prueba-tech-acc/CLAUDE.md`

```markdown
# Prueba tech acc — Locksmith Accounting (Aldo Cavanna)

**Mode:** every message in this group is auto-processed (no @Jarvis trigger).
You are the locksmith accounting agent for **Aldo Cavanna** (slug: `aldo-cavanna`).

**Language:** reply in the same language as the incoming message. The locksmith
writes in Spanish — default to Spanish if ambiguous.

## On every message — do this in order

1. **Read pending state.** `cat /workspace/extra/locksmiths/aldo-cavanna/pending.jsonl`
   if the file exists. Look for `awaiting` rows where `reporter_jid` matches the
   current sender JID. If the current message is a confirm/edit/reject of one of
   those rows, resolve it per the `locksmith-ledger` skill (§5) and STOP.

2. **Classify the new message:**
   a. **Job report?** It must have a numeric total AND at least one of
      {customer, ticket, address}. If yes → extract fields, reply with the
      confirmation markdown (skill §5.2), append a new row to `pending.jsonl`
      with status `awaiting`. Do NOT write to the ledger yet.
   b. **Owner query?** Detect intents in §6 of the skill. Run the SQL, reply
      with the markdown.
   c. **Neither?** Stay silent. Do not greet, do not acknowledge.

3. **Scheduler bootstrap (first invocation only).** If no cron tasks exist for
   this group with prompts containing "locksmith summary", create two via IPC:
   - Weekly: `schedule_type=cron`, `schedule_value='0 18 * * 0'`,
     prompt: "Post the weekly locksmith summary for Aldo Cavanna in this group."
   - Monthly: `schedule_type=cron`, `schedule_value='0 18 1 * *'`,
     prompt: "Post the previous month's locksmith summary for Aldo Cavanna in this group."
   Use the IPC task-creation contract documented in `container/skills/locksmith-ledger/`.

## Confirmation rules

- Only the **original reporter** of a job can confirm/edit/reject that job.
  Messages from anyone else mentioning a pending job are ignored for confirmation
  purposes (but may still be classified as owner queries).
- Confirm words (any of): `confirmar`, `confirm`, `sí`, `si`, `yes`, `ok`, 👍
- Reject words (any of): `no`, `rechazar`, `reject`, `cancelar`, `cancel`
- Anything else from the reporter while a pending row exists → treat as
  corrections, update `extracted`, re-prompt.

## Owner query rules

- The owner asks in this same group. No sender allowlist for the trial.
- See skill §6 for the intent table and SQL.

## Tone

Concise. Polite. No filler. Mirror the message's language. No emojis except
the markdown section headers defined by the skill.

## Skill

Use the `locksmith-ledger` container skill for all ledger operations,
schema init, normalization, and SQL recipes.
```

---

## 10. Registration Script — `scripts/register-prueba-tech-acc.ts`

Pattern: copy `scripts/register-zellyt-bot.ts`.

```typescript
/**
 * Register the Prueba tech acc WhatsApp group once JID is known.
 *
 * Usage:
 *   1. Ensure NanoClaw is running.
 *   2. Send any message to the "Prueba tech acc" WhatsApp group.
 *   3. Find JID in logs/nanoclaw.log (look for 120363...@g.us).
 *   4. Run: npx tsx scripts/register-prueba-tech-acc.ts <JID>
 *   5. Restart NanoClaw to pick up the registration.
 */
import { setRegisteredGroup, initDatabase } from '../src/db.js';
import type { RegisteredGroup } from '../src/types.js';

const jid = process.argv[2];
if (!jid) {
  console.error('Usage: npx tsx scripts/register-prueba-tech-acc.ts <JID>');
  process.exit(1);
}

initDatabase();

const group: RegisteredGroup = {
  name: 'Prueba tech acc',
  folder: 'prueba-tech-acc',
  trigger: '@Jarvis',           // ignored because requiresTrigger=false
  added_at: new Date().toISOString(),
  requiresTrigger: false,        // auto-process every message
  containerConfig: {
    additionalMounts: [
      {
        hostPath: '/home/sborit/locksmiths',
        containerPath: 'locksmiths',
        readonly: false,
      },
    ],
  },
};

setRegisteredGroup(jid, group);

console.log('Registered Prueba tech acc group:');
console.log(`  JID: ${jid}`);
console.log(`  Folder: groups/${group.folder}/`);
console.log(`  Trigger: auto (requiresTrigger=false)`);
console.log(`  Mount: /home/sborit/locksmiths -> /workspace/extra/locksmiths (rw)`);
```

### Model recommendation

**Use `claude-sonnet-4-5`** (per `CLAUDE.md` valid values: `claude-opus-4-5` | `claude-sonnet-4-5` | `claude-haiku-4-5`). Justification:
- Job extraction + free-text classification benefits from Sonnet-class reasoning; Haiku risks misclassifying multi-line Spanish job reports.
- Opus is overkill for the call shapes here (SQL, JSON, short markdown replies) and 3-4× more expensive per token.
- Sonnet matches existing peer groups (`Ventas Dimitris` uses Sonnet for comparable extract-and-write workflows).

Pre-create `data/sessions/prueba-tech-acc/.claude/settings.json`:

```json
{
  "model": "claude-sonnet-4-5",
  "env": {}
}
```

(If the user prefers Opus, only this file changes; nothing else in the spec depends on the choice.)

### JID capture — explicit step

The `Prueba tech acc` group's JID is **not yet known** (CONTEXT.md §1). The plan therefore **pauses** at the registration chunk until the user does:

1. Make sure NanoClaw is running (`systemctl --user status nanoclaw`).
2. Send any message (e.g., "test") in the `Prueba tech acc` group.
3. Capture JID: `grep -E "@g.us.*Prueba tech acc|Prueba tech acc.*@g.us" /home/sborit/prj/nanoclaw/logs/nanoclaw.log | tail -5` — or read recent unrecognized-group log entries.
4. Run `npx tsx scripts/register-prueba-tech-acc.ts 120363xxxx@g.us`.
5. Also write that JID into `~/locksmiths/locksmiths.yaml` under `group_jid`.
6. Restart NanoClaw.

---

## 11. Dockerfile Change

Single-line addition to `container/Dockerfile`. Append `sqlite3` to the existing `apt-get install -y` list (and `jq` if not already present — needed for `pending.jsonl` manipulation; verify by reading the Dockerfile during implementation).

Build-cache caveat (per `CLAUDE.md`):

```bash
# Prune builder volume so the new apt-get install line is honored.
docker buildx prune -f
# OR equivalent for the runtime in use.
./container/build.sh
```

**Verify** post-rebuild:

```bash
docker run --rm <nanoclaw-agent-image> sqlite3 --version
docker run --rm <nanoclaw-agent-image> jq --version
```

---

## 12. Host Folder Seeding

Run on the host before container rebuild (no SQLite DB created — the agent inits it on first write):

```bash
mkdir -p /home/sborit/locksmiths/aldo-cavanna
touch /home/sborit/locksmiths/aldo-cavanna/pending.jsonl
```

Write `/home/sborit/locksmiths/locksmiths.yaml` with the §4 schema (placeholder `group_jid: REPLACE_AFTER_REGISTRATION`).

The mount allowlist (`~/.config/nanoclaw/mount-allowlist.json`) already permits `/home/sborit` with `allowReadWrite: true` (CONTEXT.md §3), so no allowlist edit is required.

---

## 13. Step-by-Step Implementation Plan

Each chunk = orchestrator delegation unit. Exit criteria per step.

### Chunk A — Foundations (container + host data)

A1. **Add `sqlite3` (and verify `jq`) to `container/Dockerfile`.**
   - Files: `container/Dockerfile`
   - Acceptance: diff shows `sqlite3 \` added to the `apt-get install -y` line. `jq` either already present or added.

A2. **Prune builder + rebuild container.**
   - Commands: `docker buildx prune -f && ./container/build.sh` (or the equivalent for the active runtime).
   - Acceptance: `docker run --rm <image> sqlite3 --version` prints a version. Same for `jq`.

A3. **Seed `~/locksmiths/` host folder.**
   - Files: `/home/sborit/locksmiths/locksmiths.yaml`, `/home/sborit/locksmiths/aldo-cavanna/pending.jsonl` (empty).
   - Acceptance: `ls -la /home/sborit/locksmiths/aldo-cavanna/` shows both files. YAML parses with `yq . locksmiths.yaml` (or `python -c 'import yaml; yaml.safe_load(open("..."))'`).

### Chunk B — Skill + group config

B1. **Create `container/skills/locksmith-ledger/SKILL.md`** per §8.
   - Files: `container/skills/locksmith-ledger/SKILL.md`
   - Acceptance: file exists, frontmatter valid (`name`, `description`), contains all recipes and §5 references.

B2. **Create `groups/prueba-tech-acc/CLAUDE.md`** per §9.
   - Files: `groups/prueba-tech-acc/CLAUDE.md` (the directory may not exist yet — create it).
   - Acceptance: file exists, contains the full behavioral spec.

B3. **Pre-create `data/sessions/prueba-tech-acc/.claude/settings.json`** with the model choice.
   - Files: `data/sessions/prueba-tech-acc/.claude/settings.json`
   - Acceptance: valid JSON, `model` is `claude-sonnet-4-5` (or owner's chosen value).

### Chunk C — Registration (PAUSE for JID)

C1. **Write `scripts/register-prueba-tech-acc.ts`** per §10.
   - Files: `scripts/register-prueba-tech-acc.ts`
   - Acceptance: file exists, mirrors `scripts/register-zellyt-bot.ts` structure, `requiresTrigger: false`, correct `additionalMounts`.

C2. **Capture JID (manual; user-driven).**
   - Acceptance: JID known and copied into both the registration command and `~/locksmiths/locksmiths.yaml`.

C3. **Run registration + restart NanoClaw.**
   - Commands: `npx tsx scripts/register-prueba-tech-acc.ts <JID>` then `systemctl --user restart nanoclaw`.
   - Acceptance: row appears in `registered_groups` table for the JID; `tail logs/nanoclaw.log` shows the group recognized on next message.

### Chunk D — Smoke + scheduler bootstrap

D1. **Send a test job report in the group.**
   - Acceptance: agent replies with §5.2 markdown. `pending.jsonl` has one new `awaiting` row.

D2. **Send "confirmar" from the reporter.**
   - Acceptance: agent replies with one-line ACK. `ledger.sqlite` exists. `sqlite3 ~/locksmiths/aldo-cavanna/ledger.sqlite "SELECT * FROM jobs;"` returns the row with correct `cut_percent`/`cut_amount`. `pending.jsonl` row status flipped to `confirmed`.

D3. **Verify scheduler bootstrap.**
   - Commands: `sqlite3 store/messages.db "SELECT id, group_folder, schedule_type, schedule_value, prompt FROM scheduled_tasks WHERE group_folder='prueba-tech-acc';"`
   - Acceptance: two cron rows: `0 18 * * 0` (weekly) and `0 18 1 * *` (monthly).

D4. **Smoke the cron without waiting.** Create a one-off task via IPC scheduled for `now + 2min` with the weekly-summary prompt.
   - Acceptance: at the scheduled time, the agent posts a summary in the group. SQL totals match manual `sqlite3` query.

---

## 14. Test Criteria

Mark complete on the trial when all of the following hold. Each row is a verifiable scenario.

- [ ] **T1. Happy path — complete job.** Aldo sends a complete job ("Cliente Juan Pérez, ticket 4521, dirección X, total $180 efectivo $100 zelle $80, proveedor Mobile Locksmith"). Agent replies with the one-line `✅ ACK / Juan Pérez / $180 / Mobile Locksmith / cash $100 + zelle $80 — you keep $100 cash` (Spanish mirror: `— te quedas con $100 en efectivo`). No "please confirm" step. `SELECT * FROM jobs` shows the row with `cut_percent=30`, `cut_amount=54.0`, `cash_amount=100`, `zelle_amount=80`.
- [ ] **T2. Mixed payment integrity.** Same as T1; verify `cash_amount + zelle_amount + cashapp_amount + square_amount == total_amount` (tolerance $0.01). ACK payment string lists both non-zero methods.
- [ ] **T3. Non-ML provider → 35%.** Complete job with `proveedor Yelp`, total $200. Agent INSERTs + ACKs immediately. `cut_percent=35`, `cut_amount=70.0`.
- [ ] **T4. Provider alias.** Complete job with `proveedor ML`. INSERTed immediately with `provider_normalized='mobile_locksmith'`, cut 30%. ACK shows raw provider as "ML".
- [ ] **T5. Cancellation (out of trial scope).** Agent has no auto-cancel recipe. If the locksmith says "cancel that", handle ad-hoc by manual SQL/jq. Skip during trial.
- [ ] **T6. Corrections via follow-up update.** A complete job is stored (e.g. Juan, $180 Mobile Locksmith zelle). Locksmith follows up with "el total es 200 no 180". Agent runs `UPDATE jobs SET total_amount=200, cut_amount=60.00 WHERE id=<last>`, re-ACKs with `✏️ UPDATED / Juan / $200 / Mobile Locksmith / zelle $200`. (Payment breakdown adjusted to the new total per the ask flow if the breakdown is ambiguous; otherwise carry forward.)
- [ ] **T7. Survives container restart.** Locksmith sends an incomplete job (triggers `awaiting_details`). Force-kill the container. Locksmith follows up with the missing info. Resolution still works (pending row was on host). Expected pending row status before follow-up: `awaiting_details`.
- [ ] **T9. Owner weekly query (settlement).** Owner asks "cuánto le debo a Aldo esta semana?" / "what do I owe Aldo this week?". Response is the **three-line settlement block** (earned cut, cash already kept, net the boss owes), not a single `SUM(cut_amount)`. Numbers match the canonical settlement SQL (`earned`, `cash_kept`, `net = earned - cash_kept`) over `[date('now','weekday 0','-7 days'), date('now','+1 day'))`. If `net < 0`, the third line uses the "Cash collected exceeds cut by $X — Aldo owes boss $X" wording.
- [ ] **T10. Owner method breakdown.** Owner asks "desglose por método". Response matches `SELECT SUM(cash_amount), SUM(zelle_amount), ...` for the week.
- [ ] **T11. Last N.** Owner asks "últimos 5 trabajos". Response is a markdown table of 5 most recent jobs.
- [ ] **T12. Silent on chatter.** "buenos días" → no agent reply, no pending row, no `jobs` row.
- [ ] **T13. Silent on photo only.** A picture with no caption → no reply.
- [ ] **T14. Incomplete extract → ask for missing only.** Locksmith sends "Lockout $180 cash" (no customer, no provider). Agent does NOT insert into `jobs`. Appends an `awaiting_details` row to `pending.jsonl` with `partial_extracted` containing the parsed total/payment and `missing_fields: ["customer","provider"]`. Replies with one line: `❓ Missing: customer, provider.`
- [ ] **T15. Follow-up resolves pending.** Continuation of T14. Locksmith sends "Cliente Juan, proveedor Mobile Locksmith". Agent merges into the open `awaiting_details` row, re-evaluates the gate (now passes), INSERTs into `jobs` with snapshot `cut_percent=30` / `cut_amount=54.00`, sends `✅ ACK / Juan / $180 / Mobile Locksmith / cash $180`. Pending row updated to `status: "completed"` with `resolved_at` set.
- [ ] **T16. Cut snapshot survives YAML edit.** After T1, edit `locksmiths.yaml` to change ML cut to 40%. Re-run weekly summary. T1's row keeps `cut_amount=54.0` (snapshot), but new jobs use 40%.
- [ ] **T17. Cash-kept ACK.** Job with `total=$180` paid as `cash $100 + zelle $80` (provider Mobile Locksmith). Agent's ACK ends with `— you keep $100 cash` (English) or `— te quedas con $100 en efectivo` (Spanish). The cash-kept clause is present because `cash_amount > 0`.
- [ ] **T18. No cash, no callout.** Job with `total=$245` paid as `zelle $245` (no cash). Agent's ACK is `✅ ACK / {customer} / $245 / {provider} / zelle $245` with **no** `— you keep` suffix. The clause is omitted because `cash_amount == 0`.
- [ ] **T19. Negative net.** Construct a state where `SUM(cut_amount) < SUM(cash_amount)` over the week (e.g. several jobs paid entirely in cash so cash kept exceeds the locksmith's cut). Owner asks the weekly settlement query. The three-line block's third line uses the **`Cash collected exceeds cut by $X — Aldo owes boss $X`** wording (Spanish: `El efectivo cobrado supera al corte por $X — Aldo le debe al dueño $X`), with `$X` as the absolute difference. The "Net the boss owes Aldo" line is NOT used.
- [ ] **T20. Earned-only query.** Owner asks "how much did Aldo earn this week?" / "cuánto ganó Aldo esta semana?" (no "owed"/"debo" keyword). Response is **just the cut total** (`SUM(cut_amount)`) — a single line like "Aldo earned $X this week." No cash-kept line. No net line. The full three-line block is reserved for explicit settlement/owed queries.

---

## 15. Verification Plan (developer-driven; no DEPLOY.md)

NanoClaw has no DEPLOY.md, so verification is a mix of code-level checks and a live-WhatsApp checklist.

### 15.1 Code-level

```bash
# From repo root
npm run build                          # must pass
sqlite3 --version                      # host has sqlite3 (sanity)
docker run --rm <agent-image> sqlite3 --version  # container has sqlite3
docker run --rm <agent-image> jq --version       # container has jq
yq . /home/sborit/locksmiths/locksmiths.yaml     # YAML parses
```

### 15.2 Manual checklist (perform in the live `Prueba tech acc` group)

In this order:

1. **JID capture (Chunk C2)** — send "test" → grep logs → record JID.
2. **Registration (Chunk C3)** — run script → restart NanoClaw → tail logs.
3. **T1 happy path** — send the canonical Mobile Locksmith job → expect §5.2 markdown.
   - SQL check: `sqlite3 ~/locksmiths/aldo-cavanna/ledger.sqlite "SELECT id,total_amount,cut_percent,cut_amount FROM jobs ORDER BY id DESC LIMIT 1;"`
4. **T3 non-ML provider** — send "Yelp" job → confirm → SQL check `cut_percent=30`.
5. **T4 alias** — send "ML" job → confirm → SQL check `provider_normalized='mobile_locksmith'`.
6. **T5 rejection** — send job → reply `no` → SQL check no new row.
7. **T6 corrections** — send job → send correction → confirm → SQL check final values.
8. **T7 restart survival** — send job → `systemctl --user restart nanoclaw` → wait 1 min → send `confirmar` → SQL check.
9. **T8 wrong-sender confirm** — second person sends `confirmar` → no DB write; original reporter then confirms → DB write.
10. **T9 weekly owed query** — owner asks → cross-check with:
    `sqlite3 ~/locksmiths/aldo-cavanna/ledger.sqlite "SELECT SUM(cut_amount) FROM jobs WHERE job_timestamp >= date('now','weekday 0','-7 days');"`
11. **T10 breakdown.**
12. **T11 last 5.**
13. **T12-T14 silent cases.**
14. **T15 cron smoke** — write a one-off IPC task (commands below) → wait 2 min → see summary posted.
15. **Scheduler-table check.**
    `sqlite3 store/messages.db "SELECT schedule_value, prompt FROM scheduled_tasks WHERE group_folder='prueba-tech-acc';"` — expect 2 rows.

### 15.3 Cron-without-waiting recipe (for T15)

Write an IPC task creation JSON for "now + 2 minutes":

```bash
NOW_PLUS_2=$(date -u -d '+2 minutes' '+%Y-%m-%dT%H:%M:%SZ')
cat > /home/sborit/prj/nanoclaw/data/ipc/prueba-tech-acc/tasks/test-summary-$(date +%s).json <<EOF
{
  "type": "create_task",
  "schedule_type": "once",
  "schedule_value": "$NOW_PLUS_2",
  "context_mode": "group",
  "prompt": "Post the weekly locksmith summary for Aldo Cavanna in this group.",
  "chat_jid": "REPLACE_WITH_GROUP_JID",
  "group_folder": "prueba-tech-acc"
}
EOF
```

(Exact IPC field names: confirm against `src/ipc.ts:157` during implementation. If `schedule_value` for `once` must be an epoch ms instead of ISO, adjust.)

---

## 16. Risks and Open Questions

| # | Risk / Question | Mitigation |
|---|---|---|
| R1 | Owner-query intent detection in free-form Spanish chat is noisy. Could misinterpret a job description as a query. | Conservative classifier: only treat as query when the message lacks numeric totals AND has explicit query verbs. Otherwise prefer "silent". |
| R2 | Two `awaiting` pending rows for the same reporter at the same time → ambiguous confirm. | Skill §5.5 requires the agent to ask which ticket. Add a hard cap of 1 awaiting per reporter? — not enforced for the trial. |
| R3 | If Aldo is in the same group, "owe Aldo" is technically askable by Aldo himself. Trial accepts this; future hardening should restrict owner-query intents to specific JIDs. | Note in `groups/prueba-tech-acc/CLAUDE.md` post-trial. |
| R4 | YAML edit race: owner edits `locksmiths.yaml` mid-extraction. Snapshot semantics already mitigate (cuts frozen on confirm). | Documented in §3 and T16. |
| R5 | `pending.jsonl` corruption (e.g., partial write on host crash) breaks all future invocations. | Skill recipe must read line-by-line and skip malformed lines with a logged warning; the agent must not abort. Document in skill. |
| R6 | The IPC task-creation contract for `once` vs `cron` is not fully verified in this spec (cron is — `src/task-scheduler.ts:36-39`; `once` schedule_value format needs confirmation). | Implementation step D3/D4 verifies live; if format differs, update skill and T15 recipe. |
| R7 | Build-cache: missing the prune step silently produces a container without `sqlite3`. | Step A2 explicitly prunes and verifies with `docker run --rm <image> sqlite3 --version` before proceeding. |
| R8 | Cron timezone: `cron-parser` honors system `TIMEZONE`. If host TZ is UTC, "Sunday 18:00" is UTC 18:00 not local. | Verify `echo $TIMEZONE` / `date` on host during D3; document in plan if non-local. |
| R9 | Language detection — agent must reply in Spanish when message is Spanish, English when English. Sonnet handles this reliably but it's worth explicit testing. | Add a bilingual test message to the manual checklist if owner uses English. |
| O1 | Should the agent edit the YAML on its own (e.g., when the owner says "change Aldo's cut to 40%")? | **No for trial.** YAML is host-edited only. Document this. |
| O2 | Should stale-pending (>7 days awaiting) auto-reject? | **No for trial.** Just flagged in weekly summary. |
| O3 | Currency. YAML declares `USD`. All amounts assumed USD. No conversion. | OK for trial. |

---

## 17. Out of Scope (Trial)

- Multiple locksmiths in the same group (only Aldo Cavanna).
- Multiple locksmiths in separate groups (only `Prueba tech acc`).
- Cross-locksmith / passive-income aggregation across owners.
- Cross-group owner queries (owner asks in `Jarvis-Agenda` about Aldo). Owner asks in the same group only.
- OneCLI gateway changes.
- UI / web dashboard.
- CSV / Excel export.
- Reporting outside the group (email, push, etc.).
- Editing `locksmiths.yaml` from within the chat.
- Auto-rejection of stale pending rows.
- Per-job line items (each job is one row; no breakdown of parts/labor).
- Tax / invoice generation.
- Backups / replication of `~/locksmiths/`.

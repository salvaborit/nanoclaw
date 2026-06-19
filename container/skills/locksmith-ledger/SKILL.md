---
name: locksmith-ledger
description: Read/write the per-locksmith SQLite ledger for the Prueba tech acc group. Use whenever extracting, ACKing, updating, or summarizing locksmith jobs. Provides Bash recipes for schema init, insert, update, pending follow-ups, totals, cut calculation, and on-demand summaries.
---

# locksmith-ledger

Operational reference for the locksmith accounting agent. All recipes are
copy-paste runnable from `Bash` inside the container.

## File locations (Aldo Cavanna trial)

- Ledger:  `/workspace/extra/locksmiths/aldo-cavanna/ledger.sqlite`
- Config:  `/workspace/extra/locksmiths/locksmiths.yaml`
- Pending: `/workspace/extra/locksmiths/aldo-cavanna/pending.jsonl`

For other locksmiths in the future, swap `aldo-cavanna` for the locksmith's
`slug` from `locksmiths.yaml`.

## Schema (idempotent — safe to run on every write)

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
  provider_normalized  TEXT NOT NULL,                 -- canonical key (see Provider normalization)
  total_amount         REAL NOT NULL CHECK (total_amount >= 0),
  cash_amount          REAL NOT NULL DEFAULT 0 CHECK (cash_amount >= 0),
  zelle_amount         REAL NOT NULL DEFAULT 0 CHECK (zelle_amount >= 0),
  cashapp_amount       REAL NOT NULL DEFAULT 0 CHECK (cashapp_amount >= 0),
  square_amount        REAL NOT NULL DEFAULT 0 CHECK (square_amount >= 0),
  cut_percent          REAL NOT NULL,                 -- snapshot at insert (or recomputed on update)
  cut_amount           REAL NOT NULL,                 -- total_amount * cut_percent/100
  job_timestamp        TEXT NOT NULL,                 -- ISO8601, from WA msg ts
  message_id           TEXT,                          -- WhatsApp source msg id
  reported_by_jid      TEXT NOT NULL,                 -- sender JID of the report
  reported_by_name     TEXT,                          -- sender display name
  confirmed_at         TEXT NOT NULL,                 -- ISO8601 (insert time — name kept for legacy reasons)
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
- `cut_percent` / `cut_amount` are **snapshotted at insert**. On a later
  UPDATE that changes `total_amount` or `provider`, recompute against the
  **current** YAML.
- `confirmed_at` is a legacy column name (from the prior confirmation-gated
  design). It is now the insert timestamp — never null, always set to the
  moment the row is written.
- Payment-method integrity (`cash + zelle + cashapp + square == total`,
  tolerance $0.01) is enforced by the agent, not by a CHECK constraint.
- Summaries are computed on the fly from `jobs` — no `summaries` table.

## Recipes

All recipes assume `SLUG=aldo-cavanna`. Set it first:

```bash
SLUG=aldo-cavanna
LEDGER=/workspace/extra/locksmiths/$SLUG/ledger.sqlite
PENDING=/workspace/extra/locksmiths/$SLUG/pending.jsonl
YAML=/workspace/extra/locksmiths/locksmiths.yaml
```

### Init the DB (safe on every write)

Run before any INSERT. `CREATE TABLE IF NOT EXISTS` makes it idempotent.

```bash
mkdir -p "$(dirname "$LEDGER")"
sqlite3 "$LEDGER" <<'SQL'
PRAGMA user_version = 1;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket TEXT, customer TEXT, phone TEXT, address TEXT,
  description TEXT, notes TEXT,
  provider TEXT NOT NULL,
  provider_normalized TEXT NOT NULL,
  total_amount REAL NOT NULL CHECK (total_amount >= 0),
  cash_amount REAL NOT NULL DEFAULT 0 CHECK (cash_amount >= 0),
  zelle_amount REAL NOT NULL DEFAULT 0 CHECK (zelle_amount >= 0),
  cashapp_amount REAL NOT NULL DEFAULT 0 CHECK (cashapp_amount >= 0),
  square_amount REAL NOT NULL DEFAULT 0 CHECK (square_amount >= 0),
  cut_percent REAL NOT NULL,
  cut_amount REAL NOT NULL,
  job_timestamp TEXT NOT NULL,
  message_id TEXT,
  reported_by_jid TEXT NOT NULL,
  reported_by_name TEXT,
  confirmed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS jobs_ts_idx ON jobs (job_timestamp);
CREATE INDEX IF NOT EXISTS jobs_provider_idx ON jobs (provider_normalized);
CREATE INDEX IF NOT EXISTS jobs_message_id_idx ON jobs (message_id);
SQL
```

## ACK protocol (no confirmation gate)

A new job message is processed in two paths depending on whether the
required-fields gate passes.

### Required-fields gate

A job goes **directly into `jobs`** if and only if ALL of:

1. `total_amount` is numeric and > 0.
2. `customer` is non-empty.
3. `provider` is non-empty (raw text; will be normalized).
4. Payment methods sum to total within $0.01:
   `cash + zelle + cashapp + square == total_amount` (tolerance $0.01).
   - If only a single method is implied (e.g. "$245 zelle"), put the full
     amount in that bucket; the other three are 0.
   - If the message says "$180" with no payment method, this gate **fails**
     on the breakdown requirement — ask which method(s).

Optional (null/empty if absent): `ticket`, `phone`, `address`, `description`,
`notes`.

### Path 1 — Complete job: INSERT + ACK

Always init the DB first. Use parameter substitution via shell variables —
never concatenate user text into SQL. For quote-safe inserts, use
`sqlite3 -cmd ".parameter set ..."` with `?` placeholders so apostrophes in
customer names do not break the SQL.

```bash
# Set fields from the extracted record:
TICKET="4521"
CUSTOMER="O'Brien"
PHONE=""
ADDRESS="123 Main St"
DESCRIPTION="Car lockout"
NOTES=""
PROVIDER="Mobile Locksmith"
PROVIDER_NORM="$(normalize_provider "$PROVIDER")"     # see Provider normalization
TOTAL=180.00
CASH=100.00
ZELLE=80.00
CASHAPP=0
SQUARE=0
# Resolve cut from current YAML — see "Cut calculation per job"
CUT_PCT=30
CUT_AMT=$(awk -v t="$TOTAL" -v p="$CUT_PCT" 'BEGIN{printf "%.2f", t*p/100}')
JOB_TS="2026-06-19T14:32:00-04:00"
MSG_ID="WA-MSG-ID-OF-JOB-REPORT"
REPORTER_JID="5491133...@s.whatsapp.net"
REPORTER_NAME="Aldo Cavanna"
NOW_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

sqlite3 "$LEDGER" \
  -cmd ".parameter set :ticket   '$TICKET'" \
  -cmd ".parameter set :customer '$CUSTOMER'" \
  -cmd ".parameter set :phone    '$PHONE'" \
  -cmd ".parameter set :address  '$ADDRESS'" \
  -cmd ".parameter set :descr    '$DESCRIPTION'" \
  -cmd ".parameter set :notes    '$NOTES'" \
  -cmd ".parameter set :provider '$PROVIDER'" \
  -cmd ".parameter set :pnorm    '$PROVIDER_NORM'" \
  -cmd ".parameter set :total    $TOTAL" \
  -cmd ".parameter set :cash     $CASH" \
  -cmd ".parameter set :zelle    $ZELLE" \
  -cmd ".parameter set :cashapp  $CASHAPP" \
  -cmd ".parameter set :square   $SQUARE" \
  -cmd ".parameter set :cutp     $CUT_PCT" \
  -cmd ".parameter set :cuta     $CUT_AMT" \
  -cmd ".parameter set :jts      '$JOB_TS'" \
  -cmd ".parameter set :mid      '$MSG_ID'" \
  -cmd ".parameter set :rjid     '$REPORTER_JID'" \
  -cmd ".parameter set :rname    '$REPORTER_NAME'" \
  -cmd ".parameter set :nowts    '$NOW_TS'" \
  "INSERT INTO jobs
     (ticket, customer, phone, address, description, notes,
      provider, provider_normalized,
      total_amount, cash_amount, zelle_amount, cashapp_amount, square_amount,
      cut_percent, cut_amount,
      job_timestamp, message_id,
      reported_by_jid, reported_by_name,
      confirmed_at)
   VALUES
     (:ticket, :customer, :phone, :address, :descr, :notes,
      :provider, :pnorm,
      :total, :cash, :zelle, :cashapp, :square,
      :cutp, :cuta,
      :jts, :mid,
      :rjid, :rname,
      :nowts);"
```

Then send the one-line ACK (see **ACK templates** below).

### Path 2 — Missing fields: append `awaiting_details` + one-liner ask

When the required-fields gate fails, do NOT insert. Append a pending row and
ask only for what is missing.

```bash
MSG_ID="WA-MSG-ID-OF-JOB-REPORT"
REPORTER_JID="5491133...@s.whatsapp.net"
REPORTER_NAME="Aldo Cavanna"
NOW_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# Build partial_extracted from whatever was successfully parsed:
PARTIAL='{"total_amount":180,"cash_amount":180,"zelle_amount":0,"cashapp_amount":0,"square_amount":0}'
# missing_fields lists the required-field names that failed the gate:
MISSING='["customer","provider"]'

jq -c -n \
  --arg id     "$MSG_ID" \
  --arg rjid   "$REPORTER_JID" \
  --arg rname  "$REPORTER_NAME" \
  --arg cat    "$NOW_TS" \
  --argjson partial  "$PARTIAL" \
  --argjson missing  "$MISSING" \
  '{
    id: $id, status: "awaiting_details",
    reporter_jid: $rjid, reporter_name: $rname,
    partial_extracted: $partial,
    missing_fields: $missing,
    created_at: $cat, resolved_at: null
  }' >> "$PENDING"
```

The one-liner ask should name only the missing fields. Examples:

- Missing total: `❓ Total amount? (and payment method breakdown if mixed)`
- Missing customer: `❓ Customer name?`
- Missing breakdown (have total but not how it was paid): `❓ How was the $180 paid? (cash / zelle / cashapp / square or mix)`
- Missing provider: `❓ Provider? (Mobile Locksmith / other)`
- Several missing: `❓ Missing: customer, total amount, provider.`

### ACK templates

Single line. Provider in the ACK is the **raw** original text (not the
normalized slug). Currency: `$<int>` if whole, `$<n>.<dd>` otherwise.

**Cash-kept callout (settlement model):** when `cash_amount > 0`, append
`— you keep ${cash} cash` to the ACK. The locksmith pockets cash on the
spot, so this number is explicitly called out every time. When
`cash_amount == 0`, do NOT append the clause — keep the ACK clean.

**English / default:**

```
✅ ACK / {customer} / ${total} / {provider} / {payment_breakdown}
✅ ACK / {customer} / ${total} / {provider} / {payment_breakdown} — you keep ${cash} cash
```

**Spanish (mirror when the sender wrote in Spanish):**

```
✅ ACK / {customer} / ${total} / {provider} / {payment_breakdown}
✅ ACK / {customer} / ${total} / {provider} / {payment_breakdown} — te quedas con ${cash} en efectivo
```

`{payment_breakdown}` lists only non-zero methods, joined with ` + `:

- Single method: `zelle $245`
- Two methods:  `cash $100 + zelle $80`
- All four:     `cash $40 + zelle $50 + cashapp $30 + square $60`

Method labels (lowercase): `cash`, `zelle`, `cashapp`, `square`.

**Update ACK** (after correcting an existing row — same shape, different
prefix, same cash-kept rule):

```
✏️ UPDATED / {customer} / ${total} / {provider} / {payment_breakdown}
✏️ UPDATED / {customer} / ${total} / {provider} / {payment_breakdown} — you keep ${cash} cash
```

Spanish UPDATE:

```
✏️ UPDATED / {customer} / ${total} / {provider} / {payment_breakdown} — te quedas con ${cash} en efectivo
```

**Per-job math note.** The settlement math (`net = cut - cash`) is
**portfolio-wide, not per-job**. There is no `net_owed` column on `jobs`
— always recompute on demand from `SUM(cut_amount)` and
`SUM(cash_amount)` over the desired window. Do **not** add per-job
"you owe boss $X" or "boss owes you $X" to the ACK. The only per-job
money callout is the cash-kept clause above.

## Pending statuses

- `awaiting_details` — row created when a job message arrived with missing
  required fields. Stays open until a follow-up resolves it.
- `completed` — set when an `awaiting_details` row was merged with a
  follow-up and successfully inserted into `jobs`. `resolved_at` is set.
- `cancelled` — out of trial scope. There is **no automatic recipe** for
  cancelling a job. If the operator explicitly asks to cancel an open
  `awaiting_details` row, set its status to `cancelled` manually via a one-off
  `sqlite3`/`jq` command. Do not implement an auto-cancel flow.

**Legacy statuses (do not produce new ones):** `awaiting`, `confirmed`,
`rejected`. Pre-existing rows on disk with these statuses are historical and
must be left untouched.

## Pending row shape (new statuses)

```json
{
  "id": "uuid-or-msgid",
  "status": "awaiting_details",
  "reporter_jid": "5491133...@s.whatsapp.net",
  "reporter_name": "Aldo Cavanna",
  "partial_extracted": {
    "customer": null,
    "ticket": null,
    "provider": null,
    "total_amount": 180,
    "cash_amount": 180,
    "zelle_amount": 0,
    "cashapp_amount": 0,
    "square_amount": 0,
    "job_timestamp": "2026-06-19T14:32:00-04:00"
  },
  "missing_fields": ["customer", "provider"],
  "created_at": "2026-06-19T14:32:05-04:00",
  "resolved_at": null
}
```

When `completed`: copy all of `partial_extracted` (now full), set
`status: "completed"`, and `resolved_at: "<iso>"`.

## Follow-up resolution

When the current message is not a complete new job, decide which path:

### A. Resolves a pending `awaiting_details`

If the current sender has an open `awaiting_details` row and the message
supplies missing fields:

1. Load that row (prefer the **most recent** one for this `reporter_jid`).
2. Merge new info into `partial_extracted`.
3. Re-evaluate the required-fields gate.
4. If now complete:
   - Init the DB, INSERT into `jobs` (Path 1 recipe above).
   - Send `✅ ACK / ...`.
   - Rewrite the pending row to `status: "completed"`, set `resolved_at`.
5. If still incomplete:
   - Update `partial_extracted` and `missing_fields` in place.
   - Re-ask only for what remains.

Merge / update a pending row (rewrites the file safely):

```bash
TARGET_ID="WA-MSG-ID-OF-ORIGINAL"
PATCH='{"customer":"Juan","provider":"Mobile Locksmith"}'  # the new fields
NEW_MISSING='[]'                                            # updated after merge
NEW_STATUS="awaiting_details"                               # or "completed"
RESOLVED_AT="null"                                          # or '"<iso>"' (note quoting if non-null)

jq -s -c \
  --arg id "$TARGET_ID" \
  --arg status "$NEW_STATUS" \
  --argjson patch "$PATCH" \
  --argjson missing "$NEW_MISSING" \
  '
   map(
     if .id==$id then
       .partial_extracted = (.partial_extracted + $patch)
       | .missing_fields = $missing
       | .status = $status
     else . end
   )
   | .[]
  ' "$PENDING" > "$PENDING.tmp" && mv "$PENDING.tmp" "$PENDING"
```

(For `resolved_at`, use a separate `--arg rat "<iso>"` and add `| .resolved_at = $rat`.)

### B. Updates an already-stored recent job

Signals: explicit reference ("the one for Juan", "el último", "the last
$180 lockout"), or a ticket number match, or a clear value-correction phrasing
on a value from the most recent job.

Recipe — by ticket if present, else by most-recent (optionally filtered by
reporter):

```bash
# Determine target id:
if [ -n "$TICKET" ]; then
  TARGET_ID=$(sqlite3 "$LEDGER" "SELECT id FROM jobs WHERE ticket='$TICKET' ORDER BY id DESC LIMIT 1;")
else
  TARGET_ID=$(sqlite3 "$LEDGER" "SELECT id FROM jobs ORDER BY id DESC LIMIT 1;")
fi
```

Apply the update with bound parameters (single column shown — extend as
needed):

```bash
NEW_TOTAL=200.00
sqlite3 "$LEDGER" \
  -cmd ".parameter set :id    $TARGET_ID" \
  -cmd ".parameter set :total $NEW_TOTAL" \
  "UPDATE jobs SET total_amount = :total WHERE id = :id;"
```

If `total_amount` or `provider` changed, recompute and write `cut_percent`
and `cut_amount` in the same row using the **current** YAML:

```bash
# Re-read current provider + total for the row:
read CUR_PROVIDER CUR_TOTAL < <(sqlite3 -separator ' ' "$LEDGER" "SELECT provider, total_amount FROM jobs WHERE id=$TARGET_ID;")
PNORM="$(normalize_provider "$CUR_PROVIDER")"
# Look up cut_percent from YAML (see "Cut calculation per job"):
CUT_PCT=$(lookup_cut_percent "$PNORM")
CUT_AMT=$(awk -v t="$CUR_TOTAL" -v p="$CUT_PCT" 'BEGIN{printf "%.2f", t*p/100}')
sqlite3 "$LEDGER" \
  -cmd ".parameter set :id   $TARGET_ID" \
  -cmd ".parameter set :cutp $CUT_PCT" \
  -cmd ".parameter set :cuta $CUT_AMT" \
  "UPDATE jobs SET cut_percent = :cutp, cut_amount = :cuta WHERE id = :id;"
```

Then send the `✏️ UPDATED / ...` one-liner with the updated values.

### C. Looks like a new job

Fall back to the standard Path 1 / Path 2 split (required-fields gate).

## Provider normalization (Bash)

```bash
normalize_provider() {
  local raw="$1"
  local n
  n=$(echo "$raw" | tr '[:upper:]' '[:lower:]' \
        | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' \
        | sed 's/[^a-z0-9]\+/_/g' \
        | sed 's/^_//;s/_$//')
  case "$n" in
    ml|mobile|mobilelocksmith|mobile_locksmith) echo "mobile_locksmith" ;;
    *) echo "$n" ;;
  esac
}

PROVIDER_NORM="$(normalize_provider "Mobile Locksmith")"   # -> mobile_locksmith
```

Steps:
1. Lowercase.
2. Strip leading/trailing whitespace.
3. Replace any run of non-alphanumeric characters with a single `_`.
4. Trim leading/trailing `_`.
5. Apply alias map:
   - `ml`, `mobile`, `mobilelocksmith`, `mobile_locksmith` → `mobile_locksmith`
   - everything else → keep result of steps 1-4.

The normalized value goes into `jobs.provider_normalized`. The raw value goes
into `jobs.provider` AND into the ACK line.

## Read cut rules from YAML

```bash
yq -r '.locksmiths[] | select(.slug=="'$SLUG'") | .cut_rules[] | "\(.provider_match) \(.cut_percent)"' "$YAML"
```

Fallback (awk, no yq):

```bash
awk -v slug="$SLUG" '
  /^locksmiths:/   { in_l=1; next }
  in_l && $1=="-" && $2=="name:"          { cur_name=$3 }
  in_l && $1=="slug:"                     { cur_slug=$2; active=(cur_slug==slug) }
  in_l && active && $1=="cut_rules:"      { in_r=1; next }
  in_l && active && in_r && $1=="-"       { pm=""; cp="" }
  in_l && active && in_r && $1=="provider_match:" { pm=$2 }
  in_l && active && in_r && $1=="cut_percent:"    { cp=$2; print pm" "cp }
' "$YAML"
```

Apply first-match against the normalized provider; default rule (`*`) must
appear last in the YAML.

## Cut calculation per job

```bash
lookup_cut_percent() {
  local pnorm="$1"
  local pm cp
  while read pm cp; do
    [ -z "$pm" ] && continue
    if [ "$pm" = "*" ] || [ "$pm" = "$pnorm" ]; then
      echo "$cp"
      return 0
    fi
  done < <(yq -r '.locksmiths[] | select(.slug=="'$SLUG'") | .cut_rules[] | "\(.provider_match) \(.cut_percent)"' "$YAML")
}

PROVIDER_NORM="$(normalize_provider "$PROVIDER")"
CUT_PCT="$(lookup_cut_percent "$PROVIDER_NORM")"
CUT_AMT=$(awk -v t="$TOTAL" -v p="$CUT_PCT" 'BEGIN{printf "%.2f", t*p/100}')
```

If `yq` is unavailable, use the awk fallback above to produce the same
`provider_match cut_percent` lines.

## Reading `pending.jsonl` safely

If `pending.jsonl` may contain malformed lines (host crash, partial write),
read line-by-line and skip bad ones. Do NOT abort the agent.

```bash
while IFS= read -r line; do
  echo "$line" | jq -c '.' 2>/dev/null || {
    echo "WARN: skipping malformed pending row" >&2
    continue
  }
done < "$PENDING"
```

List open `awaiting_details` rows for a given reporter:

```bash
REPORTER_JID="5491133...@s.whatsapp.net"
jq -c --arg jid "$REPORTER_JID" \
  'select(.status=="awaiting_details" and .reporter_jid==$jid)' \
  "$PENDING"
```

## Weekly totals (Sunday-anchored — current week to date)

```bash
sqlite3 -separator '|' "$LEDGER" <<'SQL'
SELECT
  COUNT(*)               AS n_jobs,
  COALESCE(SUM(total_amount),    0) AS revenue,
  COALESCE(SUM(cash_amount),     0) AS cash,
  COALESCE(SUM(zelle_amount),    0) AS zelle,
  COALESCE(SUM(cashapp_amount),  0) AS cashapp,
  COALESCE(SUM(square_amount),   0) AS square,
  COALESCE(SUM(cut_amount),      0) AS cut_total,
  COALESCE(SUM(CASE WHEN provider_normalized='mobile_locksmith' THEN cut_amount ELSE 0 END), 0) AS cut_ml,
  COALESCE(SUM(CASE WHEN provider_normalized!='mobile_locksmith' THEN cut_amount ELSE 0 END), 0) AS cut_other
FROM jobs
WHERE job_timestamp >= date('now','weekday 0','-7 days');
SQL
```

## Monthly totals (current month to date)

```bash
sqlite3 -separator '|' "$LEDGER" <<'SQL'
SELECT
  COUNT(*), COALESCE(SUM(total_amount),0), COALESCE(SUM(cut_amount),0)
FROM jobs
WHERE job_timestamp >= date('now','start of month');
SQL
```

## Previous-month totals (for on-demand monthly summaries)

```bash
sqlite3 -separator '|' "$LEDGER" <<'SQL'
SELECT
  COUNT(*),
  COALESCE(SUM(total_amount),0),
  COALESCE(SUM(cash_amount),0),
  COALESCE(SUM(zelle_amount),0),
  COALESCE(SUM(cashapp_amount),0),
  COALESCE(SUM(square_amount),0),
  COALESCE(SUM(cut_amount),0),
  COALESCE(SUM(CASE WHEN provider_normalized='mobile_locksmith' THEN cut_amount ELSE 0 END), 0) AS cut_ml,
  COALESCE(SUM(CASE WHEN provider_normalized!='mobile_locksmith' THEN cut_amount ELSE 0 END), 0) AS cut_other
FROM jobs
WHERE job_timestamp >= date('now','start of month','-1 month')
  AND job_timestamp <  date('now','start of month');
SQL
```

## Since-date totals (custom window)

```bash
SINCE="2026-06-01"
sqlite3 -separator '|' "$LEDGER" <<SQL
SELECT COUNT(*), COALESCE(SUM(total_amount),0), COALESCE(SUM(cut_amount),0)
FROM jobs
WHERE job_timestamp >= '$SINCE';
SQL
```

## Last N jobs (markdown table)

```bash
N=5
sqlite3 -header -separator '|' "$LEDGER" <<SQL
SELECT ticket, customer, total_amount, cut_amount, job_timestamp
FROM jobs
ORDER BY job_timestamp DESC
LIMIT $N;
SQL
```

Format the output as a markdown table when replying.

## Payment-method breakdown (current week)

```bash
sqlite3 -separator '|' "$LEDGER" <<'SQL'
SELECT
  COALESCE(SUM(cash_amount),    0),
  COALESCE(SUM(zelle_amount),   0),
  COALESCE(SUM(cashapp_amount), 0),
  COALESCE(SUM(square_amount),  0),
  COALESCE(SUM(total_amount),   0)
FROM jobs
WHERE job_timestamp >= date('now','weekday 0','-7 days');
SQL
```

Compute percentages in the agent (avoid div-by-zero when total = 0).

## Weekly summary format (on-demand)

```
🧾 Weekly summary — Aldo Cavanna
Period: {YYYY-MM-DD} → {YYYY-MM-DD}

• Jobs: {N}
• Total revenue: ${total}
• By payment method:
   - Cash:    ${cash} ({cash_pct}%)
   - Zelle:   ${zelle} ({zelle_pct}%)
   - CashApp: ${cashapp} ({cashapp_pct}%)
   - Square:  ${square} ({square_pct}%)

• Locksmith cut (Aldo):
   - Mobile Locksmith (30%): ${cut_ml}
   - Other (35%):            ${cut_other}
   - Total cut:              ${cut_total}

• Cut earned this week: ${earned}
• Cash already kept by Aldo: ${cash_kept}
• Net the boss owes Aldo: ${net}
```

Spanish mirror:

```
• Corte ganado en la semana: ${earned}
• Efectivo que Aldo ya tiene: ${cash_kept}
• Neto que el dueño le debe a Aldo: ${net}
```

**Negative-net case.** When `${net} < 0` (the locksmith collected more
cash than his cut over the period), REPLACE the third line with the
explicit phrasing (use absolute value for `$X`; both numbers identical
and positive):

```
• Cash collected exceeds cut by $X — Aldo owes boss $X
```

Spanish:

```
• El efectivo cobrado supera al corte por $X — Aldo le debe al dueño $X
```

Where:
- `${earned}` = `SUM(cut_amount)` over the period.
- `${cash_kept}` = `SUM(cash_amount)` over the period.
- `${net}` = `${earned} - ${cash_kept}` (may be negative).

The three-line block is the canonical settlement disclosure: always state
both numbers (earned cut AND cash already kept) before stating the net —
never lump them.

## Monthly summary format (on-demand)

Same layout as weekly. Swap "Weekly" → "Monthly" and use the **previous
calendar month** window (see the previous-month totals recipe). The
three-line settlement block at the bottom uses "this month" / "en el
mes" phrasing instead of "this week" / "en la semana"; negative-net
wording is identical.

## Settlement math — canonical SQL recipe

When the owner asks "what do I owe Aldo" / "cuánto le debo a Aldo" /
"settlement" — or whenever you need all three settlement numbers for a
summary — use this single query. It returns `earned`, `cash_kept`, and
`net` in one row over `[:period_start, :period_end)`:

```sql
SELECT
  COALESCE(SUM(cut_amount),  0) AS earned,
  COALESCE(SUM(cash_amount), 0) AS cash_kept,
  COALESCE(SUM(cut_amount) - SUM(cash_amount), 0) AS net
FROM jobs
WHERE job_timestamp >= :period_start
  AND job_timestamp <  :period_end;
```

Bind the window via `.parameter set` exactly like the INSERT recipe.
Recipes for the four common windows:

**This week (Sunday-anchored):**

```bash
sqlite3 -separator '|' "$LEDGER" \
  -cmd ".parameter set :period_start (SELECT date('now','weekday 0','-7 days'))" \
  -cmd ".parameter set :period_end   (SELECT date('now','+1 day'))" \
  "SELECT
     COALESCE(SUM(cut_amount),  0) AS earned,
     COALESCE(SUM(cash_amount), 0) AS cash_kept,
     COALESCE(SUM(cut_amount) - SUM(cash_amount), 0) AS net
   FROM jobs
   WHERE job_timestamp >= :period_start
     AND job_timestamp <  :period_end;"
```

(`sqlite3 .parameter set` doesn't evaluate expressions, so for date
literals use the alternative shell-substitution form below.)

**This week (shell-substituted bounds — simpler, preferred):**

```bash
PERIOD_START=$(sqlite3 "$LEDGER" "SELECT date('now','weekday 0','-7 days');")
PERIOD_END=$(sqlite3 "$LEDGER"   "SELECT date('now','+1 day');")
sqlite3 -separator '|' "$LEDGER" \
  -cmd ".parameter set :period_start '$PERIOD_START'" \
  -cmd ".parameter set :period_end   '$PERIOD_END'" \
  "SELECT
     COALESCE(SUM(cut_amount),  0) AS earned,
     COALESCE(SUM(cash_amount), 0) AS cash_kept,
     COALESCE(SUM(cut_amount) - SUM(cash_amount), 0) AS net
   FROM jobs
   WHERE job_timestamp >= :period_start
     AND job_timestamp <  :period_end;"
```

**This month:**

```bash
PERIOD_START=$(sqlite3 "$LEDGER" "SELECT date('now','start of month');")
PERIOD_END=$(sqlite3 "$LEDGER"   "SELECT date('now','start of month','+1 month');")
# same -cmd / SELECT as above
```

**Previous month:**

```bash
PERIOD_START=$(sqlite3 "$LEDGER" "SELECT date('now','start of month','-1 month');")
PERIOD_END=$(sqlite3 "$LEDGER"   "SELECT date('now','start of month');")
# same -cmd / SELECT as above
```

**Since DATE:**

```bash
PERIOD_START="2026-06-01"
PERIOD_END=$(sqlite3 "$LEDGER" "SELECT date('now','+1 day');")
# same -cmd / SELECT as above
```

After fetching `earned|cash_kept|net`, render the three-line block per
the weekly/monthly templates above. If `net < 0`, swap the third line
for the "Cash collected exceeds cut by $X — Aldo owes boss $X" wording
(use `abs(net)`).

## Owner query intents

Three closely-related money intents must be distinguished. Always be
explicit — never lump "earned cut" and "what's owed" together.

| Intent | Trigger keywords | SQL | Response shape |
|---|---|---|---|
| **Settlement / owed** (full three-line block) | "what do I owe", "what does the boss owe", "owe Aldo", "settlement", "cuánto le debo", "qué le debo", "settle up" + (this week / esta semana / this month / este mes / since DATE) | Canonical settlement query (see "Settlement math — canonical SQL recipe") returning `earned`, `cash_kept`, `net` | Three-line settlement block (earned / cash kept / net), with negative-case swap if `net < 0` |
| **Earned cut only** | "how much did Aldo earn", "cut total", "earned cut", "corte ganado", "cuánto ganó Aldo" (without "owed"/"debo") | `SELECT COALESCE(SUM(cut_amount),0) FROM jobs WHERE job_timestamp >= :period_start AND job_timestamp < :period_end;` | Single line: "Aldo earned ${earned} {in/since window}." No cash-kept line. No net line. |
| **Cash kept** | "how much cash does Aldo have", "cash kept", "cuánto efectivo tiene Aldo", "cash collected" | `SELECT COALESCE(SUM(cash_amount),0) FROM jobs WHERE job_timestamp >= :period_start AND job_timestamp < :period_end;` | Single line: "Aldo has ${cash_kept} in cash {in/since window}." |
| Monthly owed (alias of settlement) | "this month", "este mes" + owed/debo keyword | Settlement query over current month | Three-line block |
| Since-date (alias of settlement) | "since YYYY-MM-DD", "desde YYYY-MM-DD" + owed/debo keyword | Settlement query over `[date, now)` | Three-line block |
| Job count | "how many", "cuántos" | `SELECT COUNT(*) FROM jobs WHERE ...` | "Aldo did N jobs in {window}." |
| Last N | "last N", "últimos N" | `ORDER BY job_timestamp DESC LIMIT N` | Markdown table: ticket, customer, total, cut, date |
| Method breakdown | "breakdown", "desglose", "por método" | `SELECT SUM(cash_amount), SUM(zelle_amount), SUM(cashapp_amount), SUM(square_amount) ...` | Bullet list per method with totals and percentages |

Disambiguation rule:
- If the user asks **only** how much was earned (cut total), reply with just the cut total — do NOT volunteer the full three-line block.
- If the user asks **only** about cash kept, reply with just the cash number.
- If the user asks **what's owed / settlement / "what do I pay Aldo"**, always reply with the full three-line block — be explicit about both earned and cash kept before stating the net.

Ambiguous queries → ask for clarification. Do not guess.

## Scheduling — do NOT auto-create cron tasks

Summaries are produced **only on explicit owner request**. Do not write
anything to `/workspace/ipc/<group_folder>/tasks/`. Do not create cron or
interval tasks. Use the weekly/monthly templates above only when the owner
asks ("show me this week's summary", "resumen mensual", etc.).

## Tone

Concise. Operational. No filler. ACKs and asks are **single lines**.
Reply in the same language as the incoming message; default English.
No emojis except the ones explicitly defined in the ACK / ask / summary
templates above (`✅`, `✏️`, `❓`, `🧾`, `⚠️`).

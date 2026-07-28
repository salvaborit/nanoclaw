# CRM access recipes — DimitrisClaw container

> **Container override.** This file replaces the upstream `dimitris` skill's `crm-access.md`. The upstream recipe (`ssh h-dmi-a 'docker compose exec ... psql -U crm ...'`) is for the user's dev machine and does NOT work here. From this container you reach the CRM through **two** paths: a **primary MCP surface for reads and writes**, and a **legacy SSH tunnel** kept as a read-only fallback. Everything below reflects the container's actual capabilities.

The CRM is the source of truth for facturación, leads, clients, projects, cash, WhatsApp state. **Never invent numbers; always query.**

**Pipeline:** always use the `Lead`-shaped tools / table for sales-pipeline questions. `SaleProspect` is legacy — do not use unless explicitly asked. See `schema.md`.

Companion file: `schema.md` — the table map.

## MCP tools (primary — reads and writes)

The CRM registers an HTTP MCP server at `https://gaston.dimitris.app/api/mcp` (env `DIMITRIS_CRM_MCP_URL`). Bearer auth is handled by the agent-runner. All 35 tools are namespaced under `crm.*` (SDK-visible as `mcp__crm__crm_*`). Every mutation writes an `Activity` row prefixed with `[MCP · <sender label>]` for audit.

**Prefer MCP tools over the SSH tunnel** — they're the primary path, faster, and support writes.

### Leads
- `crm.list_leads` — list leads with optional filters (`status?`, `responsibleId?`, `clientId?`, `limit?`).
- `crm.get_lead` — fetch a single lead by id.
- `crm.create_lead` — create a new lead. `contactName` required.
- `crm.update_lead` — patch any Lead field.
- `crm.update_lead_status` — move a lead through the pipeline. On CERRADO_GANADO/CERRADO_PERDIDO also sets `closedAt`.
- `crm.add_lead_note` — append a NOTE activity to a lead.
- `crm.convert_lead_to_client` — **Convert a lead to a client. Creates a new Client from lead fields; marks the source lead as CERRADO_GANADO with `clientId` set (lead persists for history, not deleted).** Returns `{ clientId }`. Non-destructive per REV1.
- `crm.link_lead_to_client` — attach/detach a lead's `clientId` FK. Safe — no status change.

### Clients
- `crm.list_clients` — list clients with optional filters.
- `crm.get_client` — fetch a single client by id.
- `crm.create_client` — create a new client.
- `crm.update_client` — **Update any client field. If `status` transitions PROSPECT→ACTIVE, any linked leads not already in a terminal status are marked CERRADO_GANADO (leads persist, `clientId` FK preserved).** Non-destructive per REV1.
- `crm.add_client_note` — append a NOTE activity under a client.

### Projects
- `crm.list_projects` — list projects with optional filters.
- `crm.get_project` — fetch a single project by id.
- `crm.create_project` — `clientId` required.
- `crm.update_project` — patch any project field.
- `crm.add_project_note` — append a NOTE activity under a project.

### Invoices / billing
- `crm.list_invoices` — list invoices with optional filters.
- `crm.get_invoice` — fetch a single invoice by id.
- `crm.create_invoice` — `projectId` and `amount` required; `clientId` auto-resolves from the project when omitted.
- `crm.update_invoice` — **Refuses `status: 'PAID'` — must use `crm.mark_invoice_paid` instead** (which creates the paired CashEntry INGRESO transactionally).
- `crm.mark_invoice_paid` — mark an invoice PAID. Transactional: sets paidDate, inserts paired CashEntry INGRESO, writes PAYMENT activity.

### Treasury / CashEntry
- `crm.list_cash_entries` — list cash entries (money in/out ledger) with optional filters.
- `crm.get_cash_entry` — fetch a single cash entry by id.
- `crm.create_cash_entry` — INGRESO or EGRESO. `type`, `amount`, `concept` required.
- `crm.update_cash_entry` — update a cash entry. If linked to an invoice, updating the date syncs the invoice's `paidDate`.
- `crm.delete_cash_entry` — **DELETE a cash entry — IRREVERSIBLE. Also deletes the attached file on disk (non-atomic with the DB delete).** See *Write-safety* below.

### Tasks

**Actionable vs historical — read this first.** For actionable to-do items (things the user wants tracked as work, with a due date, planning slot, or assignee) — use `crm.create_task`. It automatically appears in Tareas, Desarrollo AND Planificador. **DO NOT** use `crm.add_project_note` / `crm.add_client_note` / `crm.add_lead_note` for actionable items — those are for historical / non-planificable notes. Reference: five recent NOTEs at `docs/specs/20260717_crm_mcp_tasks/CONTEXT.md §6.1` were this mistake — never repeat it.

**Before creating, list.** Before creating a new task, call `crm.list_tasks({ projectId, includeCompleted: false })` first to check for duplicates. The 2026-07-17 incident (CONTEXT §6.2) had 2 true-duplicate NOTEs written against pre-existing Tasks — that would have been caught with a list-first check.

**Reminders.** Do NOT auto-schedule nanoclaw reminders (`schedule.*` or task-scheduler primitives) for MCP-created tasks. The Planificador appearance IS the reminder. Only schedule a WhatsApp ping when the user *explicitly* asks ("recordame", "avísame", "mandame un mensaje mañana", etc.).

**`plannerOrder`.** Leave it null unless the user asks for a specific slot ordering. UI drag-drop assigns it. If you must set it, list the target `(plannedDate, timeSlot)` cell first (`crm.list_tasks({ plannedDateFrom, plannedDateTo, ... })`), compute a non-colliding value, then set it — there is no unique constraint on `(plannedDate, timeSlot, plannerOrder)`, so collisions render as ties in the UI.

**Task notes.** There is no `crm.add_task_note` because `Activity` has no `taskId` FK. Task-adjacent notes go through `crm.add_project_note(projectId, "[Task: <title>] <body>")` — the `[Task: <title>]` prefix is a convention Jarvis maintains at the prompt layer.

- `crm.list_tasks` — List tasks with optional filters (project, status, assignee, planned/due date ranges). **Defaults to excluding DONE** — pass `includeCompleted: true` if the user asks for "todas" or "incluye completadas". Returns tasks with `assignees[]`, `projectName`, `clientName`.
- `crm.get_task` — Get full task detail including assignees, project, and time-entry count. Null if not found.
- `crm.create_task` — Create a task. Accepts `title` (req), `projectId?`, `description?`, `priority?`, `status?`, `plannedDate?` (ISO date), `timeSlot?` (MORNING/MIDDAY/AFTERNOON), `plannerOrder?`, `contextNote?`, `dueDate?` (ISO date), `assigneeIds?` (up to 5). A task with only `dueDate` set appears in the Planificador that week automatically — no separate `plan_task` call needed. Transactional.
- `crm.update_task` — Update any task field. Only fields present in the patch are touched; unrelated fields (including `plannedDate` / `dueDate`) are NOT re-normalized. `assigneeIds` is REPLACE semantics — overwrites the full set (cap 5).
- `crm.complete_task` — Convenience: set status=DONE and emit an Activity of type TASK_DONE (visible in project/client activity feeds). Idempotent — running twice on an already-DONE task does not spam a second Activity row. **Prefer this over `crm.update_task({ status: 'DONE' })`** — same DB effect but the audit row is the semantic TASK_DONE, not a generic "Tarea actualizada: status".
- `crm.assign_task` — REPLACE the assignee set for a task with the given `assigneeIds` list (max 5, empty array clears). Transactional.
- `crm.delete_task` — Delete a task. **REFUSES if the task has TimeEntry rows** — returns an error asking you to delete those first. Cascade handles TaskAssignee cleanup. See *Write-safety* below.

## Write-safety

- **The ONLY truly irreversible MCP operation is `crm.delete_cash_entry`** (also deletes the attachment file, if any). Before calling it, describe the exact row(s) affected — id, type, amount, concept, date, any attached file — and wait for user confirmation (`sí` / `dale` / `ok`) in the same conversation. Use `crm.get_cash_entry` first to fetch the exact row.
- **`crm.delete_task` refuses (returns `isError:true`) if the task has any TimeEntry rows.** Not technically destructive server-side — it never runs — but users experience it as a failed delete. When you're about to call it, describe the task first ("voy a borrar la tarea X"); if the server refuses, relay the error verbatim and offer to delete the time entries first.
- **All other writes** — creates, updates, `crm.convert_lead_to_client` (now marks CERRADO_GANADO instead of deleting), `crm.update_client` PROSPECT→ACTIVE (now marks linked leads CERRADO_GANADO instead of deleting), `crm.mark_invoice_paid`, `crm.complete_task`, `crm.assign_task` — **are non-destructive**. No confirmation needed. Just do them.
- **Scheduled-task invocations** (system prompt marks the run as scheduled, or there is no human sender): **REFUSE all writes** and reply that scheduled runs are read-only. Writes require an interactive human trigger.

## SSH tunnel (legacy read-only fallback)

Prefer MCP tools. Use SSH **only** if MCP is unreachable or you need a query the MCP surface can't express (e.g. arbitrary joins across `WhatsApp*` tables, ad-hoc aggregations not offered as a tool).

The container has a read-only mount at `/workspace/extra/dimitris/` with an SSH key, `ssh_config`, and `known_hosts`. The SSH endpoint is locked (ForceCommand) to a single command: `docker exec ... psql -U nanoclaw_ro -d crm_dimitris`. Whatever you send on stdin is fed to `psql` as SQL. You **cannot** open a shell, change DB, or run `-c`-style one-liners over SSH argv — the ForceCommand ignores those.

Single-statement:
```bash
echo 'SELECT COUNT(*) FROM "Lead";' \
  | ssh -F /workspace/extra/dimitris/ssh_config dimitris-db
```

Multi-line (heredoc — preferred for anything non-trivial):
```bash
ssh -F /workspace/extra/dimitris/ssh_config dimitris-db <<'SQL'
SELECT id, "contactName", status, amount, currency
FROM "Lead"
WHERE status = 'NUEVO'
ORDER BY "createdAt" DESC
LIMIT 10;
SQL
```

Notes:
- DB name is `crm_dimitris`, role is `nanoclaw_ro` (SELECT-only). Don't try `\c` — role can't switch DBs anyway.
- Table and column names are quoted PascalCase (Prisma / Drizzle convention). Always double-quote: `"Lead"`, `"contactName"`, `"createdAt"`.
- Enum types are PascalCase (`"LeadStatus"`, `"InvoiceStatus"`). Values are UPPER_SNAKE. Discover with `SELECT unnest(enum_range(NULL::"LeadStatus"));`.
- Discover schema on demand: `\dt`, `\d "Lead"`, `\dT+`. Use `\x on` for wide rows.
- Companion cheat-sheet at `/workspace/extra/dimitris/README.md` mirrors this file — this skill is the primary reference; the README is legacy.

### Common read recipes (SSH fallback)

**Lead pipeline snapshot:**
```sql
SELECT status, COUNT(*), SUM(amount)::int AS total_usd
FROM "Lead"
GROUP BY status
ORDER BY 2 DESC;
```

**Active leads (not closed):**
```sql
SELECT id, "contactName", channel, status, amount, "followUpDate"
FROM "Lead"
WHERE status NOT IN ('CERRADO_GANADO','CERRADO_PERDIDO')
ORDER BY "createdAt" DESC;
```

**Leads by channel (marketing analysis):**
```sql
SELECT channel, COUNT(*),
       COUNT(*) FILTER (WHERE status = 'CERRADO_GANADO') AS won,
       COUNT(*) FILTER (WHERE status = 'CERRADO_PERDIDO') AS lost,
       AVG(amount) FILTER (WHERE status = 'CERRADO_GANADO')::int AS avg_won_usd
FROM "Lead"
GROUP BY channel
ORDER BY 2 DESC;
```

**Outstanding invoices:**
```sql
SELECT i.id, c.name AS client, i.amount, i.currency, i.status, i."dueDate"
FROM "Invoice" i
JOIN "Client" c ON c.id = i."clientId"
WHERE i.status IN ('PENDING','OVERDUE')
ORDER BY i."dueDate";
```

**Cash flow by month, last 12 months:**
```sql
SELECT date_trunc('month', date)::date AS month,
       SUM(amount) FILTER (WHERE type = 'INGRESO')::int AS in_usd,
       SUM(amount) FILTER (WHERE type = 'EGRESO')::int AS out_usd,
       (SUM(amount) FILTER (WHERE type = 'INGRESO')
        - SUM(amount) FILTER (WHERE type = 'EGRESO'))::int AS net_usd
FROM "CashEntry"
WHERE currency = 'USD' AND date >= CURRENT_DATE - INTERVAL '12 months'
GROUP BY month
ORDER BY month DESC;
```

**Close rate by channel (last 90 days):**
```sql
SELECT channel,
       COUNT(*) AS leads,
       COUNT(*) FILTER (WHERE status = 'CERRADO_GANADO') AS won,
       ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'CERRADO_GANADO') / NULLIF(COUNT(*),0), 1) AS close_rate_pct,
       AVG(amount) FILTER (WHERE status = 'CERRADO_GANADO')::int AS avg_ticket_usd
FROM "Lead"
WHERE "createdAt" >= CURRENT_DATE - INTERVAL '90 days'
GROUP BY channel
ORDER BY leads DESC;
```

**KPI progress (current month, fixed, America/Montevideo):** see `schema.md` §KPI definitions for the full CTE-based query — SSH fallback only; prefer wrapping business logic in MCP tools when possible.

## When queries return nothing

- Say so plainly: "no rows for that channel / date range / client".
- Don't fabricate. Don't guess.
- Suggest a broader query if the filter was tight.

## When numbers seem off vs. user's memory

- Trust the DB, flag the discrepancy. E.g. "querying `Lead` shows 5 closes in July, not 4/5 as mentioned — do you want to see them?"
- The user's memory is not the source of truth here.

# CHANGES — CRM MCP Tasks extension

Implementation of SPEC.md (single revision, no REPLAN). Two repos touched
(`~/prj/crm-dimitris` and `~/prj/nanoclaw`). Deployment intentionally NOT
performed — Step 7 (deploy) is left to the verifier/orchestrator per the
delegation instructions.

## Files touched

### CRM (`~/prj/crm-dimitris`)

#### Step 1 — domain layer
- `lib/domain/tasks.ts` — **NEW.** Full Task domain parameterized by `Actor`:
  `normalizeDateInput`, `listTasks`, `getTask`, `createTask`, `updateTask`,
  `completeTask`, `assignTask`, `deleteTask`. Every mutation is transactional
  (`db.transaction`), audit-gated on `isAgentActor(actor)`, and routed
  through `recordActivity(actor, {...}, tx)` — never hand-rolls the
  `[MCP · …]` prefix. `normalizeDateInput` is the single source of the
  `-03:00` offset for both `plannedDate` and `dueDate`; only applied to
  patch keys the caller actually sent (undefined fields are never
  re-normalized). Domain never writes the deprecated `Task.assigneeId`
  column — assignees go exclusively through `taskAssignees[]` (cap 5).
  `deleteTask` refuses if any `TimeEntry` row references the task
  (mirrors `deleteProject` pattern; verbatim message: `"Cannot delete: N
  time entries logged; delete those first"`). `completeTask` emits
  `TASK_DONE` on the first call, is idempotent on repeat.

#### Step 2 — action-layer refactor to thin wrappers
- `app/(dashboard)/tasks/actions.ts` — rewritten. `createTask` / `updateTask`
  / `deleteTask` now call `tasksDomain.*`. Backward-compat shim: legacy
  callers passing `assigneeId?: string` (single) are mapped to
  `assigneeIds: [id]` on the domain; modern `assigneeIds?: string[]`
  passes through. **This closes the CONTEXT §7 spec
  `20260330_TAREAS_FILTER_AND_DESARROLLO_BUG` regression path** — the
  legacy path no longer writes the deprecated column.
- `app/(dashboard)/projects/[id]/actions.ts` — task-CRUD portion
  (`createTask` / `updateTask` / `deleteTask`) rewritten as thin
  `requireActor()` + `tasksDomain.*` + `revalidatePath` wrappers. Removed
  the stale "Task CRUD stays here — tasks are out of scope for the MCP
  surface" header comment on line 50. Project-CRUD portion unchanged.
- `lib/actions/tasks.ts` — `createTaskAction` rewritten as thin domain
  wrapper. Adds `requireActor()` (previously trusted the "use server"
  boundary with no auth check — now fixed as a side-effect of the
  refactor).
- `app/(dashboard)/desarrollo/actions.ts` — `updateTaskStatus` now calls
  `tasksDomain.updateTask(actor, id, { status })`; `updateTaskAssignee`
  now calls `tasksDomain.assignTask(actor, id, assigneeId ? [assigneeId] : [])`
  (single-assignee legacy UI routed through the multi-assignee REPLACE
  domain). Both use `requireActor()` for the auth check.
- `app/(dashboard)/planificador/actions.ts` — `planTask`, `unplanTask`,
  `updateContextNote`, `createTaskInPlanner` rewritten as thin domain
  wrappers. `createTaskInPlanner` gained an `assigneeIds?: string[]`
  input alongside the legacy `assigneeId?: string | null` — the domain
  path now writes `taskAssignees[]` correctly (fixes CONTEXT §3.4 bug
  where the pre-refactor UI action wrote the deprecated `assigneeId`
  column). **`reorderTasks` LEFT AS-IS intentionally** — SPEC Non-goals:
  UI-scoped batch write with no MCP counterpart. This is the only
  remaining direct `db.update(tasks)` outside `lib/domain/tasks.ts`
  (excluding the `settings/actions.ts:deleteUser` FK-nullification
  hygiene, which is unrelated to the mutation surface).

#### Step 3 — MCP handlers + tool registry
- `lib/mcp/coerce.ts` — added `TASK_STATUS` and `TIME_SLOT` enum
  constants; added `asEnumOrNull` (accepts `null | undefined | enum-value`)
  and `asStringArray` helpers; added `coerceTaskCreateInput`,
  `coerceTaskPatch`, `coerceAssigneeIds` exports. All fields go through
  the existing `build()` pipeline to drop undefined keys. Zero `as Patch`
  casts in the handler layer (Rev 2 finding #10 invariant preserved for
  the new surface).
- `lib/mcp/handlers/tasks.ts` — **NEW.** Seven handlers
  (`listTasks`, `getTask`, `createTask`, `updateTask`, `completeTask`,
  `assignTask`, `deleteTask`). Mirrors `handlers/leads.ts` shape
  byte-for-byte. Only imports from `../../domain/*` and `../coerce`;
  **never** imports from `@/app/(dashboard)/…` (carried-forward gate,
  grep-verified below).
- `lib/mcp/tools.ts` — added 7 registry entries under a new
  `// ─── Tasks ───` block. Full JSON-Schema `inputSchema` per tool.
  Naming convention `crm.<verb>_task` matches the prior cycle. Tool
  descriptions are the verbatim table from SPEC §Step 3.

#### Step 6 — DEPLOY.md
- No change. `DEPLOY.md` §MCP surface does not reference a specific tool
  count; the SPEC's conditional bump is a no-op. `git diff DEPLOY.md`
  empty.

### Nanoclaw (`~/prj/nanoclaw`) — per-group config (gitignored)

Both files below are outside git (`data/sessions/*` and `groups/*/CLAUDE.md`
are per-install config, gitignored). Edits are applied to the working
tree and will be picked up on next `systemctl --user restart nanoclaw`.

#### Step 4 — skill overhaul
- `data/sessions/dimitris-claw/.claude/skills/dimitris/crm-access.md` —
  bumped the intro tool count `29 → 35`. Added a full **Tasks**
  subsection under `## MCP tools (primary — reads and writes)` with:
  (a) the "Actionable vs historical" rule (explicitly cites CONTEXT
  §6.1 to make the mistake unrepeatable); (b) the "Before creating,
  list" rule (cites the CONTEXT §6.2 duplicate incident); (c) the
  reminders-don't-auto-schedule rule; (d) the `plannerOrder` guidance
  (leave null unless the user asks); (e) the "task notes go through
  `crm.add_project_note` with a `[Task: <title>]` prefix" convention;
  (f) all 7 tool descriptions verbatim from the SPEC table. Updated the
  **Write-safety** subsection with the `crm.delete_task` REFUSE
  behavior and added `crm.complete_task` / `crm.assign_task` to the
  non-destructive list.

#### Step 5 — group CLAUDE.md
- `groups/dimitris-claw/CLAUDE.md` — three new Spanish bullets under
  *Reglas específicas del canal*: (i) `crm.create_task` for actionables
  vs `crm.add_*_note` for historical, (ii) don't auto-schedule
  nanoclaw reminders — Planificador is the reminder, (iii)
  `crm.delete_task` may refuse when TimeEntry rows exist. Added
  `crm.complete_task` and `crm.assign_task` to the existing
  non-destructive-writes list in the pre-existing safety bullet.

## Deviations from SPEC

- **`app/(dashboard)/tasks/actions.ts` gained a backward-compat shim
  for `assigneeId?: string` (single-assignee legacy shape).** The SPEC
  says "rewrite to call `tasksDomain.{createTask,updateTask,deleteTask}`"
  but doesn't say how to handle the pre-existing legacy single-assignee
  input signature. I preserved the input shape (added `assigneeId?:
  string` alongside the new `assigneeIds?: string[]`) and mapped both
  onto `assigneeIds` inside the wrapper. Preserves behavior for any
  caller still passing single-`assigneeId`; new callers should use
  `assigneeIds`. No functional divergence from the SPEC's intent.

- **`app/(dashboard)/planificador/actions.ts:createTaskInPlanner` also
  kept its legacy `assigneeId?: string | null` input parameter.** Same
  reason: the UI dialog at
  `app/(dashboard)/planificador/create-planner-task-dialog.tsx:70`
  still submits `assigneeId` (single). Rather than touch the UI dialog
  in this cycle (which the SPEC calls out as UI-side, and would require
  a MultiUserSelect swap-in), I kept the legacy shape on the action
  and map it to `assigneeIds: [id]` for the domain. Effectively same
  fix as the tasks-actions shim above. Follow-up: migrate the dialog
  to `MultiUserSelect` in a UI-side cycle (captured under "Known
  follow-ups").

- **`lib/actions/tasks.ts:createTaskAction` gained a `requireActor()`
  auth check.** CONTEXT §3.1 notes the pre-refactor
  `lib/actions/tasks.ts` had no `auth()` call and trusted the
  "use server" boundary. Post-refactor, `requireActor()` is required
  by the domain call (it takes an `Actor` param). This is an implicit
  behavior tightening — a caller with no session would previously
  create a task with `assigneeId: null`; post-refactor they'll see
  `"No autenticado"`. Not called out by the SPEC but consistent with
  the same wrapper pattern used by all other refactored actions
  (billing, treasury, projects, clients from the prior cycle). Flagged
  here for the verifier.

- **`app/(dashboard)/projects/[id]/actions.ts` retained the
  `import ... projects` for `deleteProject`'s pre-delete revalidation
  lookup.** SPEC says "Rewrite `createTask`, `updateTask`, `deleteTask`
  to call the domain" — I did that. The `projects` table import stays
  because `deleteProject` (the project-side action, not touched by
  this cycle) still uses it for its own revalidation lookup. Removed
  the `tasks, taskAssignees` imports; kept `projects`. No functional
  drift.

## Audit sweeps performed

### `Task.assigneeId` legacy-read sweep (SPEC Step 2 requirement)

Full sweep with `grep -rn "assigneeId\|task\.assignee\b" app/ components/ lib/`.
Every hit and its disposition:

| File:line | Kind | Verdict |
|---|---|---|
| `lib/schema.ts:151` | Schema column definition (`@deprecated`) | **Left.** SPEC Non-goals: no schema changes this cycle. |
| `lib/schema.ts:527` | `tasksRelations.assignee: one(users, ...)` (`@deprecated`) | **Left.** Same. |
| `app/(dashboard)/settings/actions.ts:143` | `db.update(tasks).set({ assigneeId: null }).where(eq(tasks.assigneeId, userId))` — user-delete FK-nullification hygiene | **Left.** Cleanup targets both columns; deprecated column still exists in the schema, so the cleanup must still run. Not a functional read. |
| `app/(dashboard)/tasks/actions.ts:*` (multiple lines pre-refactor) | Legacy single-assignee `assigneeId` write path | **Migrated.** File rewritten as domain wrapper; legacy `assigneeId?: string` input shape kept for backward compat, mapped to `assigneeIds: [id]` in the domain call. Domain never writes the deprecated column. |
| `app/(dashboard)/planificador/actions.ts:94,115` (pre-refactor) | `createTaskInPlanner` wrote `assigneeId` | **Migrated.** Wrapper now maps `assigneeId` → `assigneeIds` and delegates to `tasksDomain.createTask`. |
| `app/(dashboard)/planificador/create-planner-task-dialog.tsx:58,70,124` | UI form submits `assigneeId?: string` to `createTaskInPlanner` | **Left, safe** — the action wrapper now maps single→multi assignee. Follow-up: swap in MultiUserSelect (out of scope). |
| `app/(dashboard)/planificador/planner-board.tsx:50,184` | Local `PlannerTask` interface has `assigneeId: string \| null`; used in `.filter((t) => t.assigneeId === currentUserId)` | **Left, safe** — the value populating this comes from `page.tsx:189` (`t.assignees?.[0]?.user?.id ?? null`), i.e. the modern `taskAssignees[]` many-relation. No dependency on the deprecated column. |
| `app/(dashboard)/planificador/page.tsx:189` | Serializes `assigneeId: t.assignees?.[0]?.user?.id ?? null` to feed planner-board | **Left, safe** — reads from modern relation, feeds legacy shape. Not a deprecated-column read. |
| `app/(dashboard)/desarrollo/actions.ts:20,29,32` (pre-refactor) | `updateTaskAssignee(taskId, assigneeId)` — deleted + inserted `taskAssignees` (already used the modern many-table but with a single-value parameter name) | **Migrated.** Wrapper now calls `tasksDomain.assignTask(actor, id, assigneeId ? [assigneeId] : [])`. |
| `components/task-modal/types.ts`, `adapters.ts`, `task-modal.tsx`, `components/create-task-dialog.tsx`, `app/(dashboard)/projects/[id]/task-list.tsx` | All use plural `assigneeIds` (multi-assignee modern shape) | **Left, no change needed** — modern shape already. |

**No dead callsites deleted.** All hits are either the (deprecated but
kept) schema column, the FK-nullification cleanup, the migrated action
files, or the planner-board's local `assigneeId` field which is fed
from the modern relation.

### `db.(insert|update|delete)((tasks|taskAssignees))` post-refactor sweep

Ran `grep -rnE "db\.(insert|update|delete)\((tasks|taskAssignees)\)|tx\.(insert|update|delete)\((tasks|taskAssignees)\)"` across `app/`, `components/`, `lib/actions/`.

Hits:
- `lib/domain/tasks.ts` — 9 hits (create + update + delete + assign + complete on `tasks`; delete + insert on `taskAssignees` in `createTask`, `updateTask`, `assignTask`, `deleteTask`). Domain-only, as required.
- `app/(dashboard)/planificador/actions.ts:67` — `reorderTasks` direct write. **Documented exception** per SPEC Non-goals.
- `app/(dashboard)/settings/actions.ts:143` — user-delete FK cleanup. **Not a task write** in the sense the SPEC gate cares about; targets the deprecated column for hygiene during user deletion.

Zero non-exempt hits outside the domain layer. Acceptance gate passes.

### `TASK_DONE` Activity consumer sweep (SPEC Risk #3)

Ran `grep -rn "TASK_DONE" app/ components/ lib/`. Hits:

- `components/activity-timeline.tsx:44` — **Explicit rendering path
  already exists.** `TASK_DONE` maps to `{ icon: CheckCircle, color:
  "text-primary", bgColor: "bg-primary/10", label: "Tarea completada" }`.
  First-ever emission from `completeTask` will render cleanly.
- `app/(dashboard)/projects/[id]/project-detail.tsx:115` and
  `app/(dashboard)/clients/[id]/client-detail.tsx:94` — both declare a
  local `ActivityType` union that includes `TASK_DONE`; both consume
  `activity-timeline.tsx` for rendering, so styling reaches them
  transitively.
- `lib/schema.ts:25` and `lib/prisma-types.ts:18` — enum declarations
  (unchanged).
- `lib/domain/tasks.ts:426` — the new emission site.
- `lib/mcp/tools.ts:597,630` — description text mentioning `TASK_DONE`.

**No unhandled consumer.** No UI-switch on `activity.type` was found
that lacked a `TASK_DONE` case. Risk mitigated without additional diff.

### `MCP-handler-does-not-import-actions` gate

`grep -rn "from '@/app/(dashboard)" lib/mcp/handlers/tasks.ts` → **0 hits.**
Carried-forward gate from prior cycle preserved.

## `tools/list` count

**35** (28 prior + 7 new). Verified by parsing `REGISTRY` object keys
in `lib/mcp/tools.ts`:

```
$ node -e "const s = require('fs').readFileSync('lib/mcp/tools.ts','utf8');
           const m = s.match(/^\s+\"crm\.[a-z_]+\":\s*\{/gm) || [];
           console.log(m.length, m.filter(x => x.includes('task')).length);"
35 7
```

## Local build/typecheck results

### CRM (`~/prj/crm-dimitris`)

- `npx tsc --noEmit --project tsconfig.json` on `app/`, `lib/`,
  `middleware.ts`, `scripts/`, `components/` → **zero errors**.
- Pre-existing `services/whatsapp/**` errors (missing `@types/express`,
  `pino`, `baileys`, `ws` — the WhatsApp sidecar builds in its own
  Dockerfile) are **unchanged and unrelated** — same errors, same count
  as the prior cycle's CHANGES.md documented state.
- `npm run build` (full Next turbopack build) NOT re-run this cycle;
  prior cycle documented the `lightningcss.linux-arm64-gnu.node`
  platform mismatch on the Pi dev host. The docker image builds on
  `node:20-alpine` x64 where it resolves. No CSS-pipeline changes this
  cycle so the situation is unchanged.

### Nanoclaw (`~/prj/nanoclaw`)

- No code changes this cycle — only the two per-group config files
  (both gitignored, both markdown). No build/typecheck needed. The
  nanoclaw MCP allowlist `mcp__crm__*` already covers the new
  `mcp__crm__crm_list_tasks`, `mcp__crm__crm_create_task`, etc. (per
  the delegation preamble).

## Known follow-ups (matches SPEC §Risks + new discoveries)

- **§Risk #1 — orphan-task notes.** `crm.add_project_note` requires a
  `projectId`. For orphan tasks (`projectId IS NULL`), Jarvis currently
  has no way to attach a task-adjacent NOTE. The skill guidance falls
  back to "no puedo dejar nota histórica sobre una tarea sin
  proyecto"; if this hits real use, the design call is either
  (a) surface a `crm.add_orphan_note(taskTitle, body)` tool that
  writes an Activity with all FKs null, or (b) add `taskId` to the
  Activity table. Deferred.
- **§Risk #4 — timezone drift on pre-refactor rows.** Existing tasks
  created via the legacy `T12:00:00` path retain their misaligned
  `dueDate`. This cycle does not migrate them; any future
  `crm.update_task` that touches `dueDate` will heal the row on-touch.
  Rows never touched again stay misaligned. Acceptable per SPEC
  Non-goals.
- **CONTEXT §6.1 — 5 misclassified NOTE rows on 2026-07-17.**
  Explicitly OUT of scope this cycle. Left as historical noise per
  the SPEC Non-goal. A Jarvis-driven manual cleanup can (a) leave the
  two true-duplicate NOTEs (`fase 2`, `OC GIA`) since real Tasks
  already exist and (b) create real Tasks for the three genuinely-novel
  items (`anexos No CEDE`, `cierres de balance`, `devoluciones
  WhatsApp`) — the two Platero rows need re-projecting to the correct
  project (`Platero Fase 2` and `Gestor de Ordenes` respectively) per
  CONTEXT §6.
- **§Risk #12 — `plannerOrder` collisions.** No unique constraint on
  `(plannedDate, timeSlot, plannerOrder)`; skill discourages Jarvis
  from setting it. If Jarvis does set it and collides, the UI
  renders ties.
- **§Risk #10 — rate limit still absent on `/api/mcp`.** Carried
  forward from prior cycle. This cycle adds 7 more write-capable
  tools, marginally widening the DoS surface. Mitigation unchanged
  (30-min container idle timeout).
- **UI dialog `create-planner-task-dialog.tsx` still submits
  single-`assigneeId`.** Deviation above documents that the action
  wrapper now handles both shapes, but the UI itself only exposes a
  single-select. A future UI cycle should swap in `MultiUserSelect` to
  match the Tareas/Desarrollo `CreateTaskDialog`.
- **§Risk #7 — `complete_task` vs `update_task({status:'DONE'})`
  audit-shape divergence.** Documented in the `crm.complete_task` tool
  description and the skill; users going through the "wrong" path get
  a generic `Tarea actualizada: status` NOTE instead of the
  `TASK_DONE` semantic row. Acceptable UX cost.
- **§Risk #8 — fork drift.** Neither the nanoclaw runner nor the
  per-group agent-runner fork was touched this cycle. Prior cycle's
  fork-drift risk is not aggravated by this diff.
- **`ContextNote` semantics on `unplanTask`.** SPEC calls for
  `unplanTask` to clear `contextNote` alongside `plannedDate`,
  `timeSlot`, `plannerOrder`. Implemented as-specified. Pre-existing
  behavior preserved (unplanning discards any planner-cell context
  note; historical/task-level notes should live on Activity instead).

---

## Rev 2 — post-review fix cycle

`/code-review medium` came back clean overall; the hotspots (date
normalization, idempotency, REPLACE semantics, FK guards, type coercion)
verified good. Three findings applied — all in `lib/domain/tasks.ts` (plus
one edit in `lib/mcp/coerce.ts`). No behavior regressions; only new
defensive guards and readability.

### Major

**#1 — `assigneeIds` dedup before `taskAssignees` insert.**
`TaskAssignee` has a unique index on `(taskId, userId)`. A caller sending
`assigneeIds: ["u_abc", "u_abc"]` would previously hit a raw Postgres
`duplicate key value` error — exactly the opaque-error pattern the
`deleteTask` FK guard exists to avoid. Fix applied at two layers:

- `lib/mcp/coerce.ts:asStringArray` — now `Array.from(new Set(cleaned))`
  after the string filter. Covers every MCP call site
  (`create_task` / `update_task` / `assign_task`) automatically since all
  three go through this helper for `assigneeIds`.
- `lib/domain/tasks.ts` — added a private `dedupe<T>` helper; `createTask`,
  `updateTask`, and `assignTask` all filter + `dedupe` + `.slice(0, 5)`
  before the transactional insert. Belt-and-suspenders for UI callers
  that bypass the coercer (e.g. `desarrollo/actions.ts:updateTaskAssignee`
  → `assignTask`).

### Minor

**#2 — `assignTask` audit body now logs names, not raw user IDs.**
`assertUsersExist` was extended to return `Array<{ id, name }>` (it
already selected user rows for the existence check — trivial extension).
`assignTask` uses the returned names to format the audit body as
`"Asignados: Salvador, Erika"` instead of the previous
`"Asignados: usr_abc123, usr_def456"`. No extra query. Empty-array case
still renders `"Asignados: (sin asignar)"`.

**#3 — `normalizeDateInput` T-branch re-anchors to `-03:00` midnight.**
The previous T-branch trusted any string matching `^\d{4}-\d{2}-\d{2}T`
and handed it straight to `new Date(...)`. A future caller passing
`"2026-07-15T00:00:00"` (no offset → JS parses as SERVER-LOCAL midnight,
non-portable) or `"2026-07-15T00:00:00Z"` (UTC midnight → 3h off from
Montevideo) would silently land with a TZ-shifted Date — the exact
invariant the `-03:00` literal exists to prevent. The T-branch now
extracts the date prefix (`slice(0, 10)`) and re-applies the
`YYYY-MM-DDT00:00:00-03:00` template, so every date-shaped input
converges to the same normalized value. Time-of-day is discarded (this
domain stores dates, not datetimes). Chose re-anchor over reject:
forgiving for legitimate re-round-trips, still eliminates the silent
drift.

### Rev 2 build/typecheck

- CRM: `npx tsc --noEmit --project tsconfig.json` on `app/`, `lib/`,
  `middleware.ts`, `scripts/`, `components/` → **zero errors**.
  Pre-existing `services/whatsapp/**` errors unchanged.
- Acceptance greps still pass:
  - `grep -cE "(insert|update|delete)\((tasks|taskAssignees)\)" lib/domain/tasks.ts` → 9 (unchanged).
  - Direct writes outside domain: `planificador/actions.ts:reorderTasks` (SPEC-exempt) and `settings/actions.ts:deleteUser` (deprecated-column cleanup) — unchanged.
  - MCP handler still zero imports from `@/app/(dashboard)`.
- Tool count still **35** (registry untouched in Rev 2).

# SPEC — CRM MCP Tasks extension for `dimitris-claw`

Companion doc: `CONTEXT.md` — full research (schema, existing mutations, three-page layout, duplication findings, timezone footgun). Every claim below cites `file:line` from that doc.

Builds directly on the mold shipped by
`/home/sborit/prj/nanoclaw/docs/specs/20260716_crm_mcp_control_surface/`
(`SPEC.md` for step structure and acceptance style; `CHANGES.md` as evidence
the domain/handler/coerce/tool-registry architecture is stable — Rev 2 landed
clean, `isAgentActor()` gate is in place, `toolContent` envelope is enforced).

## Goal

Extend the CRM MCP surface with 7 Task-CRUD tools so Jarvis (the
`dimitris-claw` WhatsApp agent) stops writing `Activity NOTE` rows when the
user asks it to plan actionable work — and instead operates the real Jira-style
board (`Task` + `TaskAssignee` tables) that already backs the **Tareas**,
**Desarrollo** and **Planificador** pages (CONTEXT §2). All three pages read
from the same `Task` row set; a task with only `dueDate` set already appears
in Planificador for that week (CONTEXT §2.3, §2.4), so no dual-write to a
planner-specific entity is needed. This cycle plugs into the established
`lib/domain/*` + `lib/mcp/*` mold — no new abstractions, no schema changes.

## Non-goals

- **No schema changes.** All columns (`plannedDate`, `timeSlot`, `plannerOrder`, `contextNote`, `dueDate`, `TaskAssignee`, `Task.description`, `Task.priority`) already exist (CONTEXT §1.1, §9). `drizzle-kit push --force` at boot is a no-op on `Task`/`TaskAssignee`.
- **No new tables.** No `TaskComment`, no `TaskChecklistItem`, no rrule/recurrence column.
- **No Google Calendar sync for tasks.** `lib/google-calendar.ts` stays meeting-only (CONTEXT §3.5).
- **No nanoclaw-side scheduler auto-fires for MCP-created tasks.** Jarvis only schedules a WhatsApp ping when the user *explicitly* asks ("recordame", "avísame"). Prompt-level rule in the skill + group CLAUDE.md — no code in `src/task-scheduler.ts` touched.
- **No migration of the 5 misclassified NOTE rows** from CONTEXT §6.1. They stay as historical noise (immutable-audit convention preserved from the prior cycle). A one-shot fix-up (add the 2 genuinely-novel items as real Tasks — see CONTEXT §6.2) is left for a Jarvis-driven manual cleanup after deploy; explicitly out of this SPEC's diff.
- **No changes to the legacy `Task.assigneeId` column.** It stays in the schema as a `@deprecated` vestigial field (CONTEXT §1.1, §1.3). Domain functions never write it. UI reads of `assigneeId` are audited in Step 2 — migrated to `taskAssignees[0]?` only if the callsite is otherwise dead (i.e. the value would be undefined post-refactor); active callsites stay untouched to preserve UI byte-for-byte.
- **No `crm.reorder_task` tool.** Per CONTEXT §1.1 "No `position` / `sortOrder` at the board level" — the only ordering column (`plannerOrder`) is scoped to a `(plannedDate, timeSlot)` planner cell. Instead, `plannerOrder` is exposed as a patchable field on `crm.update_task`. Bulk drag-drop reorder stays UI-only.
- **No standalone `crm.add_task_note` tool.** `Activity` has no `taskId` FK (CONTEXT §1.1 "Notable absences", §4.1: *"Task has no direct FK on Activity, but a project-scoped task's audit row should set `projectId`"*). Task-adjacent notes are covered by `crm.add_project_note` with a `[Task: <title>]` body prefix as a Jarvis convention (skill guidance). This closes the ambiguity in the brief.
- **No refactor of the four planner-specific server actions** in `app/(dashboard)/planificador/actions.ts` beyond routing their DB write through `lib/domain/tasks.ts`. `planTask`, `unplanTask`, `updateContextNote`, `createTaskInPlanner` become thin wrappers over the same domain functions used by the MCP path. `reorderTasks` (bulk plannerOrder update, drag-drop) is left as-is — it's a UI-scoped batch write with no MCP counterpart.
- **No refactor of `app/(dashboard)/desarrollo/actions.ts:updateTaskStatus` semantics.** It becomes a thin wrapper over `updateTask({ status })`. `updateTaskAssignee` becomes a thin wrapper over `assignTask`.
- **No behavior change to UI-side task flows** beyond the domain extraction. Same NOTE-emission-only-when-agent gate (`isAgentActor()`) as the prior cycle: UI writes stay silent, MCP writes get audit rows.

## Scope: standard

Single-repo (CRM) diff, no new tables, no new HTTP surface. New files: `lib/domain/tasks.ts`, `lib/mcp/handlers/tasks.ts`, plus additions to `lib/mcp/tools.ts` and `lib/mcp/coerce.ts`. Refactor of 5 existing task-writing actions files into thin domain-wrappers. Skill + group `CLAUDE.md` copy edits on the nanoclaw side. ~8-10 files touched net.

Standard-scope → `/code-review medium` at the quality gate.

---

## Ordered steps

Steps 1–4 are CRM-side (in `~/prj/crm-dimitris`). Step 5 is skill + group `CLAUDE.md` on the nanoclaw side. Step 6 is DEPLOY.md spot-check. Step 7 is deploy.

### Step 1 — Create `lib/domain/tasks.ts`

**Subject:** Pure functions parameterized by `Actor`. Single source of truth for every Task-table write. Mirrors `lib/domain/leads.ts` shape byte-for-byte (per prior cycle's Rev 2 CHANGES.md, that mold is stable).

**Files touched (in `~/prj/crm-dimitris`):**

- **Create `lib/domain/tasks.ts`.** Exports:

  - `AGENT_USER_ID`-agnostic — audit gating is done through the existing `isAgentActor(actor)` predicate from `lib/domain/activities.ts` (CONTEXT §4.1, prior cycle CHANGES.md Rev 2 finding #13).

  - `normalizeDateInput(input: string | Date | null | undefined): Date | null` — helper. Accepts:
    - `"2026-07-20"` (ISO date, YYYY-MM-DD) → `new Date("2026-07-20T00:00:00-03:00")`.
    - `"2026-07-20T00:00:00-03:00"` (already-normalized ISO with TZ) → pass through as `new Date(...)`.
    - `Date` instance → pass through unchanged (caller responsible).
    - `null` → `null` (explicit clear).
    - `undefined` → `undefined` (field not present in patch, do not touch).
    Rejects any other shape with `throw new Error("Invalid date: <value>")`.
    **Rationale (CONTEXT §1.5, §7 spec `20260508_planner_week_move`):** existing paths mix `T12:00:00` (local) and `T00:00:00-03:00`. This cycle standardizes both `plannedDate` AND `dueDate` on `T00:00:00-03:00` (America/Montevideo). Anything else risks re-triggering the planner-week boundary bug documented in that spec.

  - `createTask(actor: Actor, input: CreateTaskInput): Promise<Task>`
    - `CreateTaskInput` shape: `{ title: string; projectId?: string | null; description?: string; priority?: 'HIGH'|'MEDIUM'|'LOW'; status?: 'TODO'|'IN_PROGRESS'|'DONE'; plannedDate?: string | Date | null; timeSlot?: 'MORNING'|'MIDDAY'|'AFTERNOON' | null; plannerOrder?: number | null; contextNote?: string | null; dueDate?: string | Date | null; assigneeIds?: string[]; }`.
    - Validation up front: `title.trim()` non-empty → else `throw new Error("El título es requerido")`. `assigneeIds?.slice(0, 5)` cap (mirrors `lib/actions/tasks.ts:20`, `app/(dashboard)/projects/[id]/actions.ts:64,117` — CONTEXT §1.2, §3.1). If `projectId` supplied, verify the project exists via `getProject(projectId)` (CONTEXT §4.6) — else `throw new Error("Proyecto no encontrado: ${projectId}")`.
    - Date normalization: run `plannedDate` and `dueDate` through `normalizeDateInput` **only if the caller passed them** (never re-normalize on absence — closes CONTEXT §Risks "does update re-normalize unrelated fields").
    - Transactional insert (mirrors `app/(dashboard)/projects/[id]/actions.ts:66-83` — CONTEXT §3.1):
      ```
      db.transaction(async tx => {
        const [row] = await tx.insert(tasks).values({
          title, projectId, description, priority, status,
          plannedDate: normalized, timeSlot, plannerOrder, contextNote,
          dueDate: normalized,
          // NOTE: assigneeId NOT written — modern path uses taskAssignees[]
        }).returning();
        if (assigneeIds?.length) {
          await tx.insert(taskAssignees).values(
            assigneeIds.slice(0, 5).map(userId => ({ taskId: row.id, userId }))
          );
        }
        if (isAgentActor(actor)) {
          const projectClientId = projectId ? (await getProject(projectId))?.clientId ?? null : null;
          await recordActivity(actor, {
            type: 'NOTE',
            body: `Tarea creada: ${title}`,
            projectId: projectId ?? null,
            clientId: projectClientId,
          }, tx);
        }
        return row;
      });
      ```
    - Returns the inserted `Task` row.

  - `updateTask(actor: Actor, id: string, patch: UpdateTaskPatch): Promise<Task>`
    - `UpdateTaskPatch` shape: every `CreateTaskInput` field, all optional. `assigneeIds` handled via REPLACE semantics (see below — same transactional shape as `projects/[id]/actions.ts:updateTask` per CONTEXT §3.2).
    - Only fields the caller passed are included in the `db.update().set({...})` payload (`build<T>(entries)` pattern from `lib/mcp/coerce.ts:build` — CONTEXT §4.5).
    - `plannedDate` and `dueDate` in `patch` go through `normalizeDateInput` before being written. Fields NOT present in `patch` are never re-normalized (guarantees an update touching only `title` doesn't re-write `plannedDate`).
    - If `assigneeIds !== undefined`: inside the same transaction, `tx.delete(taskAssignees).where(eq(taskAssignees.taskId, id))` then bulk `tx.insert(taskAssignees).values(...)` (canonical REPLACE pattern from CONTEXT §3.2).
    - Guard: `if (!updated) throw new Error("Tarea no encontrada")` (mirrors Rev 2 CRM #11 fix from prior cycle).
    - Audit: if `isAgentActor(actor)`, `recordActivity(actor, { type: 'NOTE', body: 'Tarea actualizada: ' + Object.keys(patch).join(', '), projectId, clientId }, tx)` (mirrors `updateProject` at `lib/domain/projects.ts` from prior cycle).
    - Returns updated `Task` row.

  - `completeTask(actor: Actor, id: string): Promise<Task>`
    - Convenience wrapper: sets `status = 'DONE'` transactionally, THEN emits `Activity` with `type = 'TASK_DONE'` (CONTEXT §1.4: enum value exists, never emitted). Body: `"Tarea completada: <title>"`. FK: `projectId` (derived from task row) + `clientId` (derived from project). This lights up the `TASK_DONE` enum value for the first time.
    - Idempotency-ish: if task is already `status === 'DONE'`, still runs the UPDATE (no-op set), but DOES NOT emit a second `TASK_DONE` activity. Rationale: replayable without spamming the audit log.
    - Guard: `if (!task) throw new Error("Tarea no encontrada")`.
    - Always emits `TASK_DONE` (not gated on `isAgentActor`) — matches the semantics of `updateLeadStatus` at `lib/domain/leads.ts:189` per CONTEXT §4.2 ("UI already does this — no behavior drift"). But wait: current UI does NOT emit any activity on task-status change (CONTEXT §3.1 "Activity emission: NONE"). So we ARE lighting up new behavior for the UI path too. Decision: gate on `isAgentActor(actor)` for parity with the "UI writes stay silent" invariant of the domain mold — UI's status-change server action can opt-in later. **Documented deviation from `updateLeadStatus`'s always-audit rule; explicitly chosen for UI-parity preservation.**

  - `assignTask(actor: Actor, id: string, assigneeIds: string[]): Promise<Task>`
    - REPLACE semantics: `assigneeIds` (cap 5) overwrites the entire `taskAssignees` set for `id`.
    - Transactional: `tx.delete(taskAssignees).where(eq(taskAssignees.taskId, id))` then bulk insert.
    - Empty array → clears all assignees.
    - `assigneeIds` validation: each must be a valid User row (batch `SELECT id FROM users WHERE id IN (...)`; if any missing, throw `"Usuario no encontrado: <id>"`).
    - Guard: task must exist first (else `"Tarea no encontrada"`).
    - Audit (agent only): `body = "Asignados: " + assigneeIds.join(', ')`.
    - Returns updated `Task` row (with `.returning()` on the outer no-op update, or a subsequent `SELECT` — pick whichever keeps the diff smaller).

  - `deleteTask(actor: Actor, id: string): Promise<{ deleted: true }>`
    - **REFUSES if TimeEntry rows reference this task** (CONTEXT §5.1 + §Architecture footgun: `TimeEntry.taskId` FK is default RESTRICT — a raw delete would FK-fail with an opaque Postgres error).
    - Guard shape: `const count = (await db.select({ n: sql\`count(*)\` }).from(timeEntries).where(eq(timeEntries.taskId, id)))[0]?.n ?? 0; if (count > 0) throw new Error(\`Cannot delete: ${count} time entries logged; delete those first\`);`. Message wording matches the user brief verbatim. The MCP handler catches this and returns it as `{ isError: true, text: "..." }` via `toolContent(..., true)` (prior cycle §Rev 2 finding #4).
    - Guard: task must exist (else `"Tarea no encontrada"`).
    - `db.delete(tasks).where(eq(tasks.id, id))` — cascades handle `taskAssignees` (CONTEXT §1.2 `onDelete: cascade`).
    - Audit (agent only): `body = "Tarea eliminada: <title>"` before the delete (so the audit row keeps a `taskId`-free but title-preserving trail).
    - Returns `{ deleted: true }`.

  - `listTasks(filters: ListTasksFilters): Promise<TaskWithRelations[]>`
    - `ListTasksFilters`: `{ projectId?: string; status?: TaskStatus | TaskStatus[]; assigneeId?: string; plannedDateFrom?: string | Date; plannedDateTo?: string | Date; dueDateFrom?: string | Date; dueDateTo?: string | Date; includeCompleted?: boolean; limit?: number; }`.
    - Default: `includeCompleted = false` → filter out `status = 'DONE'`.
    - `assigneeId` filter uses `taskAssignees` (post-query filter or subquery — mirrors `app/(dashboard)/desarrollo/page.tsx:66-76` per CONTEXT §2.2).
    - Return shape: `Task` row + `{ assignees: User[]; projectName?: string; clientName?: string }` — mirror `db.query.tasks.findMany({ with: { project: { with: { client: true } }, assignees: { with: { user: true } } } })` (CONTEXT §2.1).
    - `limit` default 50, cap 200.

  - `getTask(id: string): Promise<TaskWithRelations & { timeEntryCount: number } | null>`
    - Same shape as `listTasks` return, plus `timeEntryCount = count of TimeEntry where taskId = id` (surfaces the delete-refuse condition to the caller pre-emptively).
    - Null if no row.

- **No changes to `lib/schema.ts`, `lib/prisma-types.ts`, or any migration.** All columns and enum values referenced above already exist (CONTEXT §1.1, §1.4).

**Acceptance:**

- `npx tsc --noEmit --project tsconfig.json` on `app/`, `lib/`, `middleware.ts`, `scripts/`, `components/` → **zero errors**.
- `grep -n "recordActivity\|isAgentActor" lib/domain/tasks.ts` shows every mutation writes an activity through the shared helper, gated on `isAgentActor`.
- `grep -n "assigneeId" lib/domain/tasks.ts` returns **zero** hits (domain never touches the deprecated legacy column — CONTEXT §1.1, §7 spec `20260330_TAREAS_FILTER_AND_DESARRELLO_BUG` invariant).
- `grep -n "T12:00:00\|new Date(.*T00:00:00-03:00)" lib/domain/tasks.ts` — every `T00:00:00-03:00` occurrence is inside `normalizeDateInput`; no ad-hoc `T12:00:00` (closes CONTEXT §1.5 timezone drift).
- Unit-style manual check via `tsx`: instantiate `createTask` with only `dueDate: '2026-07-20'` → resulting row's `dueDate` is exactly `2026-07-20T00:00:00-03:00`. Same for `plannedDate`.
- `deleteTask` with a task that has ≥1 TimeEntry throws the exact message `"Cannot delete: 1 time entries logged; delete those first"` (or the correct count).
- Depends on: nothing new. Uses `activities`, `getProject`, `isAgentActor`, `recordActivity` already shipped by the prior cycle.

---

### Step 2 — Refactor the five existing task-writing action files into thin wrappers

**Subject:** Extract every `db.insert(tasks)` / `db.update(tasks)` / `db.delete(tasks)` write from the pre-existing task-action files (CONTEXT §3 lists all five) into `lib/domain/tasks.ts` calls. Server actions become `await auth()` + role guard + call-domain + `revalidatePath` wrappers.

**Files touched:**

- `app/(dashboard)/tasks/actions.ts` (CONTEXT §3, legacy path — writes `assigneeId`, does NOT touch `taskAssignees`). Rewrite `createTask`, `updateTask`, `deleteTask` to call `tasksDomain.{createTask,updateTask,deleteTask}` with `actor = { userId: session.user.id }` (no `senderLabel`, UI path). **This is the file that historically re-introduced the CONTEXT §7 spec `20260330_TAREAS_FILTER_AND_DESARROLLO_BUG` regression** — post-refactor, it writes `taskAssignees[]` via the domain instead of the deprecated `assigneeId`. This is an intentional UI-visible fix, documented explicitly (see acceptance note below on the UI-read audit).

- `app/(dashboard)/projects/[id]/actions.ts:52-152` (CONTEXT §3, modern path). Rewrite `createTask`, `updateTask`, `deleteTask` to call the domain. Remove the header comment on line 50 (*"Task CRUD stays here — tasks are out of scope for the MCP surface"* per CONTEXT §3) — it's now stale.

- `lib/actions/tasks.ts` (CONTEXT §3, shared entry point used by `CreateTaskDialog` on both Tareas and Desarrollo). Rewrite `createTaskAction` to call `tasksDomain.createTask`.

- `app/(dashboard)/desarrollo/actions.ts` (CONTEXT §3): rewrite `updateTaskStatus(taskId, newStatus)` → `tasksDomain.updateTask(actor, taskId, { status: newStatus })`. Rewrite `updateTaskAssignee(taskId, assigneeId)` → `tasksDomain.assignTask(actor, taskId, assigneeId ? [assigneeId] : [])` (single-assignee legacy UI, now routed through the multi-assignee REPLACE domain).

- `app/(dashboard)/planificador/actions.ts` (CONTEXT §3.4): rewrite `planTask`, `unplanTask`, `updateContextNote`, `createTaskInPlanner` to call the domain. `planTask({ taskId, plannedDate, timeSlot, plannerOrder })` → `tasksDomain.updateTask(actor, taskId, { plannedDate, timeSlot, plannerOrder })`. `unplanTask(taskId)` → `updateTask(actor, taskId, { plannedDate: null, timeSlot: null, plannerOrder: null, contextNote: null })`. `updateContextNote(taskId, note)` → `updateTask(actor, taskId, { contextNote: note })`. `createTaskInPlanner({...})` → `createTask(actor, {...})` (fixes CONTEXT §3.4's pre-existing bug: `createTaskInPlanner` currently writes deprecated `assigneeId` and doesn't accept `assigneeIds`; the domain path now accepts `assigneeIds` correctly). `reorderTasks(updates[])` (bulk drag-drop plannerOrder update) is LEFT AS-IS — it's a UI-scoped batch write with no MCP counterpart and no test coverage for the refactor.

- `components/task-modal/actions.ts:updateTaskFromModal` (CONTEXT §3, thin wrapper) — already delegates to `projects/[id]/actions.ts:updateTask`; no change needed after Step 2 lands, since that upstream now calls the domain. Verify by grep-inspection only.

**UI-read audit for the deprecated `Task.assigneeId` column:** grep the codebase for any read that depends on `tasks.assigneeId` and decide fix-vs-leave per callsite:

```
grep -rn "assigneeId\|task\.assignee\b" app/ components/ lib/
```

For each hit:
- **If the read is via the drizzle relation `assignee: one(users)` (CONTEXT §1.3 `tasksRelations`):** migrate to `assignees[0]?.user` (the modern `taskAssignees` many-relation). Post-refactor, `assigneeId` is only written by legacy `tasks/actions.ts:createTask` which is being retired in this step — so any read that expects `assigneeId` to be populated will start returning `null` for newly-created tasks. Fix these callsites in the same commit.
- **If the read is a raw `SELECT ... assigneeId ...`:** same treatment. Migrate to `taskAssignees[0]?.userId`.
- **If the callsite is dead (never invoked from the current UI):** leave the schema column and relation as-is (per Non-goals), delete only the dead callsite.

Log every hit and disposition in a Rev 1 CHANGES.md sub-section modeled on prior cycle's "Audit sweeps performed" section.

**Acceptance:**

- `npx tsc --noEmit ...` → zero errors.
- `grep -nE "db\.(insert|update|delete)\((tasks|taskAssignees)\)" app/\(dashboard\)/**/actions.ts lib/actions/tasks.ts components/task-modal/actions.ts` returns **zero** hits (all direct writes to `tasks` and `taskAssignees` moved to `lib/domain/tasks.ts`). Exception: `planificador/actions.ts:reorderTasks` is allowed to retain its direct write (documented in Non-goals).
- `grep -nE "db\.(insert|update|delete)\((tasks|taskAssignees)\)" lib/domain/tasks.ts` returns **≥ 6** hits (create + update + delete + assign + complete on tasks, plus insert/delete on taskAssignees).
- Manual UI smoke — all three pages (Tareas, Desarrollo, Planificador) still work byte-for-byte for a human user:
  - Create a task via `CreateTaskDialog` on Tareas → row appears in Tareas + Desarrollo + Backlog column of Planificador (CONTEXT §2). Assignees stack in the avatar (proves `taskAssignees[]` is written correctly on the ex-legacy path — CONTEXT §7 regression NOT re-introduced).
  - Drag a task in Planificador into MORNING slot → row's `plannedDate`, `timeSlot`, `plannerOrder` update (via `planTask` → domain `updateTask`).
  - Mark a task as `IN_PROGRESS` in the Desarrollo kanban → row's `status` updates (via `updateTaskStatus` → domain `updateTask`).
  - Edit an assignee in the Task modal → `taskAssignees` REPLACE pattern executes (via `updateTaskAssignee` → domain `assignTask`).
- **Assignee-column regression check:** create a task via `CreateTaskDialog` on Tareas AFTER the refactor. In `psql`, `SELECT id, "assigneeId" FROM "Task" WHERE title='<new title>'`. Expected: `assigneeId IS NULL` (domain never writes it). Then `SELECT "userId" FROM "TaskAssignee" WHERE "taskId"='<new id>'` — expected: the assignee row(s) present. This proves the legacy `tasks/actions.ts` code path no longer writes the deprecated column (which was the whole point of CONTEXT §7 spec `20260330_TAREAS_FILTER_AND_DESARROLLO_BUG`).
- Depends on: Step 1.

---

### Step 3 — Register MCP tools + handlers

**Subject:** Add the 7 Task tools to the MCP registry. Handler file mirrors `lib/mcp/handlers/leads.ts` mold. Coerce module extended with task enum constants and patch coercers.

**Files touched:**

- **Edit `lib/mcp/coerce.ts`** (CONTEXT §4.5):
  - Add enum constants at the top of the file (alongside `LEAD_STATUS`, `PRIORITY`, etc.):
    ```
    const TASK_STATUS = ['TODO','IN_PROGRESS','DONE'] as const;
    const TIME_SLOT   = ['MORNING','MIDDAY','AFTERNOON'] as const;
    ```
  - Add `coerceTaskCreateInput(args)` and `coerceTaskPatch(args)` functions, mirroring `coerceLeadPatch` shape. Fields validated:
    - `title` — `asString`, required for create, forbidden for patch.
    - `projectId` — `asStringOrNull`.
    - `description` — `asStringOrNull`.
    - `priority` — `asEnum(v, 'priority', PRIORITY)`.
    - `status` — `asEnum(v, 'status', TASK_STATUS)`.
    - `plannedDate` — `asStringOrNull` (the domain's `normalizeDateInput` handles the date coercion; coerce here just validates it's a string or null).
    - `timeSlot` — `asEnum(v, 'timeSlot', TIME_SLOT)` — but also accept `null` to clear. Extend `asEnum` if needed, or handle at coerce site.
    - `plannerOrder` — `asNumberOrNull`.
    - `contextNote` — `asStringOrNull`.
    - `dueDate` — `asStringOrNull`.
    - `assigneeIds` — array of strings; strip non-string entries; cap 5. Add a `asStringArray(v, field)` helper if not already present.
  - `build<T>(entries)` (CONTEXT §4.5) still handles dropping `undefined` keys.

- **Create `lib/mcp/handlers/tasks.ts`** (mirrors `lib/mcp/handlers/leads.ts` mold — CONTEXT §4.4):
  - Imports `* as tasks from '@/lib/domain/tasks'`, `coerceTaskCreateInput`, `coerceTaskPatch` from `../coerce`, and local `s(args, key)` / `n(args, key)` helpers per `handlers/leads.ts:14-21`.
  - Named handlers:
    - `listTasks(actor, args)` → coerce filters → `tasks.listTasks(...)`.
    - `getTask(actor, args)` → `tasks.getTask(s(args,'id'))`.
    - `createTask(actor, args)` → `tasks.createTask(actor, coerceTaskCreateInput(args))`.
    - `updateTask(actor, args)` → `tasks.updateTask(actor, s(args,'id'), coerceTaskPatch(stripId(args)))`.
    - `completeTask(actor, args)` → `tasks.completeTask(actor, s(args,'id'))`.
    - `assignTask(actor, args)` → `tasks.assignTask(actor, s(args,'id'), coerceAssigneeIds(args.assigneeIds))`.
    - `deleteTask(actor, args)` → `tasks.deleteTask(actor, s(args,'id'))`.
  - **NEVER** imports from `@/app/(dashboard)/...` — carried-forward gate from prior cycle's Step 6 acceptance.

- **Edit `lib/mcp/tools.ts`** — add 7 entries to `REGISTRY` (CONTEXT §4.3):

  | Tool name              | Handler                    | Description (verbatim, will land in `TOOL_DEFS[i].description`) |
  |---                     |---                         |---                                                              |
  | `crm.list_tasks`       | `tasks.listTasks`          | *"List tasks with optional filters (project, status, assignee, planned/due date ranges). Defaults to excluding DONE. Returns tasks with `assignees[]`, `projectName`, `clientName`."* |
  | `crm.get_task`         | `tasks.getTask`            | *"Get full task detail including assignees, project, and time-entry count. Null if not found."* |
  | `crm.create_task`      | `tasks.createTask`         | *"Create a task. Accepts `title` (req), `projectId?`, `description?`, `priority?`, `status?`, `plannedDate?` (ISO date), `timeSlot?` (MORNING/MIDDAY/AFTERNOON), `plannerOrder?`, `contextNote?`, `dueDate?` (ISO date), `assigneeIds?` (up to 5). A task with only `dueDate` set appears in the Planificador that week automatically — no separate `plan_task` call needed. Transactional."* |
  | `crm.update_task`      | `tasks.updateTask`         | *"Update any task field. Only fields present in the patch are touched; unrelated fields (including `plannedDate` / `dueDate`) are NOT re-normalized. `assigneeIds` is REPLACE semantics — overwrites the full set (cap 5)."* |
  | `crm.complete_task`    | `tasks.completeTask`       | *"Convenience: set status=DONE and emit an Activity of type TASK_DONE (visible in project/client activity feeds). Idempotent — running twice on an already-DONE task does not spam a second Activity row."* |
  | `crm.assign_task`      | `tasks.assignTask`         | *"REPLACE the assignee set for a task with the given `assigneeIds` list (max 5, empty array clears). Transactional."* |
  | `crm.delete_task`      | `tasks.deleteTask`         | *"Delete a task. **REFUSES if the task has TimeEntry rows** — returns an error asking you to delete those first. Cascade handles TaskAssignee cleanup."* |

  Naming: **dot-separated `crm.*`** (matches prior cycle's convention — Anthropic SDK exposes them as `mcp__crm__crm_list_tasks` etc.). Prior cycle's Rev 2 landed clean with this naming, so no change.

- **Input-schema policy:** every tool gets a full `inputSchema: { type: 'object', properties: {...}, required: [...] }`. Field-level schemas mirror the `CreateTaskInput` / `UpdateTaskPatch` shapes from Step 1 verbatim. Enums declared inline (`{ enum: ['TODO','IN_PROGRESS','DONE'] }`, etc.) so the SDK client can validate at call time.

- **`tools/call` result envelope:** every handler's return value is wrapped in `toolContent(payload)` by the existing `callTool()` dispatcher (`lib/mcp/tools.ts` — prior cycle §Rev 2 finding #4). Domain `throw new Error(...)` bubbles up and lands as `{ isError: true, content: [{ type: 'text', text: err.message }] }`. This is why the `deleteTask` refuse-with-message pattern works: the domain throws → dispatcher catches → agent sees a clean error.

**Acceptance:**

- `tsc --noEmit` → zero errors.
- `curl -sS -X POST -H "Authorization: Bearer $MCP_BEARER_TOKEN" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' http://localhost:26901/api/mcp | jq '.result.tools | length'` → **35** (was 28 per prior cycle CHANGES.md Deviations note; 28 + 7 new = 35). **Any deviation from 35 must be justified in the CHANGES.md** (e.g. if a further tool consolidation happens during Step 3).
- `curl ... method=tools/list ... | jq '.result.tools[].name' | grep -c 'task'` → **≥ 7**.
- `curl ... method=tools/call params.name=crm.list_tasks params.arguments={} ... | jq '.result.content[0].text'` returns a JSON list.
- `curl ... method=tools/call params.name=crm.create_task params.arguments={"title":"acceptance smoke","projectId":"<real project id>"} ... | jq '.result.content[0].text'` returns the created task; `SELECT * FROM "Task" WHERE title='acceptance smoke'` finds the row; paired `Activity NOTE` with `[MCP · local-smoke]` prefix (via the sender header) exists on `projectId`.
- `curl ... method=tools/call params.name=crm.delete_task params.arguments={"id":"<task with time entries>"} ...` returns `{ isError: true, content: [{ text: "Cannot delete: N time entries logged; delete those first" }] }`.
- **Carried-forward gate — MCP-handler-does-not-import-actions:** `grep -rn "from '@/app/(dashboard)" lib/mcp/handlers/tasks.ts` returns **zero** hits.
- Depends on: Step 1.

---

### Step 4 — Skill overhaul: `crm-access.md`

**Subject:** Teach Jarvis about the new task tools. Add a "Tasks" section. Update "Write-safety" to include the delete-refuse-not-delete semantics. Add the "actionable → tasks, historical → notes" rule so Jarvis stops mis-using `add_*_note` for planificable items.

**Files touched (in `~/prj/nanoclaw`):**

- **Edit `data/sessions/dimitris-claw/.claude/skills/dimitris/crm-access.md`** (per prior cycle's Step 9):
  - **Add a new "Tasks" subsection** under the *"MCP tools (primary — reads and writes)"* section. Lists all 7 new tools with the exact descriptions from Step 3's tool inventory table (verbatim — same convention as the prior cycle for `convert_lead_to_client`, `update_client`, `update_invoice`).
  - **Update the "Write-safety" subsection** to add `crm.delete_task` alongside `crm.delete_cash_entry` in the "operations that surface a REFUSE at the server if a precondition fails" note. Language:
    > *"`crm.delete_task` refuses (returns `isError:true`) if the task has any TimeEntry rows. Not technically destructive server-side — it never runs — but users experience it as a failed delete. When you're about to call it, describe the task first ('voy a borrar la tarea X'); if the server refuses, relay the error verbatim and offer to delete the time entries first."*
    > *"`crm.delete_cash_entry` is still the only truly irreversible MCP operation (also deletes attached file). Same describe-then-write flow as before."*
  - **Add an "Actionable vs historical" guidance bullet** at the top of the "Tasks" subsection:
    > *"For actionable to-do items (things the user wants tracked as work, with a due date, planning slot, or assignee) — use `crm.create_task`. It automatically appears in Tareas, Desarrollo AND Planificador. DO NOT use `crm.add_project_note` / `crm.add_client_note` / `crm.add_lead_note` for actionable items — those are for historical / non-planificable notes. Reference: five recent NOTEs at `docs/specs/20260717_crm_mcp_tasks/CONTEXT.md §6.1` were this mistake — never repeat it."*
  - **Add a "Reminders" bullet:**
    > *"Do NOT auto-schedule nanoclaw reminders (`schedule.*` or task-scheduler primitives) for MCP-created tasks. The Planificador appearance IS the reminder. Only schedule a WhatsApp ping when the user *explicitly* asks ('recordame', 'avísame', 'mandame un mensaje mañana', etc.)."*
  - **Add a "Before creating, list" bullet:**
    > *"Before creating a new task, call `crm.list_tasks({ projectId, includeCompleted: false })` first to check for duplicates. The 2026-07-17 incident (CONTEXT §6.2) had 2 true-duplicate NOTEs written against pre-existing Tasks — that would have been caught with a list-first check."*

**Acceptance:**

- `grep -c "crm.create_task\|crm.update_task\|crm.delete_task\|crm.complete_task\|crm.assign_task\|crm.list_tasks\|crm.get_task" data/sessions/dimitris-claw/.claude/skills/dimitris/crm-access.md` returns **≥ 7**.
- `grep -c "actionable\|accionable\|Actionable\|Accionable" data/sessions/dimitris-claw/.claude/skills/dimitris/crm-access.md` returns **≥ 1**.
- `grep -c "TimeEntry\|time entries" data/sessions/dimitris-claw/.claude/skills/dimitris/crm-access.md` returns **≥ 1** (delete-refuse language).
- Depends on: Step 3 (tool inventory must be finalized).

---

### Step 5 — Group `CLAUDE.md`: add actionable-vs-note guardrail

**Subject:** Prompt-level rule steering Jarvis away from the `add_*_note` mistake at the group level (belt-and-suspenders with the skill).

**Files touched (in `~/prj/nanoclaw`):**

- **Edit `groups/dimitris-claw/CLAUDE.md`** (per prior cycle's Step 10):
  - **Add one Spanish bullet** to the "Reglas específicas del canal" section (or wherever the prior cycle's guardrail lives — verify by reading before editing):
    > *"Para tareas accionables usá `crm.create_task` — aparece en Tareas, Desarrollo y Planificador automáticamente. `crm.add_project_note` / `add_client_note` / `add_lead_note` son solo para notas históricas no-accionables. Antes de crear, listá con `crm.list_tasks({ projectId, includeCompleted: false })` para no duplicar."*
  - **Add one Spanish bullet** on reminders:
    > *"No auto-programés recordatorios (nanoclaw scheduler) para tareas MCP. La aparición en Planificador ya es el recordatorio. Programá ping de WhatsApp solo si el usuario lo pide explícito ('recordame', 'avísame')."*
  - **Add `crm.delete_task` to the destructive-ops list** in the existing safety bullet from the prior cycle (which already lists `crm.delete_cash_entry`):
    > *"`crm.delete_task` puede rechazar el borrado si la tarea tiene TimeEntry — describí la tarea primero y, si el server refuse, ofrecé borrar los time entries antes."*

**Acceptance:**

- `grep -c "crm.create_task\|crm.list_tasks" groups/dimitris-claw/CLAUDE.md` returns **≥ 2**.
- `grep -c "recordame\|avísame\|Planificador" groups/dimitris-claw/CLAUDE.md` returns **≥ 1**.
- `grep -c "crm.delete_task" groups/dimitris-claw/CLAUDE.md` returns **≥ 1**.
- Depends on: none directly, but sensible to land alongside Step 4.

---

### Step 6 — CRM `DEPLOY.md` spot-check

**Subject:** No changes expected. Verify the MCP surface subsection (added in prior cycle Step 11) does NOT reference a specific tool count — if it does, bump it.

**Files touched (conditionally):**

- **Read `DEPLOY.md`** in `~/prj/crm-dimitris`. If the "MCP surface" subsection mentions a tool count (e.g. "29 tools"), update to reflect the new count (35). If it doesn't, no change.

**Acceptance:**

- `grep -c "tool" DEPLOY.md` — if the count is referenced, it matches the new total.
- Otherwise, `git diff DEPLOY.md` is empty.

---

### Step 7 — Deploy

**Subject:** Ship in dependency order. No schema migration.

**Ordered ops:**

1. **CRM local build + smoke:** in `~/prj/crm-dimitris`, `npx tsc --noEmit && docker compose up -d --build`. Verify Steps 1, 2, 3 acceptance criteria against `http://localhost:26901/api/mcp`.
2. **CRM UI regression pass:** all three pages (Tareas, Desarrollo, Planificador) still work byte-for-byte — see Step 2 acceptance manual smoke.
3. **Push CRM to `main` + prod deploy:** commit Steps 1–3 and 6 on `main`. SSH `h-dmi-a`, `cd /srv/crm-dimitris && git pull && docker compose up -d --build`. `drizzle-kit push --force` at container boot no-ops on Task/TaskAssignee (no schema change).
4. **Nanoclaw local build + restart:** in `~/prj/nanoclaw`, `npm run build && systemctl --user restart nanoclaw`. Commit Steps 4 and 5 to `develop` (or `sba` per the branching strategy).
5. **Acceptance vertical from a real WhatsApp message** — see below.

---

## Acceptance (end-to-end vertical)

From the `dimitris-claw` WhatsApp group, sending as Salvador (`+549…`):

- [ ] **(a) list tasks** — "listame las tareas abiertas del proyecto Analisis de Creditos" → agent calls `crm.list_tasks({ projectId: '<r8yruwewge8pdjqj1ahg1vr5>', includeCompleted: false })` and returns a list with status, dueDate, plannedDate/timeSlot columns. CRM logs show the call with the sender header.

- [ ] **(b) create with dueDate only** — "creá una tarea 'test-dueDate MCP' con dueDate 2026-07-20 para el proyecto Analisis de Creditos" → agent calls `crm.create_task` with only `dueDate: '2026-07-20'` set (no `plannedDate` / `timeSlot`). `SELECT id, "dueDate", "plannedDate", "timeSlot" FROM "Task" WHERE title='test-dueDate MCP'` returns the row with `dueDate = '2026-07-20 03:00:00+00'` (i.e. `T00:00:00-03:00` normalized — closes CONTEXT §1.5 timezone footgun), `plannedDate IS NULL`, `timeSlot IS NULL`. The task appears in the Planificador for the week of 2026-07-20 under the "date-only" row (CONTEXT §2.3, §2.4 — proves no dual-write to a planner entity needed).

- [ ] **(c) create with plannedDate + timeSlot** — "creá una tarea 'test-planned MCP' plannedDate 2026-07-21 slot MORNING proyecto Analisis de Creditos" → agent calls `crm.create_task` with `plannedDate: '2026-07-21', timeSlot: 'MORNING'`. Row's `plannedDate = '2026-07-21 03:00:00+00'`, `timeSlot = 'MORNING'`. Appears in Planificador in the MORNING cell of 2026-07-21.

- [ ] **(d) assign to multiple users** — "asignale esa tarea a Salva y Erika" → agent calls `crm.assign_task(id, [salvaUserId, erikaUserId])`. `SELECT "userId" FROM "TaskAssignee" WHERE "taskId"='<id>'` returns exactly 2 rows. Stacked avatars appear in the Task modal in the UI.

- [ ] **(e) reassign (REPLACE semantics)** — "cambia esos asignados por solo Salva" → agent calls `crm.assign_task(id, [salvaUserId])`. `SELECT COUNT(*) FROM "TaskAssignee" WHERE "taskId"='<id>'` returns 1. Proves REPLACE, not APPEND (design decision 2 from user brief).

- [ ] **(f) mark done + verify TASK_DONE Activity** — "marcá esa tarea como hecha" → agent calls `crm.complete_task(id)`. Task row `status = 'DONE'`. `SELECT type, body FROM "Activity" WHERE type='TASK_DONE' AND "createdAt" > now() - interval '1 minute'` returns exactly one row with body `[MCP · Salvador (…)] Tarea completada: test-planned MCP`. **This is the first-ever emission of `TASK_DONE`** (CONTEXT §1.4). Idempotency check: run "marcá esa tarea como hecha" AGAIN — no second `TASK_DONE` row appears (`SELECT COUNT(*) FROM "Activity" WHERE type='TASK_DONE' AND body LIKE '%test-planned MCP%'` remains 1).

- [ ] **(g) refuse-to-delete on task with time entries** — pick a task that has ≥1 TimeEntry row. Try "borrá esa tarea" → agent describes the target task, calls `crm.delete_task(id)`, receives `isError: true` with text `"Cannot delete: N time entries logged; delete those first"`. Agent relays the error verbatim and offers to delete the time entries first (skill guidance from Step 4). Task row still exists.

- [ ] **(h) edit any field** — "cambiale la prioridad a HIGH y el título a 'test-planned MCP editado'" → agent calls `crm.update_task(id, { priority: 'HIGH', title: '...' })`. Row updated. `plannedDate` and `dueDate` on the row are UNCHANGED (proves the "only normalize fields the caller passed" rule from Step 1 — closes the CONTEXT §Risks item).

- [ ] **(i) note via project (not standalone task-note)** — "agregale una nota histórica 'seguimos el 22' a esa tarea" → agent recognizes there is no `crm.add_task_note` (per Non-goals), uses `crm.add_project_note` with `body = '[Task: test-planned MCP editado] seguimos el 22'`. Activity row exists on the parent `projectId` with the `[Task: ...]` prefix.

- [ ] **(j) appearance in Planificador — final verification** — open `https://gaston.dimitris.app/planificador` in a browser. `test-planned MCP editado` appears in the MORNING cell of 2026-07-21 with priority HIGH. `test-dueDate MCP` appears in the date-only row of 2026-07-20. `test-planned MCP` (now DONE) is filtered out per the planner query's `status != DONE` predicate (CONTEXT §2.3).

- [ ] **Every Activity from steps (b)-(i)** carries the `[MCP · Salvador (+549…)]` prefix in `body` (prior cycle's sender-label invariant, unchanged).

- [ ] **Regression:** create a task via the Tareas page `CreateTaskDialog` in the UI. Resulting Activity row (if any) does NOT have the `[MCP · …]` prefix (proves UI path bypasses `senderLabel` via `isAgentActor` gate — prior cycle's Rev 2 finding #13 invariant preserved).

- [ ] **Regression:** create a task via the UI with an assignee. `SELECT "assigneeId" FROM "Task" WHERE title='<new>'` returns NULL. `SELECT "userId" FROM "TaskAssignee" WHERE "taskId"='<new id>'` returns the assignee. Proves CONTEXT §7 spec `20260330_TAREAS_FILTER_AND_DESARROLLO_BUG` is NOT re-introduced by the legacy-actions-file refactor in Step 2.

---

## Tiered verification plan (against CRM `DEPLOY.md`)

### Tier 1 — Directly Affected (exhaustive)

The 7 new MCP tools + the 5 refactored task-writing server-action files.

**MCP tool endpoints (via `POST /api/mcp`, `tools/call`):**
- `crm.list_tasks` — valid empty (200 with array), valid with all filters (200 with filtered array), invalid `status` value (isError with `"status must be one of TODO, IN_PROGRESS, DONE"`), invalid `plannedDateFrom` (isError with `"Invalid date"`), `limit > 200` (capped silently or isError — decide during Step 1).
- `crm.get_task` — valid id (200 with task+relations+timeEntryCount), missing id (isError), non-existent id (200 with null result).
- `crm.create_task` — minimal (`title` only, 200), full (all fields, 200), missing `title` (isError `"El título es requerido"`), unknown `projectId` (isError `"Proyecto no encontrado"`), `assigneeIds` over cap 5 (silently trimmed to first 5), `dueDate` malformed (isError `"Invalid date"`), `timeSlot: 'EVENING'` (isError enum).
- `crm.update_task` — patch with one field, patch with many fields, patch with `assigneeIds: []` (clears all), unknown id (isError `"Tarea no encontrada"`), patch that touches ONLY unrelated fields (verify `plannedDate` / `dueDate` on the row are byte-for-byte unchanged).
- `crm.complete_task` — TODO task (200, status=DONE, TASK_DONE Activity), already-DONE task (200, no second Activity), unknown id (isError).
- `crm.assign_task` — 3 assignees (REPLACE, count = 3), same 3 called again (REPLACE, still count = 3, no duplicates via unique constraint), empty array (clears), unknown user in list (isError `"Usuario no encontrado"`), unknown task (isError).
- `crm.delete_task` — task with 0 time entries (200 `{ deleted: true }`, `taskAssignees` cascaded), task with N time entries (isError with exact count in message), unknown id (isError).

### Tier 2 — Adjacent (smoke)

Endpoints not modified but using affected models/services/schemas.

- `crm.list_leads`, `crm.list_clients`, `crm.list_projects`, `crm.list_invoices`, `crm.list_cash_entries` — one valid request each, verify 200 with array (proves the domain-layer refactor and coerce-module edits didn't break shared code paths in `lib/mcp/coerce.ts` or `lib/mcp/tools.ts`).
- `crm.add_project_note` — one valid request (proves the "task-notes go here" fallback from Non-goals + Step 4 works end-to-end).
- `tools/list` — verify count is exactly 35 (28 + 7).
- UI `/tasks`, `/desarrollo`, `/planificador` — one screenshot per page, sanity check no visual regression.

### Tier 3 — Distant (conditional; skip unless Tier 2 fails)

- Full UI regression pass on `/pipeline`, `/clients`, `/projects/[id]`, `/billing`, `/treasury`, `/dashboard`.
- Full MCP acceptance vertical from prior cycle (steps a–i for leads/clients/projects/billing/treasury).

### Local (before merge)

1. **CRM typecheck:** `npx tsc --noEmit --project tsconfig.json` on `app/`, `lib/`, `middleware.ts`, `scripts/`, `components/` → zero errors. Pre-existing `services/whatsapp/**` errors are unchanged and unrelated (per prior cycle CHANGES.md).
2. **CRM boot:** `docker compose up -d --build`. `curl -sS http://localhost:26901/ -o /dev/null -w '%{http_code}\n'` returns `200` or `307`.
3. **MCP local smoke (Tier 1 subset):** `curl -X POST -H "Authorization: Bearer $MCP_BEARER_TOKEN" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' http://localhost:26901/api/mcp | jq '.result.tools | length'` → **35**. Then run one `create_task` + one `complete_task` + one `delete_task`-with-time-entries via curl. Verify DB via `psql`.
4. **Grep gates:** all acceptance-grep expressions in Steps 1–5 pass.
5. **UI regression:** manual click-through of Tareas, Desarrollo, Planificador. See Step 2 acceptance.
6. **Nanoclaw typecheck + build:** in `~/prj/nanoclaw`, `npm run build`. Zero errors.
7. **Nanoclaw restart:** `systemctl --user restart nanoclaw` then `systemctl --user is-active nanoclaw` = `active`.
8. **No lightningcss dependency this cycle** — prior cycle noted the arm64 platform issue on the Pi dev host; this cycle only touches Node/TS code, no CSS pipeline.

### Prod

1. **Push CRM `main`** + SSH `h-dmi-a`, `cd /srv/crm-dimitris && git pull && docker compose up -d --build` (per patched `DEPLOY.md` from prior cycle).
2. **Prod tools/list smoke:** `curl -X POST -H "Authorization: Bearer $MCP_BEARER_TOKEN" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' https://gaston.dimitris.app/api/mcp | jq '.result.tools | length'` → 35. `curl ... | jq '.result.tools[].name' | grep -c 'task'` → ≥ 7.
3. **Prod health:** ping probe (from prior cycle DEPLOY.md) still returns 200.
4. **Nanoclaw side:** send a message in `dimitris-claw`; walk the acceptance vertical (a)–(j).
5. **DB verification:** on `h-dmi-a`, `docker compose exec db psql -U postgres -c "SELECT type, body, \"createdAt\" FROM \"Activity\" WHERE type='TASK_DONE' ORDER BY \"createdAt\" DESC LIMIT 5;"` shows at least one `TASK_DONE` row (first-ever emission).

---

## Risks & unknowns

1. **`Activity.taskId` doesn't exist — `add_task_note` deliberately skipped.** Design call resolved inline (Non-goals + Step 4 skill guidance): task-adjacent notes go through `crm.add_project_note` with a `[Task: <title>]` body prefix. Downside: notes on task-only (`projectId IS NULL`, orphan-task) tasks have no natural home. Mitigation: for orphan tasks, either skip (Jarvis tells user "no puedo dejar nota histórica sobre una tarea sin proyecto") or fall back to a `[Task: <title>]` note against no project (`recordActivity` allows all FKs to be null — verify with a smoke). Flag as a follow-up if it comes up in real use.

2. **"Refactor to thin wrappers" (Step 2) may reveal a UI regression around the deprecated `Task.assigneeId` legacy field.** The audit sub-step (`grep -rn "assigneeId\|task\.assignee\b"`) is the mitigation. If a callsite reads `task.assignee?.name` for the avatar in the Tareas table or Desarrollo kanban, and that value historically came from the legacy write path, post-refactor it will be `null` for newly-created tasks. Fix in the same commit by migrating the callsite to `task.assignees[0]?.user.name`. **Risk:** miss a callsite → new tasks silently show "unassigned" in the UI. Mitigation: the acceptance-vertical assignee-column regression check (Step 2 acceptance) will catch this on the primary surfaces; less-trafficked screens may need a post-deploy sweep.

3. **`TASK_DONE` Activity consumers — first-ever emission.** `ActivityType.TASK_DONE` has never been emitted. If the UI renders activity feeds unconditionally (`app/(dashboard)/dashboard-greeting.tsx`, `app/(dashboard)/urgent-items.tsx`, `components/activity-feed.tsx` or similar), a new `TASK_DONE` row will surface with whatever default styling the feed uses — potentially unstyled or with the raw enum name. **Mitigation:** grep before firing for real:
   ```
   grep -rn "ActivityType\|activity\.type\|\.type ===" app/ components/ lib/
   ```
   Any switch/if-else on `activity.type` that doesn't have a `case 'TASK_DONE'`: either add a case (with a reasonable label like "Tarea completada") or verify the default branch handles unknown types gracefully. **Bundle any fix into Step 3's diff** (since the emission is what makes the surface visible).

4. **Timezone: normalizing existing rows on update.** Resolved inline (Step 1): `normalizeDateInput` is only called on fields present in the patch. An update that touches only `title` will NOT re-normalize `plannedDate` / `dueDate`. Documented in the `updateTask` behavior and acceptance-vertical step (h). **Residual risk:** rows created via the pre-refactor legacy `tasks/actions.ts:createTask` (which used `T12:00:00`, CONTEXT §3.1) still have that misalignment in the DB. This SPEC does NOT migrate them. Any future update of one of those rows that touches `plannedDate` or `dueDate` will normalize to `T00:00:00-03:00`, "healing" the row on-touch. Rows that never get updated stay misaligned indefinitely. Acceptable — matches the "no migration this cycle" Non-goal.

5. **Three-page divergence (Tareas / Desarrollo / Planificador) all have different server-action mutation paths.** CONTEXT §3 explicitly lists them. Step 2 refactors all three plus the shared `lib/actions/tasks.ts` and the modal wrapper — five files total. UI regression per page is required (Step 2 acceptance manual smoke covers Tareas, Desarrollo, Planificador each). If any page has a distinct write path that Step 2 misses, it will keep writing directly to `tasks` / `taskAssignees` and the acceptance-grep gate (Step 2) will catch it (`grep -nE 'db\.(insert|update|delete)\((tasks|taskAssignees)\)' ...` returning non-zero outside the domain module).

6. **`assignTask` requires validating each `assigneeId` against `users` before inserting.** Step 1 spec includes this validation. Cost: one extra `SELECT` per `assignTask` call. Alternative: skip the pre-check and let the FK constraint reject on insert — but the error message would be an opaque Postgres constraint violation, not a clean `"Usuario no encontrado: <id>"`. Pre-check chosen for UX. If perf becomes an issue (unlikely at n≤5), rework post-v1.

7. **`completeTask` idempotency semantics.** Chosen (Step 1): running `complete_task` on an already-DONE task is a no-op on the Activity table (no second `TASK_DONE` row). This matches user expectation (don't spam) but diverges from how `updateTask({status:'DONE'})` behaves (which would emit a generic "Tarea actualizada: status" NOTE on every call). Two ways to reach DONE now yield different audit shapes. **Decision:** `complete_task` is the sanctioned path; `update_task` with `status:'DONE'` still works but emits the generic NOTE. Document in the `complete_task` tool description and skill guidance. Acceptable UX cost.

8. **Fork drift risk (unchanged from prior cycle).** The nanoclaw per-group agent-runner fork at `data/sessions/dimitris-claw/agent-runner-src/` shadows the upstream tree at `container/agent-runner/src/`. This cycle touches neither the runner nor the fork — only `.claude/skills/` and `groups/…/CLAUDE.md`. So the fork-drift risk from the prior cycle is not aggravated by this diff.

9. **Tool-count arithmetic.** Prior cycle CHANGES.md Deviations note flagged "SPEC said 29, actual is 28 (SPEC off-by-one)". This SPEC's math: 28 (post-prior-cycle actual) + 7 (this cycle) = 35. Verifier: run `tools/list | jq '.result.tools | length'` in Step 3 acceptance. If it's not 35, count the delta explicitly in CHANGES.md (do NOT paper over with a "≥ 33" hedge).

10. **Rate limiting on MCP endpoint** — still absent (prior cycle §Risks #6 unchanged; reviewer authorized skipping). This cycle adds 7 more write-capable tools, marginally widening the DoS surface. Mitigation unchanged (30-min container idle timeout as fail-safe). Post-v1 rate-limit design still applies.

11. **`crm.list_tasks` default `includeCompleted: false` may hide expected results.** If the user asks "listame todas las tareas" (all, no qualifier), Jarvis must decide whether to pass `includeCompleted: true`. Skill guidance in Step 4 does not explicitly cover this. **Mitigation:** add a one-liner to the skill's `crm.list_tasks` description: *"Default excludes DONE — pass `includeCompleted: true` if the user asks for 'todas' or 'incluye completadas'."* Bundle into Step 4.

12. **`plannerOrder` semantics via `update_task`.** Exposing `plannerOrder` as a patchable field (Non-goals: no `reorder_task`) means Jarvis could set it to a value that collides with another task in the same `(plannedDate, timeSlot)` cell. The schema has no unique constraint on `(plannedDate, timeSlot, plannerOrder)` — collisions render as ties in the sorted UI (CONTEXT §2.3). **Mitigation:** skill guidance discourages Jarvis from setting `plannerOrder` at all — leave the field null and let the UI drag-drop assign it. If the user asks for a specific slot ordering, Jarvis can query `crm.list_tasks({ plannedDateFrom, plannedDateTo, ... })` first, compute a non-colliding value, and set it. Document in Step 4 skill.

---

## Delta: SPEC → REPLAN

*(empty; no prior revisions in this cycle)*

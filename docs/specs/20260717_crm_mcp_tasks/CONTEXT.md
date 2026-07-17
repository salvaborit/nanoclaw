# CONTEXT — CRM MCP Tasks extension

Research phase for extending the MCP surface shipped by
`docs/specs/20260716_crm_mcp_control_surface/` with **Task** control tools so
Jarvis (the `dimitris-claw` group) stops writing `Activity NOTE` rows when the
user asks it to plan work — and instead operates the real Jira-style board that
already backs the **Tareas**, **Desarrollo** and **Planificador** pages.

All CRM-side paths are relative to `/home/sborit/prj/crm-dimitris/`. All
nanoclaw-side paths are relative to `/home/sborit/prj/nanoclaw/`. Read-only
investigation; no code was modified.

---

## 1. Task data model — the whole picture

### 1.1 `Task` table — `lib/schema.ts:142-161`

```
id            text PK   $defaultFn(createId())
title         text NOT NULL
description   text
status        TaskStatus DEFAULT 'TODO' NOT NULL     -- enum: TODO, IN_PROGRESS, DONE
priority      Priority   DEFAULT 'MEDIUM' NOT NULL   -- enum: HIGH, MEDIUM, LOW
dueDate       timestamp(3)                           -- the deadline
projectId     text  FK → Project.id                  -- NULLABLE (spec 20260331_TAREAS_CREATION_ENHANCEMENTS)
assigneeId    text  FK → User.id                     -- @deprecated (line 150 comment)
plannedDate   timestamp(3)                           -- the day it is planned INTO the planner
timeSlot      TimeSlot                               -- enum: MORNING, MIDDAY, AFTERNOON
plannerOrder  integer                                -- vertical order inside a (plannedDate, timeSlot) cell
contextNote   text                                   -- planner-only note ("why is this on today?")
createdAt     timestamp(3) NOT NULL DEFAULT now()
updatedAt     timestamp(3) NOT NULL DEFAULT now()    -- $onUpdateFn(() => new Date())

Indexes (`lib/schema.ts:159-160`):
  Task_status_dueDate_idx           (status, dueDate)
  Task_plannedDate_timeSlot_idx     (plannedDate, timeSlot)
```

**Notable absences** (relevant for MCP shape):

- **No `clientId` on Task.** Client relation is inferred from `projectId → Project.clientId`. Confidence: certain (`lib/schema.ts:524-530`).
- **No `leadId`, no `saleProspectId`.** Task belongs to a project or is orphan.
- **No `position` / `sortOrder` at the board level** — the only ordering column is `plannerOrder`, and it is scoped to a (plannedDate, timeSlot) cell in the Planificador. The Tareas page orders by `(status, dueDate)`, the Desarrollo kanban orders by `desc(createdAt)` inside each status column (`app/(dashboard)/desarrollo/page.tsx:53`). No user-controlled drag order in kanban.
- **No recurrence.** No `recurring`, no rrule column.
- **No labels/tags.** The `labels text[]` array only exists on `Lead` (`lib/schema.ts:118`).
- **No subtasks / checklist rows** — nothing like `TaskChecklistItem`.

### 1.2 `TaskAssignee` join — `lib/schema.ts:163-172`

```
id         text PK
taskId     text NOT NULL FK → Task.id       onDelete: cascade
userId     text NOT NULL FK → User.id       onDelete: cascade
createdAt  timestamp(3) NOT NULL DEFAULT now()

Unique   (taskId, userId)   -- TaskAssignee_taskId_userId_key
Index    (taskId)
Index    (userId)
```

Cascade deletes on both sides mean deleting a Task or User automatically clears
join rows. Cap of 5 assignees enforced application-side (not in DB) — see
`data.assigneeIds?.slice(0, 5)` in `lib/actions/tasks.ts:20` and
`app/(dashboard)/projects/[id]/actions.ts:64,117`.

### 1.3 Relations — `lib/schema.ts:524-535`

```
tasksRelations:
  project:   one(projects)     via tasks.projectId
  assignee:  one(users)        via tasks.assigneeId   -- @deprecated, still exists
  assignees: many(taskAssignees)
  timeEntries: many(timeEntries)                       -- TimeEntry.taskId (see §5)

taskAssigneesRelations:
  task: one(tasks)
  user: one(users)
```

### 1.4 Enums involved

- `TaskStatus` — `TODO`, `IN_PROGRESS`, `DONE` (`schema.ts:23`).
- `Priority` — `HIGH`, `MEDIUM`, `LOW` (`schema.ts:21`), shared with Lead/Project.
- `TimeSlot` — `MORNING`, `MIDDAY`, `AFTERNOON` (`schema.ts:32`). Nullable ⇒ "sin horario".
- `ActivityType` — task-relevant value is `TASK_DONE` (`schema.ts:25`, `lib/prisma-types.ts:18`). Currently **not emitted anywhere** — grep only finds it in type declarations. Confidence: certain.

### 1.5 The user's `plannedFor "17/07 MORNING"` observation

There is **no `plannedFor` column**. That string is the rendered composition of
`plannedDate` (date part) + `timeSlot` (enum) that Jarvis saw in the DB output.
Confidence: certain. Actual columns are `plannedDate timestamp(3)` and
`timeSlot TimeSlot`.

`plannedDate` is stored at **midnight UTC-3** (03:00 UTC) — see
`app/(dashboard)/planificador/actions.ts:19,64,109`:
`new Date(data.plannedDate + "T00:00:00-03:00")`. `dueDate` in contrast is
stored at either midnight UTC (`lib/actions/tasks.ts:27` uses
`"T12:00:00"` local, which lands close to noon UTC) or midnight UTC via other
paths — this timezone inconsistency was documented as a bug and partially
patched by `20260508_planner_week_move`. **Any MCP `plan_task` we build must
follow the `+ "T00:00:00-03:00"` convention** or planned tasks will fall off
the planner week boundary.

---

## 2. The three pages — Tareas vs Desarrollo vs Planificador

**Ground truth: all three read from the same `Task` table.** They are three
different filter/serialization views over one row set. There is no separate
`Planner*` or `DevTask` entity. This is the load-bearing answer to the user's
"cuando le pongo due date que también aparezca en planificador" question.

### 2.1 Tareas — `app/(dashboard)/tasks/page.tsx`

- Query: `db.query.tasks.findMany({ with: { project.client, assignees.user }, orderBy: [asc(status), asc(dueDate)] })` — **no where filter**, returns every task.
- Renders `TasksTable` with counts by status + overdue flag (`dueDate < now && status !== "DONE"`).
- Only column-level filters exposed in the UI are status badges. Server does not filter.

### 2.2 Desarrollo — `app/(dashboard)/desarrollo/page.tsx`

- Kanban of the same Task rows, grouped by `status` into three columns (`TODO / IN_PROGRESS / DONE`).
- **Server-side filters**: `?project=`, `?priority=` on the SQL where clause (`page.tsx:30-37`).
- **Post-query filters** (junction table): `?client=` (by project.client.name), `?assignee=` (matched against `taskAssignees.user.id`) — `page.tsx:66-76`.
- Order: `desc(tasks.createdAt)` inside each status column (`page.tsx:53`).
- Purpose per header text: "Tablero kanban de tareas por proyecto" (`page.tsx:101`).

### 2.3 Planificador — `app/(dashboard)/planificador/page.tsx`

Three parallel `db.query.tasks.findMany` calls, all over the same `Task` table:

1. **Week planned tasks** (`page.tsx:95-114`) — `plannedDate BETWEEN monday_utc3 AND sunday_utc3`, ordered by `plannerOrder`. These are tasks the user (or Jarvis) has explicitly dropped into a planner cell.
2. **Due-date-only tasks** (`page.tsx:115-136`) — `dueDate BETWEEN monday_utc0 AND sunday_utc0 AND plannedDate IS NULL AND status != DONE`. Serialized with `isDueDateOnly=true`; they show up on the day of their due date without being explicitly planned. **This confirms the user's expectation: setting only `dueDate` DOES already make a task appear in Planificador**, on the week its due date falls in. No dual-write needed.
3. **Backlog** (`page.tsx:137-161`) — `plannedDate IS NULL AND status != DONE AND (dueDate IS NULL OR dueDate outside week)`.

`PlannerBoard` (`planner-board.tsx`) renders a week grid with drag-drop via
`@dnd-kit`; slot cells are keyed by `${plannedDate}::${timeSlot}` (see
`slot-container.tsx`).

### 2.4 Answer to the user's question

- All three pages consume `Task`. There is **no separate planner entity**.
- **`dueDate` alone is enough** to make a task appear in Planificador for that week (it will show under "date-only" cards without a specific time slot).
- To pin a task to a specific day + slot, `plannedDate` (and optionally `timeSlot`, `plannerOrder`) must be set — this is what the `planTask` server action does (`planificador/actions.ts:10-32`).

---

## 3. Existing task mutation patterns

There are **three parallel task-action files** (a duplication mess predates
this cycle):

| File | Exports | Notes |
|---|---|---|
| `app/(dashboard)/tasks/actions.ts` | `createTask`, `updateTask`, `deleteTask` | Legacy path — does NOT touch `taskAssignees`; writes only `assigneeId` (deprecated). |
| `app/(dashboard)/projects/[id]/actions.ts:52-152` | `createTask`, `updateTask`, `deleteTask` | Modern path — uses transactions, `assigneeIds[]`, and clears/inserts `taskAssignees` rows. Header comment line 50: *"Task CRUD stays here — tasks are out of scope for the MCP surface"* (from the previous cycle). |
| `lib/actions/tasks.ts` | `createTaskAction` | Shared path used by the `CreateTaskDialog` on both Tareas and Desarrollo. Same shape as projects/[id] createTask. |

`app/(dashboard)/planificador/actions.ts` adds four **planner-specific**
mutations that all directly patch the `Task` row:
`planTask`, `unplanTask`, `reorderTasks`, `updateContextNote`,
`createTaskInPlanner`.

`app/(dashboard)/desarrollo/actions.ts` adds two more:
`updateTaskStatus(taskId, newStatus)`, `updateTaskAssignee(taskId, assigneeId)`
— the latter does the transactional "delete existing + insert new" pattern on
`taskAssignees` (`desarrollo/actions.ts:24-35`).

Plus `components/task-modal/actions.ts:updateTaskFromModal` which is a thin
wrapper over `projects/[id]/actions.ts:updateTask` that adds three more
`revalidatePath` calls (`/desarrollo`, `/planificador`, `/`).

### 3.1 Trace: `createTask` (modern path)

`app/(dashboard)/projects/[id]/actions.ts:52-87` and its twin
`lib/actions/tasks.ts:8-46`:

- **Validation**: handwritten. Only checks `title.trim()` non-empty. Zod is not used anywhere in task actions. Confidence: certain.
- **Auth check**: `lib/actions/tasks.ts` does NOT call `auth()` — it trusts the "use server" boundary; anyone with a Next session can call it. `projects/[id]/actions.ts` also has no explicit auth on `createTask`.
- **Activity emission**: **NONE.** No `activities` row is written on Task create/update/delete anywhere in the codebase. `ActivityType.TASK_DONE` is defined in the enum but never emitted.
- **Transaction shape**: `db.transaction(async (tx) => { insert tasks; insert taskAssignees[] })` — atomic (`actions.ts:66-83`).
- **Assignee cap**: 5, enforced with `data.assigneeIds?.slice(0, 5) ?? []`.
- **`dueDate` parsing**: `new Date(data.dueDate + "T12:00:00")` — different from planner's `T00:00:00-03:00`. Contributes to timezone drift documented in `20260508_planner_week_move`.
- **Revalidation**: `revalidatePath` on `/tasks`, `/desarrollo`, `/`, and `/projects/{projectId}` if scoped.

### 3.2 Trace: `updateTask` (modern path, `projects/[id]/actions.ts:89-135`)

- Same shape as createTask. Wrapped in a `db.transaction`.
- When `assigneeIds !== undefined`: `tx.delete(taskAssignees).where(taskId)` then bulk `tx.insert(taskAssignees).values(...)`. This is the canonical multi-assignee update pattern to imitate.
- Only `status`, `title`, `description`, `priority`, `dueDate` are directly patched. **`plannedDate`, `timeSlot`, `plannerOrder`, `contextNote`, `projectId` are NOT patchable via updateTask** — those go through the planner actions or (implicitly) the raw drizzle path.
- No activity emission.

### 3.3 Trace: `deleteTask`

- `db.delete(tasks).where(eq(tasks.id, id))`. Cascades handle `taskAssignees` and `timeEntries` via schema `onDelete: "cascade"`. No confirmation, no soft-delete.

### 3.4 "Move to planificador" / "schedule for date" primitives

`app/(dashboard)/planificador/actions.ts`:

- `planTask({ taskId, plannedDate, timeSlot, plannerOrder })` — plants a task on a day + slot.
- `unplanTask(taskId)` — clears `plannedDate, timeSlot, plannerOrder, contextNote`.
- `reorderTasks(updates[])` — bulk plannerOrder update (drag-drop).
- `updateContextNote(taskId, note)` — sets `contextNote`.
- `createTaskInPlanner({...task fields, plannedDate, timeSlot, plannerOrder, contextNote })` — create+plan in one shot. Does NOT accept `assigneeIds` (still writes deprecated `assigneeId`) — bug worth flagging but out of scope.

### 3.5 Calendar / reminder integration

- **Tasks do NOT feed into Google Calendar.** `lib/google-calendar.ts` handles meeting reads; `app/(dashboard)/reuniones/actions.ts` handles meeting create/list. Neither imports `tasks` or `taskAssignees`. Confidence: certain (grep).
- **Tasks do NOT trigger any in-app notification.** No `notifications` table, no email/webhook fires on task events.
- **Nanoclaw scheduler is unrelated.** `nanoclaw/src/task-scheduler.ts` schedules agent runs; the word "task" there refers to nanoclaw's own cron-like agent-run scheduler, not CRM Tasks. Confidence: certain.

---

## 4. MCP domain-layer patterns (imitation targets)

The prior cycle established a strict mold. `lib/domain/tasks.ts` (new) should
follow it exactly.

### 4.1 Audit helper — `lib/domain/activities.ts:54-72`

```ts
export async function recordActivity(actor: Actor, input: RecordActivityInput, tx: ActivityDb = db)
```

`Actor` (`activities.ts:16-21`): `{ userId: string; senderLabel?: string }`.
When `senderLabel` is set, `body` is prefixed with `[MCP · <label>] `.

`isAgentActor(actor)` (`activities.ts:38-40`): identity gate —
`actor.userId === AGENT_USER_ID`. UI callers pass a session user id → gate
returns false → no audit row. MCP calls pass `AGENT_USER_ID` → gate returns
true → audit row.

`RecordActivityInput` accepts `clientId | projectId | leadId | saleProspectId`
foreign keys. Task has no direct FK on Activity, but a project-scoped task's
audit row should set `projectId` (and derive `clientId` from
`project.clientId`, mirroring `projects.ts:169-183:addProjectActivity`).

### 4.2 Domain function mold — `lib/domain/leads.ts` and `lib/domain/projects.ts`

Every mutation:

1. Signature: `async function xxx(actor: Actor, input | id, patch?)`.
2. Handwritten validation up front, `throw new Error("clear ES message")`.
3. Drizzle write (`.returning()` when the caller needs the result).
4. Guard `if (!updated) throw new Error("... no encontrado")` — review finding #11.
5. Conditional audit: `if (isAgentActor(actor)) await recordActivity(actor, {...})`. `createLead` is an exception (unconditional) — matches pre-refactor UI behavior.
6. Wrap multi-step writes in `db.transaction(async (tx) => {...})` and pass `tx` down to `recordActivity`.

Concrete imitation targets for tasks:

- `createProject` (`projects.ts:74-103`) — validates required fields, inserts, conditional NOTE audit with both `projectId` and `clientId`.
- `updateProject` (`projects.ts:105-130`) — collects patch keys into `updateData`, applies, emits `Proyecto actualizado: ${Object.keys(updateData).join(", ")}` audit if agent.
- `deleteProject` (`projects.ts:137-167`) — guards + wraps deletes in a transaction. For tasks, deletion cascades via schema (no manual FK cleanup needed except `activities` if we start emitting them).

### 4.3 MCP tool registry — `lib/mcp/tools.ts:34-515`

- Single `REGISTRY` object mapping `crm.<verb>_<noun>` name to `{ def, handler }`.
- Handler shape: `(actor: Actor, args: Record<string, unknown>) => Promise<unknown>`.
- Dispatched via `callTool(actor, params)` — wraps return in `toolContent()` envelope. Empty-array / undefined = `isError:true` (review finding #4, `tools.ts:546-557`).
- Adding new tools = add entries to `REGISTRY`. `TOOL_DEFS` is derived (`tools.ts:517`).

### 4.4 Handler shape — `lib/mcp/handlers/leads.ts`

- Per-domain file. Imports domain module and `coerceXxxPatch` from `coerce.ts`.
- Local helpers `s(args, key)`, `n(args, key)` for one-off string/number reads (handlers/leads.ts:14-21). No global helper module.
- Patch handlers strip `id` from args, coerce the rest via `coerceXxxPatch`, pass to domain.
- Never import server actions (SPEC §Step 1 acceptance: "MCP-handler-does-not-import-actions gate").

### 4.5 Coerce helpers — `lib/mcp/coerce.ts`

Private helpers (only exported: the `coerceXxxPatch` functions):

- `asString(v, field)` — throws if not string, undefined-pass-through.
- `asStringOrNull(v, field)` — string, null, or undefined.
- `asNumber(v, field)` / `asNumberOrNull(v, field)` — finite-check.
- `asEnum(v, field, choices)` — throws if not in tuple.
- `build<T>(entries)` — assembles a partial patch, drops undefined keys.

**Enum constants declared at top of file** (`coerce.ts:11-16`):
`LEAD_STATUS`, `CLIENT_STATUS`, `PROJECT_STATUS`, `PRIORITY`,
`INVOICE_STATUS_NON_PAID`, `CASH_TYPE`. We need to add
`TASK_STATUS = ["TODO", "IN_PROGRESS", "DONE"]` and
`TIME_SLOT = ["MORNING", "MIDDAY", "AFTERNOON"]`.

### 4.6 Existing helpers we can reuse

- `lib/domain/projects.ts:70:getProject` — call it inside task handlers to derive `clientId` for the audit row.
- No `lib/queries/tasks.ts` exists. No `lib/tasks-*.ts`. All task logic lives in the three actions files listed in §3.

---

## 5. Adjacent concerns

### 5.1 `TimeEntry.taskId` — `lib/schema.ts:281-295`

TimeEntry has a nullable `taskId FK → Task.id`. This is what
`components/task-modal/actions.ts:getTaskTimeEntries` reads. Deletion currently
does not cascade (`schema.ts:283` has no onDelete option → default RESTRICT).
Deleting a Task with linked time entries will FK-fail. Worth flagging as a
guard the MCP `delete_task` handler should either check or surface cleanly.

### 5.2 Duplicate `createTask` in three files (§3)

The three-way split (`tasks/actions.ts`, `projects/[id]/actions.ts`,
`lib/actions/tasks.ts`) is a pre-existing mess. The MCP surface should NOT
call any of them — it should call a new `lib/domain/tasks.ts` per the SPEC
mold. Whether to also refactor the three actions files to call the new
domain is an **open question** (see §8).

---

## 6. Duplication concern — the notes Jarvis wrote instead of tasks

Query ran via `ssh h-dmi-a` (see command in task brief). Results:

### 6.1 Recently-added misclassified NOTEs (created ~02:28-02:30 UTC on 2026-07-17)

All were written by the MCP agent (`[MCP · Salvador (46901244252350@lid)]`
prefix) into `Activity` when they should have been Tasks:

| activity.id | body (preview) | projectId | project.name | client |
|---|---|---|---|---|
| `b4nunhiyuqzdq6b11o234k1x` | `Tarea [[Salva]]: pendientes anexos No CEDE - deadline lunes AM` | `db0g7boj5fg4xht1dld0n06k` | Sistema gestion - ContaFlow | Esteban Contador |
| `a0emkktp8jf8q4do6w3l343b` | `Tarea [[Salva]]: recordatorios de cierres de balance - deadlin…` | `db0g7boj5fg4xht1dld0n06k` | Sistema gestion - ContaFlow | Esteban Contador |
| `tousisedxfoygbpce88bdy2l` | `Tarea [[Salva]]: mas devoluciones por WhatsApp - deadline lune…` | `db0g7boj5fg4xht1dld0n06k` | Sistema gestion - ContaFlow | Esteban Contador |
| `v9qizw8i7c4rq0hcmc9is3c1` | `Tarea [[Salva]]: entregar fase 2 - deadline manana viernes 17` | `r8yruwewge8pdjqj1ahg1vr5` | Analisis de Creditos | Platero |
| `yy6g6i4rgwreigkjxac2fvou` | `Tarea [[Salva]]: arreglar OC nro. GIA errado - deadline lunes` | `r8yruwewge8pdjqj1ahg1vr5` | Analisis de Creditos | Platero |

**Observation:** two of the five landed on the wrong project. The Platero
tasks were written against `Analisis de Creditos` (`r8yruwewge8pdjqj1ahg1vr5`)
but the real existing tasks for "fase 2" and "OC GIA" are under
`Platero Fase 2` (`ibgbw2zuu8h9u8jf6xl7t133`) and `Gestor de Ordenes`
(`z4oevz8po1xh9dif2gzvnpmk`) respectively (see §6.2). Even if we convert
these NOTEs into Tasks blindly, they would sit under the wrong project.

### 6.2 Real pre-existing tasks that overlap topic-wise

| task.id | title | project | dueDate | plannedDate | timeSlot | status |
|---|---|---|---|---|---|---|
| `swyl3bo5suk0f458s3a0ta1j` | nro de OC (sistema vs GIA) | Platero / Gestor de Ordenes | — | 2026-07-20 03:00 | — | TODO |
| `rid0wa8ud3w2dkl5nfd0bv0p` | Platero: ver si mandaron ejemplos del nro de OC (sistema vs GIA) | Platero / Platero Fase 2 | — | 2026-07-16 03:00 | MORNING | DONE |
| `w7mj3z73ru5tbzpvy77xxpgj` | Platero: mostrar y mandar avances Fase 2 | Platero / Platero Fase 2 | — | 2026-07-17 03:00 | MORNING | TODO |
| `ik6iy73unn6zuna0lauzmhkl` | FASE 2 PLATERO | Platero / PADs | 2026-07-16 00:00 | 2026-07-16 03:00 | AFTERNOON | TODO |
| `pz6zwzxhbdl2ufz5071zmxv0` | Devoluciones Olmedo y subir a nuevo hosting | Olmedo | 2026-04-12 | — | — | DONE |
| `dos5w35tm9qkd2y08w94a9eg` | Devoluciones Paula sabado 28/3 | Olmedo | 2026-03-29 | — | — | DONE |
| `hvbpazohwglc3ba9xwxw1gyu` | Devoluciones Paula | Olmedo | 2026-03-26 | — | — | DONE |

Overlaps with the fresh NOTEs:

- NOTE "entregar fase 2" ↔ existing Task `w7mj3z73ru5tbzpvy77xxpgj` (already TODO on Platero Fase 2, planned MORNING 17/07). **True duplicate.**
- NOTE "arreglar OC nro. GIA errado" ↔ existing Task `swyl3bo5suk0f458s3a0ta1j` (TODO on Gestor de Ordenes, planned 20/07). **True duplicate.**
- NOTE "mas devoluciones por WhatsApp" — the "Devoluciones" hits are all DONE and belong to Olmedo, not ContaFlow. **Not a true duplicate.**
- NOTE "pendientes anexos No CEDE" and "recordatorios de cierres de balance" — no matching existing tasks found. **Genuinely new items.**

**Open question flagged in §8**, not decided here: whether to delete the five
NOTEs, convert them to correct-project Tasks, or leave them as historical
noise.

---

## 7. Prior specs & their invariants (imitation / respect)

Located under `crm-dimitris/docs/specs/`:

| Spec | Established invariant |
|---|---|
| `20260325_tarea_edit_modal` | Task rows are click-through to a detail modal (not navigation). |
| `20260330_TAREAS_MODAL` | Unified `components/task-modal/` for all three contexts (Tareas, Desarrollo, projects/[id]). |
| `20260330_multi_user_tareas` | `TaskAssignee` junction table replaces single `assigneeId`. Cap 5. Stacked avatars. |
| `20260330_TAREAS_FILTER_AND_DESARROLLO_BUG` | Desarrollo and dashboard MUST read/write `taskAssignees` (not the deprecated `assigneeId`). This is the bug we would re-introduce if MCP writes went through the legacy `tasks/actions.ts` path. |
| `20260331_TAREAS_CREATION_ENHANCEMENTS` | `projectId` on Task became nullable; introduced `lib/actions/tasks.ts:createTaskAction` as the shared entry point for both "with project" and "orphan" creates. |
| `20260406_FIX_TASK_EDIT_SERVER_ACTION_HYDRATION` | Server actions must be imported directly from `"use server"` modules — no barrel re-exports. Applies to any new task action we expose UI-side (not to the MCP domain layer, which is not a server action). |
| `20260429_daily_task_planner` | Introduced `timeSlotEnum` and added `plannedDate / timeSlot / plannerOrder / contextNote` to Task. Established `MORNING / MIDDAY / AFTERNOON` vocabulary. |
| `20260501_planner_task_detail_edit` | Planner cards open the same `TaskModal` used elsewhere; tap-vs-drag discrimination on mobile. |
| `20260508_planner_week_move` | Timezone convention: `plannedDate` = UTC-3 midnight, `dueDate` = UTC midnight. Documents the boundary bug. Tasks with `dueDate` in the current week AND no `plannedDate` MUST appear in Planificador as `isDueDateOnly`. |
| `20260325_google_calendar_integration` | Read-only Calendar bridge under `lib/google-calendar.ts` and `/reuniones`. **No task↔calendar bridge exists.** |

---

## 8. Open questions for the planner

1. **Single tool vs. split for planning.** Should MCP expose a single
   `crm.create_task` that accepts `plannedDate / timeSlot / plannerOrder`
   alongside `title / dueDate / projectId / assigneeIds` (matching the UI's
   `createTaskInPlanner`)? Or a minimal `crm.create_task` + a separate
   `crm.plan_task(taskId, plannedDate, timeSlot?, plannerOrder?)`? Both work
   at the DB level. Splitting matches the UI's two paths (`createTask` +
   `planTask`) and keeps `create_task` symmetric with `update_task`.

2. **Multi-assignee shape.** `crm.assign_task(taskId, assigneeIds[])` (full
   replacement, matches `projects/[id]/actions.ts:updateTask` transaction)
   vs. `crm.add_task_assignee` / `crm.remove_task_assignee` (incremental).
   Multi-assignee semantics in the UI is REPLACE, not APPEND. Cap = 5.

3. **Should `crm.update_task` accept planner fields?** In the UI they are
   separated (`updateTask` doesn't touch `plannedDate`; `planTask` does).
   Symmetry with UI = split. Ergonomics for Jarvis = combined.

4. **Should Jarvis stop scheduling nanoclaw-side reminders once tasks with
   `dueDate` land in Planificador?** The CRM has no push-notification system;
   the only "reminder" is that the task appears in the planner's due-date-only
   row. Nanoclaw-side scheduling (jarvis-agenda) is still the only way to get
   an actual WhatsApp ping at a specific time. Recommendation to the planner:
   **keep both** — Planificador for visibility, nanoclaw scheduler for the
   ping. Not obviously wrong to change either way; user decision.

5. **What to do with the 5 misclassified NOTE rows from §6?** Options:
   (a) leave them as-is (historical noise; the audit prefix already flags
   them as agent-written), (b) delete them, (c) convert to correctly-projected
   Tasks (with the caveat that two would need re-projecting per §6).
   Recommendation: leave the two true-duplicate ones as-is, convert the three
   novel ones, delete none — but this is a user call.

6. **`TASK_DONE` activity emission.** Currently `ActivityType.TASK_DONE`
   exists in the enum but is never emitted (grep-confirmed). Should
   `crm.update_task` with `status: "DONE"` emit a `TASK_DONE` audit row (in
   addition to the generic `NOTE` audit)? This would light up the enum for
   the first time and add a real signal to project/client activity feeds.

7. **Cascading concerns on `crm.delete_task`.** `TimeEntry.taskId` uses the
   default RESTRICT — a delete on a task with time entries will FK-fail. The
   handler should either pre-check and refuse (mirror
   `projects.ts:deleteProject:143-146`) or manually null out the FK first.
   Which behavior does the user want?

8. **CLAUDE.md guidance update for `dimitris-claw`.** The channel's
   `groups/dimitris-claw/CLAUDE.md` currently doesn't mention tasks or the
   planner. It should get a section that says "use `crm.*` task tools instead
   of `crm.add_project_note` when the user's ask is a to-do / planificable
   item; check `crm.list_tasks` before creating to avoid duplicates like the
   ones in §6". Wording is a planner call.

9. **Timezone convention on `dueDate` when coming from Jarvis.** The
   existing paths use two inconsistent conventions (`"T12:00:00"` local vs
   `"T00:00:00-03:00"`). What does the MCP tool coerce `dueDate` to? To
   avoid re-triggering the planner-week boundary bug (spec
   `20260508_planner_week_move`), pick **`T00:00:00-03:00`** for both
   `dueDate` and `plannedDate` inputs. Flag for planner to confirm.

---

## 9. Deploy / verification touchpoints

- **No schema migration required.** All columns needed (`plannedDate`,
  `timeSlot`, `plannerOrder`, `contextNote`, `dueDate`, `TaskAssignee`) already
  exist. `drizzle-kit push --force` at boot will no-op on the Task/TaskAssignee
  tables.
- **New files only** in the CRM: `lib/domain/tasks.ts`, `lib/mcp/handlers/tasks.ts`, plus additions to `lib/mcp/tools.ts` (registry entries) and `lib/mcp/coerce.ts` (task patch coercers, new enum constants).
- **Nanoclaw side**: no changes to the MCP transport are needed — the new tools are auto-discovered via `tools/list`. Only `groups/dimitris-claw/CLAUDE.md` guidance may need to update (see §8.8).
- **Verify path**: after deploy, `curl -H "Authorization: Bearer $DIMITRIS_CRM_MCP_TOKEN" ... method=tools/list` should list the new `crm.*task*` names. Then a real end-to-end via Jarvis in `dimitris-claw` — create a task under an existing project, plan it into a specific day+slot, mark it DONE, verify it appears/disappears from Tareas / Desarrollo / Planificador as expected.

---

## 10. Relevant file paths (absolute)

CRM:

- `/home/sborit/prj/crm-dimitris/lib/schema.ts` — Task table `:142-161`, TaskAssignee `:163-172`, relations `:524-535`, enums `:18-38`.
- `/home/sborit/prj/crm-dimitris/lib/domain/activities.ts` — audit helper mold (all 72 lines).
- `/home/sborit/prj/crm-dimitris/lib/domain/leads.ts` — full domain mold (`createLead` `:123`, `updateLead` `:151`, `updateLeadStatus` `:189`, `linkLeadToClient` `:218`, `convertLeadToClient` `:254`, `addLeadActivity` `:316`).
- `/home/sborit/prj/crm-dimitris/lib/domain/projects.ts` — nearest-shape reference (Task has `projectId` like Project has `clientId`).
- `/home/sborit/prj/crm-dimitris/lib/mcp/tools.ts` — tool registry (all 564 lines).
- `/home/sborit/prj/crm-dimitris/lib/mcp/handlers/leads.ts` — handler shape reference.
- `/home/sborit/prj/crm-dimitris/lib/mcp/handlers/activities.ts` — note-append handler shape.
- `/home/sborit/prj/crm-dimitris/lib/mcp/coerce.ts` — coerce helpers to extend.
- `/home/sborit/prj/crm-dimitris/lib/mcp/json-rpc.ts` — envelope helpers (`toolContent`).
- `/home/sborit/prj/crm-dimitris/app/api/mcp/route.ts` — the HTTP surface; no changes needed.
- `/home/sborit/prj/crm-dimitris/app/(dashboard)/tasks/actions.ts` — legacy path (72 lines, avoid).
- `/home/sborit/prj/crm-dimitris/app/(dashboard)/projects/[id]/actions.ts` — modern task CRUD `:52-152`.
- `/home/sborit/prj/crm-dimitris/lib/actions/tasks.ts` — shared `createTaskAction`.
- `/home/sborit/prj/crm-dimitris/app/(dashboard)/planificador/actions.ts` — planner mutations (129 lines).
- `/home/sborit/prj/crm-dimitris/app/(dashboard)/desarrollo/actions.ts` — status + assignee mutations (41 lines).
- `/home/sborit/prj/crm-dimitris/app/(dashboard)/tasks/page.tsx` — Tareas query.
- `/home/sborit/prj/crm-dimitris/app/(dashboard)/planificador/page.tsx` — three-query planner (231 lines).
- `/home/sborit/prj/crm-dimitris/app/(dashboard)/desarrollo/page.tsx` — kanban query.
- `/home/sborit/prj/crm-dimitris/components/task-modal/actions.ts` — modal wrapper (46 lines).
- `/home/sborit/prj/crm-dimitris/components/create-task-dialog.tsx` — UI shape reference.
- `/home/sborit/prj/crm-dimitris/lib/prisma-types.ts` — enum type re-exports.

Prior spec (mold to follow byte-for-byte):

- `/home/sborit/prj/nanoclaw/docs/specs/20260716_crm_mcp_control_surface/SPEC.md`
- `/home/sborit/prj/nanoclaw/docs/specs/20260716_crm_mcp_control_surface/CONTEXT_CRM.md`
- `/home/sborit/prj/nanoclaw/docs/specs/20260716_crm_mcp_control_surface/CHANGES.md`

Nanoclaw:

- `/home/sborit/prj/nanoclaw/groups/dimitris-claw/CLAUDE.md` — channel-specific guidance to potentially amend (§8.8).

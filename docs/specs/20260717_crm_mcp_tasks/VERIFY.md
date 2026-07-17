# VERIFY — CRM MCP Task extension (local pass)

## Target

local (dev host: arm64 Pi). Prod deploy to `h-dmi-a` / `https://gaston.dimitris.app` explicitly **NOT** performed. Nanoclaw systemd service **NOT** restarted. No git commit/push.

## Results

### CRM (`~/prj/crm-dimitris`)

**1. Typecheck — PASS.**
`npx tsc --noEmit --project tsconfig.json 2>&1 | grep -v "^services/whatsapp/"` returns only follow-on hint lines from the pre-existing `services/whatsapp/**` `@types/express` error (36 total lines in the raw log, every `TS...` line is prefixed `services/whatsapp/`). Zero in-scope errors. Matches CHANGES.md §"Local build/typecheck results".

**2. SPEC Step 2 acceptance grep — PASS (with documented exemptions).**
`grep -rnE 'db\.(insert|update|delete)\(tasks\)' app/(dashboard) lib/actions/tasks.ts` returns exactly one hit:
- `app/(dashboard)/settings/actions.ts:143` — `db.update(tasks).set({ assigneeId: null })` — deprecated-column FK-nullification hygiene inside `deleteUser`. Explicitly documented as exempt in CHANGES.md §"Audit sweeps performed" and CHANGES.md §"Deviations". Not a task-write in the sense the SPEC gate cares about.

`grep -rnE '(db|tx)\.(insert|update|delete)\((tasks|taskAssignees)\)' app/(dashboard) lib/actions/tasks.ts components/task-modal/actions.ts` finds the same single hit — the `reorderTasks` bulk write (SPEC Non-goal exemption) is at `app/(dashboard)/planificador/actions.ts:67` and uses `.update(tasks)` via a chained builder starting with `tx` inside its own `db.transaction`, so it doesn't match the strict regex — but it's confirmed present (`grep -n "reorderTasks\|update(tasks)"` finds it at lines 53, 67). Both exemptions match SPEC + CHANGES.

**3. MCP no-actions-import gate — PASS.**
`grep -rn "from '@/app/(dashboard)" lib/mcp/handlers/tasks.ts` → 0 hits (exit=1).

**4. Tool count — PASS.**
`grep -cE '^\s*"crm\.' lib/mcp/tools.ts` → **35** (28 prior + 7 new). Matches SPEC §Risks #9 arithmetic.

**5. 7 new tool names present — PASS.**
Every one of `crm.list_tasks`, `crm.get_task`, `crm.create_task`, `crm.update_task`, `crm.complete_task`, `crm.assign_task`, `crm.delete_task` appears in `lib/mcp/tools.ts` (2 hits each — REGISTRY key + description reference).

**6. Rev 2 fix evidence — PASS.**
- **Fix #1 (dedup, both layers):**
  - `lib/domain/tasks.ts:84–85` — `function dedupe<T>(items: T[]): T[] { return Array.from(new Set(items)) }`; applied in `createTask` (271), `updateTask` (357), `assignTask` (484).
  - `lib/mcp/coerce.ts:99` — `return Array.from(new Set(cleaned))` inside `asStringArray`.
- **Fix #2 (readable audit):**
  - `assertUsersExist` defined at `lib/domain/tasks.ts:147`; call sites at 274, 364, 485 all use the returned rows.
  - `assignTask` audit body at `lib/domain/tasks.ts:507–508` formats as `` `Asignados: ${resolved.map((u) => u.name).join(", ")}` `` with the `(sin asignar)` empty case. Names, not IDs.
- **Fix #3 (T-branch re-anchor):**
  - `lib/domain/tasks.ts:132` — `const datePart = trimmed.slice(0, 10)` followed by `new Date(\`${datePart}T00:00:00-03:00\`)` at 133. Matches CHANGES.md Rev 2 #3.

**7. `isAgentActor` gate coverage — PASS.**
`grep -n "isAgentActor\|recordActivity" lib/domain/tasks.ts` shows every mutation site pairs the gate with `recordActivity(actor, {...}, tx)` inside its transaction:
- `createTask` — gate at 303, record at 304.
- `updateTask` — gate at 399, record at 403.
- `completeTask` — combined gate at 449 (`if (!wasAlreadyDone && isAgentActor(actor))`), record at 450 — matches SPEC §Step 1 idempotency spec.
- `assignTask` — gate at 498, record at 501.
- `deleteTask` — gate at 551, record at 554.
No unconditional-`recordActivity` outliers.

**8. `normalizeDateInput` explicit `-03:00` — PASS.**
`grep -cn -- "-03:00" lib/domain/tasks.ts` → **10** (well above the ≥2 threshold). Load-bearing occurrences: line 115 (base YYYY-MM-DD branch) and line 133 (T-branch re-anchor). Rest are docstrings.

**9. `completeTask` idempotency guard — PASS.**
`lib/domain/tasks.ts:435` — `const wasAlreadyDone = existing.status === "DONE"`. Update at 443–444 runs unconditionally (no-op set), but Activity emission at 449 is gated by `!wasAlreadyDone`. Matches SPEC §Step 1 and CHANGES.md.

**10. `deleteTask` FK guard — PASS.**
`lib/domain/tasks.ts:537–542` — pre-delete `SELECT count(*) FROM timeEntries WHERE taskId = ...`; if `> 0`, throws `` `Cannot delete: ${timeEntryCount} time entries logged; delete those first` `` — verbatim SPEC wording. Also read-time exposure at 244–245 (`getTask` surfaces `timeEntryCount`) so callers can pre-check.

**11. `assignTask` REPLACE + cap 5 — PASS.**
`lib/domain/tasks.ts:81` — `const ASSIGNEE_CAP = 5`. Enforced at 273 (`createTask`), 361 (`updateTask`), 484 (`assignTask`), each via `.slice(0, ASSIGNEE_CAP)`.

**12. Backward-compat shim safety — PASS.**
- `app/(dashboard)/tasks/actions.ts:37–39` (createTask) — `data.assigneeIds ?? (data.assigneeId ? [data.assigneeId] : undefined)`. When both absent → `undefined` (never `[undefined]`).
- `app/(dashboard)/tasks/actions.ts:75–79` (updateTask) — nested ternary: `assigneeIds` takes precedence; if only single `assigneeId` set, becomes `[id]`; if explicit `null`, becomes `[]`; if truly absent, `undefined`. Cannot produce `[undefined]`.
- `app/(dashboard)/planificador/actions.ts:103–105` (createTaskInPlanner) — same `?? (x ? [x] : undefined)` pattern. Safe.

### Nanoclaw (skill + CLAUDE.md — both gitignored, no build required)

**13. All 7 tool names in `crm-access.md` — PASS.**
Every one of `crm.create_task`, `crm.list_tasks`, `crm.complete_task`, `crm.assign_task`, `crm.delete_task`, `crm.get_task`, `crm.update_task` present in `data/sessions/dimitris-claw/.claude/skills/dimitris/crm-access.md` (grep counts: 2, 3, 2, 2, 2, 1, 2 respectively).

**14. Group `CLAUDE.md` guardrail bullets — PASS.**
`groups/dimitris-claw/CLAUDE.md:36` — Spanish bullet: *"Tareas accionables → `crm.create_task`. Aparece en Tareas, Desarrollo y Planificador automáticamente. `crm.add_project_note` / `add_client_note` / `add_lead_note` son solo para notas históricas no-accionables."* Plus line 38 reminder-guardrail. Matches SPEC §Step 5.

**15. `delete_task` "REFUSE on time entries" language — PASS.**
`crm-access.md:73` (tool listing) — *"REFUSES if the task has TimeEntry rows"*.
`crm-access.md:78` (Write-safety section) — *"refuses (returns isError:true) if the task has any TimeEntry rows … relay the error verbatim and offer to delete the time entries first"*. Matches SPEC §Step 4.

**16. `[Task: <title>]` prefix convention documented — PASS.**
`crm-access.md:65` — *"Task-adjacent notes go through `crm.add_project_note(projectId, "[Task: <title>] <body>")` — the `[Task: <title>]` prefix is a convention Jarvis maintains at the prompt layer."* Documented in the skill (SPEC only required "somewhere").

## Summary

- **Total PASS: 16, FAIL: 0, SKIP: 0.**
- No failures to classify.
- **Recommendation: ready-for-prod.**

Notes / caveats (not failures):
- No runtime endpoint verification performed (no `docker compose up`, no `POST /api/mcp` curl). Local pass here is grep + typecheck evidence only, per the scoped ask. Prod verification is a separate user-gated step.
- Prior-cycle `lightningcss.linux-arm64-gnu.node` platform mismatch on the Pi dev host (unrelated to this cycle) still means `npm run build` would fail locally; SPEC §Local #8 acknowledges this. Typecheck (which is what this cycle actually needs) is clean.
- `services/whatsapp/**` typecheck errors are pre-existing (`@types/express`, `pino`, `baileys`, `ws` not installed on the main tsconfig — the sidecar builds in its own Dockerfile), unchanged from prior cycle.

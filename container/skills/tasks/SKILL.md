---
name: tasks
description: "Manage personal tasks, to-dos, backlog, and priorities. Use when the user asks about what to work on, task status, creating/updating/deleting tasks, triaging work, weekly planning, reviewing backlog, checking overdue items, or anything related to their to-do list, pending work, or task prioritization."
---

# Task Management

Data lives at `/workspace/extra/tasks/`. Spec: `/workspace/extra/tasks/SPEC.md`. Read it for full schema details if needed.

## Files

- `/workspace/extra/tasks/backlog.yml` — all tasks (source of truth)
- `/workspace/extra/tasks/daily/YYYY-MM-DD.md` — context log
- `/workspace/extra/tasks/archive/YYYY-WXX.yml` — weekly completed archive by project

## Category Config

The `config` block at the top of `backlog.yml` maps projects to categories:

```yaml
config:
  categories:
    personal: [personal]
    work: [yousellit, platero]
```

New projects: ask "work or personal?" once, then add to config.

## Task Schema (quick ref)

Fields: id, name, desc, context, project, priority (1-5), state, due, created, started, completed, times_pushed, blocked_by, depends_on, tags, effort (small/medium/large/unknown), history[]

States: `backlog | pending | in_progress | paused | blocked | depends_on | completed`

### Defaults

| Field | Default | Notes |
|---|---|---|
| desc | `""` | Skip unless user provides |
| context | `null` | Skip unless user provides |
| priority | `3` | Infer from request context, propose value, confirm. Default 3 if unclear. |
| effort | `unknown` | Infer from request context, propose value, confirm. Default unknown if unclear. |
| blocked_by | `[]` | Skip unless user flags |
| depends_on | `[]` | Skip unless user flags |

## Create Task (triage flow)

Ask sequentially: name → project → tags → due date → state. For priority and effort: infer a suitable value from the request context and propose it for confirmation. If inference isn't possible, default to priority 3 and effort unknown. Skip desc (default empty), context (default null), blocked_by/depends_on (default empty).

When the user provides enough info in a single message (name, project, due, etc.), batch the triage — propose all values including inferred priority/effort in one confirmation summary rather than asking field by field.

Auto-set: id (`t-YYYYMMDD-NNN`), created (now), times_pushed (0), history ([{created}]).

## Update Task

On any mutation: update field in backlog.yml, append history entry with timestamp + change + optional reason.

When state → `in_progress` for first time, set `started`. When state → `completed`, set `completed`.

## Query ("what should I work on")

1. Read `/workspace/extra/tasks/backlog.yml` (including `config.categories`)
2. Read recent `/workspace/extra/tasks/daily/*.md` (last 2-3 days) for context
3. **Detect category from tone:**
   - Work tone ("what should I work on", "work tasks", project names) → filter to `work` category
   - Personal tone ("what do I need to do", "personal stuff", "errands") → filter to `personal` category
   - Neutral/unspecified ("what's on my plate", "my tasks") → show all
   - Explicit override always wins ("show me personal tasks" / "work tasks only")
   - **If filtered result is empty:** mention it and offer the other category. Never silently swap.
4. Filter: exclude completed, blocked (external), depends_on with unmet deps
5. Apply filters: timeframe, project, tags if specified
6. Score: overdue_days×10 + (6-priority)×5 + times_pushed×3 + staleness_weeks + unblocked_boost(5)

### Response Mode (critical)

**Default: single-task mode.** Most queries want ONE actionable answer, not a list.

Detect intent:
- **"What should I grab/do/work on next"** → Return the #1 scored task. Name, project, due, and a brief reason WHY it's the top pick (e.g. "blocks phase 2", "due tomorrow", "overdue by 3 days"). Keep it to 1-2 lines total. No fluff, but enough to justify the recommendation.
- **"What's on my plate today"** → Only tasks due today or overdue. If none, say so. Max 2-3 bullet points (name + due). Don't list multi-day tasks as "today" work unless they're due today.
- **"Give me my list" / "show backlog" / "all tasks"** → Full ranked list. This is the ONLY time you dump everything.
- **"What's next after this"** → Next single task after current in_progress one.

**Formatting rules (for chat/text surfaces):**
- No tables. No headers. No markdown formatting beyond bold.
- One task = one line. e.g. **Message engine phase 1** — yousellit, due Wed
- Details only when asked. Context, effort, tags — omit unless requested.
- Blocked/waiting tasks: mention only if the user has zero actionable tasks, or explicitly asks.

**Be a Jarvis, not a project manager.** Quick, decisive, one answer. The user can always ask for more.

## Context Logging

When conversation reveals info affecting task priority, blockers, or timelines — append to `/workspace/extra/tasks/daily/YYYY-MM-DD.md`. Update relevant task's context field and history if applicable.

## Heartbeat Check

On heartbeat, scan backlog.yml for:
- Overdue: due < today, state not completed/blocked → alert
- Stale: pending 14+ days without history entry → flag
- Newly unblocked: depends_on all completed → notify

Silent if nothing found.

## Weekly Archive

Cron handles this (Sunday 23:00 UTC-3). Manual trigger also supported. Move completed tasks to `/workspace/extra/tasks/archive/YYYY-WXX.yml` grouped by project, remove from backlog.yml.

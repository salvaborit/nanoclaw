# Context: Locksmith Accounting Agent

## Summary

This feature adds a per-group accounting agent to NanoClaw for the `Prueba tech acc` WhatsApp group (one locksmith trial: Aldo Cavanna). Jarvis auto-processes every message in the group, extracts completed-job records, writes them to a per-locksmith SQLite ledger at `~/locksmiths/aldo-cavanna/ledger.sqlite`, computes owner/locksmith cuts, and answers owner queries. This is a **per-group customization** only — it does not touch shared core code and must live on `develop` (or a feature branch off it). The key constraints are: (a) the `Prueba tech acc` group does not yet have a registered NanoClaw JID; (b) the SQLite ledger needs `sqlite3` CLI installed in the container (not currently present); (c) there is no built-in pending-action / confirmation-wait mechanism — that must be designed.

---

## Findings

### 1. Group Identification and Per-Group Customization

**Group registration model.** Groups are stored in the `registered_groups` table in `store/messages.db` (`src/db.ts:77-84`). Each row carries: `jid` (WhatsApp JID like `120363...@g.us`), `name`, `folder` (slug used for file paths), `trigger_pattern`, `container_config` (JSON blob for `ContainerConfig`), `requires_trigger`, and `is_main`. Source: `src/db.ts:77-84`. Confidence: certain.

**The `Prueba tech acc` group is not yet registered.** A full scan of all groups in the DB returned no match for "Prueba", "tech", "acc", "locksmith", or "Aldo". All currently registered group JIDs are: `Jarvis-Agenda`, `Dmitris 2.0`, `Ventas Dimitris`, `DimitrisClaw`, `Vice city 2`, `Purpl Bot`, `Yonita Trolls`, `Zellyt Bot`. The group has not had a message sent to it since NanoClaw started, so no JID has been observed yet. Source: `store/messages.db` (queried live). Confidence: certain.

**JID capture procedure (confirmed from Yonita Trolls precedent).** The pattern is: send a message in the group, grep logs for the JID, run a registration script (`scripts/register-<groupname>.ts`), then restart NanoClaw. Source: `docs/specs/20260505_YONITA_TROLLS_SETUP/SPEC.md:143-163`. Confidence: certain.

**Folder naming rules.** The `folder` slug must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` and is reserved-word-protected (no `global`). Spaces and special characters are not allowed. For `Prueba tech acc`, the natural slug would be `prueba-tech-acc`. Source: `src/group-folder.ts:3-9`. Confidence: certain.

**Per-group instruction file.** Each group gets `groups/{folder}/CLAUDE.md` mounted at `/workspace/group/CLAUDE.md` inside the container. This is the primary behavioral customization point — the agent reads it as project-level memory via the Claude Agent SDK (`settingSources: ['project', 'user']` in `container/agent-runner/src/index.ts:458`). The working directory inside the container is always `/workspace/group` (`container/agent-runner/src/index.ts:439`). Source: `src/container-runner.ts:100-103`, `container/agent-runner/src/index.ts:439`. Confidence: certain.

**Live example — Ventas Dimitris.** That group's `groups/ventas-dimitris/CLAUDE.md` contains the language setting and a skill-routing directive instructing all requests to use the `sales` skill. Same pattern applies here. Source: `/home/sborit/prj/nanoclaw/groups/ventas-dimitris/CLAUDE.md`. Confidence: certain.

**Per-group model override.** The model used by each group's agent is set in `data/sessions/{folder}/.claude/settings.json`. The file is auto-created by `src/container-runner.ts:128-151` on first run if it doesn't exist; it can be pre-created to set a specific model (e.g., `claude-sonnet-4-6`). Source: `src/container-runner.ts:128-151`. Confidence: certain.

---

### 2. Trigger Pattern

**Global trigger pattern.** `TRIGGER_PATTERN` in `src/config.ts:65-68` is `^@Jarvis\b` (case-insensitive). It is a module-level constant derived from `ASSISTANT_NAME`. It cannot be overridden per-group from config alone. Source: `src/config.ts:65-68`. Confidence: certain.

**How the trigger check works (two places).** The trigger gate appears in two code paths:

1. **`startMessageLoop` (line 429-443 of `src/index.ts`).** When new messages arrive, for a non-main group with `requiresTrigger !== false`, NanoClaw checks if any of the batch contains `TRIGGER_PATTERN` or `is_mentioned`. If not, the messages are stored but no container is launched.

2. **`processGroupMessages` (line 197-204 of `src/index.ts`).** Same check is repeated when the queue actually processes the group — looks at all pending messages since `lastAgentTimestamp`. If no trigger found, returns early without invoking the agent.

Source: `src/index.ts:197-204` and `src/index.ts:429-443`. Confidence: certain.

**The `requiresTrigger` field is the extension point.** The `RegisteredGroup` type (`src/types.ts:41`) includes `requiresTrigger?: boolean`. If set to `false`, both trigger checks are bypassed (`!isMainGroup && group.requiresTrigger !== false`). This means setting `requiresTrigger: false` in the group's DB registration will make Jarvis process every message in the group without needing `@Jarvis`. Source: `src/types.ts:41`, `src/index.ts:197`, `src/index.ts:429`. Confidence: certain.

**No per-group trigger-pattern override exists today.** The `TRIGGER_PATTERN` used in both checks is the global constant; there is no field in `RegisteredGroup` or `ContainerConfig` for a different pattern. The only per-group trigger variation is the `requiresTrigger: false` flag. Source: all of `src/index.ts`, `src/types.ts`. Confidence: certain.

---

### 3. Container Mounts

**Standard non-main group mounts.** For non-main groups, `buildVolumeMounts` in `src/container-runner.ts:63-220` creates these mounts:

| Host Path | Container Path | Mode |
|-----------|---------------|------|
| `groups/{folder}/` | `/workspace/group` | read-write |
| `groups/global/` (if exists) | `/workspace/global` | read-only |
| `data/sessions/{folder}/.claude/` | `/home/node/.claude` | read-write |
| `data/ipc/{folder}/` | `/workspace/ipc` | read-write |
| `data/sessions/{folder}/agent-runner-src/` | `/app/src` | read-write |

Source: `src/container-runner.ts:100-208`. Confidence: certain.

**Additional mounts via `containerConfig.additionalMounts`.** Each group's `container_config` JSON blob in the DB can include `additionalMounts: [{hostPath, containerPath, readonly}]`. These are processed by `validateAdditionalMounts` in `src/mount-security.ts:336-384` and mounted at `/workspace/extra/{containerPath}`. Source: `src/container-runner.ts:211-218`, `src/types.ts:1-5`, `src/mount-security.ts:357`. Confidence: certain.

**Mount security allowlist.** Additional mounts are validated against `~/.config/nanoclaw/mount-allowlist.json`. The current allowlist has a single allowed root: `/home/sborit` with `allowReadWrite: true` and `nonMainReadOnly: false`. This means a mount of `/home/sborit/locksmiths/aldo-cavanna/` will be **allowed read-write** without any changes to the allowlist. Source: `~/.config/nanoclaw/mount-allowlist.json` (queried live). Confidence: certain.

**Blocked patterns.** The allowlist has empty `blockedPatterns` (beyond the hardcoded defaults). The path `locksmiths` does not match any default blocked pattern (`.ssh`, `.gnupg`, `credentials`, etc.). Source: `src/mount-security.ts:29-47`, `~/.config/nanoclaw/mount-allowlist.json`. Confidence: certain.

**Precedent for writable per-group mounts.** Multiple existing groups already use this pattern with `readonly: false`: `Ventas Dimitris` mounts `/home/sborit/dimitris/sales`, `DimitrisClaw` mounts `/home/sborit/dimitris-vault`, `Vice city 2` mounts `/home/sborit/vice-city-2`. Source: `store/messages.db` registered_groups table (queried live). Confidence: certain.

**Resulting container path for the ledger.** With `hostPath: '/home/sborit/locksmiths'`, `containerPath: 'locksmiths'`, `readonly: false`, the ledger at `~/locksmiths/aldo-cavanna/ledger.sqlite` will appear inside the container at `/workspace/extra/locksmiths/aldo-cavanna/ledger.sqlite`. Source: `src/mount-security.ts:357` (prefix `/workspace/extra/`). Confidence: certain.

---

### 4. Container Tools and SQLite Access

**`sqlite3` CLI is NOT installed in the container.** The `container/Dockerfile` installs only Chromium, standard browser libraries, `curl`, `git`, `npm`, and `agent-browser` / `@anthropic-ai/claude-code` globally. There is no `sqlite3` package in the `apt-get install` list. Source: `container/Dockerfile`. Confidence: certain.

**No Node.js SQLite package in agent-runner.** The `container/agent-runner/package.json` lists only `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, `cron-parser`, and `zod`. No `better-sqlite3` or similar. Source: `container/agent-runner/package.json`. Confidence: certain.

**No existing SQLite skill in `container/skills/`.** The skills directory contains: `agent-browser`, `asdlc`, `capabilities`, `obsidian-vault-ops`, `project-status`, `sales`, `slack-formatting`, `status`. None provides SQLite access. Source: `ls /home/sborit/prj/nanoclaw/container/skills/`. Confidence: certain.

**The agent can run Bash.** The SDK in `container/agent-runner/src/index.ts:446` lists `'Bash'` as an allowed tool. Any tool available in the container's shell can be called via `Bash`. So if `sqlite3` CLI is added to the Dockerfile, the agent can use it directly via `Bash`. Source: `container/agent-runner/src/index.ts:446`. Confidence: certain.

**Skill pattern for per-group capabilities.** Container skills are instruction-only SKILL.md files in `container/skills/{skill-name}/SKILL.md`. They are synced into each group's `.claude/skills/` directory at each container run (`src/container-runner.ts:153-166`). The `sales` skill (in `container/skills/sales/SKILL.md`) is the clearest model: it provides a SKILL.md that instructs the agent how to read/write YAML files under `/workspace/extra/sales/` via Bash. A `locksmith-ledger` skill would follow the same pattern, instructing the agent to run `sqlite3 /workspace/extra/locksmiths/aldo-cavanna/ledger.sqlite` commands via Bash. Source: `container/skills/sales/SKILL.md`, `src/container-runner.ts:153-166`. Confidence: certain.

**`sqlite3` host version.** The host has `sqlite3 3.46.1` at `/usr/bin/sqlite3`. The container base `node:24-slim` (Debian-based) has `sqlite3` available via `apt-get install sqlite3`. Source: `which sqlite3 && sqlite3 --version` (run on host). Confidence: certain.

---

### 5. Reply-in-Group Flow

**How agent replies reach the group.** When the container agent produces a result, it is emitted as JSON between `OUTPUT_START_MARKER`/`OUTPUT_END_MARKER` sentinels on stdout. The host-side `processGroupMessages` in `src/index.ts:240-271` captures each result via `onOutput` callback and immediately calls `channel.sendMessage(chatJid, text)`. The channel (WhatsApp skill) delivers it to the group. Source: `src/index.ts:246-260`, `src/router.ts:40-48`. Confidence: certain.

**No pending-action model exists in NanoClaw today.** There is no mechanism to: (a) pause the agent mid-conversation while waiting for user confirmation, (b) hold a "draft" job record in a pending state, or (c) correlate a follow-up message specifically to a prior prompt. All message processing is linear: trigger arrives → agent runs to completion → agent exits (or waits on IPC). Source: full reading of `src/index.ts`, `src/ipc.ts`, `container/agent-runner/src/index.ts`. Confidence: certain.

**IPC follow-up messages are the multi-turn mechanism.** While a container is alive (within `IDLE_TIMEOUT`, default 30 minutes), follow-up messages from the group are piped into the running container via IPC files in `/workspace/ipc/input/`. The agent's inner polling loop picks them up and feeds them into the active Claude query stream. This is the existing multi-turn path. Source: `container/agent-runner/src/index.ts:383-401`, `src/group-queue.ts` (referenced), `src/index.ts:456-470`. Confidence: certain.

**Implication for confirmation flow.** If `requiresTrigger: false` and a container is alive, a locksmith's "yes/confirm" message in the group will be piped as a follow-up to the same agent session. The agent can detect it and finalize the ledger write. This works without any new infrastructure, as long as the agent's CLAUDE.md instructs it on the expected confirmation protocol and the container stays alive between the agent's "please confirm" reply and the locksmith's response. The only risk is IDLE_TIMEOUT (30 min) — if the locksmith takes longer, the container exits and the next message spawns a new container (losing the pending-confirmation context unless it was persisted to a file). Source: `src/config.ts:55`, `container/agent-runner/src/index.ts:380-409`. Confidence: certain.

---

### 6. Scheduled Tasks

**Scheduler mechanism.** `startSchedulerLoop` in `src/task-scheduler.ts:243-277` polls every `SCHEDULER_POLL_INTERVAL` (60 seconds, `src/config.ts:19`). Due tasks from `getDueTasks()` are queued per group via `queue.enqueueTask`. Each task runs `runContainerAgent` with the task's stored `prompt` and sends the result to `task.chat_jid`. Source: `src/task-scheduler.ts:243-277`. Confidence: certain.

**Task schema.** `ScheduledTask` in `src/types.ts:59-72` has: `schedule_type: 'cron' | 'interval' | 'once'`, `schedule_value` (cron string or ms interval), `context_mode: 'group' | 'isolated'`, `chat_jid`, `group_folder`. Cron expressions are parsed with `cron-parser` respecting the system `TIMEZONE`. Source: `src/types.ts:59-72`, `src/task-scheduler.ts:36-39`. Confidence: certain.

**How the agent creates tasks.** The agent creates tasks via IPC: it writes a JSON file to `/workspace/ipc/{group_folder}/tasks/` with `type: 'create_task'` and task fields. The host-side `processTaskIpc` in `src/ipc.ts:157+` picks it up and calls `createTask()`. Source: `src/ipc.ts:157-179`. Confidence: certain.

**Weekly summary is directly supported.** A `schedule_type: 'cron'` task with `schedule_value: '0 18 * * 0'` (Sunday 18:00) would run the agent with a prompt like "Post the weekly locksmith summary for Aldo Cavanna in the group". The agent would query the SQLite ledger and send the summary. This requires no new infrastructure. Source: `src/task-scheduler.ts:36-39`. Confidence: certain.

---

### 7. Memory and Config Conventions

**Group CLAUDE.md path scheme.** Per-group behavioral instructions live at `groups/{folder}/CLAUDE.md`. The folder name must be a valid slug (see Section 1). For this trial, the file would be at `groups/prueba-tech-acc/CLAUDE.md` (or whatever slug is chosen at registration time). Source: `src/container-runner.ts:69`, `src/config.ts:39`. Confidence: certain.

**`locksmiths.yaml` config location.** There is no existing convention for a per-agent YAML config file. Two viable patterns exist in the codebase: (a) place it inside the group's writable folder `groups/prueba-tech-acc/` — it would be accessible at `/workspace/group/locksmiths.yaml` inside the container without any extra mount; (b) place it inside the mounted `~/locksmiths/` directory (e.g., `~/locksmiths/locksmiths.yaml`) — it would be accessible at `/workspace/extra/locksmiths/locksmiths.yaml`. Option (a) is simpler and requires no additional mount. Source: mount table in Section 3. Confidence: certain.

**Global memory directory.** `groups/global/CLAUDE.md` is mounted read-only at `/workspace/global/CLAUDE.md` in all non-main containers. It is loaded as a system prompt append by the agent runner. This is for cross-group shared instructions, not per-group config. Source: `container/agent-runner/src/index.ts:408-418`, `src/container-runner.ts:109-117`. Confidence: certain.

**Per-group CLAUDE.md is auto-loaded.** The Claude Agent SDK's `settingSources: ['project', 'user']` means it reads `CLAUDE.md` from the working directory (`/workspace/group`) automatically, without the agent needing to explicitly read the file. Source: `container/agent-runner/src/index.ts:458`. Confidence: certain.

---

### 8. Operational Constraints and Gotchas

**Container build cache.** Per `CLAUDE.md` troubleshooting: `--no-cache` alone does not invalidate COPY steps. To add `sqlite3` to the Dockerfile, prune the builder volume before rebuilding (`docker buildx prune` or equivalent) to guarantee the new `apt-get install sqlite3` line takes effect. Source: `CLAUDE.md` (troubleshooting section). Confidence: certain.

**Agent-runner source is per-group.** `data/sessions/{folder}/agent-runner-src/` is a copy of `container/agent-runner/src/` made once on first container run (`src/container-runner.ts:189-208`). After that initial copy, changes to the canonical `container/agent-runner/src/` are NOT automatically propagated to existing groups — the per-group copy must be deleted or manually updated to pick up changes. This matters if the agent-runner is modified. Source: `src/container-runner.ts:189-208`. Confidence: certain.

**Skills ARE synced on every run.** Unlike agent-runner source, container skills in `container/skills/` ARE synced on each container invocation (`src/container-runner.ts:153-166`). A new `container/skills/locksmith-ledger/SKILL.md` will appear in the container on the next run without any manual step. Source: `src/container-runner.ts:153-166`. Confidence: certain.

**`~/locksmiths/` does not exist yet.** The directory `/home/sborit/locksmiths/` was not found on the host. It must be created before registering the group (mount validation calls `fs.realpathSync` which fails on non-existent paths — `src/mount-security.ts:139-145`). Source: live check + `src/mount-security.ts:139-145`. Confidence: certain.

**Branch.** The working branch is `develop` as required by `CLAUDE.md`. The `Prueba tech acc` feature should be implemented there. Source: `CLAUDE.md` (branching strategy), `git status` (current branch: `develop`). Confidence: certain.

**Existing specs.** `docs/specs/20260505_YONITA_TROLLS_SETUP/SPEC.md` is the best precedent — it documents the exact steps for registering a new WhatsApp group including folder creation, CLAUDE.md, settings.json, registration script, and JID capture. There is no CONTEXT.md for that spec (only SPEC.md). The productization research spec (`20260605_PRODUCTIZATION_RESEARCH/CONTEXT.md`) is unrelated to this feature. Source: `ls docs/specs/`. Confidence: certain.

---

## Open Questions

The following require user clarification before planning:

1. **Confirmation flow timeout.** If Aldo takes more than 30 minutes to confirm a job, the container exits and the confirmation context is lost. Should the agent write a "pending" record to a file so the next container run can pick up where it left off? Or is 30 minutes sufficient for the trial?

2. **Confirmation actor.** Who sends the "yes/confirm" — only Aldo (the locksmith), or can the owner also confirm/reject? Does the agent need to check `sender_name` before acting on a confirmation?

3. **`locksmiths.yaml` config ownership.** Should the config file live in `groups/prueba-tech-acc/` (in-repo, edited by owner via main group or directly) or in `~/locksmiths/locksmiths.yaml` (outside repo, alongside the ledger)? The latter is more operationally natural; the former is easier to track in git.

4. **Error on unparseable messages.** The group will have non-job messages (greetings, photos, etc.). Should the agent silently ignore them, send a private-style acknowledgment, or log them to a separate file?

5. **Owner query sender restriction.** Should queries like "how much do I owe Aldo?" only be processed from the owner's phone number, or from any sender in the group? (Relevant if Aldo is also in the same group.)

6. **Multi-locksmith ledger path.** The user said future locksmiths will also be in this group or separate groups. Should each locksmith get their own sub-directory under `~/locksmiths/{locksmith-slug}/ledger.sqlite`, or a single shared DB? The current design (one dir per locksmith) is extensible either way.

7. **`Prueba tech acc` group JID.** The group has not been seen by NanoClaw yet. The user needs to send a message in the group while NanoClaw is running to capture the JID before registration can proceed.

---

## Recommendations (Extension Points for the Planner)

These are factual extension points identified in the codebase — not a plan.

**R1: "Always-on" mode via `requiresTrigger: false`.** Set `requiresTrigger: false` in the group's registration. This is a single field in `setRegisteredGroup`. No core code changes needed. Source: `src/types.ts:41`, `src/index.ts:197`.

**R2: Ledger mount via `containerConfig.additionalMounts`.** Add `{hostPath: '/home/sborit/locksmiths', containerPath: 'locksmiths', readonly: false}` to the group's `containerConfig`. The mount allowlist already permits `/home/sborit`. The ledger appears at `/workspace/extra/locksmiths/aldo-cavanna/ledger.sqlite`. Source: `src/mount-security.ts`, `src/types.ts:30-33`.

**R3: SQLite access requires one Dockerfile change.** Add `sqlite3 \` to the `apt-get install -y` line in `container/Dockerfile`. Requires rebuilding the image and pruning the build cache. No other infrastructure change needed — the agent calls `sqlite3` via `Bash`. Source: `container/Dockerfile`.

**R4: Behavior lives in `groups/prueba-tech-acc/CLAUDE.md`.** The full job-extraction, confirmation protocol, cut-calculation logic, and query-answering instructions go in this file. It is loaded automatically by the SDK. No code changes needed for behavioral customization. Source: `container/agent-runner/src/index.ts:458`.

**R5: Skills for ledger operations.** A new `container/skills/locksmith-ledger/SKILL.md` can provide the agent with reusable Bash recipes for schema creation, job insertion, cut calculation, and summary queries. It is auto-synced to the container on every run. No Dockerfile change needed for the skill itself. Source: `src/container-runner.ts:153-166`.

**R6: `locksmiths.yaml` readable from `/workspace/group/`.** Placing the config at `groups/prueba-tech-acc/locksmiths.yaml` makes it available inside the container at `/workspace/group/locksmiths.yaml` without any extra mount. This is the path of least resistance. Source: mount table, Section 3.

**R7: Scheduled weekly summary via IPC task creation.** The agent can create a cron task (via IPC) the first time it is invoked, using `schedule_type: 'cron'`, `schedule_value: '0 18 * * 0'`. The scheduler will then fire the prompt every Sunday at 18:00 and the agent will post the summary to the group. No new scheduler infrastructure needed. Source: `src/task-scheduler.ts:36-39`, `src/ipc.ts:157`.

**R8: Registration script pattern.** Follow `scripts/register-zellyt-bot.ts` exactly. The registration script for `prueba-tech-acc` should set `requiresTrigger: false`, the `additionalMounts` for locksmiths, and the model (recommend `claude-sonnet-4-6` for cost). Source: `scripts/register-zellyt-bot.ts`.

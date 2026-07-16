# CONTEXT — Nanoclaw side of the CRM MCP control surface

Research for wiring a per-group MCP server that gives the `dimitris-claw` WhatsApp group full CRUD control of the Dimitris CRM. Companion to `CONTEXT_CRM.md` (CRM-side).

Repo root: `/home/sborit/prj/nanoclaw`. Host is Linux (`Linux 6.12.34+rpt-rpi-2712`, RaspberryPi-class). Container runtime is Docker (`src/container-runtime.ts:11`).

---

## 1. MCP wiring inside a container

**MCP servers are declared programmatically in the SDK query() call.** In `container/agent-runner/src/index.ts:460-470` the agent-runner passes exactly one MCP server today:

```ts
mcpServers: {
  nanoclaw: {
    command: 'node',
    args: [mcpServerPath],           // /app/dist/ipc-mcp-stdio.js
    env: { NANOCLAW_CHAT_JID, NANOCLAW_GROUP_FOLDER, NANOCLAW_IS_MAIN },
  },
},
```

The nanoclaw stdio server implements `mcp__nanoclaw__*` (send_message, schedule_task, list_tasks, pause/resume/cancel/update_task, register_group) via IPC files under `/workspace/ipc/` — source `container/agent-runner/src/ipc-mcp-stdio.ts`. This is the only in-tree MCP server. Confidence: certain.

**The SDK also loads project `.mcp.json` files, gated by settings.** The `@anthropic-ai/claude-agent-sdk` types show three settings knobs (`sdk.d.ts` in `@anthropic-ai/claude-agent-sdk` node_modules, examined via `/home/sborit/prj/minsait-ai/container/agent-runner/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:4058-4075`):
- `enableAllProjectMcpServers?: boolean` — auto-approve every `.mcp.json` server in the project
- `enabledMcpjsonServers?: string[]` / `disabledMcpjsonServers?: string[]` — per-server approval

The current agent-runner sets `settingSources: ['project', 'user']` (`container/agent-runner/src/index.ts:459`) and `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true` (`:457-458`). The `settingSources` docstring (`sdk.d.ts:1667`) says "Must include `'project'` to load CLAUDE.md files" — but the same source lets `.mcp.json` approvals flow through since they live in the same tier. Whether `bypassPermissions` alone auto-approves `.mcp.json` without `enableAllProjectMcpServers: true` is untested here. Confidence: likely, needs a smoke test.

**Supported MCP transport types in the SDK.** From `sdk.d.ts:978`:
- `stdio` — `{ command, args?, env? }`
- `sse`   — `{ type: 'sse',  url, headers? }`
- `http`  — `{ type: 'http', url, headers?, tools?, alwaysLoad? }`
- `sdk`   — in-process (`McpSdkServerConfigWithInstance`), **NOT inherited by subagents**

For a remote HTTPS MCP at `https://gaston.dimitris.app/...`, the config is `{ type: 'http', url, headers: { Authorization: 'Bearer …' } }`. Confidence: certain.

**Where per-group MCP config could live.** Three options, all viable:

| Option | Location | Scope | Pros | Cons |
|---|---|---|---|---|
| A. Edit `container/agent-runner/src/index.ts` to conditionally merge extra `mcpServers` based on a per-group flag/env | tree | all groups (with per-group gate) | one source of truth, subagent-inheritable | shared-core change (must land on `main`/`develop`, all groups rebuild against it) |
| B. Drop `.mcp.json` in the group's workdir (`/workspace/group/.mcp.json` = host `groups/dimitris-claw/.mcp.json`) plus enable in per-group `settings.json` | per-group | dimitris-claw only | no shared-core change; only visible to this container | requires SDK to actually load project `.mcp.json` under our `bypassPermissions`/`settingSources` — see confidence caveat above |
| C. Ship MCP as `mcpServers.*` inside the per-group session `settings.json` at `data/sessions/dimitris-claw/.claude/settings.json` | per-group | dimitris-claw only | already a stable per-group customization point (already carries the `env` block); merged by SDK via `user` source | the file is bind-mounted at `/home/node/.claude/settings.json` — it's the SDK "user" scope, not "project"; needs confirmation that `mcpServers` in user settings.json is loaded |

Confidence on all three: likely-but-unverified. See §7 for the decision the planner has to make.

**Note on `agent-runner-src` per-group fork.** `src/container-runner.ts:187-208` copies `container/agent-runner/src/` into `data/sessions/{folder}/agent-runner-src/` on **first run only** (`if (!fs.existsSync(...))`), then bind-mounts it at `/app/src`, and `container/Dockerfile:62` recompiles that source at container startup. This means Option A can be applied **per-group** by editing only `data/sessions/dimitris-claw/agent-runner-src/index.ts` — no image rebuild, no impact on other groups. Confidence: certain.

**Is any group currently using an MCP server other than nanoclaw?** No. `grep -rn "mcpServers"` across `src/`, `container/`, `container/skills/`, `data/sessions/*/agent-runner-src/` finds only the built-in `nanoclaw` config in `container/agent-runner/src/index.ts:460`. No `.mcp.json` anywhere in the repo. Confidence: certain (files verified today).

---

## 2. Container network / outbound HTTPS

**Outbound is unrestricted.** `src/container-runner.ts:236-288` (`buildContainerArgs`) never emits `--network`, `--dns`, `--cap-drop`, or any proxy env. Docker's default bridge network gives full outbound. `src/container-runtime.ts:14-20` only adds `--add-host=host.docker.internal:host-gateway` on Linux (so containers can hit host services). Confidence: certain.

**`https://gaston.dimitris.app` reaches the container fine.** Verified today with `docker run --rm --entrypoint sh nanoclaw-agent:latest -c 'curl -sS -o /dev/null -w "%{http_code}" https://gaston.dimitris.app/'` → **307** (redirect, TLS handshake succeeded). Confidence: certain.

**CA store.** Image base is `node:24-slim` (Debian slim), which ships `ca-certificates`. Verified: `/etc/ssl/certs/ca-certificates.crt` exists in `nanoclaw-agent:latest`. Confidence: certain.

**One caveat if OneCLI comes online.** `@onecli-sh/sdk` (`node_modules/@onecli-sh/sdk/lib/index.js:148-158`) sets `SSL_CERT_FILE=/tmp/onecli-combined-ca.pem` (system CAs + OneCLI proxy CA). That still trusts real public CAs, so `gaston.dimitris.app`'s Let's Encrypt / real cert still validates. But *any* env var manipulation of `NODE_EXTRA_CA_CERTS` or `SSL_CERT_FILE` by a future change must keep the public CA bundle. Confidence: certain.

---

## 3. Secret injection for the MCP

**OneCLI is NOT running on this host.** `curl http://localhost:10254/api/container-config` → connection refused. No listener on port 10254 or 25000. `logs/nanoclaw.log` contains **421** occurrences of `"OneCLI gateway not reachable"`. So the OneCLI code path is currently a no-op — every container spawn logs the warning and moves on (`src/container-runner.ts:252-258`). Confidence: certain.

**What actually injects credentials today.** `src/container-runner.ts:227-234` (`readSecrets()`) reads an allowlist from `.env`: `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`. These are written to the container **via stdin JSON** (not env vars, not files) at `:353-357`, then the agent-runner merges them into `sdkEnv` at `container/agent-runner/src/index.ts:530-533`. Only `CLAUDE_CODE_OAUTH_TOKEN` is present in the current `.env`. Confidence: certain.

**How OneCLI *would* inject secrets, if reachable.** The SDK method `applyContainerConfig(args, { agent })` (`node_modules/@onecli-sh/sdk/lib/index.js:137-164`) does two things:
1. Push `-e KEY=VALUE` docker args for each entry in the per-agent env dict returned by `GET /api/container-config?agent=<identifier>`.
2. Bind-mount the OneCLI proxy CA at a container path (plus a combined CA bundle) and set `SSL_CERT_FILE`.

The per-group agent identifier is `group.folder.toLowerCase().replace(/_/g, '-')` (`src/container-runner.ts:305-307`), so `dimitris-claw` maps to OneCLI agent `dimitris-claw`. If someone brings OneCLI up later, the injection is automatic and per-group. Confidence: certain (from code); nothing today depends on it.

**Where a per-group MCP bearer token could live.** Ranked from least to most invasive:

1. **Per-group `settings.json` env block.** `src/container-runner.ts:128-151` writes a default `data/sessions/{folder}/.claude/settings.json` that already carries an `env: { ... }` block. Adding `DIMITRIS_CRM_MCP_TOKEN` there flows into `sdkEnv` and becomes visible to whichever mcpServers config reads it. Persisted, per-group, gitignored (whole `data/` is gitignored). Confidence: certain that the file is not overwritten once created (`if (!fs.existsSync(settingsFile))` on `:130`), so hand-edits stick.
2. **`.env` + `readSecrets` allowlist.** Add `DIMITRIS_CRM_MCP_TOKEN` to the four-key allowlist in `src/container-runner.ts:229-233`. Then all groups get it via stdin (not per-group; the current secret model is *all secrets to all containers*). Small shared-core change.
3. **OneCLI env for the `dimitris-claw` agent.** Only meaningful once OneCLI is deployed on this host. Would give clean per-group scoping without touching `.env`. Not available today.
4. **Read-only mount of a token file.** `containerConfig.additionalMounts` allowlist (`~/.config/nanoclaw/mount-allowlist.json`) permits everything under `/home/sborit` read-write. A file mount at, e.g., `/home/sborit/dimitris-claw-config/mcp-token` is possible, but `mount-security.ts:39` blocks any path containing the substring `"token"` (default blocked pattern list at `mount-security.ts:29-47`). Rename to `mcp-auth` or similar to bypass — or block-pattern override in the allowlist. Confidence: certain.

**Is there any prior art for "MCP server needs a token"?** No. The only MCP server today is the local nanoclaw stdio server, which needs no auth (IPC via bind-mounted `/workspace/ipc/`). We are the first to wire a token-bearing MCP. Confidence: certain.

---

## 4. Trigger surface & multi-agent

**`dimitris-claw` fires on every message (no trigger).** SQLite `registered_groups` row: `requires_trigger=0`, `is_main=0` (queried today). So every WhatsApp message in that group spawns/routes to the container; there is no `@Jarvis` gate. Confidence: certain.

**Scheduled tasks are supported for this group.** `src/task-scheduler.ts` fires for any registered group; no per-group opt-out. Scheduled runs spawn a container with `isScheduledTask: true` (`:180`), which just changes bookkeeping — the agent runs the same query loop with the same `mcpServers`. So a scheduled task could invoke MCP write tools. There is no built-in "no writes from scheduled runs" guardrail. Confidence: certain. Concern for planner: whether we want a hook or in-CLAUDE.md rule that gates writes when `isScheduledTask` is set.

**Agent Teams: subagent MCP inheritance.** `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set in `data/sessions/dimitris-claw/.claude/settings.json:4` (verified today). The SDK deep-dive at `docs/SDK_DEEP_DIVE.md:600` says explicitly: *"Creates an in-process MCP server (we use stdio instead for subagent inheritance)"*. Interpretation: **stdio / sse / http MCP servers ARE inherited by subagents; only `type: 'sdk'` in-process is not.** Since we plan `type: 'http'`, subagents on the team get the same CRM tools. Confidence: likely (from doc phrasing + SDK architecture — subagent processes are children of the same CLI, which owns the MCP client pool; not empirically verified in this repo).

**No confirmation-in-chat pattern exists.** From `docs/specs/20260618_LOCKSMITH_ACCOUNTING_AGENT/CONTEXT.md:93` (verbatim): *"No pending-action model exists in NanoClaw today. There is no mechanism to (a) pause the agent mid-conversation while waiting for user confirmation, (b) hold a draft record in a pending state, or (c) correlate a follow-up message specifically to a prior prompt."* The locksmith spec's workaround: the agent asks "please confirm", stays alive during `IDLE_TIMEOUT=30min` (`src/config.ts:55`), and the sender's follow-up message is piped in via IPC (`container/agent-runner/src/index.ts:394-398`). The 30-min window is the ceiling; longer than that and the confirmation context is lost unless the agent persisted it to disk. Same limitation applies to any "should I run this DELETE?" flow we build here. Confidence: certain.

**`permissionMode: 'bypassPermissions'` short-circuits the SDK's own `canUseTool` gate.** So the SDK will not call back into host code to ask "is this MCP tool call OK?" — any per-tool authorization has to live inside the MCP server itself (server-side allowlist based on the bearer token, or server-side sender check), or inside the agent's CLAUDE.md as a soft rule. Confidence: certain.

---

## 5. Prior art / adjacent work

**`docs/specs/` in this repo:**
- `20260716_crm_mcp_control_surface/CONTEXT_CRM.md` — the sibling CRM-side research doc (already written). Covers CRM auth model, server-actions vs MCP layer trade-off, and the fact that this is the first "external control surface" for the CRM. This doc is what the planner will pair with mine.
- `20260618_LOCKSMITH_ACCOUNTING_AGENT/` (CONTEXT.md + SPEC.md + CHANGES.md) — recent per-group agent feature. **Most useful precedent** because it walks the same shape: per-group `additionalMounts`, per-group `CLAUDE.md`, no shared-core code change, container-side `sqlite3` CLI as the only Docker dep added. The confirmation-flow discussion (`:93-97`) is directly relevant to any "please confirm this write" UX we design.
- `20260605_PRODUCTIZATION_RESEARCH/CONTEXT.md` — general productization note; mentions MCP servers only as a stock capability (`§1.1`). Not directly relevant.
- `20260505_YONITA_TROLLS_SETUP/SPEC.md` — precedent for the registration script pattern (send message → capture JID → run `scripts/register-*.ts` → restart nanoclaw). Same shape as what `dimitris-claw` uses.
- `recordatorios/` — Jarvis-Agenda scheduling design; irrelevant here.

**`dimitris-claw` registration state (verified in `store/messages.db` today).**
```
jid=120363427115081775@g.us, name=DimitrisClaw, folder=dimitris-claw,
requires_trigger=0, is_main=0,
container_config = {"additionalMounts":[
  {"hostPath":"/home/sborit/dimitris-claw-config",
   "containerPath":"dimitris",
   "readonly":true}
]}
```
Host directory `/home/sborit/dimitris-claw-config/` contains `id_key`, `ssh_config`, `known_hosts`, `README.md`. Mounted read-only at `/workspace/extra/dimitris/`. `groups/dimitris-claw/CLAUDE.md` (verbatim §"Reglas específicas del canal") makes the current channel contract explicit: *"Read-only, físicamente. El rol `nanoclaw_ro` no puede escribir. Si el usuario pide un `INSERT/UPDATE/DELETE`, explicá que este canal es de solo lectura y que las escrituras van por la UI del CRM."* This is the invariant the new feature explicitly changes — it must be updated as part of the SPEC. Confidence: certain.

**Other groups with interesting mount patterns.**
- `ventas-dimitris`: `{"model":"claude-sonnet-4-6","additionalMounts":[{"hostPath":"/home/sborit/dmitris/sales","containerPath":"sales","readonly":false}]}` — RW mount + model override in the same JSON blob.
- `cencoclaw`: `additionalMounts: [{ hostPath: '/home/sborit/prj/minsait-ai', containerPath: 'minsait-ai', readonly: false }]` (`scripts/register-cencoclaw.ts:29-32`) — proves that RW mounts of a full project directory work fine.
- `prueba-tech-acc` (locksmith): mounts `/home/sborit/locksmiths` at `/workspace/extra/locksmiths` (rw). Also has an in-container per-group SQLite ledger — pattern to imitate if we ever want a local audit log of MCP calls.

No group currently ships a `.mcp.json` or per-group `mcpServers` config; this feature would be the first.

---

## 6. Deploy story for nanoclaw

**Runtime: `systemctl --user nanoclaw` (Linux, user-mode systemd).** Verified today: `systemctl --user is-active nanoclaw` → `active`. Unit at `/home/sborit/.config/systemd/user/nanoclaw.service`:
```
ExecStart=/home/sborit/.nvm/versions/node/v22.20.0/bin/node /home/sborit/prj/nanoclaw/dist/index.js
WorkingDirectory=/home/sborit/prj/nanoclaw
Environment=CREDENTIAL_PROXY_PORT=25000
StandardOutput=append:/home/sborit/prj/nanoclaw/logs/nanoclaw.log
```
Restart procedure: `systemctl --user restart nanoclaw`. Confidence: certain.

**Rebuild requirements for this feature.**
- If Option A (edit `container/agent-runner/src/index.ts`) is applied via the **per-group agent-runner-src fork** at `data/sessions/dimitris-claw/agent-runner-src/`, **no host restart and no image rebuild** are needed — the entrypoint (`container/Dockerfile:62`) recompiles `/app/src` on every container start. The next message to `dimitris-claw` picks up the change.
- If applied to the tree at `container/agent-runner/src/index.ts` **and** the group's per-group fork already exists (which it does, per `ls data/sessions/dimitris-claw/agent-runner-src/`), the fork **shadows the tree**. So a tree-only edit would silently not apply. Must either edit the fork, or delete the fork before restart (`src/container-runner.ts:201` only copies if the fork doesn't exist).
- Option B/C (`.mcp.json` or per-group `settings.json`) requires zero rebuild — files are read at container startup.
- A `npm run build` is only needed if `src/` (orchestrator) changes. Container image only needs rebuild if `container/Dockerfile` changes. Confidence: certain.

---

## 7. Open questions for the planner

Concrete decisions that must be resolved before drafting SPEC/steps. Each is either a fork in the road or a "cite this" for the SPEC.

1. **Config surface: .mcp.json vs settings.json vs agent-runner-src edit** — which of §1's Options A/B/C do we pick? Option A (per-group agent-runner-src fork) is the safest bet because we know it works (the current `nanoclaw` MCP server rides that exact path). Option B is cleanest architecturally but relies on unverified assumption that `permissionMode: 'bypassPermissions'` + `settingSources: ['project', 'user']` is enough to auto-load `.mcp.json` servers without also setting `enableAllProjectMcpServers: true`. Suggest: prototype B first (5-line experiment), fall back to A if it doesn't wire up.

2. **Where does the MCP bearer token live?** §3 lists four options. Recommend #1 (per-group `settings.json` `env` block) as the default: no shared-core diff, no OneCLI dependency, no allowlist bypass. But — see #3.

3. **Token per-group (static) or per-WhatsApp-sender (dynamic)?** If per-sender, the token has to be minted by the MCP surface for each sender identity, and the agent has to know the sender's WhatsApp phone number → CRM user mapping (which is a `CONTEXT_CRM.md`-side concern — see its §"Implication for MCP" about `createdById` on writes). If per-group, one shared bearer token → all writes are attributed to a single synthetic `agent@dimitris.uy` CRM user. The CRM-side spec must decide this first; the nanoclaw side just carries whatever token shape it chooses.

4. **Do we host the MCP under `https://gaston.dimitris.app/api/mcp` or under a separate hostname?** The container reaches the existing hostname fine (§2). The `CONTEXT_CRM.md` (§7 hardening constraint) flags that "No JSON token endpoint" is current policy — introducing `/api/mcp` **is** a policy departure and needs an explicit call-out in the SPEC. A separate subdomain (e.g. `mcp.gaston.dimitris.app`) would isolate the MCP surface, its rate limits, and its auth from the human-user cookie-based auth. This is a CRM-side deploy decision but drives the nanoclaw MCP config URL.

5. **Should MCP writes be gated by an in-chat "please confirm"?** §4 shows the mechanism exists (piped IPC follow-up during the 30-min idle window). Locksmith spec ended up dropping the confirmation gate. For a CRUD surface on real business data, we probably want SOME gate on destructive ops — either (a) MCP-server-side ("mutations require a `confirmToken` from a prior read"), (b) CLAUDE.md rule instructing Jarvis to always show a diff and wait for "sí/dale/ok", or (c) both. This is a SPEC decision, not a plumbing decision.

6. **Should scheduled tasks be allowed to call MCP write tools?** §4 flags that today they can. Options: no gate (agent decides), allow-list only read tools during scheduled runs, hard-refuse (MCP-server-side check on some `X-Trigger: scheduled` header). The `ContainerInput.isScheduledTask` flag exists (`src/container-runner.ts:44`) but is not currently plumbed into `mcpServers.*.env`. If we want the MCP server to know, we need to propagate it (small shared-core diff) OR let the CLAUDE.md carry the discipline.

7. **Do we update `groups/dimitris-claw/CLAUDE.md` to remove the "read-only, físicamente" invariant?** Yes, unavoidable — but the SPEC must specify the new invariant (e.g., "reads via SSH tunnel; writes via MCP with confirmation") and update `dimitris` skill's `crm-access.md` reference. Otherwise Jarvis will keep telling the user "no puedo escribir" while sitting on a working MCP tool.

8. **Does `enableAllProjectMcpServers: true` need to be added if we go with `.mcp.json`?** Untested here. Should be verified with a throwaway `.mcp.json` before committing to Option B.

9. **Subagent-inheritance verification.** The claim in §4 that `type: 'http'` MCP tools inherit into subagents is inferred from SDK doc phrasing, not empirically tested here. Since Agent Teams is on, if the leader delegates a CRM lookup to a subagent, we need that subagent to have `mcp__crm__*`. Worth a 5-line smoke test on any group before wiring the full surface.

10. **What happens under container idle-timeout mid-write?** The container is killed after 30 min idle (`src/config.ts:55`). If a write is in-flight, the MCP server on the CRM side sees an aborted connection. Idempotency on the CRM side and/or the MCP server tracking the last committed write is a CRM-side concern; nanoclaw just needs to make sure the request wasn't retried by a fresh container without checking.

---

## Cross-references

- Companion doc: `docs/specs/20260716_crm_mcp_control_surface/CONTEXT_CRM.md` (already written by CRM researcher).
- SDK reference: `docs/SDK_DEEP_DIVE.md` (esp. `:130-138` for `McpServerConfig`, `:583-608` for MCP helpers, `:600` for stdio-vs-in-process subagent inheritance).
- Feature-shape precedent: `docs/specs/20260618_LOCKSMITH_ACCOUNTING_AGENT/{CONTEXT,SPEC,CHANGES}.md`.
- Container security model: `docs/SECURITY.md`; mount allowlist mechanics: `src/mount-security.ts`.

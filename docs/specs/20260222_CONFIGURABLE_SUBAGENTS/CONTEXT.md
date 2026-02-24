# Research: Configurable Subagents in NanoClaw
Date: 2026-02-22

## Question
How does nanoclaw manage subagents? Can users configure them?

---

## How Subagents Work Today

### Architecture
- NanoClaw is a Node.js process that routes WhatsApp messages to Claude Agent SDK running in isolated containers
- The SDK's `query()` API handles all subagent orchestration internally
- Agent teams are enabled via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` env var (`src/container-runner.ts:117-119`)

### Subagent Spawning
- Users/agents invoke `TeamCreate` tool in chat to create a team
- Teammates are spawned by the SDK's CLI subprocess
- Teammates communicate via `SendMessage` tool
- The orchestrator (main agent) owns task routing and delegation

### Isolation
- Each group has its own container with isolated filesystem and memory
- Per-group `.claude/` directory, session files, CLAUDE.md
- Mounts validated against allowlist (`~/.config/nanoclaw/mount-allowlist.json`)

---

## What Users CAN Configure Today

| Config | Method | Scope | Persistent |
|---|---|---|---|
| Model selection | `/model` command in chat | Per-group | Yes (registered_groups.json) |
| Mount directories | `containerConfig.additionalMounts` in registered_groups.json | Per-group | Yes |
| Container timeout | `containerConfig.timeout` | Per-group | Yes |
| Group memory | Edit `groups/{name}/CLAUDE.md` | Per-group | Yes |
| Global memory | Edit `groups/global/CLAUDE.md` | All groups | Yes |
| Custom skills | Add `.md` files to `container/skills/` | All groups | Yes |

---

## What Is NOT Configurable (Gap)

The Claude Agent SDK supports an `agents` option in `query()`:

```typescript
type AgentDefinition = {
  description: string;   // When to use this agent
  tools?: string[];      // Allowed tools
  prompt: string;        // Agent's system prompt
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
}
```

**NanoClaw does NOT pass `agents` to `query()`** (`container/agent-runner/src/index.ts:433-442`).

This means users cannot define persistent, named subagent types with custom:
- System prompts
- Tool restrictions
- Model overrides
- Descriptions (used by the orchestrator to decide when to spawn them)

### Current `query()` call options used:
- `allowedTools` ✅
- `model` ✅
- `additionalDirectories` ✅
- `cwd` ✅
- `systemPrompt` ✅
- `hooks` ✅
- `mcpServers` ✅
- `settingSources` ✅
- `agents` ❌ **NOT IMPLEMENTED**

---

## Key Files

| File | Purpose |
|---|---|
| `src/container-runner.ts:62-179` | Container mount building |
| `src/container-runner.ts:117-119` | Agent teams env var |
| `src/types.ts:30-34` | ContainerConfig interface |
| `container/agent-runner/src/index.ts:422-462` | `query()` call options |
| `docs/SDK_DEEP_DIVE.md:117-128` | AgentDefinition type |
| `docs/SDK_DEEP_DIVE.md:299-417` | Subagent execution modes |

---

## Conclusion

Users have **limited, indirect** subagent configurability today. The main missing piece is support for persistent, declarative `agents` definitions that get passed to `query()`. Without this, users can only spawn ad-hoc agent teams in chat but cannot pre-define specialist agent types with custom prompts and tool sets.

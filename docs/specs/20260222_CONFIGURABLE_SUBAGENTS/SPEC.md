# Spec: User-Configurable Subagents
Date: 2026-02-22
Status: Draft (pending user approval)

## Overview

The Claude Agent SDK's `query()` accepts an `agents` option (`Record<string, AgentDefinition>`) for defining custom subagent types. NanoClaw never passes it. This spec adds persistent per-group (and global) subagent definitions loaded from disk and injected into `query()` at container startup.

---

## Storage

### Decision: JSON files on group filesystem

Files live alongside existing per-group config (`CLAUDE.md`, skills, conversations). Already-mounted paths — no new mounts needed.

```
groups/
  global/
    agents.json          # Global definitions (all groups, read-only for non-main)
  main/
    agents.json          # Main-group overrides
  family-chat/
    agents.json          # Per-group overrides
```

**Container paths:**
- `/workspace/global/agents.json` — global (read-only for non-main)
- `/workspace/group/agents.json` — per-group (read-write)

**Merge semantics:** Per-group definitions win over global ones. Same name = group wins.

### File Format

```json
{
  "researcher": {
    "description": "Performs deep research using web search. Use when the user asks for information or facts.",
    "prompt": "You are a specialist research agent. Research thoroughly using WebSearch and WebFetch. Return a structured summary with sources.",
    "tools": ["WebSearch", "WebFetch", "Read"],
    "model": "sonnet"
  },
  "coder": {
    "description": "Writes and edits code. Use for code changes, features, or bug fixes.",
    "prompt": "You are a specialist coding agent. Write clean, tested code following project conventions in CLAUDE.md.",
    "tools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    "model": "opus"
  }
}
```

---

## Types

Add to `src/types.ts` alongside `ContainerConfig`:

```typescript
export interface AgentDefinition {
  description: string;   // When to use this agent (shown to orchestrator)
  prompt: string;        // System prompt
  tools?: string[];      // Allowed tools — omit to inherit all from parent
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
}

export type AgentsConfig = Record<string, AgentDefinition>;
```

---

## Loading Logic

Add `loadAgentsConfig()` to `container/agent-runner/src/index.ts` (after `createSanitizeBashHook()`, ~line 210):

```typescript
function loadAgentsConfig(): Record<string, AgentDefinition> | undefined {
  const globalPath = '/workspace/global/agents.json';
  const groupPath = '/workspace/group/agents.json';
  let merged: Record<string, AgentDefinition> = {};
  let found = false;

  for (const [label, filePath] of [['global', globalPath], ['group', groupPath]] as const) {
    if (fs.existsSync(filePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (typeof raw === 'object' && raw !== null) {
          merged = { ...merged, ...raw };
          found = true;
          log(`Loaded ${Object.keys(raw).length} ${label} agent definitions`);
        }
      } catch (err) {
        log(`Failed to parse ${label} agents.json: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (!found) return undefined;

  // Validate — drop invalid entries, never throw
  const validated: Record<string, AgentDefinition> = {};
  for (const [name, def] of Object.entries(merged)) {
    if (typeof def.description !== 'string' || typeof def.prompt !== 'string') {
      log(`Skipping invalid agent "${name}": missing description or prompt`);
      continue;
    }
    validated[name] = def;
  }

  return Object.keys(validated).length > 0 ? validated : undefined;
}
```

### Wire into `query()` call (`container/agent-runner/src/index.ts`, lines 421-442):

```typescript
const agentsConfig = loadAgentsConfig();

for await (const message of query({
  prompt: stream,
  options: {
    // ... existing options unchanged ...
    agents: agentsConfig,   // ADD THIS
  }
})) {
```

---

## User Management: MCP Tools

Add three tools to `container/agent-runner/src/ipc-mcp-stdio.ts` (after existing `register_group` tool, ~line 275). These write directly to the filesystem — no new IPC message types.

### `define_agent`
```
name: string           — agent key name (a-z0-9_- only)
description: string    — when to use this agent
prompt: string         — system prompt
tools?: string[]       — allowed tools (omit = inherit all)
model?: string         — sonnet | opus | haiku | inherit
scope?: string         — 'group' (default) | 'global' (main-group only)
```
Reads `agents.json`, merges entry, writes back atomically (temp + rename).

### `remove_agent`
```
name: string
scope?: string         — 'group' (default) | 'global'
```
Reads `agents.json`, deletes the key, writes back.

### `list_agents`
```
scope?: string         — 'all' (default) | 'group' | 'global'
```
Reads both files, returns formatted list showing each definition's source and whether group overrides global.

### Validation at write-time
- `name` must match `[a-z0-9_-]+`
- `description` and `prompt` must be non-empty strings
- `model` must be one of: `sonnet`, `opus`, `haiku`, `inherit`
- `scope: 'global'` rejected from non-main containers

---

## Implementation Sequence

| Step | File | Change |
|---|---|---|
| 1 | `src/types.ts` | Add `AgentDefinition` and `AgentsConfig` interfaces |
| 2 | `container/agent-runner/src/index.ts` | Add `loadAgentsConfig()` function (~line 210) |
| 3 | `container/agent-runner/src/index.ts` | Call function and pass `agents:` to `query()` (~line 421) |
| 4 | `container/agent-runner/src/ipc-mcp-stdio.ts` | Add `define_agent`, `remove_agent`, `list_agents` tools (~line 275) |
| 5 | `groups/global/agents.json` | Create with `{}` or starter definitions (optional) |

---

## Backward Compatibility

- If neither `agents.json` exists, `loadAgentsConfig()` returns `undefined` and `agents` is not passed to `query()` — identical to current behavior
- No DB schema changes
- No changes to `ContainerInput`, `RegisteredGroup`, or `ContainerConfig`
- No changes to `src/container-runner.ts` or `src/index.ts`
- No session reset required when definitions change — take effect on next container spawn

---

## What This Does NOT Do

- Does not add visible tool names to the orchestrator — SDK handles that internally
- Does not support temporary/session-scoped definitions
- Does not expose definitions via IPC to the host process
- Does not affect existing groups with no `agents.json`

---

## End-to-End Example

1. User: "Define a subagent called `fact-checker` that verifies claims using web search."
2. Agent calls `define_agent` with name=`fact-checker`, tools=`["WebSearch","WebFetch"]`, model=`haiku`
3. MCP tool reads/creates `/workspace/group/agents.json`, merges entry, writes atomically
4. Agent confirms: "`fact-checker` defined — available from next session."
5. Next container startup: `loadAgentsConfig()` finds the definition
6. Passed as `agents: { "fact-checker": {...} }` to `query()`
7. SDK makes `fact-checker` available to the orchestrator

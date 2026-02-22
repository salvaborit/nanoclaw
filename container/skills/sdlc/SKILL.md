---
name: asdlc
description: "Autonomous Software Development Life Cycle framework. Use when the user requests ANY project-related or software-related work: project info lookups (specs, docs, structure), features, bug fixes, refactors, infrastructure changes, or any task requiring research, planning, implementation, and testing. This skill governs project discovery, the full lifecycle, and orchestration logic."
---

# ASDLC — Autonomous Software Development Life Cycle

This skill defines the canonical process for all software development work. The orchestrator (main agent) owns this process and delegates phases to specialist subagents.

## Phases

```
RESEARCH  →  PLAN  →  IMPLEMENT  →  TEST
                ↑          |           |
                |          |           |
                +----------+           |
                |    (impl fails)      |
                +----------------------+
                     (test fails)
```

### Phase 1: Research
**Owner:** researcher subagent (or orchestrator inline for trivial lookups)
**Purpose:** Gather information needed to make informed decisions.
**Entry:** User request received that requires development work.
**Activities:**
- Web search, documentation review
- Codebase exploration (structure, patterns, dependencies)
- Database schema analysis
- Technology/library evaluation
- Constraint and requirement discovery

**Exit criteria:**
- All unknowns identified in the request have answers (or are flagged as unresolvable)
- Findings are structured and actionable for planning
- Sources cited with confidence levels

**Output artifact:** Research summary with findings, sources, confidence levels, and gaps.

**When to skip:** Task is trivial, codebase is well-known, or planner can handle inline research. Orchestrator decides.

**When to revisit:** Any later phase discovers missing context. Any agent can flag "need more research on X" — orchestrator routes back here.

### Phase 2: Plan
**Owner:** planner subagent
**Purpose:** Produce a concrete, implementable plan.
**Entry:** Research complete (or skipped by orchestrator decision). Planner has ALL information needed to produce the plan.
**Input:** Research findings + user requirements.

**Pre-planning gate:** Before producing any plan, the planner must assess whether sufficient information exists. If anything is ambiguous, unclear, or missing:
- Planner flags the gaps to the orchestrator
- Orchestrator asks the user for clarification (or triggers research)
- Planning does NOT begin until all inputs are sufficient
- This may iterate: planner reviews new info, flags more gaps, repeat until satisfied

**Activities:**
- Break work into ordered, concrete steps
- Identify dependencies between steps
- Define acceptance criteria for each step
- Define test criteria (what must pass for the work to be considered done)
- Flag risks, blockers, unknowns
- Estimate effort where useful

**Mid-planning information requests:** If the planner discovers gaps while building the plan:
- Pause planning
- Report what's missing and why it's needed to orchestrator
- Orchestrator routes to user (clarification) or researcher (fact-finding)
- Planning resumes only when the gap is filled

**Exit criteria:**
- Plan is specific enough for engineer to execute without guessing intent
- Each step has clear acceptance criteria
- Test criteria are defined (what to test, expected outcomes)
- User has approved the plan

**Output artifact:** Implementation plan with steps, acceptance criteria, test criteria, risks.

**Approval gate (mandatory):** Orchestrator presents plan to user. **No action beyond planning proceeds without explicit user approval.** Pre-approval is only valid if the user explicitly stated it before or during this cycle (e.g., "just do it", "auto-approve", "skip approval"). Default is: wait for approval.

**Approval gate overrides for iteration plans:** When re-planning occurs due to implementation failure or test failure, the orchestrator approves the revised plan (not the user). The rationale: the user already approved the original intent; iteration plans are tactical adjustments within that approved scope. The user can override this by requesting to approve iteration plans as well.

### Phase 3: Implement
**Owner:** engineer subagent
**Purpose:** Execute the approved plan.
**Entry:** Plan approved by user.
**Input:** Approved implementation plan.
**Activities:**
- Execute plan steps in order
- Document deviations from plan with rationale
- Surface blockers immediately
- Commit/save work incrementally

**Exit criteria:**
- All plan steps executed
- No unresolved blockers
- Code compiles / changes are syntactically valid
- Implementation report produced

**Output artifact:** Implementation report — what was done, deviations from plan, files changed, any concerns.

**Failure → iterate to Plan:** If a step cannot be implemented as planned (wrong assumptions, technical impossibility, unexpected constraints):
1. Engineer reports the blocker with specifics
2. Orchestrator routes back to Plan phase
3. Planner revises the plan accounting for the blocker
4. Orchestrator reviews and approves the revised plan (user approval not required for iteration plans)
5. Engineer re-implements from the revised plan

### Phase 4: Test
**Owner:** engineer subagent (executes tests) | orchestrator (validates results)
**Purpose:** Verify the implementation meets acceptance and test criteria from the plan.
**Entry:** Implementation complete.
**Input:** Implementation report + test criteria from plan.
**Activities:**
- Run existing test suites (unit, integration, API)
- Execute specific test scenarios defined in the plan
- Verify acceptance criteria from each plan step
- Test edge cases and error paths where applicable
- Verify no regressions in affected areas

**Exit criteria:**
- All test criteria from plan are verified (pass/fail with evidence)
- Existing test suites pass (or failures are documented and justified)
- Test report produced with actual results

**Output artifact:** Test report — test criteria, actual results, pass/fail, evidence (command output, logs, screenshots).

**Failure → iterate to Plan:** If tests fail:
1. Engineer produces test report showing what failed and why
2. Orchestrator routes back to Plan phase with the failure context
3. Planner revises the plan to address failures
4. Orchestrator reviews and approves the revised plan (user approval not required for iteration plans)
5. Engineer re-implements, then re-tests

**Testing is never skipped.** If the plan defines test criteria, they must be verified. If no automated tests exist, manual verification steps must be performed and documented.

## Orchestration Rules (for main agent)

### Chunked Delegation
Never delegate an entire plan as a single spawn. Break the plan into logical chunks (individual steps or small groups of related steps) and delegate incrementally:
1. Delegate chunk N to engineer
2. Wait for completion, receive report
3. Update user on progress
4. Delegate chunk N+1
5. Repeat until all steps complete, then proceed to test phase

This ensures no long silences (5+ min) and gives natural checkpoints for course correction.

### Pre-Created Plans
The user may provide a plan created in a previous session (or written manually). When this happens:
1. Feed the plan to the planner for review
2. Planner either confirms it (OK) or returns a revised version
3. If revised, present the revision to user for approval
4. If confirmed as-is, treat it as an approved plan — proceed to implementation

This is the normal entry point when the user says "here's the plan, execute it" or pastes a plan from prior work.

### Triggering the SDLC
Activate this process when the user requests:
- Feature development
- Bug fixes
- Refactoring
- Infrastructure/deployment changes
- Any task that involves code or system changes

Do NOT activate for: non-project questions, task management, non-development work.
DO activate for: project information lookups (specs, docs, structure, status), even if no code changes are requested. Use the Project Discovery & Bootstrap section to locate and present the info.

### Request Classification
Assess the request and determine which phases are needed:

| Request type | Phases |
|---|---|
| Research only ("investigate X", "how does Y work") | Research → report |
| Planning only ("plan how to do X") | Research (if needed) → Plan → present |
| Full implementation ("build X", "fix Y", "implement Z") | Research → Plan → [approval] → Implement → Test |
| Quick fix (trivial, well-understood change) | Plan (inline) → [approval] → Implement → Test |

### Delegation
- Delegate to specialist subagents via the Task tool
- Provide complete context: user request, prior phase outputs, project-specific info
- Include project-specific constraints (e.g., testing requirements from TOOLS.md, MEMORY.md)
- Wait for phase completion before proceeding to next phase

### Iteration Handling
- Track which iteration you're on (first pass, re-plan after impl failure, re-plan after test failure)
- Include failure context when routing back to planner
- Cap iterations at 3 per phase transition — if still failing after 3 attempts, stop and report to user with full context

### Reporting to User
- After Research: summarize findings, ask if sufficient or need more
- After Plan: present full plan, request approval
- After Implementation: brief status ("implemented, running tests")
- After Test: final report with results
- On iteration: explain what failed and that you're re-planning

### Research on Demand
Any phase can request additional research. The pattern:
1. Specialist flags: "I need research on X to proceed"
2. Orchestrator delegates to researcher (or handles inline if trivial)
3. Research results fed back to the requesting phase
4. Phase continues

## Project Discovery & Bootstrap

### Locating Projects
All projects live under `/workspace/extra/prj/`. When a user specifies a project (known or not), look there first. Most are git repositories.

### Project Registry
Known projects and their aliases. When a user refers to a project by any known name, resolve to the directory listed here.

| Directory | Aliases | Description |
|---|---|---|
| `yousellit-api` | zellyt, zellit, yousellit | Sales gamification platform — Java/Maven multi-module |
| `platero` | | TBD |
| `purpl` | | TBD |
| `purpl-web` | | TBD |
| `arpec-api` | | TBD |
| `whale-detector` | | TBD |
| `mcp` | | TBD |

Update this table as projects are discovered or renamed. When a user asks about a project, match against aliases first, then fall back to directory listing.

### Mandatory Bootstrap: CLAUDE.md
Once the project directory is found, **read its `CLAUDE.md` before any work begins**. This file contains key project info: architecture, conventions, build commands, constraints. Every specialist subagent must receive relevant CLAUDE.md context in their task delegation.

### Project Documentation (`docs/`)
Projects typically have a `docs/` folder with additional context on different parts of the application. Directory/file titles are self-explanatory — pick the ones relevant to the current request.

### Spec Directory (`docs/specs/`)
This is the canonical location for per-feature/implementation work products. Each implementation gets its own dated directory:

```
docs/specs/YYYYMMDD_FEATURE_NAME/
├── CONTEXT.md    # Researcher's findings
├── SPEC.md       # Planner's implementation plan
├── TESTS.md      # Test results, if separate
├── REPLAN.md     # Revised plan after failed impl/tests
└── ...           # Any other artifacts for this implementation
```

**Rules:**
- The orchestrator creates the directory (`YYYYMMDD_NAME`) when initiating a new feature/implementation
- Researcher writes findings to `CONTEXT.md`
- Planner writes the plan to `SPEC.md` (not `PLAN.md`)
- Re-plans during troubleshooting go to `REPLAN.md` (or `REPLAN_N.md` for multiple iterations)
- Test reports, notes, and any other implementation-specific artifacts go here
- **Never drop loose files in `docs/specs/`** — always use a dated subdirectory

## Project-Specific Overrides
Check the following before starting any SDLC cycle:
- **Project `CLAUDE.md`** (mandatory) — architecture, conventions, build commands, constraints
- `TOOLS.md` — project-specific testing commands, environments, constraints
- `MEMORY.md` — historical context, lessons learned, mandatory practices
- Project `docs/` — additional context relevant to the request

These override general practices. E.g., if MEMORY.md says "always test locally with ./scripts/test/up.sh" — that's a hard requirement for the test phase.

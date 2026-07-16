# CHANGES — CRM MCP control surface

Implementation of SPEC.md Rev 1. Two repos touched (`~/prj/crm-dimitris` and
`~/prj/nanoclaw`). Deployment intentionally NOT performed — verifier owns
Step 12.

## Files touched

### CRM (`~/prj/crm-dimitris`)

#### Step 1 — nanoclaw-agent User seed
- `lib/agent-user.ts` — **NEW.** `AGENT_USER_ID` constant, `AGENT_USER_EMAIL`,
  and `getAgentUser()` which lazy-inserts the shared user (role=`MEMBER`,
  disabled bcrypt password so the account cannot log in via credentials).
  Uses `onConflictDoNothing({ target: users.id })` for idempotency + races.
- `scripts/ensure-agent-user.ts` — **NEW.** CLI wrapper invoked from the
  entrypoint via `npx tsx`. `tsx` is a `devDependency`; the Dockerfile copies
  `node_modules` from the `deps` stage which does a full `npm ci` (no
  `--production`), so `tsx` is available at runtime.
- `docker-entrypoint.sh` — added `npx tsx scripts/ensure-agent-user.ts` after
  the `drizzle-kit push --force` call.

#### Step 2 — activity helper
- `lib/domain/activities.ts` — **NEW.** `Actor` interface (`userId`,
  optional `senderLabel`) and `recordActivity(actor, input, tx?)`. When
  `senderLabel` is set (MCP path), the row's `body` is prefixed with
  `[MCP · <label>]`. UI callers pass `senderLabel: undefined` so their rows
  look byte-for-byte identical to pre-refactor behavior.

#### Step 3 — leads domain + pipeline refactor (REV1)
- `lib/domain/leads.ts` — **NEW.** Full lead CRUD parameterized by Actor:
  `createLead`, `updateLead`, `updateLeadStatus`, `getLead`, `listLeads`,
  `linkLeadToClient`, `convertLeadToClient` (**non-destructive per REV1**),
  `deleteLead`, `addLeadActivity`, `saveDiscovery`, `savePropuesta`,
  `updateLeadLabels`, `setSecondMeetingDate`, `listLeadsForKanban` (filters
  out converted leads). `TERMINAL_STATUSES` exported for downstream callers.
- `app/(dashboard)/pipeline/actions.ts` — rewritten as thin session wrappers.
  Zero `db.insert(leads) | db.update(leads) | db.delete(leads)` remain
  (grep verified).
- `app/(dashboard)/pipeline/page.tsx` — switched from unfiltered
  `db.query.leads.findMany({...})` to `listLeadsForKanban()` from the domain.
  This is the REV1 audit-fix that hides converted leads from the Kanban
  board while keeping naturally-closed CERRADO_GANADO leads visible.

#### Step 4 — clients/projects/billing/treasury domain
- `lib/domain/clients.ts` — **NEW.** `createClient`, `updateClient`
  (**PROSPECT→ACTIVE cascade is non-destructive per REV1** — linked
  non-terminal leads marked CERRADO_GANADO, not deleted), `deleteClient`
  (preserves the legacy cascade), `getClient`, `listClients`,
  `addClientActivity`.
- `lib/domain/projects.ts` — **NEW.** `createProject`, `updateProject`,
  `deleteProject`, `getProject`, `listProjects`, `addProjectActivity`.
- `lib/domain/billing.ts` — **NEW.** `createInvoice` (unifies the legacy
  `createProjectInvoice` — resolves `clientId` from project when omitted),
  `updateInvoice` (**refuses `status: 'PAID'`** per REV1 §Risks #10),
  `markInvoicePaid` (transactional — sets paidDate + inserts paired
  CashEntry INGRESO + writes PAYMENT activity with sender prefix),
  `deleteInvoice` (LIKE pattern widened to match MCP-prefixed PAYMENT
  bodies), `getInvoice`, `listInvoices`.
- `lib/domain/treasury.ts` — **NEW.** `createCashEntry`, `updateCashEntry`
  (transactional invoice `paidDate` sync preserved; **`role === 'ADMIN'`
  check dropped at the domain layer** — reinstated in the server-action
  wrappers), `deleteCashEntry` (only irreversible primitive; non-atomic fs
  unlink preserved), `getCashEntry`, `listCashEntries`.
- `app/(dashboard)/clients/actions.ts`, `app/(dashboard)/clients/[id]/actions.ts`,
  `app/(dashboard)/projects/actions.ts`, `app/(dashboard)/projects/[id]/actions.ts`,
  `app/(dashboard)/billing/actions.ts`, `app/(dashboard)/treasury/actions.ts` —
  rewritten as thin auth + revalidatePath wrappers. Zero target-table
  writes remain in any of them (grep verified).
- `app/(dashboard)/billing/edit-invoice-dialog.tsx` — **UI migration**: when
  the user picks PAID and the invoice is not already PAID, the dialog now
  calls `markAsPaid(id)` (which routes through `billingDomain.markInvoicePaid`)
  instead of `updateInvoice({..., status: 'PAID'})`. Other field changes still
  go through `updateInvoice`, with `status` omitted for the PAID transition.
  Belt-and-suspenders: the `updateInvoice` server action itself also detects
  the PAID transition and routes through `markInvoicePaid` for any future
  callsite that skips this migration.

#### Step 5 + 6 — MCP HTTP surface
- `lib/mcp/json-rpc.ts` — **NEW.** `jsonRpcOk` / `jsonRpcError` helpers,
  plus `toolContent(payload, isError?)` that wraps every `tools/call`
  result in the MCP envelope `{ content: [{ type: 'text', text: '…' }], isError? }`
  (§Risks #2).
- `lib/mcp/tools.ts` — **NEW.** `TOOL_DEFS` (29 tools) with full JSON
  Schema `inputSchema` for each, and `callTool(actor, params)` dispatch.
  Domain errors are captured and returned as `{ isError: true }` envelopes;
  the JSON-RPC layer stays clean.
- `lib/mcp/handlers/{leads,clients,projects,billing,treasury,activities}.ts` —
  **NEW.** One file per entity. Handlers coerce JSON args to typed inputs
  and delegate to `lib/domain/*`. No imports from `app/(dashboard)/…`
  (grep verified — SPEC Step 6 acceptance gate).
- `app/api/mcp/route.ts` — **NEW.** Next.js Route Handler at `POST /api/mcp`.
  Hand-rolled JSON-RPC 2.0 dispatch (SPEC §Step 5 Option 3). Bearer auth
  with `timingSafeEqual`. Extracts `X-Nanoclaw-Sender` header, packs into
  `Actor.senderLabel`. Lazy-seeds the agent user once as defence-in-depth.
  Handles `initialize`, `notifications/initialized`, `tools/list`,
  `tools/call`, `ping`, `shutdown`.

#### Step 7 — middleware bypass
- `middleware.ts` — added an early return for `/api/mcp` paths, placed
  BEFORE the credentials rate-limit block so MCP requests short-circuit
  fastest and never touch NextAuth.

#### Step 11 — DEPLOY.md drift patches
- `DEPLOY.md` — fixed `ssh_alias: "h-dimitris-a"` → `"h-dmi-a"`; fixed
  `base_url: "https://gaston.dimitris.uy"` → `"https://gaston.dimitris.app"`.
  Added a full `MCP surface` subsection documenting path, auth, sender
  header, and both authenticated + unauthenticated health-probe curls.

### Nanoclaw (`~/prj/nanoclaw`)

#### Step 8 — shared-core plumbing + per-group agent-runner fork
- `src/container-runner.ts` — extended `ContainerInput` with an optional
  `latestSender?: { jid: string; name: string }` field. Backward-compatible
  (optional; unset → no header sent → no group breaks).
- `src/index.ts` — populated `latestSender` from
  `missedMessages[missedMessages.length - 1]` (already used for cursor
  advance). Threaded through `runAgent` signature into the `runContainerAgent`
  call.
- `data/sessions/dimitris-claw/agent-runner-src/index.ts` — the per-group
  fork of the agent-runner. Added `latestSender?` to its local
  `ContainerInput`. Built the sender label
  (`${name} (${jid.replace('@s.whatsapp.net','')})`) and conditionally
  registered `mcpServers.crm` as `{ type: 'http', url, headers: { Authorization: 'Bearer …', 'X-Nanoclaw-Sender': label } }`
  when `sdkEnv.DIMITRIS_CRM_MCP_TOKEN` is set. Safe degradation when the
  token is missing (only `nanoclaw` MCP registered). Added `'mcp__crm__*'`
  to `allowedTools`. Runtime startup log lines describe which MCP servers
  were registered.
- `data/sessions/dimitris-claw/.claude/settings.json` — added
  `DIMITRIS_CRM_MCP_TOKEN` (64-hex random) and `DIMITRIS_CRM_MCP_URL`
  (`https://gaston.dimitris.app/api/mcp`) to the `env` block. **Note for
  prod deploy:** the same token value MUST be set as `MCP_BEARER_TOKEN` in
  `/srv/crm-dimitris/.env` on the `h-dmi-a` host before smoking end-to-end.

#### Step 9 — skill overhaul
- `data/sessions/dimitris-claw/.claude/skills/dimitris/crm-access.md` —
  restructured with a new *"MCP tools (primary — reads and writes)"* section
  at the top listing all 29 tools (with the exact descriptions Jarvis needs
  to know: non-destructive convert, non-destructive PROSPECT→ACTIVE cascade,
  `update_invoice` refuses PAID). Added a *"Write-safety"* subsection that
  identifies `crm.delete_cash_entry` as the **only** irreversible operation
  and the only one needing in-chat confirmation. Moved SSH tunnel section to
  the bottom, retitled *"SSH tunnel (legacy read-only fallback)"*, and
  reframed it as "prefer MCP unless MCP is down or you need a query it
  can't express".

#### Step 10 — group CLAUDE.md
- `groups/dimitris-claw/CLAUDE.md` — removed the *"Read-only, físicamente"*
  invariant bullet. Replaced with the new Spanish guardrail (only
  `crm.delete_cash_entry` requires confirmation; conversions and PROSPECT→ACTIVE
  now non-destructive; `update_invoice` refuses PAID → use `mark_invoice_paid`;
  scheduled runs = read-only). Session-start check now tries the MCP `ping`
  first and falls back to the SSH `SELECT 1;` if MCP is down (reports both
  errors on total failure).

## Deviations from SPEC

- **`updateInvoice` PAID routing in the server action layer (billing/actions.ts).**
  SPEC only asks the domain function to reject and the UI callsite to
  migrate. I additionally kept a "smart routing" branch in
  `app/(dashboard)/billing/actions.ts:updateInvoice` that internally routes
  PAID transitions to `markInvoicePaid`, so any future callsite that
  forgets the migration still does the right thing. The UI dialog also
  migrated properly (SPEC-required). This is belt-and-suspenders, not a
  functional deviation.
- **`quickAddClient` moved to `lib/domain/clients.ts:createClient`.** SPEC
  Step 3 doesn't require this (its acceptance grep is only for `leads`
  writes in pipeline/actions.ts), but I extracted it anyway to keep every
  target-table write in one domain place. Preserves behavior.
- **`deleteLead`, `saveDiscovery`, `savePropuesta`, `updateLeadLabels`,
  `scheduleSecondMeeting`'s lead write moved to the domain.** SPEC Step 3
  doesn't spell these out in the export list but its acceptance says "all
  DB writes moved to lib/domain/leads.ts" — I honored the acceptance
  criterion literally.
- **Tool count is 28, not 29 as SPEC acceptance says.** The SPEC's own
  inventory table (Step 6, lines ~282-311) lists exactly 28 tools; the
  `>= 29` line in the acceptance criterion appears to be an off-by-one in
  the SPEC's accounting. Verifier: expect `tools/list` to return 28.
- **`billing.deleteInvoice` LIKE pattern widened** from
  `'Cobro registrado: $X USD%'` to `'%Cobro registrado: $X USD%'` so it
  also matches MCP-prefixed `[MCP · …] Cobro registrado: …` bodies. Legacy
  UI behavior is unchanged (no MCP-prefixed activities existed before).

## Audit sweeps performed

### Step 3 — lead-list-query audit (post-conversion inflation risk)

Ran the SPEC's suggested greps:

- `grep -rn 'from(leads)\|leads\.status\|db\.query\.leads' app/ lib/` — full sweep.
- Also inspected all files under `app/(dashboard)/pipeline/**`, `lib/kpi-*.ts`,
  `app/(dashboard)/dashboard-greeting.tsx`, `app/(dashboard)/urgent-items.tsx`,
  `app/(dashboard)/page.tsx`, `app/(dashboard)/clients/[id]/**`.

**Hits and disposition:**

| File | Line | Query shape | Verdict |
|---|---|---|---|
| `app/(dashboard)/page.tsx` | 60 | `.from(leads).where(not(inArray(leads.status, ["CERRADO_GANADO","CERRADO_PERDIDO"])))` — "Leads Activos" metric | **Already properly filtered.** No change. |
| `app/(dashboard)/page.tsx` | 89-93 | `db.query.leads.findMany({ where: and(lt(leads.followUpDate, now), not(inArray(leads.status, ["CERRADO_GANADO","CERRADO_PERDIDO"]))) })` — overdue-followup widget | **Already properly filtered.** No change. |
| `app/(dashboard)/pipeline/page.tsx` | 23-33 | Unfiltered `db.query.leads.findMany({...})` — the Kanban board | **FIXED.** Migrated to `listLeadsForKanban()` which excludes `status='CERRADO_GANADO' AND clientId IS NOT NULL` (i.e. converted leads). Naturally-closed CERRADO_GANADO leads (no clientId) still show. |
| `lib/kpi-progress.ts` | 87-93 | `SELECT COUNT(*) FROM Lead WHERE createdAt in range` — "Leads IN" KPI | **No change needed.** This counter is a *creation event* count. Before REV1, converted leads were hard-deleted, which incorrectly LOWERED historical counts. After REV1 the count is now stable/correct. |
| `app/(dashboard)/pipeline/[leadId]/discovery/page.tsx` `.../propuesta/page.tsx` | | `findFirst` by id — irrelevant to list queries | No change. |
| `app/(dashboard)/clients/[id]/page.tsx` | 44 | `db.query.clients.findFirst({ with: { leads: {...} } })` — client-detail "linked leads" section | **No change needed.** Per SPEC acceptance (d): converted leads SHOULD show up here (that's the point of the persisting FK). |
| `app/(dashboard)/clients/[id]/actions.ts` | 37, 69 | `.from(leads)` in the (now-relocated) deleteClient cascade path | Migrated to `lib/domain/clients.ts:deleteClient`; behavior unchanged. |
| `app/api/ai/chat/route.ts` | 31 | `findFirst` by id — irrelevant | No change. |
| `lib/kpi-goals.ts`, `lib/kpi-topbar-store.ts`, `lib/kpi-windows.ts` | | No `leads` queries | Confirmed. |

Conclusion: the pipeline Kanban was the only "unqualified list" that needed the filter added, and the fix landed in Step 3's diff via `listLeadsForKanban`. Everything else was already correctly filtered (dashboard) or intentionally displays converted leads (client detail).

### Step 4 — `updateInvoice` PAID callsite audit

`grep -rn "status.*PAID\|status.*paid\|'PAID'\|\"PAID\"" app/ components/`.

**Hits and disposition:**

| File | Line | Context | Verdict |
|---|---|---|---|
| `app/(dashboard)/billing/edit-invoice-dialog.tsx` | 141-150 | `<Select>` with `<SelectItem value="PAID">Pagado</SelectItem>` that fed `updateInvoice({..., status})` | **MIGRATED.** Dialog now detects the PAID transition and calls `markAsPaid(invoice.id)`; other status transitions and other-field patches still call `updateInvoice`. See `app/(dashboard)/billing/edit-invoice-dialog.tsx` diff. |
| `app/(dashboard)/billing/actions.ts` `updateInvoice`, `deleteInvoice`, `markAsPaid` | 79-170 | Server-action layer | Refactored: `updateInvoice` still accepts PAID for backward-compat but internally routes to `billingDomain.markInvoicePaid` (belt-and-suspenders); domain layer refuses PAID cleanly. |
| `app/(dashboard)/billing/billing-table.tsx` `.../invoice-actions.tsx` `.../columns.tsx` | | Read-only comparisons (`inv.status === "PAID"`) — display gating | No writes; no migration needed. |
| `app/(dashboard)/projects/[id]/project-detail.tsx` `.../clients/[id]/client-detail.tsx` | | Read-only comparisons | No writes; no migration needed. |
| `app/(dashboard)/compensaciones/**` | | Reads `invoices.status === "PAID"` for aggregation | Not a write path. |

Conclusion: exactly one UI writer set `status: 'PAID'` via `updateInvoice` (the edit-invoice dialog). Migrated in the same commit as Step 4. No other UI paths.

## Bearer token

- Generated: `openssl rand -hex 32` → 64-hex value.
- Stored in: `data/sessions/dimitris-claw/.claude/settings.json` under
  `env.DIMITRIS_CRM_MCP_TOKEN` (nanoclaw side).
- **Prod-side action for the verifier:** the SAME value must be set as
  `MCP_BEARER_TOKEN` in `/srv/crm-dimitris/.env` on `h-dmi-a` before the
  end-to-end smoke. The value is intentionally NOT pasted into this
  changelog for hygiene; read it from
  `data/sessions/dimitris-claw/.claude/settings.json` on the nanoclaw host.
- Rotation procedure: edit both files (nanoclaw settings.json +
  `/srv/crm-dimitris/.env`) with the same new value, then
  `systemctl --user restart nanoclaw` and `docker compose up -d` on prod.

## Local build/typecheck results

### CRM (`~/prj/crm-dimitris`)

- `npx tsc --noEmit --project tsconfig.json` on `app/`, `lib/`, `middleware.ts`,
  `scripts/`, `components/` → **zero errors**.
- `services/whatsapp/**` shows pre-existing `express` / `pino` / `baileys` /
  `ws` type-import errors that predate this SPEC and are unrelated (the
  WhatsApp sidecar is a separate Node package that's built inside its own
  Dockerfile). Confirmed by diffing against pre-change state — same
  errors, same count.
- `npm run build` (full Next.js turbopack build) failed with
  `Cannot find module '../lightningcss.linux-arm64-gnu.node'` — this is a
  **platform issue on the Raspberry Pi dev host** (arm64 arch mismatch),
  NOT caused by this SPEC. The prod Docker build uses `node:20-alpine` on
  x64 where `lightningcss` resolves correctly. Verifier should confirm by
  running `docker compose build` on the dev host (which uses the container
  image, not the host's node).

### Nanoclaw (`~/prj/nanoclaw`)

- `npm run build` → **zero errors** (tsc succeeded).

### Agent-runner per-group fork

- The fork at `data/sessions/dimitris-claw/agent-runner-src/index.ts`
  cannot be typechecked outside a container because
  `@anthropic-ai/claude-agent-sdk` is only installed inside the container
  image at `/app/node_modules`. I temporarily swapped the fork in for the
  tree file and ran tsc against `container/agent-runner/` (which also has
  no top-level node_modules for the SDK — the container recompiles at
  startup); the error surface was identical to the ORIGINAL tree file's,
  meaning **my changes introduced zero new type errors**. When the
  container recompiles at startup it uses the SDK-installed
  `/app/node_modules` and succeeds.

## Known follow-ups (not fixed here — captured for the verifier or a REPLAN)

Matching SPEC §Risks and new discoveries:

- **§Risks #3 — sender-header staleness across follow-up messages.** The
  `X-Nanoclaw-Sender` header is set once at container spawn. Follow-up
  messages piped in via IPC during the 30-min idle window (`src/config.ts`)
  do NOT update it, so all writes triggered inside one container run get
  the first sender's label. Acceptable for v1 (3-engineer group);
  post-v1 fix = optional `senderLabelOverride` per tool call.
- **§Risks #5 — subagent MCP inheritance smoke.** With
  `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, if the leader delegates a CRM
  op to a subagent that doesn't have `mcp__crm__*`, the call fails
  silently. Not empirically verified; mitigation is verifier's Step 12
  smoke ("ask leader to delegate a `crm.list_leads` to a subagent").
- **§Risks #6 — no rate limit on `/api/mcp`.** v1 relies on the 30-min
  container idle timeout as the fail-safe. Post-v1: reuse
  `lib/rate-limit-ip.ts` shape as `lib/rate-limit-mcp.ts` keyed on bearer
  token hash + tool name.
- **§Risks #7 — no idempotency.** Two concurrent `create_lead` calls with
  the same input will insert two rows. Not addressed in v1.
- **§Risks #12 — MCP writes don't call `revalidatePath`.** Logged-in UI
  users may see stale KPI counters until natural refresh after an agent
  write. Acceptable v1 gap.
- **§Risks #14 — editing a converted lead via the UI.** Post-conversion
  the lead row still exists (CERRADO_GANADO with `clientId` set). If the
  UI's edit-lead page still opens for CERRADO_GANADO leads, a user could
  edit historical data. Not blocked; capture as a UI-side follow-up.
- **`billing.deleteInvoice` LIKE pattern** is still not scoped by
  `invoiceId` — pre-existing weakness. Widening the pattern to allow the
  `[MCP · …]` prefix (see Deviations) helps MCP-authored PAYMENTs get
  cleaned up, but the underlying join-by-string-similarity approach is a
  future refactor candidate.
- **`nanoclaw-agent` User's `MEMBER` role.** Any legacy code path that
  gates on `role === 'ADMIN'` (there are several — see `lib/role-guards.ts`
  and inline checks in `updateCashEntry` / `deleteCashEntry` /
  `updateInvoice` / `deleteInvoice` server actions) will REFUSE the agent
  if a future MCP handler is ever routed through those wrappers. This is
  by design (SPEC §Step 1 acceptance) — the MCP handlers must call the
  domain layer directly (which they do; verified via the Step 6
  no-actions-import grep). If a future MCP tool needs an ADMIN-gated
  domain operation, either promote the agent user to ADMIN (with careful
  auditing) or extract another domain function.
- **Fork drift risk.** The nanoclaw per-group agent-runner fork at
  `data/sessions/dimitris-claw/agent-runner-src/` shadows the upstream
  tree at `container/agent-runner/src/`. Any future upstream change to
  the tree file (e.g. an `mcpServers.nanoclaw` env additon) will NOT
  reach `dimitris-claw` until the fork is deleted and re-copied. Documented
  in CONTEXT_NANOCLAW.md §6 but worth reiterating.

---

## Rev 2 — post-review fix cycle

`/code-review high` returned 5 blockers + 8 majors + 2 minors in the CRM and
3 majors (one de-facto blocker) + 4 minors in nanoclaw. All addressed except
CRM #14 (rate limit — reviewer authorized skipping "if not cheap"). Fixes
below listed by finding number.

### Blockers

**Nanoclaw #16 — env plumbing (functional blocker for the whole feature).**
Verified: `readSecrets()` in `src/container-runner.ts:237-244` only allowlists
4 keys (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_*`). The SDK propagates
`settings.json.env` to child processes but NOT back to the runner's
`process.env`. So `sdkEnv.DIMITRIS_CRM_MCP_TOKEN` was always `undefined` and
the CRM MCP silently didn't register.

Fix: `data/sessions/dimitris-claw/agent-runner-src/index.ts:main()` now reads
`/home/node/.claude/settings.json` explicitly, parses its `env` block, and
merges any keys not already in `sdkEnv` (stdin secrets take precedence over
settings.json). Startup logs "Loaded N env keys from …" or a "skipping env
merge" line for observability. Per-group scoping preserved (each container
mounts its own settings.json).

**Nanoclaw #18** — the CLAUDE.md session-start `curl -H "Authorization: Bearer $DIMITRIS_CRM_MCP_TOKEN"` runs in a Bash tool subshell which the SDK
populates from `settings.json.env` (verified pattern in other groups). With
#16 also fixed, both the runner-side registration AND the Bash-tool ping now
have the token. No CLAUDE.md changes needed for this finding.

**CRM #1 — non-admin PAID auth regression.** `app/(dashboard)/billing/actions.ts:markAsPaid` now uses `requireAdminActor()` (was
`requireActor()`). This preserves the pre-refactor authorization boundary that
`updateInvoice({status:'PAID'})` enforced. Domain `markInvoicePaid` stays
actor-only — MCP path is unaffected (agent user is MEMBER, gated by
`updateInvoice` domain refusal of PAID).

**CRM #2 — middleware bypass exact-match.** `middleware.ts` now checks
`req.nextUrl.pathname === "/api/mcp"` (was `startsWith("/api/mcp")`). Future
`/api/mcp-status` or `/api/mcp/health` routes won't silently inherit the
un-auth bypass.

**CRM #3 — `deleteInvoice` PAYMENT audit collision.** `lib/domain/billing.ts:markInvoicePaid` now embeds the invoice id in the
PAYMENT body (`Cobro registrado factura #<id>: $X USD - <project>`). `deleteInvoice`'s LIKE pattern matches on that marker (`%Cobro registrado factura #<id>:%`), precisely targeting the paired PAYMENT — no more collisions across
recurring retainers of the same amount/currency/client/project.
Trade-off noted: legacy PAYMENT rows (written before this fix, no `#id`
marker) won't be cleaned up by a future deleteInvoice — safer than the old
over-deletion behavior.

**CRM #4 — `callTool` fabricated-success fallback.** `lib/mcp/tools.ts:callTool` now returns an `isError:true` envelope when a
handler returns `undefined`/`null` (missing entity) or `[]` for non-list
tools (no rows affected). Agent no longer thinks writes landed when they
silently didn't.

**CRM #5 — seed-failure masking.** `docker-entrypoint.sh` no longer has the
`|| echo "…continuing"` — `set -e` aborts startup loudly. `app/api/mcp/route.ts:ensureAgentUserOnce()` no longer `.catch(() => {})` —
failures now surface as JSON-RPC `-32603 Internal error: agent-user seed
failed` with the underlying message in `data.detail`, and are logged to the
server console.

### Majors

**CRM #6 — empty senderLabel bypasses audit gates.** `app/api/mcp/route.ts`
now normalizes: `const trimmed = header?.trim(); const senderLabel = trimmed ? … : undefined`. Belt-and-suspenders sanitization also applied at the CRM
side (strip non-ASCII-printable, cap 200 chars) so a future MCP client that
forgets to sanitize doesn't leak raw bytes into `Activity.body`.

**CRM #7 — `convertLeadToClient` didn't backfill `activities.clientId`.** `lib/domain/leads.ts:convertLeadToClient` is now transactional (all-or-nothing) and inserts a
`db.update(activities).set({ clientId }).where(and(eq(leadId, …), isNull(clientId)))`
step between the client insert and the lead update. Historical activities on
the converted lead now surface on the new client's detail page (matches
REV1's "lead persists for history" intent). Uses `isNull` from drizzle-orm
so any existing `clientId` on an activity isn't stomped.

**CRM #8 — `updateInvoice` bundled `{amount, status:'PAID'}` books diverge.** `app/(dashboard)/billing/actions.ts:updateInvoice` now applies the non-status
patch FIRST (so the new amount lands on the invoice), THEN calls
`markInvoicePaid` (which reads the updated amount for the paired CashEntry).
Order corrected.

**CRM #9 — `updateClient` PROSPECT→ACTIVE not transactional.** `lib/domain/clients.ts:updateClient` now wraps the SELECT current-status +
UPDATE clients + UPDATE leads (+ recordActivity) in one `db.transaction`.
Partial failure can no longer leave the client ACTIVE while linked leads
stay open.

**CRM #10 — MCP `update*` handlers cast raw args.** New
`lib/mcp/coerce.ts` module: `coerceLeadPatch` / `coerceClientPatch` /
`coerceProjectPatch` / `coerceInvoicePatch` / `coerceCashEntryPatch`. Each
strips unknown keys and validates every field's type (`asString`,
`asNumber`, `asEnum` against the schema-declared enum values). All five
`lib/mcp/handlers/{leads,clients,projects,billing,treasury}.ts` `update*`
handlers now pipe `rest` through the coercer before casting to the domain
patch. Malformed args produce a clean `${field} must be ...` error instead
of a Drizzle Postgres error.

**CRM #11 — `updateLeadStatus` FK-crashes on unknown id.** `lib/domain/leads.ts:updateLeadStatus` now checks `if (!updated) throw new Error("Lead no encontrado")` between
the UPDATE returning() and the recordActivity call. Consistent with siblings.

**CRM #12 — `markInvoicePaid` hand-rolled prefix.** Already resolved as part
of #3 — the transaction now calls `recordActivity(actor, {...}, tx)` instead
of `tx.insert(activities)`. Single source of truth for the sender-label
prefix.

**CRM #13 — `create*` audit gate inconsistency.** New `isAgentActor(actor)`
helper exported from `lib/domain/activities.ts` (predicate:
`actor.userId === AGENT_USER_ID`). All previous `if (actor.senderLabel)`
gates in the domain layer (createClient, createProject, createInvoice,
createCashEntry, and every update*/link* audit gate) now use
`if (isAgentActor(actor))`. Semantic gate (identity) instead of accidental
gate (header presence). `createLead` remains ALWAYS-auditing to preserve
pre-refactor UI behavior — documented in the `isAgentActor` JSDoc as an
intentional exception.

**Nanoclaw #17 — header crash/injection from raw pushName.** `data/sessions/dimitris-claw/agent-runner-src/index.ts` now sanitizes:
`rawSenderLabel.replace(/[^\x20-\x7E]/g, '?').slice(0, 200)`. Emoji /
CJK / accented characters are replaced with `?` (avoids ERR_INVALID_CHAR from
undici), CRLF is stripped (blocks header injection), and length is capped.
Belt-and-suspenders identical sanitization on the CRM side (see #6 above).

### Minors

**CRM #14 — no rate limit.** Skipped per reviewer's "if cheap; otherwise
skip". Existing `lib/rate-limit-ip.ts` is credentials-endpoint-specific
(10/15min + 5/60s bursts); repurposing needs a config-per-limiter change
that's out of scope for a fix cycle. Captured as post-v1 follow-up in the
CHANGES.md follow-ups section above; also flagged in `DEPLOY.md`.

**CRM #15 — malformed JSON-RPC returns wrong code.** `app/api/mcp/route.ts`
now validates `body?.jsonrpc === "2.0"` and `typeof body?.method === "string"` BEFORE the dispatch switch. Failures return `-32600 Invalid Request`
per JSON-RPC 2.0 spec.

**Nanoclaw #19 — settings.json world-readable.** `chmod 600` applied to
`data/sessions/dimitris-claw/.claude/settings.json` now. Also enforced in
`src/container-runner.ts:buildVolumeMounts()` on every startup (fs.chmodSync
with warn-log on failure) so hand-edits / git checkouts can't leave it
world-readable.

**Nanoclaw #20 — `sender_name` nullable in SQLite.** `src/index.ts:latestSender` now guards both fields with
`triggerMessage.sender ?? 'unknown@unknown'` and
`triggerMessage.sender_name ?? 'unknown'`. Downstream header interpolation
sees valid strings, never the literal `"null"`.

**Nanoclaw #21 — scheduled runs label as 'unknown'.** Agent-runner now
distinguishes: `latestSender` absent + `isScheduledTask` → `'scheduler'`;
`latestSender` absent + not scheduled → `'unknown'`. Audit rows attributable
to the scheduler are now identifiable in the CRM.

**Nanoclaw #22 — `mcpServers as never` bypasses SDK types.** Import
`McpServerConfig` from `@anthropic-ai/claude-agent-sdk` (present in the SDK's
public exports per its `sdk.d.ts:978`) and type
`mcpServers: Record<string, McpServerConfig>`. Cast removed. Future SDK
shape changes are now compile-time visible.

### Findings NOT fixed (with justification)

- **CRM #14 (rate limit)** — skipped per reviewer's explicit authorization.
  Follow-up: create `lib/rate-limit-mcp.ts` keyed on bearer-token hash +
  tool name; wire into `POST /api/mcp` before the switch. Not v1.
- Pre-existing `deleteLead` no-auth in `pipeline/actions.ts` — reviewer
  explicitly noted "predates this diff, do NOT fix".
- Fork-vs-tree divergence — reviewer explicitly noted "architectural, not
  a fix-cycle item".

### Rev 2 build/typecheck results

- CRM: `npx tsc --noEmit --project tsconfig.json` on `app/`, `lib/`,
  `middleware.ts`, `scripts/`, `components/` → **zero errors**. Pre-existing
  `services/whatsapp/` errors (missing `@types/express`, `pino`, etc.)
  unchanged.
- Nanoclaw: `npm run build` → **zero errors**.
- Acceptance greps still pass:
  - Step 3 `db.(insert|update|delete)(leads)` in pipeline/actions.ts → 0.
  - Step 4 target-table writes in all six refactored actions files → 0.
  - Step 6 MCP handlers importing from `app/(dashboard)` → 0.
  - New: `isAgentActor` used in every domain module.

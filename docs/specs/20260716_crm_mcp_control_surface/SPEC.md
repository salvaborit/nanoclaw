# SPEC — CRM MCP control surface for `dimitris-claw`

Companion docs:
- `CONTEXT_CRM.md` — CRM-side research (schema, actions, deploy, auth).
- `CONTEXT_NANOCLAW.md` — nanoclaw-side research (MCP wiring, secrets, sender plumbing).

## Goal

Give the `dimitris-claw` WhatsApp group full CRUD control of the Dimitris CRM by mounting an HTTP MCP server at `POST /api/mcp/*` inside the Next.js app (`~/prj/crm-dimitris`, prod `h-dmi-a:/srv/crm-dimitris`, TLS-fronted at `https://gaston.dimitris.app`) and wiring it into the per-group agent-runner as `mcpServers.crm` with a bearer token. Every mutation writes an `Activity` row that identifies the WhatsApp sender, using a single dedicated `nanoclaw-agent` CRM `User` for FK attribution. All existing UI behavior must remain byte-for-byte identical — this is a pure extraction refactor plus a new HTTP surface.

## Non-goals

- **No per-WhatsApp-sender identity in `User`.** Sender attribution lives only in `Activity.body` prefix, not as a `User` row per phone. One shared `nanoclaw-agent` User is the FK target on all agent writes.
- **No MCP-side confirmation flow.** `dimitris-claw` is a trusted-user group; the one remaining destructive operation (`crm.delete_cash_entry`) is gated by prompt-level CLAUDE.md guidance ("describe-then-write for the delete"), not enforced server-side.
- **No scheduled-task auto-writes.** The CLAUDE.md rule forbids MCP writes when the run was triggered by `task-scheduler` unless the user explicitly requested pre-authorized. We do not gate this at the server (no `X-Trigger: scheduled` enforcement) — prompt-level only.
- **No new `AuditLog` table** (§7.5 of `CONTEXT_CRM.md` option b). Audit lives in the existing `Activity` table with sender label in `body`.
- **No idempotency / rate-limit / per-key scoping surface v1.** Flagged in §Risks — revisit after v1 lands.
- **The `convertLeadToClient` and `updateClient` PROSPECT→ACTIVE primitives are being changed from destructive (hard-delete) to conservative (mark-CERRADO_GANADO).** This is intentional and applies to both the UI and MCP paths — the CRM primitives are fixed at the source, not papered over with MCP-only wrappers. See Steps 3 and 4. This is a UI-visible behavior change (Non-goal "byte-for-byte UI identical" is deliberately relaxed for these two flows).
- **No behavior change to human-facing UI beyond the two conversion/cascade primitives above.** The rest of the domain extraction (Steps 2–4) must be a pure refactor; server actions become thin adapters over the domain helpers.
- **No refactor of unrelated actions files.** Only the actions files that back the MCP surface (`pipeline`, `clients`, `clients/[id]`, `projects`, `projects/[id]`, `billing`, `treasury`) get extracted. `compensaciones`, `desarrollo`, `horas`, `maintenance-contracts`, `planificador`, `recurring-expenses`, `reuniones`, `settings`, `tasks` are out of scope.
- **No changes to the `/workspace/extra/dimitris/ssh_config` SSH-tunnel read path.** It becomes a legacy fallback (documented in `crm-access.md`), not removed.

## Scope: large

Cross-repo (two codebases), 15+ files touched, adds a new HTTP protocol surface + auth model to a system whose `DEPLOY.md` explicitly says "There is no bearer-token API". Triggers `/code-review high` at the quality gate.

---

## Ordered steps

Dependencies are noted where they matter. Steps 1–7 are CRM-side (in `~/prj/crm-dimitris`). Steps 8–10 are nanoclaw-side (in `~/prj/nanoclaw`). Steps 11–12 are docs + deploy.

### Step 1 — Seed the `nanoclaw-agent` CRM User

**Subject:** Create the User row all agent writes will be attributed to (satisfies the NOT-NULL `createdById` FK on `Activity`, `CashEntry`, etc. — `CONTEXT_CRM.md` §4 "Activity attribution").

**Files touched:**
- Create `lib/agent-user.ts` — exports `AGENT_USER_ID` constant (fixed cuid2 so it survives `db:push --force`) and `async function getAgentUser(): Promise<User>` that lazy-inserts the row if missing.
- Add a bootstrap call in `docker-entrypoint.sh` right after `npx drizzle-kit push --force` — e.g. `node -e "require('./dist/lib/agent-user').getAgentUser()"` — or inline it as a startup side-effect (see acceptance).

  Practical choice: do NOT run node inline in the entrypoint (dist path is fragile). Instead:
  - Ship `scripts/ensure-agent-user.ts` runnable via `tsx` (already a transitive dep via drizzle-kit) or a plain `pg` insert `INSERT ... ON CONFLICT (id) DO NOTHING`.
  - Call it from `docker-entrypoint.sh` after the schema push.

- Constants:
  - `AGENT_USER_ID = "usr_nanoclaw_agent_00000000"` (or any 24-char cuid2-shaped literal — chosen once, hardcoded).
  - `AGENT_USER_EMAIL = "nanoclaw-agent@dimitris.internal"` (unique constraint on `User.email` — `CONTEXT_CRM.md` §4).
  - `role = "MEMBER"` (NOT `ADMIN`, so any check that gates on ADMIN in `updateCashEntry` / `deleteCashEntry` / `updateInvoice` / `deleteInvoice` also gates the agent — see acceptance).

**Acceptance:**
- `psql $DATABASE_URL -c "SELECT id, email, role FROM \"User\" WHERE id='usr_nanoclaw_agent_00000000'"` returns one row after container boot.
- Row is idempotent across restarts (second `ensure-agent-user` invocation is a no-op).
- Grep confirms no other code references `AGENT_USER_ID` yet.
- **Design gate for ADMIN-only actions:** the `MEMBER` role choice means the agent cannot call `updateCashEntry` / `deleteCashEntry` / `updateInvoice` / `deleteInvoice` through the existing action code path. Since we're moving mutation guts to `lib/domain/*` in Steps 3–4 and the domain functions take an explicit `actor` (bypassing session-based role checks), this is fine — but the MCP tool handlers in Step 6 MUST NOT re-import the ADMIN-gated action wrappers. Instead they call the domain function directly. Document this in Step 6 acceptance.

---

### Step 2 — Extract `lib/domain/activities.ts`

**Subject:** One shared helper for the audit-trail row. Every domain mutation in Steps 3–4 calls it; MCP tools rely on it for the "sender label" prefix.

**Files touched:**
- Create `lib/domain/activities.ts`:
  ```ts
  import { db } from '@/lib/db';
  import { activities } from '@/lib/schema';
  import type { ActivityType } from '@/lib/prisma-types';

  export interface Actor {
    userId: string;                // FK for createdById
    senderLabel?: string;          // e.g. "Salvador (+5491133...)" — added to Activity.body
  }

  export interface RecordActivityInput {
    type: ActivityType;
    body: string;
    clientId?: string | null;
    projectId?: string | null;
    leadId?: string | null;
    saleProspectId?: string | null;
  }

  export async function recordActivity(actor: Actor, input: RecordActivityInput, tx = db) {
    const prefix = actor.senderLabel ? `[MCP · ${actor.senderLabel}] ` : '';
    return tx.insert(activities).values({
      type: input.type,
      body: prefix + input.body,
      clientId: input.clientId ?? null,
      projectId: input.projectId ?? null,
      leadId: input.leadId ?? null,
      saleProspectId: input.saleProspectId ?? null,
      createdById: actor.userId,
    });
  }
  ```
- The `tx` parameter defaults to the top-level `db` so it works inside and outside transactions (Drizzle's tx type is compatible with `db.insert`).

**Acceptance:**
- `tsc` passes.
- `grep -r "recordActivity" app/ lib/` shows only the definition (not yet called; callers come in Steps 3–4).
- No existing behavior change: no server action calls this yet.

---

### Step 3 — Extract `lib/domain/leads.ts`; refactor `pipeline/actions.ts` to call it

**Subject:** Pull the mutation guts of Lead server actions into pure functions parameterized by `Actor`. Server actions become thin session-wrappers.

**Files touched:**
- Create `lib/domain/leads.ts`. Export:
  - `createLead(actor, input): Promise<Lead>` — mirrors `pipeline/actions.ts:76-113` `createLead`. Validation (`contactName` required, `amount > 0`, etc.) moves here. Calls `recordActivity(actor, { type: 'NOTE', body: 'Lead creado: <name>', leadId })`.
  - `updateLead(actor, id, patch): Promise<Lead>` — mirrors `updateLead`; NOTE activity added on any change (new behavior — see `CONTEXT_CRM.md` §3 gap: current `updateLead` writes no activity; the audit-trail requirement means the domain layer now DOES write one, but only when `actor.senderLabel` is set — i.e. only agent writes get an audit row, UI writes stay silent to preserve UI-side behavior). See acceptance.
  - `updateLeadStatus(actor, id, status): Promise<Lead>` — mirrors `pipeline/actions.ts:44-74`. `closedAt` set on CERRADO_* transitions. Writes a NOTE always (UI already does this — no behavior drift).
  - `listLeads(filters): Promise<Lead[]>` — read-only, no actor.
  - `getLead(id): Promise<Lead | null>` — read-only.
  - `linkLeadToClient(actor, leadId, clientId | null)` — mirrors `pipeline/actions.ts:177-186`. Safe link (no delete). Writes NOTE only if `actor.senderLabel` is set.
  - `convertLeadToClient(actor, leadId): Promise<{ clientId: string }>` — **rewrites the primitive from `pipeline/actions.ts:188-223`** to be non-destructive. New behavior:
    1. Load lead; error if `lead.clientId` already set.
    2. Insert new `Client` with `name = lead.contactName`, `status = 'ACTIVE'` (unchanged).
    3. **DO NOT null `activities.leadId`.** The lead persists, so activity FKs stay valid.
    4. **DO NOT delete the lead row.** Instead: `db.update(leads).set({ status: 'CERRADO_GANADO', closedAt: new Date(), clientId: <new client id> }).where(eq(leads.id, leadId))`. The lead persists as a won/closed row linked to the new client. Activity history remains queryable both via `leadId` (original) and via `clientId` (client-scoped views).
    5. Insert NOTE activity under the **new client** (also references `leadId` so it's discoverable from both angles): `"Lead convertido a cliente: <contactName>"`.
    6. Return `{ clientId }`.
    This applies to **both UI and MCP callsites** — the primitive is fixed at the source per user directive: *"i dont want to hard delete shit when converting. use the safe alternatives or fix beforehand."*

- Refactor `app/(dashboard)/pipeline/actions.ts`:
  - Each server action becomes: `await auth()` + role guards → call domain function with `actor = { userId: session.user.id }` (no `senderLabel` — UI path) → `revalidatePath(...)`.
  - `revalidatePath` and `redirect` stay in the server action, not the domain.

- **Sub-step: Audit lead-list queries for the newly-persisting converted rows.** With `convertLeadToClient` no longer deleting the source row, any query that lists or counts leads without filtering on status may now return the converted lead. Grep and inspect:
  - `app/(dashboard)/pipeline/**` — the Kanban board query (`page.tsx`, any `getLeads*` helpers). Confirm it filters by `status NOT IN ('CERRADO_GANADO','CERRADO_PERDIDO')` or equivalent.
  - `lib/kpi-*.ts`, `lib/kpi-goals.ts`, `lib/kpi-progress.ts`, `lib/kpi-topbar-store.ts`, `lib/kpi-windows.ts` — lead-count KPIs. If any is `SELECT COUNT(*) FROM Lead` unqualified, add the status filter.
  - `app/(dashboard)/dashboard-greeting.tsx`, `app/(dashboard)/urgent-items.tsx`, `app/(dashboard)/page.tsx` — dashboard widgets that reference leads.
  - `app/(dashboard)/clients/[id]/**` — if the client detail page shows "linked leads", verify it now surfaces the converted lead (should — that's the point of `clientId` FK survival) or gates on non-terminal status.
  - Any `sql\`SELECT ... FROM \"Lead\"\`` in `lib/**` — grep `grep -rn "FROM \"Lead\"\|from(leads)\|leads\\." lib/ app/`.
  - **Migration action:** where an unqualified count is found, add the `status NOT IN ('CERRADO_GANADO','CERRADO_PERDIDO')` predicate (or `status NOT IN` matching whatever "open" semantics that widget wants). Bundle these fixes into Step 3's diff — do NOT split into a separate step, since the primitive change requires them for correctness.

**Acceptance:**
- `tsc` passes.
- **UI-side behavior:** creating/editing leads still works. Clicking "convert to client" in the UI: (a) creates the Client row (unchanged); (b) the source Lead row **persists** with `status='CERRADO_GANADO'`, `closedAt` set, `clientId` set (new behavior); (c) the pipeline Kanban board no longer shows the converted lead (validates the lead-list-query audit found and filtered every relevant surface); (d) opening the new Client's detail page shows the converted lead in the "linked leads" section (if such a section exists) or at least keeps the historical activities visible.
- `grep -n "db.delete(leads)" lib/domain/leads.ts` returns **zero** hits — the primitive no longer hard-deletes.
- `grep -n "db.insert(leads)\|db.update(leads)\|db.delete(leads)" app/\(dashboard\)/pipeline/actions.ts` returns **zero** hits — all DB writes moved to `lib/domain/leads.ts`.
- `grep -n "recordActivity\|db.insert(activities)" lib/domain/leads.ts` shows every mutation writes an activity through the helper.
- Manual smoke on the UI `updateLead` still writes NO activity (because `actor.senderLabel` is undefined → domain skips the audit row) — preserves current UI-side behavior for non-conversion flows.
- No new dependencies. No schema change.

---

### Step 4 — Same extraction for `clients`, `projects`, `billing`, `treasury`

**Subject:** Repeat Step 3's pattern for the remaining entity groups the MCP will expose.

**Files touched:**

- Create `lib/domain/clients.ts`. Exports:
  - `createClient(actor, input)` — from `clients/actions.ts` `createClient`. Writes NOTE `"Cliente creado: <name>"` only when `actor.senderLabel` set (new behavior, agent-only).
  - `updateClient(actor, id, patch)` — **rewrites the PROSPECT→ACTIVE side effect** from `clients/[id]/actions.ts:34-48` to be non-destructive. New behavior when `patch.status === 'ACTIVE'` and previous status was `'PROSPECT'`:
    - `db.update(leads).set({ status: 'CERRADO_GANADO', closedAt: new Date() }).where(and(eq(leads.clientId, id), notInArray(leads.status, ['CERRADO_GANADO','CERRADO_PERDIDO'])))` — mark any linked leads not already in a terminal status as won/closed. The `clientId` FK is preserved (leads stay linked to their client).
    - **DO NOT null `activities.leadId`.** **DO NOT delete leads.**
    - No opt-in flag needed. Per user directive: *"i dont want to hard delete shit when converting. use the safe alternatives or fix beforehand."* Applies to both UI and MCP callsites.
  - `listClients(filters)`, `getClient(id)` — read-only.

- Create `lib/domain/projects.ts`. Exports:
  - `createProject(actor, input)` — from `projects/actions.ts`. Validation: `name`, `clientId` required. NOTE `"Proyecto creado: <name>"` agent-only.
  - `updateProject(actor, id, patch)` — from `projects/[id]/actions.ts`.
  - `listProjects(filters)`, `getProject(id)` — read-only.
  - **Also cover** the sibling `createProjectInvoice` in `projects/[id]/actions.ts:219-243` — merge its guts into `lib/domain/billing.ts` `createInvoice` (below) so both callsites share one path.

- Create `lib/domain/billing.ts`. Exports:
  - `createInvoice(actor, input)` — from `billing/actions.ts:9-40`. Validation: `projectId`, `clientId`, `amount > 0`. NOTE agent-only.
  - `updateInvoice(actor, id, patch)` — from `billing/actions.ts`. **Explicitly REJECT `patch.status === 'PAID'`** with error `"Use markInvoicePaid to set PAID (creates paired CashEntry)"`. This closes the `CONTEXT_CRM.md` §2 warning ("naive set status=PAID via updateInvoice would leave no cash entry"). UI callsite has no path that sets PAID via updateInvoice today (`billing/actions.ts:107-114` allows it, but the UI never triggers it — verify by grepping components). If a UI path IS found, keep the domain rejection and update the UI to call `markInvoicePaid` instead.
  - `markInvoicePaid(actor, invoiceId)` — from `billing/actions.ts:130-170`. Transactional: sets status+paidDate, inserts paired `CashEntry INGRESO`, inserts `Activity PAYMENT`. The PAYMENT activity is written by `recordActivity` with sender label.
  - `deleteInvoice(actor, invoiceId)` — from `billing/actions.ts`. Not exposed by MCP v1 (see Step 6 tool list) but extracted to keep the layer complete.
  - `listInvoices(filters)`, `getInvoice(id)` — read-only.

- Create `lib/domain/treasury.ts`. Exports:
  - `createCashEntry(actor, input)` — from `treasury/actions.ts:13-44`. Validation: `type ∈ INGRESO|EGRESO`, `amount > 0`, `concept` required. **Writes an activity** (new behavior, agent-only) — attach to `clientId`/`projectId` if provided.
  - `updateCashEntry(actor, id, patch)` — from `treasury/actions.ts:46-101`. Preserves the transactional invoice-paidDate sync when `invoiceId` is set. **Drops the `role === "ADMIN"` check** — replaced by the actor model: any caller with a valid `actor.userId` may update. The UI's server-action wrapper reinstates the ADMIN check at the session layer; the domain function does not.
  - `deleteCashEntry(actor, id)` — from `treasury/actions.ts:103-124`. Same actor-model shift. Preserves the attachment-unlink side effect. Non-atomic caveat from `CONTEXT_CRM.md` §3 unchanged.
  - `listCashEntries(filters)`, `getCashEntry(id)` — read-only.

- Refactor each of `clients/actions.ts`, `clients/[id]/actions.ts`, `projects/actions.ts`, `projects/[id]/actions.ts`, `billing/actions.ts`, `treasury/actions.ts` to become thin `await auth()` + role-guard + call-domain + `revalidatePath` wrappers.

**Acceptance:**
- `tsc` passes.
- Manual UI smoke: create a client, edit a client, create a project, create an invoice, mark an invoice paid, create/edit/delete a cash entry — all still work in the browser with no visible change.
- `grep -n "db.insert\|db.update\|db.delete" app/\(dashboard\)/{clients,clients/[id],projects,projects/[id],billing,treasury}/actions.ts` returns **zero** hits for tables `leads|clients|projects|invoices|cashEntries|activities`. Only reads (`db.select`, `db.query`) remain, and even those can move to the `list*`/`get*` helpers if trivial.
- Depends on: Steps 1, 2, 3.

---

### Step 5 — Choose MCP HTTP library / protocol shape

**Subject:** Decide the HTTP surface style before writing the route handler.

**Constraints:**
- The nanoclaw SDK side uses `{ type: 'http', url, headers }` (`CONTEXT_NANOCLAW.md` §1) — a standard MCP HTTP transport. The URL is the single MCP endpoint; the SDK client speaks JSON-RPC 2.0 over HTTP POST at that path, and separately supports SSE for streaming.
- The Anthropic MCP HTTP spec (aka "Streamable HTTP transport", introduced 2025-03-26 spec revision) mandates a single endpoint that accepts POST for client-to-server RPC and (optionally) GET for the SSE stream. See <https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http> (referenced from `sdk.d.ts` docstring for `McpHttpServerConfig`, per `CONTEXT_NANOCLAW.md` §1).

**Options (research-gap — pick one before Step 6):**
1. **`@modelcontextprotocol/sdk` (official TypeScript SDK).** Exports `StreamableHTTPServerTransport` + `Server` for hand-registering tools. Framework-agnostic — mount its `handleRequest(req, res)` inside a Next.js Route Handler by adapting `NextRequest` ↔ Node `IncomingMessage`. See <https://github.com/modelcontextprotocol/typescript-sdk>. **Risk:** the SDK expects raw Node req/res, not Fetch-API `Request`/`Response`; a shim is needed.
2. **Vercel MCP adapter (`@vercel/mcp-adapter`).** Purpose-built for Next.js App Router. Handles the shim. Adds a dep. See <https://vercel.com/docs/mcp>.
3. **Hand-rolled JSON-RPC 2.0 handler.** ~200 LOC in `app/api/mcp/route.ts`: parse `jsonrpc` envelope, dispatch on `method` (`initialize`, `tools/list`, `tools/call`, `ping`), return `result`/`error`. Skip SSE (return non-streaming JSON responses). Sufficient because the nanoclaw SDK client accepts non-streaming responses per the spec. **Zero new deps.**

**Recommendation:** **Option 3 (hand-rolled)** for v1. Rationale:
- Only 6 protocol methods matter (`initialize`, `notifications/initialized`, `tools/list`, `tools/call`, `ping`, `shutdown`).
- Avoids Vercel-adapter framework lock-in and avoids the raw-Node shim of option 1.
- Keeps the diff small, auditable, and matches the AGENTS.md warning ("This is NOT the Next.js you know" — minimize surface area of new abstractions).
- If nanoclaw's SDK http-transport rejects non-streaming, upgrade to option 1 in a follow-up.

**Sources cited in SPEC:**
- MCP HTTP transport spec: <https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http>
- Official TypeScript SDK: <https://github.com/modelcontextprotocol/typescript-sdk>
- JSON-RPC 2.0: <https://www.jsonrpc.org/specification>

**Acceptance:**
- Decision documented at the top of `app/api/mcp/route.ts` as a code comment with the three URLs.
- Confirmed via a manual test: `curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' http://localhost:26901/api/mcp` returns a JSON envelope with `result.tools` array. (After Step 6.)
- **If Option 3 fails during Step 8 smoke** (nanoclaw SDK refuses the response shape) — flag as REPLAN, swap to Option 1.

---

### Step 6 — Implement `POST /api/mcp/route.ts`

**Subject:** The MCP HTTP surface: bearer auth, sender-header extraction, JSON-RPC dispatch, tool handlers that call `lib/domain/*`.

**Files touched:**

- Create `app/api/mcp/route.ts`. Sketch:

  ```ts
  export const runtime = 'nodejs';                 // not edge — Drizzle+pg
  export const dynamic = 'force-dynamic';

  import { NextRequest, NextResponse } from 'next/server';
  import { timingSafeEqual } from 'node:crypto';
  import * as leads from '@/lib/domain/leads';
  import * as clients from '@/lib/domain/clients';
  import * as projects from '@/lib/domain/projects';
  import * as billing from '@/lib/domain/billing';
  import * as treasury from '@/lib/domain/treasury';
  import * as acts from '@/lib/domain/activities';
  import { AGENT_USER_ID } from '@/lib/agent-user';
  import { TOOL_DEFS, callTool } from '@/lib/mcp/tools';

  function authorize(req: NextRequest): boolean {
    const header = req.headers.get('authorization') ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    const expected = process.env.MCP_BEARER_TOKEN ?? '';
    if (!bearer || !expected || bearer.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(bearer), Buffer.from(expected));
  }

  export async function POST(req: NextRequest) {
    if (!authorize(req)) return new NextResponse('Unauthorized', { status: 401 });
    const senderLabel = req.headers.get('x-nanoclaw-sender') ?? undefined;
    const actor = { userId: AGENT_USER_ID, senderLabel };

    let body: any;
    try { body = await req.json(); } catch { return jsonRpcError(null, -32700, 'Parse error'); }

    // Dispatch minimal method set: initialize, notifications/initialized, tools/list, tools/call, ping.
    switch (body.method) {
      case 'initialize':               return jsonRpcOk(body.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'crm-dimitris', version: '1.0.0' } });
      case 'notifications/initialized': return new NextResponse(null, { status: 204 });
      case 'tools/list':               return jsonRpcOk(body.id, { tools: TOOL_DEFS });
      case 'tools/call':               return jsonRpcOk(body.id, await callTool(actor, body.params));
      case 'ping':                     return jsonRpcOk(body.id, {});
      default:                         return jsonRpcError(body.id, -32601, 'Method not found');
    }
  }
  ```

- Create `lib/mcp/tools.ts`. This module holds the tool registry `TOOL_DEFS` (name, description, `inputSchema` JSON Schema for each tool) and `callTool(actor, { name, arguments })` dispatch. Every handler calls the corresponding `lib/domain/*` function. Below is the v1 tool list.

- Create `lib/mcp/handlers/{leads,clients,projects,billing,treasury,activities}.ts` — one file per entity, exports named handler funcs. Keeps `tools.ts` from ballooning.

- Create `lib/mcp/json-rpc.ts` — `jsonRpcOk(id, result)` and `jsonRpcError(id, code, message, data?)` helpers.

**Tool inventory (v1):**

| Tool name                          | Domain call                                    | Notes |
|---                                 |---                                             |---    |
| `crm.list_leads`                   | `leads.listLeads(input)`                       | Filters: `status?`, `responsibleId?`, `clientId?`, `limit?` |
| `crm.get_lead`                     | `leads.getLead(id)`                            | |
| `crm.create_lead`                  | `leads.createLead(actor, input)`               | |
| `crm.update_lead`                  | `leads.updateLead(actor, id, patch)`           | Any field editable. |
| `crm.update_lead_status`           | `leads.updateLeadStatus(actor, id, status)`    | Dedicated because it carries the CERRADO_* `closedAt` rule. |
| `crm.add_lead_note`                | `acts.recordActivity(actor, { type:'NOTE', body, leadId })` | Convenience. |
| `crm.convert_lead_to_client`       | `leads.convertLeadToClient(actor, leadId)`     | Description: *"Convert a lead to a client. Creates a new Client from lead fields; marks the source lead as CERRADO_GANADO with `clientId` set (lead persists for history, not deleted)."* Non-destructive per Step 3. |
| `crm.link_lead_to_client`          | `leads.linkLeadToClient(actor, leadId, clientId)` | Safe: FK update only, no status change. Use when you want to associate without closing the lead. |
| `crm.list_clients`                 | `clients.listClients(input)`                   | |
| `crm.get_client`                   | `clients.getClient(id)`                        | |
| `crm.create_client`                | `clients.createClient(actor, input)`           | |
| `crm.update_client`                | `clients.updateClient(actor, id, patch)`       | Description: *"Update any client field. If `status` transitions PROSPECT→ACTIVE, any linked leads not already in a terminal status are marked CERRADO_GANADO (leads persist, clientId FK preserved)."* No destructive-flag opt-in per Step 4. |
| `crm.add_client_note`              | `acts.recordActivity(actor, { type:'NOTE', body, clientId })` | |
| `crm.list_projects`                | `projects.listProjects(input)`                 | |
| `crm.get_project`                  | `projects.getProject(id)`                      | |
| `crm.create_project`               | `projects.createProject(actor, input)`         | `clientId` required. |
| `crm.update_project`               | `projects.updateProject(actor, id, patch)`     | |
| `crm.add_project_note`             | `acts.recordActivity(actor, { type:'NOTE', body, projectId })` | |
| `crm.list_invoices`                | `billing.listInvoices(input)`                  | |
| `crm.get_invoice`                  | `billing.getInvoice(id)`                       | |
| `crm.create_invoice`               | `billing.createInvoice(actor, input)`          | |
| `crm.update_invoice`               | `billing.updateInvoice(actor, id, patch)`      | **Refuses `status: 'PAID'` — use `crm.mark_invoice_paid`.** |
| `crm.mark_invoice_paid`            | `billing.markInvoicePaid(actor, invoiceId)`    | Transactional: also creates paired CashEntry INGRESO. |
| `crm.list_cash_entries`            | `treasury.listCashEntries(input)`              | Filters: `type?`, `dateFrom?`, `dateTo?`. |
| `crm.get_cash_entry`               | `treasury.getCashEntry(id)`                    | |
| `crm.create_cash_entry`            | `treasury.createCashEntry(actor, input)`       | |
| `crm.update_cash_entry`            | `treasury.updateCashEntry(actor, id, patch)`   | |
| `crm.delete_cash_entry`            | `treasury.deleteCashEntry(actor, id)`          | **Description warns: "irreversible; also deletes attached file"**. |

  Naming: **dot-separated `crm.*`** for readability (Anthropic SDK sanitizes to `mcp__crm__crm_list_leads` etc.). If sanitization loses the `crm.` prefix, drop the prefix from names and rely on the MCP server name (`crm`) for namespacing — decide during Step 6 based on the SDK's actual tool-name resolution.

- **Input-schema policy:** every tool has a `inputSchema: { type: 'object', properties: {...}, required: [...] }` describing every accepted field. Use the CRM's Drizzle table types as the source of truth (mirror field names, mark truly-optional fields as optional).

**Acceptance:**
- `tsc` passes across the CRM.
- `curl -sS -X POST -H "Authorization: Bearer $MCP_BEARER_TOKEN" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' http://localhost:26901/api/mcp | jq '.result.tools | length'` returns `>= 29`.
- Same call with a wrong bearer → HTTP 401.
- `curl … -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"crm.list_leads","arguments":{"limit":3}}}' … | jq '.result'` returns a lead list.
- A create call with `X-Nanoclaw-Sender: Salvador (+549…)` header inserts an `Activity` row whose `body` starts with `[MCP · Salvador (+549…)]`.
- **MCP-handler-does-not-import-actions gate:** `grep -rn "from '@/app/(dashboard)" lib/mcp/` returns **zero** hits — handlers only touch `lib/domain/*` and `lib/agent-user.ts`.
- Depends on: Steps 1–5.

---

### Step 7 — Whitelist `/api/mcp` in `middleware.ts`

**Subject:** The current middleware (`middleware.ts`, verified: it applies NextAuth `authorized()` to all non-static paths per the `matcher`) redirects unauthenticated requests to `/login`. The MCP endpoint needs to bypass NextAuth entirely — its own bearer check in Step 6 is the auth boundary.

**Files touched:**
- Edit `middleware.ts`:
  ```ts
  export default function middleware(req: NextRequest, ev: NextFetchEvent) {
    // Bypass NextAuth for the MCP surface — /api/mcp enforces its own bearer auth.
    if (req.nextUrl.pathname.startsWith('/api/mcp')) {
      return NextResponse.next();
    }
    // …existing rate-limit block for /api/auth/callback/credentials…
    return authMiddleware(req, ev);
  }
  ```
  Insert the bypass **before** the existing rate-limit block so it short-circuits fastest.
- No change to the `matcher` — MCP still passes through middleware, just skips the auth callback.

**Acceptance:**
- `curl -o /dev/null -w '%{http_code}\n' http://localhost:26901/api/mcp` (no auth) returns **401** (Step 6's bearer check), NOT **302 → /login** (which would prove the bypass didn't fire).
- `grep -c "/api/mcp" middleware.ts` returns `1`.
- Unrelated protected pages (e.g. `/pipeline`) still redirect to `/login` when unauthenticated (regression check).
- Depends on: Step 6 in place so `/api/mcp` returns 401 instead of 404.

---

### Step 8 — Nanoclaw: plumb sender + register `mcpServers.crm` in per-group fork

**Subject:** Wire the CRM MCP into the `dimitris-claw` agent-runner fork and thread WhatsApp sender identity through to the `X-Nanoclaw-Sender` header.

**Files touched (in `~/prj/nanoclaw`):**

- **Extend `ContainerInput`** in `src/container-runner.ts:38-48` with an optional field:
  ```ts
  latestSender?: { jid: string; name: string };   // sender of the message that triggered this run
  ```
  Populate it in `src/index.ts:346-360` (the `runContainerAgent` call site) from the last unread message record (`msg.sender`, `msg.sender_name` — both already available; confirmed by grep of `src/router.ts:22` and `src/index.ts:539-550`).

- Propagate `latestSender` through the stdin JSON payload (`src/container-runner.ts:353-357`) to the agent-runner. The payload is a `ContainerInput` shape — the extra field falls through naturally.

- **Edit the per-group agent-runner fork** at `data/sessions/dimitris-claw/agent-runner-src/index.ts` (this file exists — verified; container runtime recompiles it on every start, no image rebuild needed per `CONTEXT_NANOCLAW.md` §6). Around the existing `mcpServers: { nanoclaw: {...} }` block (currently at line ~460 in the tree copy — the fork may drift), add:
  ```ts
  const senderLabel = input.latestSender
    ? `${input.latestSender.name} (${input.latestSender.jid.replace('@s.whatsapp.net','')})`
    : 'unknown';
  const crmToken = sdkEnv.DIMITRIS_CRM_MCP_TOKEN;
  const crmUrl   = sdkEnv.DIMITRIS_CRM_MCP_URL   ?? 'https://gaston.dimitris.app/api/mcp';

  const mcpServers: Record<string, McpServerConfig> = {
    nanoclaw: { command: 'node', args: [mcpServerPath], env: {...} },
    ...(crmToken ? {
      crm: {
        type: 'http',
        url: crmUrl,
        headers: {
          Authorization: `Bearer ${crmToken}`,
          'X-Nanoclaw-Sender': senderLabel,
        },
      } as McpHttpServerConfig,
    } : {}),
  };
  ```
  If `DIMITRIS_CRM_MCP_TOKEN` is unset, `crm` is not registered — safe degradation.

- **Set the token + URL** in `data/sessions/dimitris-claw/.claude/settings.json` `env` block. New shape:
  ```json
  {
    "model": "claude-sonnet-5",
    "env": {
      "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
      "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD": "1",
      "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "0",
      "DIMITRIS_CRM_MCP_TOKEN": "<64-hex-random>",
      "DIMITRIS_CRM_MCP_URL": "https://gaston.dimitris.app/api/mcp"
    }
  }
  ```
  The same token value is set as `MCP_BEARER_TOKEN` in `/srv/crm-dimitris/.env` on the prod host (Step 12).

- Generate the token: `openssl rand -hex 32`. Store it in the user's password manager. Rotate by editing both files + `systemctl --user restart nanoclaw` + `docker compose up -d` on prod.

**Acceptance:**
- `npm run build` in `~/prj/nanoclaw` passes (only touches `src/` typings).
- `systemctl --user restart nanoclaw` starts cleanly.
- Send a test message in the `dimitris-claw` WhatsApp group ("listá los leads abiertos"). In the resulting container log (`groups/dimitris-claw/logs/container-*.log`) confirm:
  - The agent-runner emits a startup log naming `mcp servers: nanoclaw, crm`.
  - No TLS or connection error to `gaston.dimitris.app/api/mcp`.
  - The tool listing includes `mcp__crm__*` entries.
- On the CRM side, the request log (or `docker compose logs app --tail 50`) shows the incoming POST with a well-formed `X-Nanoclaw-Sender` header.
- **Sender-header staleness caveat:** the header is fixed at container spawn. Follow-up messages during the 30-min idle window (piped in via IPC per `CONTEXT_NANOCLAW.md` §4) do NOT update the header, so the `Activity.body` prefix will reflect the first sender only. Flagged in §Risks; workaround for v1 is a per-turn CLAUDE.md hint that the agent should re-derive sender from the prompt XML on multi-turn writes and (post-v1) accept an optional `senderLabelOverride` per tool call.

- Depends on: Steps 6, 7. `~/prj/nanoclaw` changes can be built before the CRM deploys, but the message-loop smoke can only succeed once the CRM is live.

---

### Step 9 — Overhaul `dimitris-claw` skill: `crm-access.md`

**Subject:** Teach Jarvis that writes go via MCP now; keep SSH tunnel as read-fallback.

**Files touched:**
- Edit `data/sessions/dimitris-claw/.claude/skills/dimitris/crm-access.md`:
  - **Add a top section:** *"MCP tools (primary — reads and writes)"* listing all 29 tools from Step 6 with one-line descriptions. Include the description language from the tool inventory verbatim (in particular: `convert_lead_to_client` is non-destructive — marks lead CERRADO_GANADO; `update_client` PROSPECT→ACTIVE is non-destructive — marks linked leads CERRADO_GANADO; `update_invoice` refuses `status: 'PAID'` — must use `mark_invoice_paid`).
  - **Move the SSH-tunnel section to the bottom** and retitle it *"SSH tunnel (legacy read-only fallback)"*. Keep the `dimitris-db` alias notes and psql examples. State: *"Prefer MCP tools. Use SSH only if MCP is unreachable or you need a query the MCP can't express (e.g. arbitrary joins across `WhatsApp*` tables)."*
  - Add a *"Write-safety"* subsection:
    - *"The only irreversible MCP operation is `crm.delete_cash_entry` (also deletes the attached file, if any). Before calling it, describe the exact row(s) affected and wait for user confirmation ('sí' / 'dale' / 'ok') in the same conversation."*
    - *"All other writes (creates, updates, lead-to-client conversions, invoice mark-paid, client PROSPECT→ACTIVE transitions) are non-destructive — no confirmation needed. Just do them."*
    - *"If the caller is a scheduled-task invocation (check for `[scheduled]` marker in the system prompt or absence of a human sender), REFUSE all writes and reply that scheduled runs are read-only."*

**Acceptance:**
- The file contains a *"MCP tools (primary — reads and writes)"* header before the SSH section.
- All 29 tool names are listed with descriptions.
- The Write-safety subsection identifies `crm.delete_cash_entry` as the only irreversible operation.
- Depends on: Step 6 (tool list must be finalized first).

---

### Step 10 — Rewrite `groups/dimitris-claw/CLAUDE.md`

**Subject:** Drop the *"Read-only, físicamente"* invariant; add prompt-level write-safety.

**Files touched:**
- Edit `groups/dimitris-claw/CLAUDE.md`. Specifically:
  - **Remove the entire "Reglas específicas del canal" bullet that begins with "Read-only, físicamente."** (currently the first bullet in that section — verified in the file today).
  - Replace with a new bullet:
    > *"Escrituras al CRM via MCP `crm.*` tools. La única operación irreversible es `crm.delete_cash_entry` (también borra el adjunto en disco) — antes de llamarla, describí la fila afectada y esperá confirmación explícita ('sí'/'dale'/'ok'). El resto de las escrituras (creates, updates, `convert_lead_to_client` que ahora marca CERRADO_GANADO en vez de borrar, `update_client` PROSPECT→ACTIVE que ahora marca linked leads como CERRADO_GANADO, `mark_invoice_paid`) son no-destructivas — ejecutalas directo. Runs disparados por scheduler → solo lectura."*
  - **Session-start check:** update the `echo 'SELECT 1;'` block to first try `curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $DIMITRIS_CRM_MCP_TOKEN" -X POST -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"ping"}' $DIMITRIS_CRM_MCP_URL` (expect `200` with a JSON-RPC OK envelope), and fall back to the SSH tunnel check only if MCP is down. Report both to the user on failure.
  - Keep the WhatsApp formatting rules and mount reference unchanged.

**Acceptance:**
- `grep -c "Read-only, físicamente" groups/dimitris-claw/CLAUDE.md` returns `0`.
- `grep -c "crm\\." groups/dimitris-claw/CLAUDE.md` returns `>= 3`.
- Depends on: Step 8 (env vars exist so the ping check is runnable).

---

### Step 11 — Patch CRM `DEPLOY.md` stale strings

**Subject:** Fix the two known drift items surfaced in `CONTEXT_CRM.md` §6.

**Files touched (in `~/prj/crm-dimitris`):**
- Edit `DEPLOY.md`:
  - `ssh_alias: "h-dimitris-a"` → `ssh_alias: "h-dmi-a"`.
  - `base_url: "https://gaston.dimitris.uy"` → `base_url: "https://gaston.dimitris.app"`.
- Add a new Notes subsection *"MCP endpoint"*:
  ```
  ### MCP surface
  - Path: `POST /api/mcp` (JSON-RPC 2.0). Bypasses NextAuth (see middleware.ts).
  - Auth: `Authorization: Bearer $MCP_BEARER_TOKEN`.
  - Sender attribution: `X-Nanoclaw-Sender: <label>` — echoed into Activity.body prefix.
  - Health probe: `curl -sS -X POST -H "Authorization: Bearer $MCP_BEARER_TOKEN" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"ping"}' https://gaston.dimitris.app/api/mcp` → 200 with `{"jsonrpc":"2.0","id":1,"result":{}}`.
  ```

**Acceptance:**
- `grep -c "h-dmi-a" DEPLOY.md` returns `>= 1`.
- `grep -c "gaston.dimitris.app" DEPLOY.md` returns `>= 2` (base_url + health probe).
- `grep -c "gaston.dimitris.uy" DEPLOY.md` returns `0`.

---

### Step 12 — Deploy

**Subject:** Ship in dependency order.

**Ordered ops:**

1. **CRM local build:** in `~/prj/crm-dimitris`, `npm run build` → `docker compose up -d --build` on the dev host. Verify Steps 6, 7 acceptance criteria against `http://localhost:26901/api/mcp`.
2. **Push CRM to `main` + prod deploy:** commit Steps 1–7, 11 on `main`. SSH `h-dmi-a` (per corrected `DEPLOY.md`), `cd /srv/crm-dimitris && git pull && docker compose up -d --build`. `drizzle-kit push --force` runs at container boot but no schema change occurred in this SPEC — the only DB write is the `nanoclaw-agent` User row insert by `scripts/ensure-agent-user.ts` from the entrypoint (Step 1).
3. **Add `MCP_BEARER_TOKEN` to `/srv/crm-dimitris/.env`** on `h-dmi-a`. Value = same token generated in Step 8. Restart the compose stack (`docker compose up -d`, no rebuild needed for env changes since `env_file` re-reads).
4. **Nanoclaw local:** in `~/prj/nanoclaw`, `npm run build`. `systemctl --user restart nanoclaw`.
5. **Acceptance vertical from a real WhatsApp message** — see §Acceptance below.

---

## Acceptance (end-to-end vertical)

From the `dimitris-claw` WhatsApp group, sending as Salvador (`+549…`):

- [ ] **(a) list open leads** — "listá los leads abiertos" → agent replies with a list; CRM logs show `mcp__crm__crm_list_leads` call with the sender header.
- [ ] **(b) create a lead** — "creá un lead 'Prueba MCP' canal WhatsApp" → agent confirms creation; `SELECT * FROM "Lead" WHERE "contactName"='Prueba MCP'` returns a row; a paired `Activity` NOTE with `body LIKE '[MCP · Salvador (+549…)] Lead creado%'` exists.
- [ ] **(c) add an activity note** — "agregale a ese lead una nota 'contactado por email hoy'" → `Activity` NOTE row for that `leadId` exists with the sender prefix.
- [ ] **(d) convert to client** — "convertí ese lead a cliente" → agent calls `crm.convert_lead_to_client` directly (no confirmation prompt, since the op is now non-destructive). Post-conditions: a `Client` row `name='Prueba MCP'` exists; the source `Lead` row **still exists** with `status='CERRADO_GANADO'`, `closedAt` set, `clientId=<new client id>`; all prior activities from step (c) still resolvable via their original `leadId`; a NOTE `"Lead convertido a cliente: Prueba MCP"` exists under the new `clientId`.
- [ ] **(d.1) UI regression for the conversion primitive** — logged into the CRM UI as a human user, click "convert to client" on any lead. Result: the corresponding Client row appears; the source Lead row **persists** in the DB with `status='CERRADO_GANADO'`; the lead **no longer shows on the pipeline Kanban board** (validates that Step 3's lead-list-query audit correctly filtered all "open leads" queries); no console/UI errors.
- [ ] **(d.2) UI regression for the PROSPECT→ACTIVE cascade** — in the UI, edit an existing PROSPECT client that has ≥1 linked lead in a non-terminal status, change status to ACTIVE, save. Result: linked leads persist with `status='CERRADO_GANADO'`, `closedAt` set, `clientId` still pointing at the client (not nulled, not deleted). Historical activities preserved.
- [ ] **(e) create an invoice** — "creá una factura de USD 500 para 'Prueba MCP' proyecto X" → agent picks or creates a project (may need a preceding `create_project` call), then `create_invoice`. `Invoice` row exists status PENDING.
- [ ] **(f) mark it paid** — "marcá esa factura como cobrada" → `mark_invoice_paid` runs. `Invoice.status='PAID'`, `Invoice.paidDate` set, paired `CashEntry` (type INGRESO, `invoiceId=<id>`) inserted, `Activity` PAYMENT inserted — all in one transaction (`billing/actions.ts:130-170` primitive preserved).
- [ ] **(g) create a CashEntry** — "registrá un egreso USD 30 concepto 'test'" → `CashEntry` type EGRESO exists with sender-prefixed activity.
- [ ] **(h) edit it** — "cambiale el monto a 45" → `updateCashEntry` runs; row's `amount=45`; activity updated (new one, since Activity is append-only).
- [ ] **(i) delete it** — "borralo" → agent describes the destructive op, user confirms, `deleteCashEntry` runs; row gone.
- [ ] **Every Activity from steps (b), (c), (d), (e), (f), (g), (h), (i)** carries the `[MCP · Salvador (+549…)]` prefix in `body`.
- [ ] **Regression:** logging into the CRM UI as a human user, creating a lead through the pipeline — the created lead's Activity `body` does NOT have the `[MCP · …]` prefix (proves UI path bypasses `senderLabel`).

---

## Tiered verification plan (against CRM `DEPLOY.md`)

### Local (before merge)

1. **CRM typecheck + build:** in `~/prj/crm-dimitris`, `npm run lint && npm run build`. Zero errors.
2. **CRM boot:** `docker compose up -d --build`. `curl -sS http://localhost:26901/ -o /dev/null -w '%{http_code}\n'` returns `200` or `307`.
3. **MCP local smoke:**
   - `curl -o /dev/null -w '%{http_code}\n' -X POST http://localhost:26901/api/mcp` → **401** (proves middleware bypass + bearer check).
   - `curl -X POST -H "Authorization: Bearer $MCP_BEARER_TOKEN" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' http://localhost:26901/api/mcp | jq '.result.tools | length'` → `>= 29`.
   - Repeat `tools/call` for `crm.create_lead` with a `X-Nanoclaw-Sender: local-smoke` header. Verify row + activity prefix via `psql`.
4. **UI regression:** open `http://localhost:26901`, log in, create a lead via the UI, verify no `[MCP · …]` prefix on the resulting Activity (proves domain refactor doesn't leak the prefix into the UI path).
5. **Nanoclaw typecheck + build:** in `~/prj/nanoclaw`, `npm run build`. Zero errors.
6. **Nanoclaw restart:** `systemctl --user restart nanoclaw` then `systemctl --user is-active nanoclaw` = `active`.
7. **No end-to-end test suite exists** in either repo (`CONTEXT_CRM.md` §5, and nanoclaw has no e2e); coverage is manual only.

### Prod

1. **Push CRM `main`** + SSH `h-dmi-a`, `cd /srv/crm-dimitris && git pull && docker compose up -d --build` (per patched `DEPLOY.md`).
2. **Set `MCP_BEARER_TOKEN`** in `/srv/crm-dimitris/.env`; `docker compose up -d` to reload env.
3. **Smoke unauth:** `curl -o /dev/null -w '%{http_code}\n' -X POST https://gaston.dimitris.app/api/mcp` → **401** (proves middleware bypass and bearer check work through nginx).
4. **Smoke tools/list:** `curl -X POST -H "Authorization: Bearer $MCP_BEARER_TOKEN" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' https://gaston.dimitris.app/api/mcp | jq '.result.tools[].name'` → 29 tool names.
5. **Nanoclaw side:** send a message in `dimitris-claw`; walk the acceptance vertical (a)–(i).
6. **DB verification:** on `h-dmi-a`, `docker compose exec db psql -U postgres -c "SELECT type, body, \"createdAt\" FROM \"Activity\" WHERE body LIKE '[MCP%' ORDER BY \"createdAt\" DESC LIMIT 20;"` shows the acceptance-vertical activities with sender prefixes.

---

## Risks & unknowns

1. **MCP HTTP library choice — RESOLVED to hand-rolled JSON-RPC (Step 5 Option 3).** Contingency: if the nanoclaw SDK http-transport client refuses non-streaming responses during Step 8 smoke, swap to `@modelcontextprotocol/sdk` `StreamableHTTPServerTransport` (Option 1). Time cost of swap: ~1 day.
2. **`tools/call` result envelope shape.** Anthropic's MCP tool-result contract (per <https://modelcontextprotocol.io/specification/2025-06-18/server/tools#calling-tools>) expects `{ content: [{ type: 'text', text: '…' }], isError?: boolean }`. Confirm handlers wrap domain return values in this shape (JSON-stringify the payload into `text`). Not doing this = silent failure at agent side.
3. **Sender-header staleness across IPC-piped follow-up messages** (§Step 8). Header captures the container-spawn sender; subsequent messages during the 30-min idle window (`src/config.ts:55`) will carry the wrong sender label. For v1 in a 3-engineer group this is acceptable; post-v1 fix = accept `senderLabelOverride` per tool call.
4. **Sender-name plumbing gap (blocking sub-task inside Step 8).** `ContainerInput` today has no `latestSender` field. Step 8 adds it, but requires a source-of-truth for "which message is the trigger" in `src/index.ts` at the `runContainerAgent` callsite (~line 346). The last unread message from the batch is the right choice; message records already carry `sender` and `sender_name`. Verified feasible, but this is a shared-core diff to `~/prj/nanoclaw/src/`, not just the per-group fork — it changes the ContainerInput contract for all groups. Backward-compat: field is optional, unset = no header sent, no group breaks.
5. **Subagent MCP-inheritance smoke test.** `CONTEXT_NANOCLAW.md` §4 flags this as "likely, not empirically verified." Since Agent Teams is on (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`), if the leader delegates a CRM operation to a subagent and the subagent has no `mcp__crm__*` tool, the delegation fails silently. Mitigation: during Step 8 smoke, ask the agent to invoke a subagent that calls `crm.list_leads`. If it fails, degrade to leader-only CRM writes and note in CLAUDE.md.
6. **Rate limiting on MCP endpoint.** v1 has none. Runaway agent loops could DoS the CRM. Mitigation for v1: nanoclaw's own container idle timeout (30 min) is the fail-safe. Post-v1: reuse `lib/rate-limit-ip.ts` shape as `lib/rate-limit-mcp.ts` keyed on bearer-token hash + tool name.
7. **Concurrent `dimitris-claw` container invocations sharing the same bearer.** MCP server is stateless (no session cookies, no server-side idempotency store). Two concurrent `create_lead` calls with the same input WILL create two rows — no dedup. Idempotency is a post-v1 concern.
8. **`bypassPermissions` and `.mcp.json` gate.** Since we're using Option A (per-group agent-runner fork edit, `mcpServers` inline in SDK config), not Option B (`.mcp.json`), we avoid the untested `enableAllProjectMcpServers` question entirely. This is a plus of picking Option A.
9. **`docker-entrypoint.sh` change (Step 1) may not run cleanly.** If `scripts/ensure-agent-user.ts` can't find `tsx` at container boot (it needs to be at least devDep — verify `tsx` is in `package.json`), boot fails. Alt: hand-roll a tiny Node script using `pg` directly (no ts, no runtime deps). Fallback path documented in Step 1.
10. **`updateInvoice` PAID-path — fixed at the domain layer, not just at the MCP boundary.** Same treatment as `convertLeadToClient` and `updateClient` PROSPECT→ACTIVE: the primitive itself rejects `status: 'PAID'` at `lib/domain/billing.ts`, forcing all callers (UI and MCP alike) through `markInvoicePaid`. The UI callsite grep (`grep -rn "status.*PAID\|status.*paid" app/(dashboard)/billing/`) is a **UI-side migration sub-task**, not an escape hatch: any callsite found must be rewritten to call `markInvoicePaid`. If any UI form allowed toggling status to PAID directly, that flow is now impossible and the UI must be updated in the same commit as Step 4.
11. **The `AGENT_USER_ID` literal is not a valid cuid2** if we pick an easy-to-recognize string like `"usr_nanoclaw_agent_00000000"`. `Lead.responsibleId` and `User.id` are `text` (not enforced cuid2 by CHECK constraint per `CONTEXT_CRM.md` §2), so this is safe — the ID is just an opaque string. Confirmed no code parses/validates the User id format.
12. **`revalidatePath` from an MCP handler.** MCP tool handlers do NOT call `revalidatePath` (they can't — no request context tied to a browser navigation). UI users who happen to be logged in during an agent write will see stale KPI counters until their next natural refresh. Acceptable v1 gap; document in CLAUDE.md if it comes up.
13. **Inflated lead counts from persisting converted leads.** Now that `convertLeadToClient` marks the lead CERRADO_GANADO instead of deleting it, any pipeline/KPI/dashboard query that counts `leads` without filtering on status will show inflated numbers. The Step 3 sub-step ("Audit lead-list queries") is the mitigation — every found unqualified query must add the `status NOT IN ('CERRADO_GANADO','CERRADO_PERDIDO')` predicate. If the audit misses a surface, the acceptance-vertical `(d.1)` UI regression check will catch the pipeline board itself; other KPIs may need eyeballing after deploy.
14. **Editing a converted lead (CERRADO_GANADO with `clientId` set) via the UI.** Post-conversion, all lead fields (`responsibleId`, `contactName`, `interest`, discovery fields, propuesta fields, etc.) are preserved on the persisting row. If the UI's "edit lead" page still opens for CERRADO_GANADO leads, a user could confusingly edit historical data on a lead that's already been converted. Options: (a) block edits when `status === 'CERRADO_GANADO' && clientId IS NOT NULL` in the UI; (b) render read-only with a "converted to <client>" banner; (c) accept the current UX and revisit. **Flag as a UI-side follow-up** — do NOT block this SPEC on it, but capture in the eventual REPLAN/CHANGES doc.

---

## Delta: SPEC → REPLAN

### Revision 1 — 2026-07-16, planner pass (no verification failure; user-directive revision)

**Trigger:** user rejected the original plan's decision to keep the hard-delete semantics in the CRM primitives and wrap them with MCP-only safety flags. Direct quote:
> *"i dont want to hard delete shit when converting. use the safe alternatives or fix beforehand."*

The original design papered over destructive CRM behavior with MCP-side wrappers (`convert_lead_to_client` warning; `update_client` with `deleteLinkedLeads: true` opt-in flag). Revision 1 fixes both primitives at the source so the UI and MCP paths converge on non-destructive behavior. This is a deliberate UI-visible behavior change on those two flows, opted into via the updated Non-goals section.

#### Changed
- **Step 3 (`lib/domain/leads.ts` — `convertLeadToClient`)** — no longer hard-deletes the source lead. Rewritten to `UPDATE Lead SET status='CERRADO_GANADO', closedAt=now(), clientId=<new>` after creating the Client row. `activities.leadId` is NOT nulled (FK stays valid). NOTE activity now references both `clientId` and the surviving `leadId`. Applies to both UI and MCP callsites. Added an in-step sub-task to audit every lead-list/count query in `app/(dashboard)/pipeline/**`, `lib/kpi-*.ts`, dashboard widgets, and any raw `FROM "Lead"` grep hits — where unqualified, add the `status NOT IN ('CERRADO_GANADO','CERRADO_PERDIDO')` predicate. **Why:** user directive above; also fixes the historical "Lead convertido a cliente" activities losing their `leadId` FK.
- **Step 4 (`lib/domain/clients.ts` — `updateClient` PROSPECT→ACTIVE cascade)** — no longer hard-deletes linked leads. Rewritten to `UPDATE Lead SET status='CERRADO_GANADO', closedAt=now() WHERE clientId=<id> AND status NOT IN (terminal)`. Preserves `clientId` FK (leads stay linked). `activities.leadId` is NOT nulled. Dropped the `deleteLinkedLeads: true` opt-in flag entirely — no longer needed. **Why:** same user directive; consistency with Step 3.
- **Step 6 (`lib/mcp/tools.ts` — tool inventory)** — `crm.convert_lead_to_client` description rewritten to reflect the non-destructive semantics; no warning. `crm.update_client` description rewritten to reflect the non-destructive cascade; no `deleteLinkedLeads` argument, no warning. Other tool descriptions unchanged.
- **Step 9 (`crm-access.md` skill)** — Write-safety subsection rewritten. The description of `convert_lead_to_client` and `update_client` reflects the new non-destructive semantics. `crm.delete_cash_entry` is now identified as the **only** irreversible operation requiring in-chat confirmation. All other writes (including conversions and PROSPECT→ACTIVE) execute directly. Acceptance criterion updated to check for this single-op identification instead of the three-op list.
- **Step 10 (`groups/dimitris-claw/CLAUDE.md`)** — Spanish guardrail bullet rewritten. Explicitly states only `crm.delete_cash_entry` requires confirmation; explicitly notes `convert_lead_to_client` now marks CERRADO_GANADO and `update_client` PROSPECT→ACTIVE now marks linked leads CERRADO_GANADO instead of deleting.
- **§Non-goals** — added an explicit bullet acknowledging that the two conversion/cascade primitives ARE changing UI-visible behavior (from destructive to conservative). Rewrote the "byte-for-byte UI identical" bullet to carve out the two exceptions. Updated the "no MCP-side confirmation flow" bullet to identify `crm.delete_cash_entry` as the sole remaining destructive op.
- **§Acceptance vertical step (d)** — rewritten. No longer expects the source lead to be gone; instead verifies it persists with `status='CERRADO_GANADO'`, `clientId=<new>`, `closedAt` set. Removed the "agent shows the pending destructive-op description" clause (no confirmation needed post-delta). Added new sub-steps (d.1) and (d.2) as UI-side regression checks that the pipeline board no longer shows converted leads and that the PROSPECT→ACTIVE cascade also converges on CERRADO_GANADO.
- **§Risks #10** — reworded from "MCP forbids updateInvoice PAID" to explicitly say the fix is at the domain layer (parallel to the two above), and the UI-callsite grep is a **UI-side migration sub-task**, not an escape hatch. Any UI form that toggled status to PAID directly must be rewritten to call `markInvoicePaid` in the same commit as Step 4.

#### Removed
- The `deleteLinkedLeads: true` opt-in argument from `updateClient` / `crm.update_client` — no longer needed since the primitive is non-destructive by default.
- The "hard-deletes the source lead row" warning from `crm.convert_lead_to_client` tool description.
- The "PROSPECT→ACTIVE transition hard-deletes all linked leads" warning from `crm.update_client` tool description.
- The three-op destructive checklist (`convert_lead_to_client`, `delete_cash_entry`, `update_client` with `deleteLinkedLeads:true`, `update_lead` on `status: CERRADO_*`) from `crm-access.md` Write-safety and from `groups/dimitris-claw/CLAUDE.md`. Only `delete_cash_entry` remains.

#### Added
- **Step 3 sub-task:** "Audit lead-list queries for the newly-persisting converted rows." Concrete file targets listed: `app/(dashboard)/pipeline/**`, `lib/kpi-*.ts`, `lib/kpi-goals.ts`, `lib/kpi-progress.ts`, `lib/kpi-topbar-store.ts`, `lib/kpi-windows.ts`, `app/(dashboard)/dashboard-greeting.tsx`, `app/(dashboard)/urgent-items.tsx`, `app/(dashboard)/page.tsx`, `app/(dashboard)/clients/[id]/**`, and `grep -rn "FROM \"Lead\"\|from(leads)\|leads\\." lib/ app/`. Bundled into Step 3's diff.
- **§Acceptance (d.1) and (d.2)** — UI-regression sub-steps validating that the pipeline board correctly filters out CERRADO_GANADO leads post-conversion, and that PROSPECT→ACTIVE cascades to CERRADO_GANADO instead of deleting.
- **§Risks #13:** inflated lead counts from persisting converted leads. Mitigation = the Step 3 audit sub-task; acceptance (d.1) catches the pipeline board specifically.
- **§Risks #14:** editing a converted lead (CERRADO_GANADO with `clientId` set) via the UI is now possible and potentially confusing. Flagged as a UI-side follow-up; not blocking this SPEC.

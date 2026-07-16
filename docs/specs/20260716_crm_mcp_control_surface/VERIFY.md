# VERIFY — CRM MCP control surface (local pass)

## Target
local (Raspberry Pi arm64 dev host; prod deploy to `h-dmi-a` intentionally deferred to a separate user-gated step)

## Results

### CRM (`~/prj/crm-dimitris`)

- **PASS — Typecheck.** `npx tsc --noEmit --project tsconfig.json` produced 36 output lines total; after filtering `^services/whatsapp/` the residual is 2 lines, both `Try 'npm i --save-dev @types/express' …` continuation lines of the pre-existing express-import errors (no new error lines). Effective in-scope error count: **0**. Whitelisted pre-existing (`services/whatsapp/**` — @types/express, pino, baileys, ws): 34 error lines, matching CHANGES.md §"Local build/typecheck results".

- **PASS — SPEC Step 3 grep.** `grep -nE 'db\.(insert|update|delete)\(leads\)' 'app/(dashboard)/pipeline/actions.ts'` → 0 hits.

- **PASS — SPEC Step 4 grep.** For every file `{clients,clients/[id],projects,projects/[id],billing,treasury}/actions.ts` × tables `{leads,clients,projects,invoices,cashEntries,activities}` → 0 hits each. Every target-table write is now in `lib/domain/*`.

- **PASS — SPEC Step 6 grep.** `grep -rn "from '@/app/(dashboard)" lib/mcp/` → 0 hits. MCP handlers only touch domain layer.

- **PASS — Rev 2 #1 requireAdminActor / markAsPaid.** `app/(dashboard)/billing/actions.ts:17` defines the helper; called at lines 45, 70, 125 (surrounding `markAsPaid`). Auth boundary restored.

- **PASS — Rev 2 #2 middleware exact match.** `middleware.ts:17` uses `req.nextUrl.pathname === "/api/mcp"` (not `startsWith`). Comment above (lines 9–15) explicitly names the reason.

- **PASS — Rev 2 #3 invoice-id in PAYMENT body.** `lib/domain/billing.ts:200` inserts `Cobro registrado factura #${invoice.id}: …`; `lib/domain/billing.ts:227` deletes via `%Cobro registrado factura #${invoice.id}:%`. No more cross-invoice collisions.

- **PASS — Rev 2 #4 not-found handling in callTool.** `lib/mcp/tools.ts:548` returns `{ error: 'Not found or no rows affected for tool ${name}' }` envelope.

- **PARTIAL — Rev 2 #5.** `grep -n "|| echo" docker-entrypoint.sh` → **1 hit** on line 5, but that's the pre-existing `drizzle-kit push --force || echo "…continuing"` line, unchanged by this feature. The **seed-ensure** line (12: `timeout 30 npx tsx scripts/ensure-agent-user.ts`) has NO `|| echo` — the specific fix targeted by finding #5 landed correctly. `grep -nE 'catch.*\(\) *=> *\{\}' app/api/mcp/route.ts` → 0 hits (seed-ensure catch swallowing was removed). Classification: **not a regression** — the drizzle-push `|| echo` predates this SPEC and the finding was scoped to the seed path. The literal grep in the prompt is over-broad relative to the finding's actual scope.

- **PASS — Rev 2 #6 sender-header sanitize.** `app/api/mcp/route.ts:95-100`: reads raw header, trims, collapses empty → `undefined`, then `.replace(/[^\x20-\x7E]/g, "?").slice(0, 200)`.

- **PASS — Rev 2 #7 activity backfill.** `lib/domain/leads.ts:289` inside a `db.transaction`: `.update(activities).set({ clientId }).where(and(eq(activities.leadId, leadId), isNull(activities.clientId)))`.

- **PASS — Rev 2 #9 tx-wrapped client cascade.** `lib/domain/clients.ts:125` (`updateClient`) and `:198` (`deleteClient`) wrap SELECT + UPDATE + UPDATE + recordActivity in `db.transaction`.

- **PASS — Rev 2 #11 `!updated` guard.** `lib/domain/leads.ts:207`: `if (!updated) throw new Error("Lead no encontrado")` before `recordActivity`.

- **PASS — Rev 2 #12 markInvoicePaid uses recordActivity.** `lib/domain/billing.ts:196` calls `await recordActivity(actor, …, tx)` inside the paid-transition transaction (single source of truth for the sender prefix). Also imports the helper at line 15.

- **PASS — Rev 2 #13 isAgentActor across domain.** Present in every domain module: `activities.ts:38` (definition), `billing.ts:15,103,151`, `clients.ts:22,84,119`, `leads.ts:24,177,229`, `projects.ts:21,93,123`, `treasury.ts:17,96,148`.

- **PASS — Rev 2 #15 Invalid Request (-32600).** `app/api/mcp/route.ts:115`: `return jsonRpcError(id, -32600, "Invalid Request")` after validating `body?.jsonrpc === "2.0"` and `typeof body?.method === "string"`.

- **PASS — Docker compose build.** `docker compose build` succeeded on this arm64 Pi (~4 min); both `crm-dimitris-whatsapp` and `crm-dimitris-app` images produced (`sha256:80bf07671b09…`). The Pi's Docker toolchain handled the multi-stage node/next build.

- **SKIP — Docker compose up + MCP smoke.** `.env` is absent on this dev host (only `.env.deploy`, `.env.example`, `.env.production.example` exist; `docker-compose.yml` declares `env_file: .env` for all three services). Booting the stack would crash on missing `DATABASE_URL`/`NEXTAUTH_SECRET`/etc., and provisioning a real dev env is outside the verifier's mandate. Additionally, per the prompt, even with a local `.env` there's no `MCP_BEARER_TOKEN` and modifying `.env` is disallowed. **Feature only smokeable in prod** — verify with the health probe in `DEPLOY.md` after the user-gated prod deploy.

### Nanoclaw (`~/prj/nanoclaw`)

- **PASS — Build.** `npm run build` (tsc) → zero errors, zero warnings.

- **INFO — Service state (read-only).** `systemctl --user status nanoclaw` reports `active (running)` since 2026-07-14 19:53:22 UTC (>2 days uptime, PID 1250195). Currently running the **pre-fix build** — not restarted per the prompt. Restart-then-smoke is deferred to prod verify.

- **PASS — Fix #16 settings.json env merge.** `data/sessions/dimitris-claw/agent-runner-src/index.ts:585-603`: reads `/home/node/.claude/settings.json`, parses the `env` block, merges keys not already in `sdkEnv`. Fallback log line "No settings.json … skipping env merge" at :603. The stdin-secrets-take-precedence ordering matches CHANGES.md Rev 2 description.

- **PASS — Fix #17 header sanitize.** `data/sessions/dimitris-claw/agent-runner-src/index.ts:460`: `.replace(/[^\x20-\x7E]/g, '?')` on the raw sender label. Surrounding comment at :443 documents intent ("sanitize for HTTP header safety").

- **PASS — Fix #19 settings.json mode.** `stat -c '%a'` on `data/sessions/dimitris-claw/.claude/settings.json` → **`600`**. Bearer token is no longer world-readable.

- **PASS — Fix #20 sender_name null guard.** `src/index.ts:223`: `name: triggerMessage.sender_name ?? 'unknown'`. Guards the SQLite-nullable column.

- **PASS — Fix #21 scheduler label.** `data/sessions/dimitris-claw/agent-runner-src/index.ts:456-457`: ternary `isScheduledTask ? 'scheduler' : 'unknown'` in the label-computation path; also gated at :620 for downstream branching. `ContainerInput.isScheduledTask?: boolean` declared at :28.

- **PASS — Fix #22 McpServerConfig import.** `data/sessions/dimitris-claw/agent-runner-src/index.ts:19`: `import { query, HookCallback, PreCompactHookInput, McpServerConfig } from '@anthropic-ai/claude-agent-sdk';`. `mcpServers` typed as `Record<string, McpServerConfig>` at :463. `grep -c 'as never' …/agent-runner-src/index.ts` → **0**. Cast removed.

- **PASS — Bearer token consistency.** `data/sessions/dimitris-claw/.claude/settings.json`: `DIMITRIS_CRM_MCP_TOKEN` present, 64-hex, redacted; `DIMITRIS_CRM_MCP_URL` = `https://gaston.dimitris.app/api/mcp` (matches SPEC Step 8 exactly).

## Summary

- **PASS: 22, FAIL: 0, SKIP: 1, INFO: 1, PARTIAL: 1**
  - PARTIAL is Rev 2 #5 — the literal grep matched one line, but the surviving `|| echo` is on the drizzle-kit-push line (predates this SPEC), not the seed-ensure path targeted by finding #5. The finding's actual scope is satisfied. Not a regression.
  - SKIP is the local MCP HTTP smoke: no `.env` on the Pi + prompt disallows editing it → feature only verifiable against prod.
  - INFO is nanoclaw service state (read-only observation, no restart per prompt).

- **Failure classification:** none. No implementation bugs, no architectural issues, no environment blockers beyond the acknowledged Pi/local-env gap.

- **Recommendation: ready-for-prod.** All acceptance greps land, CRM typecheck is clean, nanoclaw builds clean, docker compose can even build on the arm64 Pi. The two paths that could not be locally exercised (`POST /api/mcp` smoke, message-loop end-to-end) are explicitly gated on prod deploy per SPEC §Step 12 and CHANGES.md §"Bearer token" — the user-gated prod deploy is the correct next step.

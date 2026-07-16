# CONTEXT — CRM MCP control surface

Research phase for exposing the Dimitris CRM at `~/prj/crm-dimitris` (prod: `h-dmi-a:/srv/crm-dimitris`, public URL `https://gaston.dimitris.app`) as an MCP tool surface consumable by the nanoclaw WhatsApp agent.

All paths in this doc are relative to `/home/sborit/prj/crm-dimitris/` unless stated.

---

## 1. Stack & structure

- **Next.js 16.2.1**, **App Router** (`app/` with `(dashboard)` and `(auth)` route groups). `package.json:31`. React 19.2.4.
- **TypeScript 5** throughout; `tsconfig.json` uses `@/*` path alias.
- **AGENTS.md** carries a big warning: "This is NOT the Next.js you know" — Next 16 broke naming conventions vs prior versions. Anything new (e.g. middleware / proxy) must consult `node_modules/next/dist/docs/`. Confidence: certain.
- **ORM: Drizzle** (`drizzle-orm ^0.45.1`, `drizzle-kit ^0.31.10`), Postgres driver `pg` 8.20. Not Prisma — there is a legacy-named `lib/prisma-types.ts` file that just re-exports Drizzle enum types.
- **DB client**: `lib/db.ts` — a single Drizzle client on `process.env.DATABASE_URL`, singleton via globalThis. Schema imported from `lib/schema.ts` (643 lines, all tables + relations).
- **Migration flow**: `drizzle-kit`. `docker-entrypoint.sh` runs `npx drizzle-kit push --force` at container start, so schema is pushed from `lib/schema.ts` — SQL files in `drizzle/` (0000–0012) exist but appear to be for reference/generate; the live path is `db:push`. There is no runtime migrations directory being applied. Confidence: certain.
- **API code organization** — three layers, only one carries business logic:
  1. **Server Actions** (`"use server"`) in `app/(dashboard)/**/actions.ts` — this is where *all* CRUD lives. Called directly from React client components. 14 actions files, ~1880 lines total. Every mutation the user cares about (create lead, update client, create invoice, mark paid, cash entry create/update/delete) is a server action.
  2. **Route handlers** in `app/api/**/route.ts` — small surface: `api/auth/[...nextauth]` (NextAuth), `api/ai/{chat,messages,usage}`, `api/uploads/[id]`, `api/whatsapp/{status,send,chats,disconnect,reset}`. Only `api/whatsapp/send/route.ts` is a mutation-shaped endpoint and it delegates to a sidecar (`waFetch` → `http://whatsapp:3001`).
  3. No tRPC, no REST convention, no controller layer.
- **No shared service layer.** Business logic (validation, auth check, DB writes, activity logging, `revalidatePath`) is inlined in each server action. The same lead-status transition is written directly against `db.update(leads)…` inside `updateLeadStatus` (`app/(dashboard)/pipeline/actions.ts:44-74`). No `services/` module wraps this — the top-level `services/` dir only contains the WhatsApp sidecar and nginx config. Confidence: certain.

Implication for MCP planning: there is **no reusable domain layer to call from an MCP tool**. Any MCP implementation has three options — call the server actions directly (they check `auth()`), duplicate the logic into a fresh service layer, or extract shared helpers from actions first. See §7.

---

## 2. Data model

Schema: `lib/schema.ts` — all pgTables, enums, relations. Every table uses cuid2 ids (`text primary key`, `$defaultFn(() => createId())`), `createdAt`/`updatedAt` are `timestamp(precision: 3)` with `$onUpdateFn`.

### Enums (`lib/schema.ts:16-38`)

| Enum | Values |
|---|---|
| `UserRole` | `ADMIN`, `MEMBER`, `SALES_MANAGER`, `SALES` |
| `ClientStatus` | `ACTIVE`, `INACTIVE`, `PROSPECT` |
| `ProjectStatus` | `IDEA`, `ANALYSIS`, `DEVELOPMENT`, `TESTING`, `DONE`, `PAUSED` |
| `Priority` | `HIGH`, `MEDIUM`, `LOW` |
| `LeadStatus` | `NUEVO`, `CONTACTADO`, `PROPUESTA`, `NEGOCIACION`, `CERRADO_GANADO`, `CERRADO_PERDIDO` |
| `InvoiceStatus` | `PENDING`, `PAID`, `OVERDUE` |
| `ActivityType` | `NOTE`, `CALL`, `MEETING`, `PAYMENT`, `EMAIL`, `TASK_DONE`, `MESSAGE` |
| `CashEntryType` | `INGRESO`, `EGRESO` |
| `QualificationStatus` | `QUALIFIED`, `NOT_QUALIFIED` |
| `PropuestaOutcome` | `CLOSED`, `NEEDS_TIME`, `NEEDS_DECISION_MAKER`, `LOST` |

### Lead — `lib/schema.ts:86-140` (table `Lead`)

- Key fields: `id`, `contactName NOT NULL`, `channel`, `interest`, `status LeadStatus DEFAULT 'NUEVO'`, `clientId → Client.id` (nullable), `responsibleId → User.id`, `followUpDate`, `closedAt`, `closedReason`, `amount`, `currency DEFAULT 'USD'`, `labels text[] NOT NULL DEFAULT '{}'`.
- Discovery fields (populated by "Discovery" flow): `companyDescription`, `employeeCount`, `branchCount`, `decisionMakerName`, `hasDeadline`, `deadlineNote`, `currentProcess`, `painPoint`, `desiredSolution`, `diagnosisSummary`, `priceConfirmed`, `qualificationStatus`, `discoveryDate`, `agreesCustomSoftware`, `whyScheduled`, `generalNotes`, `secondMeetingDate`.
- Propuesta fields: `whatsappNotes`, `prototypeShown`, `demoUrl`, `testCredentials`, `proposalScope`, `proposalExclusions`, `proposalTimeline`, `proposalAmount`, `paymentTerms`, `objectionNotes`, `nextStep`, `propuestaOutcome`, `propuestaDate`.
- AI fields: `aiRating`, `aiRatingDate`, `aiRatingSummary`.
- Index: `Lead_status_idx` on `status`.
- Lifecycle rule (from code, not DB): when `status` moves to `CERRADO_GANADO` or `CERRADO_PERDIDO`, `updateLeadStatus` sets `closedAt = now()` (`pipeline/actions.ts:60-63`). Not enforced at DB level.

### Client — `lib/schema.ts:56-69` (table `Client`)

- Fields: `id`, `name NOT NULL`, `email`, `phone`, `company`, `status ClientStatus DEFAULT 'PROSPECT'`, `notes`, `hourlyRate double precision`, timestamps.
- Index: `Client_status_idx` on `status`.
- No unique constraint on `email` or `phone` — duplicates possible. Confidence: certain.

### Project — `lib/schema.ts:71-84` (table `Project`)

- Fields: `id`, `name NOT NULL`, `status ProjectStatus DEFAULT 'IDEA'`, `priority Priority DEFAULT 'MEDIUM'`, `repo`, `domain`, `startDate`, `endDate`, `clientId → Client.id NOT NULL`, `responsibleId → User.id` nullable.
- No unique indexes. FK to Client is required.

### Invoice — `lib/schema.ts:174-189` (table `Invoice`)

- Fields: `id`, `amount NOT NULL`, `currency DEFAULT 'USD' NOT NULL`, `status InvoiceStatus DEFAULT 'PENDING' NOT NULL`, `projectId → Project.id NOT NULL`, `clientId → Client.id NOT NULL`, `maintenanceContractId → MaintenanceContract.id` nullable (`onDelete: set null`), `dueDate`, `paidDate`, `notes`.
- Index: `Invoice_status_idx`.
- Related `InvoiceContribution` table (`schema.ts:424-435`) for founder-compensation attribution; not required for basic invoice CRUD but may exist for existing rows — deletion cascades from `Invoice`.
- Lifecycle rule (from code): `markAsPaid` sets `status='PAID'`, `paidDate=now()`, AND creates a paired `CashEntry` of type `INGRESO` with `invoiceId` set, AND inserts an `Activity` of type `PAYMENT`. All in a single `db.transaction`. `app/(dashboard)/billing/actions.ts:130-170`.
- `updateInvoice` when `status → PAID` also sets `paidDate` but does NOT auto-create the CashEntry — that only happens through `markAsPaid`. When `status` leaves PAID, `paidDate` is nulled. `billing/actions.ts:107-114`. This is an inconsistency worth flagging — a naive "set status=PAID" via updateInvoice would leave no cash entry.

### CashEntry — `lib/schema.ts:203-220` (table `CashEntry`)

- Fields: `id`, `type CashEntryType NOT NULL`, `amount NOT NULL`, `currency DEFAULT 'USD' NOT NULL`, `concept NOT NULL`, `clientId → Client.id` nullable, `projectId → Project.id` nullable, `invoiceId text` (NO FK, but has unique constraint), `recurringExpenseId → RecurringExpense.id` (`onDelete: set null`), `date DEFAULT now() NOT NULL`, `createdById → User.id NOT NULL`.
- Constraints: `CashEntry_invoiceId_key` unique (one cash entry per invoice — enforced at DB), `CashEntry_recurringExpenseId_date_key` unique on `(recurringExpenseId, date)`, index on `(type, date)`.
- **Watch out:** `invoiceId` is `text` without a FK reference (`schema.ts:211`) — orphan risk if the app deletes an invoice by anything other than the transactional path in `deleteInvoice` (`billing/actions.ts:53-66`).

### Activity — `lib/schema.ts:191-201` (table `Activity`)

- Fields: `id`, `type ActivityType NOT NULL`, `body NOT NULL`, `clientId → Client.id` nullable, `projectId → Project.id` nullable, `leadId → Lead.id` nullable, `saleProspectId → SaleProspect.id` nullable, `createdById → User.id NOT NULL`, `createdAt`.
- No `updatedAt` — activities are append-only in current design.
- **All server actions currently write Activity rows manually as side effects** (never via a trigger, never automatically). E.g. `updateLeadStatus` writes `"Lead movido a <label>"`, `createLead` writes `"Lead creado: <name>"`, `markAsPaid` writes `"Cobro registrado: $... - <project>"`. There is NO shared "audit" helper — each caller inserts.

### Lead → Client conversion

Existing primitive: **`convertToClient(leadId)`** in `app/(dashboard)/pipeline/actions.ts:188-223`. Behavior:
1. Loads lead; errors if `lead.clientId` is already set ("El lead ya esta vinculado a un cliente").
2. Inserts a new `Client` with `name = lead.contactName`, `status = 'ACTIVE'` (NO email/phone/company copied — those fields don't exist on Lead).
3. Nulls `activities.leadId` for the lead's activities (preserves history under `clientId`).
4. **Deletes the lead row.** Not "linked"—the lead is gone.
5. Inserts a `NOTE` activity: `"Lead convertido a cliente: <contactName>"` under the new client.
6. Returns `client.id`.

There is a sibling **`linkLeadToClient(leadId, clientId | null)`** (`pipeline/actions.ts:177-186`) — pure FK update, no lifecycle logic. Used for attaching a lead to an existing client without conversion.

There is also a client-status-driven cleanup in `updateClient` (`clients/[id]/actions.ts:34-48`): when a client goes `PROSPECT → ACTIVE`, all leads with `clientId = <that client>` are hard-deleted (activities' `leadId` nulled first). This is a hidden side effect — an MCP `updateClient` call must be aware.

### Invoice.markPaid

Existing primitive: **`markAsPaid(invoiceId)`** in `app/(dashboard)/billing/actions.ts:130-170`. See §2 Invoice lifecycle above. Callable directly.

### DB-level constraints summary

- `User.email` unique.
- `WhatsAppSession.key` unique. `WhatsAppChat.chatId` unique. `WhatsAppMessage.messageId` unique.
- `TaskAssignee (taskId, userId)` unique.
- `CashEntry.invoiceId` unique. `CashEntry (recurringExpenseId, date)` unique.
- `Attachment.cashEntryId` unique (one attachment per cash entry).
- `InvoiceContribution (invoiceId, userId)` unique.
- `MonthlyNonBillableContribution (yearMonth, userId)` unique.
- Almost no CHECK constraints — validation is all in app code (e.g. `amount <= 0` rejected in server action, not DB).

---

## 3. Existing mutation patterns

### Representative: **create Lead** (end-to-end)

Trace:

1. UI trigger: `app/(dashboard)/pipeline/create-lead-dialog.tsx` (client component, "use client") — imports and calls `createLead` from `../actions`.
2. Server action: `app/(dashboard)/pipeline/actions.ts:76-113`:
   ```ts
   export async function createLead(data: { contactName; channel?; interest?; ... }) {
     const session = await auth()
     if (!session?.user?.id) throw new Error("No autenticado")
     if (!data.contactName?.trim()) throw new Error("El nombre de contacto es obligatorio")
     const [lead] = await db.insert(leads).values({ ... }).returning()
     await db.insert(activities).values({ type: "NOTE", body: `Lead creado: ${...}`, leadId: lead.id, createdById: session.user.id })
     revalidatePath("/pipeline"); revalidatePath("/", "layout")
   }
   ```

- **Validation**: handwritten `if`/`throw` inside the action. **No Zod, no Yup, no schema validator anywhere in the CRM** — I searched. Only ad-hoc checks (`!data.contactName?.trim()`, `data.amount <= 0`, etc.). Confidence: certain.
- **Authorization**: per-action `await auth()` from NextAuth; some actions add an extra `role !== "ADMIN"` check inline (see `updateInvoice`, `deleteInvoice`, `updateCashEntry`, `deleteCashEntry`, `checkpoint-actions.ts`, most `settings/*` actions). No middleware-level enforcement beyond "logged in" on all non-`/login` routes.
- **Activity writes**: manual by the caller. `createLead` inserts a NOTE. `updateLeadStatus` inserts a NOTE. `saveDiscovery`/`savePropuesta` insert a MEETING. `convertToClient` inserts a NOTE. `markAsPaid` inserts a PAYMENT. `updateLead`/`updateClient`/`createInvoice`/`updateInvoice`/`createCashEntry`/`updateCashEntry`/`deleteCashEntry` **do NOT** write an activity. This inconsistency is important for MCP: if we want every agent write audited, we cannot rely on the underlying primitives.
- **Side effects beyond DB**: `revalidatePath(...)` calls on 1–3 routes and often on `("/", "layout")` to refresh KPI meters. No webhook, no notification, no WhatsApp echo. Only exception is `scheduleSecondMeeting` (`pipeline/actions.ts:363-429`) which calls `createMeeting()` in `lib/google-calendar.ts` (Google Calendar API via `googleapis` + OAuth refresh token).

### Invoice creation — `createInvoice` (`billing/actions.ts:9-40`)

- Auth: session required, no role check.
- Validation: `projectId && clientId` required; `amount > 0` required.
- Inserts row with `status: "PENDING"`.
- Revalidates `/billing` and `/` layout.
- **No activity row** written on creation.
- Sibling `createProjectInvoice` in `projects/[id]/actions.ts:219-243` skips the session/auth check entirely (relies purely on middleware). Also no activity row.

### Invoice mark-paid — `markAsPaid` (`billing/actions.ts:130-170`)

- Auth: session required (no explicit ADMIN check — anyone logged in can mark).
- Loads invoice with `project` + `client`. Rejects if already `PAID`.
- Transaction: sets status/paidDate → inserts paired `CashEntry INGRESO` (with `invoiceId` unique link) → inserts `Activity PAYMENT`.
- Revalidates `/billing` and `/` layout.

### CashEntry — `createCashEntry`/`updateCashEntry`/`deleteCashEntry` (`treasury/actions.ts`)

- **`createCashEntry`** (`:13-44`): session required. Validation: `type`, `amount > 0`, `concept.trim()` required. Inserts row. **No activity row.** Returns `{id}`.
- **`updateCashEntry`** (`:46-101`): session + **role === "ADMIN"** required. Handwritten validation. Wrapped in transaction because if the cash entry is linked to an invoice (`invoiceId` non-null), the invoice's `paidDate` is synced to the new cash-entry date. **No activity row.**
- **`deleteCashEntry`** (`:103-124`): session + **role === "ADMIN"** required. Deletes any attached `Attachment` (unlinks file on disk from `UPLOADS_DIR`). Deletes the cash entry. **No activity row.**
- **Gotcha:** delete is NOT transactional — attachment unlink + delete cash entry are two separate `db.` calls with a filesystem `unlink()` between them. Non-atomic if the fs unlink fails.

### Lead → Client conversion — `convertToClient` (`pipeline/actions.ts:188-223`)

Covered in §2. Auth: session required, no role check. Rejects if lead already linked. Deletes the lead. Writes NOTE activity. Revalidates `/pipeline`, `/clients`, `/` layout.

### General patterns worth extracting

- Every action starts `const session = await auth(); if (!session?.user?.id) throw ...`.
- Some add `role !== "ADMIN"` check as second line.
- `revalidatePath("/", "layout")` is used to refresh top-bar KPI meters after any mutation that could move a KPI. An MCP layer that bypasses server actions must decide whether to call `revalidatePath` (it works from any server context in Next 16) or accept that logged-in UI users will see stale counters until natural refresh.
- Dates come in as `YYYY-MM-DD` strings and are converted to `new Date(str + "T12:00:00")` (noon-local to dodge TZ edges).

---

## 4. Auth & sessions

- **NextAuth v5** (`next-auth ^5.0.0-beta.30`), Credentials provider only, JWT session strategy.
- Wired in `lib/auth.ts` (37 lines) and `lib/auth.config.ts` (40 lines). Middleware in `middleware.ts` runs NextAuth's `authorized` callback on every path except `_next/static`, `_next/image`, `favicon.ico` (see `middleware.ts:34-36`).
- Login flow: `POST /api/auth/callback/credentials` with form-encoded body (`email`, `password`, `csrfToken`, `callbackUrl`). CSRF token from `GET /api/auth/csrf`. Successful login sets a session cookie (`__Secure-authjs.session-token` prod / `authjs.session-token` local). Confirmed by `DEPLOY.md` notes.
- `authorize()` callback (`lib/auth.ts:18-34`) fetches user by email, `bcrypt.compare` password, returns `{id, name, email, role}`. Rate-limited per email via `lib/rate-limit.ts` (in-process Map).
- `middleware.ts:8-25` adds an extra per-IP rate limit (10/15min + 5/60s burst) on the login POST that returns HTTP 429 — see `docs/specs/20260613_POST_PENTEST_HARDENING/SPEC.md`.
- `session()` callback copies `id` and `role` from the JWT into `session.user`. JWT `token.role` set in `jwt()` callback from the user object at signin. Session shape used everywhere: `session.user.id`, `session.user.role`.

### Binding user → request

- Server actions call `await auth()` (imported from `@/lib/auth`) which reads the session cookie. That's the only mechanism — no header-based bearer token, no API-key middleware, no service account.
- **There is no concept of API keys, service accounts, machine users, or long-lived tokens in the codebase today.** `DEPLOY.md` line 21: *"There is no bearer-token API."* Grep for `apiKey|api_key|api-key|serviceAccount` finds only `XAI_API_KEY` (env var for calling xAI, outbound), `GOOGLE_CLIENT_ID`/`GOOGLE_REFRESH_TOKEN` (env vars for outbound Google Calendar), and doc mentions. No inbound API-key handling exists.

### Auth-related tables

- `User` (`schema.ts:42-54`): `id`, `name`, `email UNIQUE`, `passwordHash`, `role UserRole DEFAULT 'MEMBER'`, `avatarInitials`, `avatarColor`, timestamps.
- **No `Session`, `Account`, `VerificationToken` tables** — JWT strategy means NextAuth doesn't persist sessions. Only `User` participates.

### Activity attribution

- `Activity.createdById` is `NOT NULL` FK to `User.id`. Every insert in server actions passes `session.user.id`. No provenance beyond that — no "created_via" column, no distinction between "typed in the UI" vs "written by agent". Confidence: certain.

Implication for MCP: an agent-driven write MUST resolve to a real `User.id` for the `createdById` FKs on `Activity`, `CashEntry`, `MaintenanceContract`, `SaleMeeting`, `TreasuryCheckpoint`, `RecurringExpense`. Either (a) create a dedicated `agent` user (email like `agent@dimitris.uy`, role `MEMBER` or `ADMIN`) whose id the MCP server uses, or (b) map per-WhatsApp-sender to an existing user. Both need a design decision.

---

## 5. Prior art / adjacent integrations

### WhatsApp integration inside the CRM

- The CRM has an **outbound** WhatsApp surface (contact writes are stored, not authored by an agent).
- Sidecar: `services/whatsapp/` — separate Node service, own Dockerfile. Runs on `whatsapp:3001` (HTTP) + `whatsapp:3002` (WebSocket). Uses `@whiskeysockets/baileys`. Configured by `docker-compose.yml` and gets `DATABASE_URL` — it writes to the shared Postgres.
- Tables populated by the sidecar: `WhatsAppSession` (Baileys auth state, key-value JSONB), `WhatsAppChat` (chat metadata, one per JID), `WhatsAppMessage` (message log). Details in `docs/specs/20260329_WHATSAPP_WEB_INTEGRATION/SPEC.md`.
- CRM → sidecar bridge: `lib/whatsapp/client.ts` exports `waFetch(path, init)` → `http://whatsapp:3001${path}`. Consumed by `app/api/whatsapp/{status,send,chats,disconnect,reset}/route.ts`.
- `app/api/whatsapp/send/route.ts:11-15` requires `role === "ADMIN"` — the closest thing to an "agent-shaped" endpoint that already exists.
- **The CRM's WhatsApp integration is independent of nanoclaw.** Nanoclaw uses its own WhatsApp session (separate Baileys). No shared state.

### External-API surface

- Public/external endpoints: only the auth endpoints (`/api/auth/*`) plus static/session-gated routes.
- All `/api/*` non-auth routes are session-gated by `middleware.ts` — no bypass, no exception list, no webhook receiver. Confidence: certain.
- Outbound integrations: Google Calendar (`lib/google-calendar.ts`, refresh-token OAuth), xAI (Grok, `lib/xai.ts`, `XAI_API_KEY`). Nothing else.

### Specs relevant to this feature

Under `docs/specs/`:

- `20260329_WHATSAPP_WEB_INTEGRATION/SPEC.md` — establishes the WA sidecar pattern.
- `20260517_whatsapp_standalone_service/SPEC.md` — extracts WA into its own compose service.
- `20260613_POST_PENTEST_HARDENING/SPEC.md` — the hardening SPEC that produced `DEPLOY.md`, the per-IP rate limiter, and `BIND_ADDR`. Explicit statement (line 13): *"NextAuth v5 credentials provider. Login is `POST /api/auth/callback/credentials` (form-encoded, sets session cookie). No JSON token endpoint."* Any MCP proposal that introduces a token endpoint is a policy departure and should be called out.
- `docs/specs/INDEX.md` exists — did not read; no matching entry keyword for "MCP", "agent", "API", "control surface" in the directory names. Confidence: likely.

**No existing spec covers an external control surface, public API, or agent-callable interface.** MCP would be net-new architecture. Confidence: certain.

### CI/CD, tests

- **No test framework, no test files, no test scripts.** `package.json` has scripts `dev`, `build`, `start`, `lint`, `db:*` only. Grep for `vitest|jest|__tests__|.test.` finds nothing under `app/`, `lib/`, `services/whatsapp/`. Confidence: certain.
- No CI pipeline files in repo (no `.github/workflows/`, no `.gitlab-ci.yml`, no `bitbucket-pipelines.yml`; not verified exhaustively but not present at repo root).
- Deployment is manual `git pull && docker compose up -d --build` on the prod host (see §6).

---

## 6. Deploy story

### DEPLOY.md summary

`DEPLOY.md` (46 lines) — ASDLC-format frontmatter documenting two environments:

```yaml
environments:
  local:
    deploy_cmd: "docker compose up -d --build"
    base_url:   "http://localhost:26901"
    health_path: "/"
    health_expect_status: [200, 307]
  prod:
    ssh_alias:  "h-dimitris-a"      # NOTE: stale alias, see below
    path:       "/srv/crm-dimitris"
    branch:     "main"
    deploy_cmd: "git pull && docker compose up -d --build"
    base_url:   "https://gaston.dimitris.uy"   # NOTE: real is .app, see below
    health_path: "/"
    health_expect_status: [200, 307]
```

Notes section documents: NextAuth login flow, no `/health` endpoint (use `/` or `/api/auth/csrf`), CREDS TBD, rate limiter caveats for verification, `BIND_ADDR` guidance.

- **Prod deployment**: manual — SSH to prod host, `cd /srv/crm-dimitris && git pull && docker compose up -d --build`. Branch tracked: `main`. Confirmed on `h-dmi-a`: `git branch` shows current branch `main`, last commit `d720181 fix(desarrollo): make user column tint theme-adaptive`.
- No CI. No auto-deploy on push. No blue/green. `docker compose up -d --build` rebuilds the app container in place; brief outage during rebuild.
- Container startup runs `drizzle-kit push --force` (see `docker-entrypoint.sh`), so schema is applied at boot from `lib/schema.ts`.

### Prod host `h-dmi-a` (178.156.255.84)

- Confirmed via SSH.
- Ports exposed publicly (`ss -ltn`): `:80`, `:443` (system nginx), `:8081` (unknown, IPv4+IPv6), `:8025` (mailhog?). Everything else on `127.0.0.1`. Confidence: certain.
- CRM compose stack binds proxy on `127.0.0.1:26901` (confirmed: `LISTEN 127.0.0.1:26901`). Not directly reachable from public internet.
- System nginx at `/etc/nginx/sites-enabled/gaston.dimitris.app.conf` terminates TLS for **`gaston.dimitris.app`** (LetsEncrypt certs at `/etc/letsencrypt/live/gaston.dimitris.app/`), proxies to `127.0.0.1:26901`. Adds security headers (CSP, HSTS, etc.), rate-limits with `limit_req zone=general`. **The base_url in DEPLOY.md says `gaston.dimitris.uy` but the live domain is `gaston.dimitris.app`.** Also `ssh_alias` in DEPLOY.md is `h-dimitris-a` but user's actual SSH config alias is `h-dmi-a` — this drift is worth flagging to the planner.
- WhatsApp WS also proxied at `/ws` (see `services/nginx-proxy.conf`) → `whatsapp:3002`.

### Env vars / secrets management

- `.env` file at `/srv/crm-dimitris/.env` on prod host (git-ignored). Read by `docker compose` (implicit `env_file` on services via `docker-compose.yml`).
- Contains: `DATABASE_URL`, `POSTGRES_PASSWORD`, `NEXTAUTH_URL`, `NEXTAUTH_SECRET` (implicit — required by NextAuth), `APP_PORT`, `BIND_ADDR`, `GOOGLE_CLIENT_ID`, `GOOGLE_REFRESH_TOKEN`, `UPLOADS_DIR`, `WHATSAPP_ENABLED`, `XAI_MODEL`, plus presumably `GOOGLE_CLIENT_SECRET`, `XAI_API_KEY` (filtered from what I read).
- No secret manager, no Vault, no doppler. Plain file on disk, root-owned presumably.
- Local dev likely uses `.env.deploy` per `20260613_POST_PENTEST_HARDENING/SPEC.md`.

### How to add a new HTTP-exposed surface

Three feasible shapes for an MCP endpoint reachable by nanoclaw over the internet or LAN:

1. **New route in the existing Next app** (`app/api/mcp/[transport]/route.ts` or similar) — inherits TLS from system nginx, must add auth-bypass (currently middleware blocks anything non-`/login` if not logged in). The `middleware.ts:22` `authorized` callback returns `false` for any non-auth-pages when not logged in → results in redirect to `/login`. An MCP endpoint would need to either (a) be explicitly whitelisted in `authorized()` and enforce its own token check, or (b) live under `/api/auth/...` prefix (fragile), or (c) middleware is modified.
2. **New service in `docker-compose.yml`**, sharing `internal` network, reads Postgres directly. Add nginx `location /mcp { proxy_pass … }` in `services/nginx-proxy.conf` and/or on the system nginx vhost.
3. **Out-of-tree service** on the same host, another vhost like `mcp.dimitris.app`, connecting to CRM's Postgres over the `internal` docker network (would need docker network exposure, or use published `5432`). Least intrusive to the CRM repo but duplicates DB-connection logic.

The user's stated constraint ("over the network, not via SQL") rules out shape 3 if "SQL" means talking to Postgres directly. Shapes 1 and 2 both call Next.js server code. Shape 1 reuses the app's DB client and server actions in-process (simplest). Shape 2 needs to duplicate or import them.

---

## 7. Open questions for planning

Design decisions the planner must resolve before implementation:

1. **Where does the MCP server live?**
   - (a) In-process Next.js route handler at `app/api/mcp/**` — reuses `lib/db`, `lib/auth`, and existing server actions; hot path but couples MCP surface to CRM deploy cycle.
   - (b) Separate service in the same `docker-compose.yml` — clean boundary, needs its own DB or gRPC/HTTP calls back to CRM; duplication risk if it goes to DB directly.
   - (c) Standalone service outside the CRM repo — most isolated but has to replicate schema + auth understanding.

2. **What is the transport for MCP?**
   MCP over stdio (nanoclaw agent spawns a child process) vs MCP over HTTP/SSE (nanoclaw calls a remote server). Nanoclaw agents run in Linux containers on Salvador's home metal; CRM lives on hetzner (`h-dmi-a`). Latency + firewall considerations favor HTTP-transport MCP over the public `https://gaston.dimitris.app`. If HTTP: need auth header design (see next question).

3. **How does the agent authenticate?**
   - Currently there is **no bearer-token, API-key, or service-account concept** in the CRM (`DEPLOY.md` line 21, confirmed by grep).
   - Options: (i) NextAuth "impersonate" flow using a stored long-lived cookie for a dedicated agent user (fragile, cookies expire); (ii) new `User.apiToken` column + a header check in middleware; (iii) separate `ApiKey` table with per-key scoping and audit; (iv) OAuth device flow (heaviest); (v) mTLS if the MCP server is on the same host.
   - Related: **do multiple WhatsApp senders need distinct identities?** If yes, one shared key is wrong. Salvador is likely the only human; but audit trail cleanliness may want a dedicated `agent-<wa-jid>` user per sender.

4. **Do we reuse existing server actions or build a parallel mutation layer?**
   - Reuse: `import { createLead } from "@/app/(dashboard)/pipeline/actions"` from the MCP route works only if the action is called within an authenticated session context — because `await auth()` reads cookies. We'd need to either mock a session (call `auth()` differently) or refactor actions to accept an explicit `userId` parameter.
   - Parallel layer: extract "core" logic from every action into `lib/domain/{leads,clients,invoices,cash,...}.ts` that takes `userId` explicitly, has no `revalidatePath`, no `redirect`. Both the actions and the MCP tools would call the core. Substantial refactor of 14 actions files (~1880 lines), but this is the "right" answer — see §3 on the missing service layer.
   - Hybrid: MCP writes go through raw `db` + duplicated validation for the first cut; migrate actions to a shared layer later. Faster but forks the mutation logic.

5. **How do we solve the "every mutation should write an Activity" question for audit?**
   Existing UI actions only write Activity for a subset of mutations (see §3). If the MCP surface is a compliance/audit surface, the planner must decide: (a) MCP tools *always* write an Activity row with `body: "[via WhatsApp agent] ..."`; (b) new dedicated `AuditLog` table with `source`, `actorUserId`, `via` (UI/MCP/CRON), `payload`, `entity`, `entityId`; (c) accept the current gap.

6. **How is the `markAsPaid` semantic exposed?**
   The MCP tool for "mark invoice paid" should almost certainly call the existing `markAsPaid` primitive (which creates the paired CashEntry + Activity in a transaction) — NOT expose the raw `updateInvoice({status:"PAID"})` path which does NOT create a CashEntry (`billing/actions.ts:107-114`, see §2 warning).

7. **`convertToClient` currently deletes the lead. Is that acceptable via the MCP?**
   The UI primitive hard-deletes the source lead after conversion (`pipeline/actions.ts:208`). Confirming the agent flow should have the same semantics vs "keep lead as historical record".

8. **Middleware bypass for MCP.**
   Whatever shape is chosen, `middleware.ts:22` currently blocks any non-`/login` request when not authenticated. Design must explicitly amend the middleware's `authorized` callback to whitelist the MCP route(s) while ensuring the MCP handler enforces its own auth. Getting this wrong = open door on prod.

9. **Deploy story change.**
   Adding an MCP surface likely means: new env vars (agent token or secret), possible new compose service, possible new nginx location. Prod is manual `git pull && docker compose up -d --build` — the change lands on next manual deploy. No CI to catch regressions. Planner should note whether the first deploy needs a maintenance window (schema changes for `ApiKey` table would go through `drizzle-kit push --force` at container boot).

10. **DEPLOY.md drift.** `ssh_alias: h-dimitris-a` doesn't resolve; correct alias is `h-dmi-a` (per `~/.ssh/config`). `base_url: https://gaston.dimitris.uy` is stale — live domain is `https://gaston.dimitris.app` (confirmed nginx + certs). Not blocking, but flag for a quick doc fix as part of this feature or split.

11. **Idempotency for agent calls.**
   WhatsApp messages can arrive with retries; the MCP surface should probably support an idempotency key for "create" tools so a resent "create lead Juan" doesn't duplicate. No existing pattern in the CRM to build on — new design.

12. **Rate limiting for agent surface.**
   The CRM's rate limiter (`lib/rate-limit.ts`, `lib/rate-limit-ip.ts`) targets the login endpoint. Should agent MCP calls be similarly rate-limited to survive nanoclaw runaway loops? Probably yes.

---

## Confidence summary

- **Certain**: schema shape/enums (§2), auth model (§4), existing server-action code paths (§3), test/CI absence (§5), prod deploy mechanics and nginx/TLS (§6), no MCP/API-key/bearer surface exists today (§4/§5).
- **Likely**: `docs/specs/INDEX.md` contains no MCP entry (skimmed dir listing only, didn't read INDEX contents).
- **Unknown / needs user input**: choice of auth model for agent (§7.3), whether one shared agent identity or per-WA-user (§7.3), whether to reuse or refactor server actions (§7.4), audit-trail expectations (§7.5), whether `convertToClient`'s delete-on-convert is acceptable via agent (§7.7).

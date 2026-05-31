# Conduit

> Self-hostable workflow automation. Webhook- or cron-triggered DAGs of HTTP / Condition / Delay / Notify / Loop nodes, with at-least-once execution, declarative retries, real-time monitoring, multi-tenant isolation, and a JSON-first API.

Think Zapier or n8n — but you own the runtime, you can see every step that ran, and failed steps retry with smart backoff. Built as a backend-engineering case study to demonstrate distributed systems patterns end-to-end: event-driven orchestration, durable execution, Postgres RLS-based multi-tenancy, leader election, envelope encryption, and a polished React frontend.

---

## Table of Contents

1. [Features](#features)
2. [Tech Stack](#tech-stack)
3. [Architecture](#architecture)
4. [Data Model](#data-model)
5. [API Reference](#api-reference)
6. [Quick Start](#quick-start)
7. [Manual Testing Guide](#manual-testing-guide)
8. [Project Structure](#project-structure)
9. [Design Decisions](#design-decisions)
10. [Testing & Quality Gates](#testing--quality-gates)
11. [Production Deployment Notes](#production-deployment-notes)
12. [Roadmap](#roadmap)

---

## Features

Mapped against the case-study brief:

| Brief requirement | Implemented |
|---|---|
| Workflow Definition (Draft → Publish) | ✅ `workflows.status` + immutable `workflow_versions` |
| Webhook triggers with HMAC secret | ✅ Constant-time signature compare, 5-min replay window, dedup by `x-flow-delivery-id` |
| Cron schedule triggers | ✅ `cron-parser`, leader-elected scheduler, `cron_fires` PK prevents double-fire |
| HTTP Request node | ✅ GET/POST/PUT/PATCH/DELETE + headers + body templating |
| Condition node (branching) | ✅ 11 operators (eq/neq/gt/gte/lt/lte/contains/exists/matches/…) + `next_true`/`next_false` |
| Delay node | ✅ Up to 30 days; Redis sorted set + Postgres `wake_at` recovery backstop |
| Notify node | ✅ Slack incoming webhooks + SMTP email (nodemailer) |
| Sequential node execution with branches | ✅ Dispatcher is sole owner of run state; advances DAG via `next` pointers |
| Persist run status, start/end, per-node logs | ✅ `runs` + `node_attempts` tables, input/output snapshots, retry count, duration |
| Pause / resume / cancel runs | ✅ `/v1/runs/:id/{pause,resume,cancel,retry}` |
| Workflow versioning (in-flight runs unaffected) | ✅ Runs snapshot `workflow_version_id` at fire |
| Loops + branching | ✅ `LOOP` node with `count: N`, `body: <node-id>`, dispatcher tracks `loop_state` |
| Auto-retry with backoff | ✅ Exponential backoff + jitter, per-node policy, error-class filter |
| Error notifications to the user | ✅ Tenant-level `failure-notify` config; dispatcher fires NOTIFY handler on FAILED |
| Detailed logs | ✅ Per-attempt status, error class, input/output snapshots |
| Real-time monitoring | ✅ SSE stream of run events; UI subscribes via fetch + ReadableStream |
| System health tracking | ✅ `/healthz`, `/readyz` (probes PG + Redis), Prometheus `/metrics` |
| Multi-user authentication | ✅ RS256 JWT + refresh-token families + revocation table |
| Rate limits / fair-usage | ✅ Per-tenant fixed-window Redis limiter on auth/workflows/triggers |
| Modular connectors | ✅ `register(handler)` / `getHandler(type)` plugin registry |
| Multi-tenant isolation | ✅ Postgres RLS + `app.tenant_id` session GUC + defence-in-depth tenant predicate |
| Fault tolerance + idempotency | ✅ Stable idempotency key `sha256(run_id + node_id)`; advisory-lock dedup; XAUTOCLAIM recovery |

**Bonus features beyond the brief:**

- **Google OAuth** (custom implementation alongside email/password) with state-protected callback and tokens delivered via URL fragment.
- **Shared zod schemas** between the React frontend and Express backend — same `SignInSchema` validates both client (`react-hook-form` + `@hookform/resolvers/zod`) and server.
- **Glassmorphism UI** — aurora gradient backdrop, frosted glass surfaces, animated CTAs.
- **Visual DAG builder** (React Flow) with drag-from-palette, drag-to-connect, properties panel.
- **Per-attempt inspector** on the run detail page (every retry's request/response).
- **Audit log** with paginated, filterable, expandable before/after diffs.
- **Envelope-encrypted secrets** (per-tenant DEK wrapped by a root KEK).
- **Webhook payload templating** — `{{trigger.payload.X}}` and `{{nodes.<id>.output.Y}}` interpolated into any string config field.

---

## Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 22 + TypeScript (strict, `noUncheckedIndexedAccess`) | Type safety end-to-end |
| Package manager | pnpm 10 + workspace | Fast installs, hoisted dev deps |
| API | Express 4 + zod | Battle-tested, simple, zero hidden magic |
| Database | Postgres 16 (raw `pg`, no ORM) | RLS for multi-tenancy needs raw SQL; Postgres-specific features (LISTEN/NOTIFY, advisory locks, SKIP LOCKED) |
| Cache / queue | Redis 7 (ioredis) | Streams + consumer groups, sorted sets for delays, Lua atomic ops |
| Auth | Custom RS256 JWT + refresh-token families | Asymmetric — only auth service holds private key; refresh families allow revocation |
| Frontend | React 18 + Vite + React Router 6 | Standard stack, fast dev loop |
| Forms | react-hook-form + zodResolver | Shared schemas, inline validation |
| Visual builder | @xyflow/react (React Flow) | Mature DAG editor library |
| Email | nodemailer | SMTP via any provider (Gmail / SendGrid / Resend / Mailpit) |
| Slack | Incoming webhooks via `fetch` | No bot token complexity for v1 |
| Testing | Vitest + jsdom + Testing Library + testcontainers | Unit + integration with real PG/Redis |
| CI | GitHub Actions (typecheck + lint + format + tests) | Standard, free for public repos |
| Containerization | Multi-stage Docker (alpine, USER node, tini PID 1, HEALTHCHECK) | Production-grade base image |

---

## Architecture

### Components (C4 Container view)

```
       ┌─────────┐        ┌─────────────┐
       │  Web    │        │  Webhook    │
       │  (SPA)  │        │  upstream   │
       └────┬────┘        └──────┬──────┘
            │                    │
            │  /v1/*             │ /v1/triggers/webhook/:id
            ▼                    ▼
       ┌────────────────────────────────┐
       │           API (Express)        │
       │  auth, workflows, runs,        │
       │  triggers, secrets, audit      │
       └────────────────┬───────────────┘
                        │ enqueue
                        ▼
                ┌───────────────┐         ┌──────────────────┐
                │  Dispatcher   │◀───────▶│  Scheduler       │
                │ (sole owner   │  cron   │  leader-elected  │
                │  of run state)│  fires  │  (advisory lock) │
                └───────┬───────┘         └──────────────────┘
                        │ node tasks (Redis Streams)
                        ▼
                ┌───────────────┐
                │  Worker pool  │ ──→ external HTTP / Slack / SMTP
                │  (stateless)  │
                └───────┬───────┘
                        │ NodeCompleted events
                        ▼
                  (back to Dispatcher → next node)


       ┌────────────────────────────┐
       │ Postgres 16 (source of truth)│   ┌───────────────────────┐
       │  + Row-Level Security       │   │  Redis 7 (streams,     │
       │  tenants, workflows,        │   │  consumer groups,      │
       │  runs, node_attempts,       │   │  delayed ZSET, locks)  │
       │  secrets, audit_log…        │   └───────────────────────┘
       └────────────────────────────┘
```

### Component responsibilities

| Component | Owns |
|---|---|
| **API** | HTTP surface, authn/authz, accepting webhook ingress, validating workflow definitions |
| **Dispatcher** | The only thing that decides *what runs next*. Reads completion events, schedules next node, finalises runs as SUCCEEDED/FAILED. Also fires `failure-notify`. |
| **Worker** | Stateless. Pulls one node task, executes via the registered handler, publishes a `NodeCompleted` event. Crashing mid-execution loses *that* attempt, never the run. |
| **Scheduler** | Polls cron-style triggers. Leader-elected via Redis advisory lock (only one instance fires at a time even with N replicas). |
| **Postgres** | Source of truth. Every run, every attempt, every audit entry. RLS enforces tenant isolation. |
| **Redis** | Ephemeral plumbing — Streams for work distribution, ZSET for delayed tasks, hashes for the per-tenant concurrency bulkhead, KV for refresh-family revocation cache. |

### Key flow: webhook trigger → run completion

```
1. Upstream POSTs to  /v1/triggers/webhook/:trigger_id
2. API verifies HMAC + timestamp + delivery-id (replay protection)
3. API inserts a `runs` row (status=PENDING)
4. Dispatcher picks it up, looks up the *current* workflow version,
   snapshots `workflow_version_id` on the run, schedules `start_node`
5. Worker pulls the task, executes the handler, publishes NodeCompleted
6. Dispatcher reads the completion event, advances DAG via `successors()`,
   schedules next node — or finalises run as SUCCEEDED if no more nodes
7. If status flips to FAILED, dispatcher fires tenant-level failure-notify
   (best-effort; notify failure doesn't make the run "more failed")
```

### Why this shape

- **State in DB, not in worker memory.** This is the most important decision. Workers can die mid-step; another worker picks up the next attempt. No replay needed because every completed attempt is durable.
- **Dispatcher is single-writer for run state.** Eliminates a class of races where multiple workers would have raced to finalise the same run.
- **Redis Streams + consumer group + XAUTOCLAIM.** Reliable queue without the gotchas of `BRPOPLPUSH` (no per-element TTL, racy sweeper).
- **RLS-based multi-tenancy.** Even if a query forgets `WHERE tenant_id = …`, Postgres refuses to return rows. Defence-in-depth — repo code still includes the predicate, but the DB is the last line.

---

## Data Model

10 tables, 8 migrations. Highlights:

| Table | Owns | Key columns |
|---|---|---|
| `tenants` | Tenant identity | `id`, `name`, `created_at` |
| `users` | Account + role | `id`, `tenant_id`, `email`, `hashed_password`, `role` (admin/editor/viewer), `google_id`, `last_auth_provider` |
| `refresh_families` | Refresh-token revocation | `id` (the `fam` claim), `user_id`, `tenant_id`, `revoked`, `last_used_at` |
| `workflows` | Workflow identity + draft definition | `id`, `tenant_id`, `name`, `status` (draft/published/archived), `current_version` |
| `workflow_versions` | Immutable published versions | `id`, `workflow_id`, `version_number`, `definition` (JSONB), `published_at` |
| `triggers` | Webhook + cron triggers | `id`, `workflow_id`, `type`, `cron_expr`, `webhook_secret_ciphertext`, `active`, `last_fired_at`, `next_fire_at` |
| `cron_fires` | Cron-fire dedup (PK guarantee) | `(trigger_id, scheduled_for)` |
| `runs` | One workflow execution | `id`, `tenant_id`, `workflow_id`, `workflow_version_id`, `trigger_id` (nullable on trigger delete), `status`, `error_summary`, `started_at`, `ended_at`, `loop_state` |
| `node_attempts` | One attempt at one node in one run | `(run_id, node_id, attempt)`, `status`, `input`, `output`, `error_class`, `error_message`, `started_at`, `ended_at` |
| `run_events` | Append-only event log | `id` (bigserial), `run_id`, `kind`, `payload`, `created_at` — SSE subscribers stream from here |
| `secrets` | Tenant-scoped encrypted values | `tenant_id`, `name`, `ciphertext`, `iv`, `dek_id` |
| `tenant_deks` | Per-tenant data encryption keys (wrapped by root KEK) | `tenant_id`, `wrapped_key`, `created_at` |
| `connector_configs` | Tenant-level config (currently: failure-notify) | `tenant_id`, `connector_type`, `config` (JSONB) |
| `audit_log` | Admin actions | `id`, `tenant_id`, `actor_id`, `action`, `resource_type`, `resource_id`, `before`, `after`, `ip`, `created_at` |

### Row-Level Security pattern

```sql
-- Every tenant-scoped table has a policy like:
CREATE POLICY tenant_isolation ON workflows
  USING (tenant_id = current_setting('app.tenant_id')::uuid
         OR current_setting('app.bypass', true) = 'on');

-- The app must connect as a non-superuser role (flow_app), not the owner (flow):
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO flow_app;
-- Postgres bypasses RLS for superusers and table owners by default.

-- Every tenant-scoped query goes through `withTenant`:
async function withTenant(tenantId, fn) {
  return await client.query('BEGIN')
    .then(() => client.query('SELECT set_config($1, $2, true)',
                             ['app.tenant_id', tenantId]))
    .then(() => fn(...))
    .then(() => client.query('COMMIT'));
}
```

This is the *only* sanctioned way to read tenant data from the API plane. Cross-tenant queries (scheduler, webhook ingress, login) use `withSystem(...)` which sets `app.bypass=on` — those routes filter by `tenant_id` explicitly.

---

## API Reference

All endpoints under `/v1/*`. All return RFC 7807 `application/problem+json` for errors.

### Auth

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/v1/auth/register` | none | Create tenant + admin user |
| POST | `/v1/auth/login` | none | Email/password → access + refresh tokens |
| POST | `/v1/auth/refresh` | none | Rotate access + refresh; old refresh becomes invalid |
| POST | `/v1/auth/logout` | bearer | Revoke refresh-token family |
| GET | `/v1/auth/oauth/google/start` | none | Redirect to Google consent |
| GET | `/v1/auth/oauth/google/callback` | none | Google → tokens via URL fragment to `${WEB_BASE_URL}/auth/callback` |

### Workflows

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/v1/workflows` | editor | List |
| POST | `/v1/workflows` | editor | Create (draft) |
| GET | `/v1/workflows/:id` | viewer | Fetch with definition + triggers + versions |
| PATCH | `/v1/workflows/:id` | editor | Update draft |
| POST | `/v1/workflows/:id/publish` | editor | Freeze new version |
| POST | `/v1/workflows/:id/archive` | editor | Disable all triggers |
| DELETE | `/v1/workflows/:id?force=true` | admin | Hard delete (refuses if runs exist unless `force`) |
| GET | `/v1/workflows/:id/versions` | viewer | Version history |

### Triggers

| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/v1/workflows/:id/triggers` | editor | Attach webhook or cron; returns URL + `secret_shown_once` |
| DELETE | `/v1/triggers/:id` | editor | Delete (preserves run history; `runs.trigger_id` → NULL) |
| POST | `/v1/triggers/webhook/:id` | HMAC | Webhook ingress (NO bearer; signed with `x-flow-signature`) |

### Runs

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/v1/runs` | viewer | List (filterable by workflow, status, date) |
| GET | `/v1/runs/:id` | viewer | Full run detail with nodes |
| GET | `/v1/runs/:id/events` | viewer | Paginated events OR `Accept: text/event-stream` → SSE |
| GET | `/v1/runs/:id/nodes/:nodeId/attempts` | viewer | Per-attempt details |
| POST | `/v1/runs/:id/{pause,resume,cancel,retry}` | editor | Run control |

### Secrets

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/v1/secrets` | editor | List with masked values |
| POST | `/v1/secrets` | editor | Create (value encrypted at rest) |
| DELETE | `/v1/secrets/:name` | editor | Remove |

### Tenant settings

| Method | Path | Role | Description |
|---|---|---|---|
| GET/PUT/DELETE | `/v1/tenant/failure-notify` | admin | Tenant-wide failure-alert config |

### Audit

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/v1/audit` | admin | Paginated, filterable by actor/action/resource |

### Health & metrics

| Method | Path | Description |
|---|---|---|
| GET | `/healthz` | API liveness |
| GET | `/readyz` | API + PG + Redis with timeout |
| GET | `/metrics` | Prometheus scrape (same on dispatcher :8081, worker :8082, scheduler :8083) |

---

## Quick Start

### Prerequisites

| Tool | Version |
|---|---|
| Node.js | ≥ 20 (22 LTS recommended) |
| pnpm | 10.x (`corepack enable && corepack prepare pnpm@10.33.3 --activate`) |
| Docker + Compose v2 | latest |

### One-time setup

```bash
git clone https://github.com/DevAvishArora/conduit.git
cd conduit

# Install workspace deps
pnpm install

# Start Postgres (:5432) + Redis (:6380 — note the non-default port)
pnpm stack:up

# Generate JWT RS256 keypair (./keys/jwt_{private,public}.pem)
pnpm keygen

# Copy env (defaults work for local dev)
cp .env.example .env

# Run migrations (creates schema, RLS policies, app role grants)
pnpm migrate
```

### Run the stack (development mode)

Open these in separate terminal tabs:

| Tab | Command | Port |
|---|---|---|
| 1 | `pnpm dev:api` | API `:8080` |
| 2 | `pnpm dev:dispatcher` | metrics/health `:8081` |
| 3 | `pnpm dev:worker` | metrics/health `:8082` |
| 4 | `pnpm dev:scheduler` | metrics/health `:8083` |
| 5 | `pnpm dev:web` | Vite `:5173` |

Minimum to demo: tabs 1, 3, 5 (api + worker + web). Open http://localhost:5173.

### Or run everything containerised

```bash
docker compose --profile app up --build
```

Closest you can get to production locally — non-root container user, healthchecks chained, 2 worker replicas, 2 scheduler replicas with leader election.

### Seed a demo workflow

```bash
pnpm seed
```

Creates a CONDITION → NOTIFY workflow, attaches a webhook trigger, prints a ready-to-fire signed `curl`. Paste it, watch the run succeed in the UI.

---

## Manual Testing Guide

### 1. Auth flow

- Visit http://localhost:5173/sign-up.
- Inline validation: try `not-an-email` → "Enter a valid email"; password `short` → "at least 8 chars"; password `passwordpassword` (no digit) → "Mix letters and numbers".
- Submit valid → land on `/workflows`. Reload — stays signed in.
- Sign out → back to Home. Back-button does NOT return to `/sign-in` (uses `replace`).
- Sign in with wrong password → constant-time response (no timing oracle).
- Multi-tenant: sign up a second tenant in incognito, verify can't see first tenant's workflows.

### 2. Workflow CRUD

- `+ New` → JSON editor pre-fills a sample DAG → save → Publish → version 1.
- Edit definition → save → still v1 (draft on top).
- Publish again → v2. Old runs still show against v1.
- Delete via API: `curl -X DELETE -H "authorization: Bearer $T" $BASE/v1/workflows/$ID` → 204.

### 3. Triggers

```bash
# Attach a webhook trigger:
curl -X POST -H "authorization: Bearer $T" \
  -H "content-type: application/json" \
  $BASE/v1/workflows/$WORKFLOW_ID/triggers \
  -d '{"type":"webhook"}' | jq
# Note: save `webhook_url` and `secret_shown_once` — secret is shown ONCE.

# Fire it:
URL="http://localhost:8080/v1/triggers/webhook/<trigger-id>"
SECRET="<shown-once-secret>"
BODY='{"priority":"high","title":"test"}'
TS=$(date +%s)
SIG="t=$TS,v1=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')"
curl -i -X POST "$URL" \
  -H "content-type: application/json" \
  -H "x-flow-signature: $SIG" \
  -H "x-flow-delivery-id: $(uuidgen)" \
  -d "$BODY"
```

Negative tests:

| Attack | Expected |
|---|---|
| Drop `x-flow-signature` | 401 |
| Same `x-flow-delivery-id` twice | Idempotent — 200, no new run |
| Stale `TS=$(($(date +%s) - 600))` | 401 (5-min replay window) |
| Wrong secret | 401 |

### 4. Notifications

**Slack** — store an incoming-webhook URL as a tenant secret named `slack_hook`, reference it via `webhook_url_secret` in a NOTIFY node. To test without real Slack, use https://webhook.site — same code path, you see the rendered POST in a browser.

**Email** — set `SMTP_URL` + `SMTP_FROM` in `.env`, restart the worker. For local-only testing, run Mailpit:

```bash
docker run -d --name mailpit -p 1025:1025 -p 8025:8025 axllent/mailpit
# SMTP_URL=smtp://localhost:1025  →  view rendered emails at http://localhost:8025
```

For real delivery via Gmail SMTP, use an App Password (requires 2FA on the account):

```
SMTP_URL=smtps://your.email%40gmail.com:16-char-app-password@smtp.gmail.com:465
SMTP_FROM=your.email@gmail.com
```

**Multi-channel in one workflow** — chain NOTIFY nodes (each has a single `next`):

```json
"slack_ping": { "type": "NOTIFY", "channel": "slack", "config": {...}, "next": "email_ping" },
"email_ping": { "type": "NOTIFY", "channel": "email", "config": {...}, "next": null }
```

**Tenant-wide failure-notify** — fires on ANY run that FAILs:

```bash
curl -X PUT -H "authorization: Bearer $T" -H "content-type: application/json" \
  $BASE/v1/tenant/failure-notify \
  -d '{"channel":"slack","config":{"webhook_url_secret":"slack_hook","message":"❌ Run {{run.run_id}} failed: {{run.error_summary}}"}}'

# Break a workflow on purpose (HTTP_REQUEST → localhost:5432 → SSRF blocked) → Slack ping arrives.
```

### 5. Real-time monitoring

Open a run detail page in one tab, fire the webhook in another. Node statuses flip live without any reload — backed by an SSE stream from `/v1/runs/:id/events`.

### 6. Security — SSRF defence

Add an HTTP_REQUEST node pointing at `http://169.254.169.254/latest/meta-data/` (AWS metadata) or `http://localhost:5432` (Postgres). Publish, fire → run FAILED with "blocked egress" error. See [`packages/shared/src/handlers/ssrf.ts`](packages/shared/src/handlers/ssrf.ts).

### 7. Health & metrics

```bash
curl -s http://localhost:8080/metrics | grep conduit_runs_total
# conduit_runs_started_total{tenant="..."} 12
# conduit_runs_finalized_total{status="succeeded"} 11
# conduit_runs_finalized_total{status="failed"} 1
```

### 8. Reset between tests

```bash
docker compose exec postgres psql -U flow -d flow -c "TRUNCATE runs CASCADE;"
# Or full reset:
docker compose down -v && pnpm stack:up && pnpm migrate
```

---

## Project Structure

```
.
├── README.md                  ← This file (single source of truth)
├── docker-compose.yml
├── package.json               ← root scripts (dev:*, migrate, seed, keygen)
├── pnpm-workspace.yaml
├── eslint.config.mjs
├── tsconfig.base.json
├── vitest.config.ts
│
├── migrations/                ← Numbered SQL files (0001 → 0008)
├── infra/
│   ├── Dockerfile             ← Multi-stage prod image (alpine, USER node, tini, healthcheck)
│   ├── Dockerfile.web         ← Nginx + built React bundle
│   ├── postgres/init/         ← First-boot app-role provisioning
│   └── web-nginx.conf
├── keys/                      ← .gitignored; pnpm keygen writes here
├── scripts/
│   ├── keygen.ts              ← Generate RS256 keypair
│   └── seed.ts                ← Demo workflow + signed curl
├── tests/integration/         ← Full-stack e2e (testcontainers PG + Redis)
│
└── packages/
    ├── shared/
    │   └── src/
    │       ├── config.ts logger.ts errors.ts redis.ts metrics.ts
    │       ├── auth/          ← jwt, password
    │       ├── crypto/        ← envelope (KEK/DEK), hmac
    │       ├── db/            ← pool, withTenant/withSystem, migrate
    │       ├── handlers/      ← http, condition, notify, registry, ssrf, types
    │       ├── queue/         ← redis streams + delayed zset
    │       ├── schemas/       ← shared zod schemas (auth — browser-safe)
    │       └── types.ts validate.ts template.ts secrets.ts
    │
    ├── api/                   ← Express HTTP API
    │   └── src/routes/        ← auth, oauth, workflows, triggers, runs, secrets, audit, tenant
    │
    ├── dispatcher/            ← Run-state owner; reads NodeCompleted, advances DAG, failure-notify
    ├── worker/                ← Stateless node executor; bulkhead + retry
    ├── scheduler/             ← Cron firer; leader-elected via advisory lock
    │
    └── web/                   ← React SPA (Vite + React Router + React Flow)
        └── src/
            ├── App.tsx auth.tsx api.ts styles.css
            ├── pages/         ← Home SignIn SignUp Workflows WorkflowDetail Runs RunDetail Secrets Audit AuthCallback
            └── components/    ← Layout GoogleButton (visual builder lives in WorkflowDetail)
```

---

## Design Decisions

### Why no ORM?

Raw `pg` + `withTenant(tenantId, fn)` + `withSystem(fn)`. Three concrete reasons:

1. **RLS depends on per-connection GUC** (`app.tenant_id`). Prisma/Drizzle don't manage Postgres GUCs natively — you'd write `$queryRaw` around every query and lose the ORM's value.
2. **Postgres-specific features everywhere** — `SKIP LOCKED`, advisory locks, partial indexes, `set_config(...,true)` for transaction-local GUCs, LISTEN/NOTIFY. ORMs abstract over the common SQL; the unusual stuff is where they get in the way.
3. **Performance visibility** — every query is explicit. No N+1 from a lazy-loaded relation.

If/when there are >50 simple CRUD queries, **Drizzle** would be the right migration (closest to raw SQL, escape hatch for `db.execute(sql\`SET LOCAL ...\`)`).

### Why dispatcher as single-writer for run state?

Workers race when they're allowed to finalise. The original design had them publishing both NodeCompleted *and* RunSucceeded events, which means two workers could race to mark the same run succeeded. Concentrating run-level state transitions in a single dispatcher process eliminates that class of bugs — and it's still horizontally scalable because the dispatcher consumes from a Redis Stream consumer group (the consumer group provides single-delivery semantics).

### Why Redis Streams over a list-based reliable queue?

`BRPOPLPUSH` + sweeper is the classic Redis reliable-queue pattern. It has problems: no per-element visibility timeout (you have to track it yourself), racy sweeper, and the pending list can grow if a worker dies mid-ack. Streams + consumer groups + `XAUTOCLAIM` give you all of that built in. Workers ack with `XACK`; abandoned messages are claimed by another worker after a TTL.

### Why URL fragment for OAuth token delivery?

The OAuth callback redirects the browser to `${WEB_BASE_URL}/auth/callback#access_token=…&refresh_token=…`. Tokens travel in the URL **fragment**, not the query string. The fragment is never sent to the server in the HTTP request, so:

- Tokens never appear in API server access logs.
- Tokens never appear in `Referer` headers if the user clicks any link on the callback page.
- The frontend JS reads `window.location.hash`, plants the tokens in localStorage, and `history.replaceState` wipes the fragment from the URL bar.

### Why RS256 over HS256?

The original LLD specced HS256 (shared secret). Every service that verifies JWTs would need the secret → broad blast radius if any service is compromised. With RS256: only the auth service holds the private key; every other service has the public key for verify-only. Standard practice for multi-service deployments.

### Why no message broker (Kafka, NATS, RabbitMQ)?

Redis Streams cover the use case: ordered, multi-consumer, durable enough for our SLA. Adding Kafka would be operational overhead with no functional gain at this scale (1M runs/day target). If we needed event sourcing for the entire history, that'd be different — but `run_events` in Postgres is already an append-only event log.

### Why pre-commit hook + CI gate?

`husky` runs `lint-staged` on staged files (lint + format). Catches the dumb stuff before it reaches CI. CI then runs the full matrix: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`. This means the merge bar is "all four pass."

---

## Testing & Quality Gates

| Gate | Status |
|---|---|
| TypeScript strict (`strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`) | ✅ |
| `pnpm typecheck` across 6 packages | ✅ |
| ESLint v9 flat config (TS + React + Hooks) | ✅ |
| Prettier check in CI | ✅ |
| Pre-commit hook (lint-staged) | ✅ |
| Server unit tests (vitest) | ✅ 52 tests |
| Frontend unit tests (jsdom + Testing Library) | ✅ 46 tests |
| Integration test (testcontainers, real PG + Redis) | ✅ |
| Coverage threshold (90% lines, 80% branches) | ✅ Current: 95% / 91% |
| CI on every push (typecheck + lint + format + tests) | ✅ |

```bash
pnpm check               # all of typecheck + lint + format + tests
pnpm test:integration    # spins up real PG + Redis via testcontainers (~30s)
```

---

## Production Deployment Notes

The repo ships with a production-grade multi-stage `infra/Dockerfile`:

- **Base:** Node 22 alpine
- **Deps layer:** workspace-aware install, cached on lockfile alone
- **Build layer:** runs `pnpm typecheck && pnpm lint && pnpm format:check` — image won't be built if any check fails
- **Runtime layer:** prod-only deps, `USER node` (non-root), `tini` as PID 1, `HEALTHCHECK` curling `/healthz`

Compose has healthchecks on every service with `depends_on: service_healthy` — services start in dependency order.

### What's NOT yet wired (be honest in submission)

- K8s manifests + HPA — would just be a translation of the compose file
- PgBouncer in front of Postgres
- Postgres WAL archiving / PITR
- Grafana dashboard JSON (metrics are exported; no bundled dashboards)
- Out-of-process connectors (gRPC for adding handlers in any language)
- OTel tracing (logs are structured but no trace propagation)

### Free hosting paths

| Path | Cost | Trade-off |
|---|---|---|
| **Oracle Cloud Always Free** (4-core ARM A1 + 24 GB RAM) + `docker compose --profile app up -d` + Cloudflare DNS | $0/mo | Manual ops; Oracle reclaims idle instances |
| Vercel (web) + Fly.io (api/worker/dispatcher/scheduler) + Neon (PG) + Upstash (Redis) | ~$5/mo | Easy ops, no cold starts |
| Render + Neon + Upstash | $0/mo (web free tier) | API spins down after 15 min idle |

---

## Roadmap

Beyond v1, in rough priority order:

- **Parallel branches (fan-out / fan-in)** — currently a workflow has a single `next` per node; a PARALLEL node would schedule N children and join their futures
- **Sub-workflow nodes** — call another workflow as a step (with its own retry/timeout)
- **Out-of-process connectors over gRPC** — write a handler in Python/Go without rebuilding the worker
- **Event-replay debugger** — re-execute a run against the same workflow version with a modified trigger payload
- **DAG diff** between workflow versions
- **Light/dark theme toggle + full mobile responsive** for the web app
- **OpenAPI / Swagger spec** for the API
- **Grafana dashboards** bundled
- **OTel tracing** (trace_id = run_id)
- **Connector marketplace** (community-contributed handlers)
- **Self-service tenant onboarding + billing** (Stripe)
- **Customer-managed encryption keys (CMEK)**
- **SOC2-readiness** — audit log SIEM export

---

## License

MIT

---

## Acknowledgements

Built as a Backend Engineering Launchpad case study. Design borrows execution semantics from **Temporal** (durable state in DB, stateless workers, idempotency keys), the **n8n** node-based mental model, and **AWS Step Functions**' declarative retry policies on each node.

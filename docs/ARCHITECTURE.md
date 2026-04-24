# Kassa System Architecture v0

Status: v0 (MVP, 30-day window). Owner: Engineer. Linked issue: [KASA-6](/KASA/issues/KASA-6).
Companion docs: [TECH-STACK.md](./TECH-STACK.md), [VISION.md](../../../docs/VISION.md), [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md).

This is the reference for how Kassa v0 is structured, how data moves through it, and how it is deployed. It assumes the tech stack decisions are settled; rationale for those choices lives in `TECH-STACK.md`. Architectural decisions specific to the *shape* of the system (not the tools) live here, as ADR-style entries at the bottom.

The north star is the goal statement: **a merchant onboards, configures catalog and BOMs across multiple outlets, processes sales transactions on an unreliable network for a full business day, and performs end-of-day close without support intervention.** Every component below earns its place by serving that sentence.

---

## 1. System Overview

Kassa is a **two-tier system** with a thin offline-first client and a single back-office API that fronts a relational store.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          Merchant tablet / device                        │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │                    POS PWA  (React 19 + Vite + TS)                 │  │
│  │                                                                    │  │
│  │  UI ──► Cart/State (Zustand) ──► Domain services (sale, stock,…)   │  │
│  │                   │                               │                │  │
│  │                   ▼                               ▼                │  │
│  │          TanStack Query cache            Dexie/IndexedDB store     │  │
│  │                   │                               │                │  │
│  │                   ▼                               ▼                │  │
│  │                Sync engine ◄── Workbox service worker ──────────┐  │  │
│  └────────────────────────────────────────────────────────────────┼──┘  │
└───────────────────────────────────────────────────────────────────┼─────┘
                                    │ HTTPS (REST + JSON, retried) │
                                    ▼                              │
┌──────────────────────────────────────────────────────────────────┼──────┐
│                    Fly.io (Singapore `sin`)                      │      │
│  ┌───────────────┐   ┌──────────────────┐   ┌────────────────┐   │      │
│  │  Fly proxy    │──►│  @kassa/api      │──►│  Postgres 16   │   │      │
│  │  (TLS, ACME)  │   │  Fastify 5 + TS  │   │   (Neon, sin)  │   │      │
│  └───────────────┘   │  Drizzle ORM     │   └────────────────┘   │      │
│                      │                  │   ┌────────────────┐   │      │
│                      │                  │──►│    Redis 7     │   │      │
│                      │                  │   │  (BullMQ jobs) │   │      │
│                      │                  │   └────────────────┘   │      │
│                      │  BullMQ worker   │                        │      │
│                      │  (sync, EOD,     │                        │      │
│                      │   reconciliation)│                        │      │
│                      └──────────────────┘                        │      │
└──────────────────────────────────────────────────────────────────┼──────┘
                                    ▲                              │
                                    │ Midtrans Core API (QRIS)     │
                                    └──────────────────────────────┘
```

- **Tier 1 — POS PWA**: installed to the merchant's Android tablet, runs offline, holds a full-day mirror of catalog, BOM, and stock, and queues transactions for sync. Source: `apps/pos` (scaffolded in a follow-up ticket).
- **Tier 2 — Back-office API**: a single Fastify HTTP service that owns the Postgres schema, exposes the REST/JSON endpoints the PWA and back-office UI talk to, and dispatches async work to a BullMQ worker on Redis. Source: `apps/api` ([KASA-22](/KASA/issues/KASA-22)).
- **External**: Midtrans handles QRIS. Sentry receives errors from both tiers. Cloudflare Pages hosts the static PWA bundle. Neon hosts the Postgres.

There is **no separate "API gateway" service**, **no general-purpose message broker** (BullMQ-on-Redis covers the async layer), **no separate auth service**, and **no BFF** between the PWA and the API. Every "microservice"-shaped temptation is deferred until v1.

---

## 2. Component Structure

Source lives in a single TypeScript monorepo (pnpm workspaces; Turborepo added in a later ticket). Packages are scaffolded incrementally as tickets land. Present workspaces: `apps/api` (KASA-22) and `packages/payments` (KASA-54, vendor-agnostic payment provider abstraction + Midtrans QRIS implementation).

### 2.1 POS PWA (client) — `apps/pos`

Single client build, one static artifact served by Cloudflare Pages, installed as a PWA.

| Module | Responsibility | Key deps |
|--------|---------------|----------|
| `app/` | Route tree, providers (QueryClient, router, toast, sync status). | TanStack Router, TanStack Query |
| `pages/` | Screen-level components: catalog, cart, tender, receipt, EOD, admin. | — |
| `features/cart` | Cart state, totals, discounts, tender split, rupiah math. | Zustand |
| `features/catalog` | Catalog browsing, search, filters. Reads only from local Dexie. | Dexie, React Hook Form |
| `features/stock` | Per-outlet stock snapshot reads, BOM resolution for combo items. | Dexie |
| `features/sale` | Sale finalization: persists a `PendingSale` to Dexie, fires an optimistic stock decrement, hands off to sync. | Dexie, Zod |
| `features/tender/cash` | Cash drawer workflow, change calculation. | — |
| `features/tender/qris` | QRIS request, QR display, polling for paid status, fallback to static QRIS. | TanStack Query |
| `features/eod` | End-of-day close: totals, variance entry, reconciliation report. | — |
| `features/admin` | Device enrollment, outlet selection, sync status, diagnostic tools. | — |
| `data/db` | Dexie schema + typed repositories. One file per local table. | Dexie |
| `data/api` | Typed REST client for `@kassa/api`. One function per endpoint, Zod-validated responses. | fetch, Zod |
| `data/sync` | Sync engine: pull (reference data), push (pending sales), reconcile stock. | Workbox BG Sync |
| `design-system/` | Tailwind v4 config, token shims, shared primitives from `DESIGN-SYSTEM.md`. | Tailwind, Headless UI |
| `sw/` | Service worker (Workbox): app-shell precache, runtime caches, background sync queue. | workbox-*, vite-plugin-pwa |

**Strict rules for the client**:
- UI never imports from `data/api` directly. It goes through TanStack Query hooks (`useCatalogItems`) or Dexie repositories (`repos.items.search`). The sync engine is the only module that talks to both.
- Every read from the network goes through a Zod schema before it hits the cache. A network response that fails parse is a crash, not a silent mutation.
- Money is never `number`. It is `Rupiah` (a branded `number` in integer IDR) at every boundary. Floating-point rupiah is a compile error.

### 2.2 Back-office API — `apps/api`

Single Fastify 5 service on Node.js 22 LTS. All routes are under the `/v1` prefix. Placeholder endpoints return `501 { error: { code: "not_implemented" } }` until their owning tickets ([KASA-23](/KASA/issues/KASA-23) et seq.) wire real behaviour.

| Layer | Content | Notes |
|-------|---------|-------|
| `src/server.ts`, `src/app.ts` | Fastify factory: logging, error hook, config, route registration. | Pino (JSON), env validated by Zod on boot. |
| `src/routes/*` | One file per resource group: `health`, `auth`, `catalog`, `outlets`, `stock`, `sales`, `payments`, `eod`. `routes/index.ts` registers every business group under the `/v1` prefix; `health.ts` is mounted unversioned at the root for uptime-monitor stability. Handlers are thin; they parse, delegate to services, and format responses. |
| `src/services/*` | Business logic: `sales`, `payments`, `eod`, `catalog`, `stock`, `auth`. | Unit-testable without the Fastify request context. |
| `src/db/schema/*` | Drizzle schema: one file per domain aggregate. | `drizzle-kit generate` writes SQL into `db/migrations/` ([KASA-21](/KASA/issues/KASA-21)). |
| `src/db/client.ts` | `pg` + Drizzle client factory; transaction helper. | `db.transaction(async tx => …)` at the boundary of any multi-row mutation. |
| `src/plugins/*` | Fastify plugins: `@fastify/cookie`, `@fastify/rate-limit`, auth (session + JWT), RBAC, tenant scoping, Zod type-provider, OpenAPI. | Each plugin owns one concern. |
| `src/lib/errors.ts` | Shared error shape `{ error: { code, message, details? } }`. | Client retry policy keys off this. |
| `src/workers/*` | BullMQ processors: `sales-sync`, `eod-rollup`, `stock-reconcile`. | Run in a separate Fly process (`fly.toml` processes block) sharing the same image. |
| `src/schemas/*` (until extracted) | Zod request/response schemas. Will move into `packages/schemas` when the PWA workspace lands so the client and API share one source. | Zod |

**Strict rules for the API**:
- `routes/*` contains no business logic — it parses input, authenticates, delegates, formats the response.
- Every handler passes its inputs through a Zod schema via `fastify-type-provider-zod`. A request that fails parse returns `400` with the structured error shape.
- Money is stored and transported as integer IDR (`bigint` in Postgres, `number` in JSON — under `Number.MAX_SAFE_INTEGER` for any realistic sale). No float anywhere.
- Every query is tenant-scoped by `merchant_id`, enforced by a preHandler that injects `scope` into the request context; a query that bypasses the helper is a review-blocking bug.

### 2.3 Shared infrastructure

| Component | Purpose | Version |
|-----------|---------|---------|
| Fly.io | Hosts `@kassa/api` (web process) and BullMQ worker (worker process). TLS termination, private networking between processes. | — |
| PostgreSQL | Primary datastore. Neon, Singapore region. Branching on PR via Neon's API. | 16 |
| Redis | Cache + BullMQ broker. Single instance on Fly or Upstash (TBD infra ticket). | 7.x |
| S3-compatible object store | Receipts (PDF), merchant logos, product images, CSV imports. Provider decided during infra ticket. | — |
| Cloudflare Pages | Static hosting for PWA; `main` deploys from GitHub Actions. | — |
| Sentry | Errors from both PWA (`@sentry/react`) and API (`@sentry/node`). Release tagging + source maps. | — |

---

## 3. Data Flow

### 3.1 Principal flows

The PWA has exactly four interactions with the API. Every feature reduces to one of these. Describing them explicitly keeps us from accidentally inventing a fifth.

**Flow A — Reference pull (read-through cache).**
```
PWA boot / interval / manual refresh
     │
     ▼
TanStack Query ──► GET /v1/catalog/items?outlet=…&updated_after=…
     │
     ├── parse with Zod
     ├── upsert into Dexie table `items`  (idempotent by item.id)
     └── write `sync_state.items_cursor = response.cursor`
```

Same shape for `/v1/catalog/boms`, `/v1/catalog/uoms`, `/v1/catalog/modifiers`, `/v1/stock/snapshot` (per-outlet), `/v1/outlets`. Each endpoint is **cursor-based** (`updated_after` timestamp + optional page token). Pulls are delta by default; a full refresh is a cursor reset.

**Flow B — Sale push (write-ahead queue).**
```
Clerk taps "Pay"
     │
     ▼
features/sale.finalize()
     │
     ├── build canonical `Sale` object (Zod-validated)
     ├── Dexie tx:  INSERT pending_sale, DECREMENT stock_snapshot rows
     ├── mark receipt "Synced locally"
     │
     ▼
Sync engine (immediately + on reconnect)
     │
     ▼
POST /v1/sales        (single sale)
  or
POST /v1/sales/sync   (batched drain of the outbox)
     │
     ├── Fastify validates (Zod) + checks RBAC + tenant scope
     ├── services/sales: BEGIN tx → insert sale + sale_items + tenders
     │                 → explode BOMs → append stock_ledger rows
     │                 → COMMIT
     ├── returns { id, server_time, canonical_totals }
     │
     ▼
PWA: mark pending_sale as synced (server_id stored), update status chip
```

If the POST fails with a **retriable** error (network, 5xx, 409 idempotency conflict for a not-yet-seen key), Workbox's `BackgroundSyncPlugin` re-queues it. If it fails with a **terminal** error (4xx validation), the sale is flagged and surfaced in the admin "Needs attention" list. Nothing is silently dropped.

**Flow C — Tender side-channel (QRIS).**
```
Sale in "Awaiting payment" state with tender=QRIS
     │
     ▼
POST /v1/payments/qris
    { amount, local_sale_id, outlet_id }
     │
     ├── services/payments: call Midtrans Core API → qr_string, order_id
     ├── INSERT tender row (pending, unverified)
     │
     ▼
PWA displays QR; polls GET /v1/payments/qris/:orderId/status
     │
     ├── API replies from its mirror of the Midtrans webhook state
     │
     ▼
When status=paid → PWA finalizes sale via Flow B (with tender_ref attached)
```

Midtrans also POSTs to `/v1/payments/webhooks/midtrans` out-of-band. The handler verifies the HMAC signature, updates the tender row, and enqueues a BullMQ job to reconcile stale client polls.

If the PWA is **offline** at tender time, it falls back to **static QRIS** mode: the clerk scans the printed merchant QR, the buyer pays, and the clerk confirms receipt by entering the last 4 digits of the reference. This becomes a tender with `method=qris_static` and `verified=false`; reconciliation at EOD matches these against the Midtrans settlement report once online.

**Flow D — End-of-day close.**
```
Clerk hits "Close day" at outlet
     │
     ▼
PWA computes local totals from Dexie `sales` + `tenders` for this outlet/date
     │
     ├── Displays expected cash, expected QRIS, expected voids
     ├── Clerk enters counted cash; variance calculated
     │
     ▼
Sync engine: POST /v1/eod/close
    { outlet_id, business_date, counted_cash, variance_reason, client_sale_ids[] }
     │
     ├── services/eod: verify all client sale ids are present server-side
     │                (rejects if any are missing — client must drain Flow B first)
     ├── INSERT end_of_day row, lock the (outlet_id, business_date) tuple
     └── Returns summary; PWA prints (browser print) or emails the receipt
```

EOD is the **only** flow that is explicitly ordered with respect to Flow B: the client must finish all pending pushes before `close` can succeed. This is enforced by the client (drain queue first) and the server (rejects `close` if any client sale ids are unknown).

### 3.2 Canonical data shapes

These are the v0 primitives. Full field lists live in Drizzle schema files (`apps/api/src/db/schema/*`) and shared Zod schemas; this table is the map. Primary keys are UUIDv7 (client-generated where relevant for idempotency; server-generated otherwise).

| Entity | Table | Key | Notes |
|--------|-------|-----|-------|
| Merchant | `merchant` | `id` | Tenant boundary. Every other row carries `merchant_id`. |
| Outlet | `outlet` | `id` | A physical location. Owns its stock rows and EOD records. |
| Device | `device` | `id` | One row per enrolled tablet. Holds rotated credentials and outlet binding. |
| Staff | `staff` | `id` | User with role (`owner`, `manager`, `cashier`, `read_only`). |
| Item | `item` | `id` | Catalog row. `is_stock_tracked` flag gates ledger writes. |
| UOM | `uom` | `id` | Reference table. Rarely mutated. |
| Modifier | `modifier` | `id` | Options and add-ons (size, syrup, spice). |
| BOM | `bom` | `id` | Recipe. A sale line referencing a BOM consumes its components, not the BOM itself. |
| BOM Item | `bom_item` | `(bom_id, component_item_id)` | Component quantities. |
| Stock Snapshot | `stock_snapshot` | `(outlet_id, item_id)` | Current on-hand. Derived from the ledger; rebuilt by the reconcile job. |
| Stock Ledger | `stock_ledger` | `id` | Append-only. Every POS-driven decrement, receipt, adjustment lands here. |
| Sale | `sale` | `id` | Header: outlet, clerk, business date, totals, `local_sale_id` (client UUIDv7, unique-indexed for idempotency). |
| Sale Item | `sale_item` | `id` | Line item: item, qty, uom, unit_price, line_total, optional BOM link. |
| Tender | `tender` | `id` | Payment instrument applied to a sale. Method, amount, Midtrans order ref, `verified` flag. |
| End of Day | `end_of_day` | `(outlet_id, business_date)` | Counted cash, variance, breakdown by tender. |
| Sync Log | `sync_log` | `id` | Diagnostic trail of client pushes (request id, outcome). Purged after 30 days by a BullMQ cron. |
| Transaction Event | `transaction_events` | `id` | Append-only audit log of money-movement events (double-entry style). The summary rows above are derivable from this log. |

**Idempotency key**: every client-originated write carries a `local_sale_id` (or `local_*_id`) generated client-side as UUIDv7 at the moment of user action. The server enforces `UNIQUE (merchant_id, local_sale_id)` and collapses duplicate pushes on retry — not the HTTP `Idempotency-Key` header.

**Stock truth**: `stock_ledger` is authoritative. `stock_snapshot` is a derived projection, rebuilt from the ledger by a BullMQ job and on-demand after a sale commit. The PWA's own Dexie `stock_snapshot` is a best-effort projection of that; reconciliation on pull overwrites it; the client's optimistic decrements are labels, not facts.

**Time**: both sides use UTC at the wire (`timestamptz` in Postgres). The `business_date` for EOD is the outlet's local calendar date (Asia/Jakarta, UTC+7) computed at sale time by the client and stored on the sale. Reconciliation uses this field, not the server's `created_at`.

**Money**: integer IDR everywhere. `bigint` in Postgres; typed as a branded `Rupiah` number in TS (safe up to `2^53 − 1`, which is enough for any plausible single sale). No fractional unit exists for rupiah.

---

## 4. API Boundaries

### 4.1 External API (exposed by us)

v0 exposes **one** API surface: the REST/JSON endpoints under `/v1/*` consumed by the POS PWA and the back-office UI. There is no public/partner API in v0. Every endpoint is authenticated, schema-validated, and rate-limited.

The route map is authoritatively documented in [apps/api/README.md](../apps/api/README.md). The table below groups routes by flow for architectural clarity.

| Endpoint | Method | Purpose | Flow |
|----------|--------|---------|------|
| `/health` | GET | Liveness probe. Unauthenticated, **unversioned** (mounted at root) so external uptime monitors never have to track API versions. | — |
| `/v1/auth/enrolment-codes` | POST | Staff-only: issue a single-use 8-character enrolment code bound to one outlet, 10-minute TTL. | Bootstrap |
| `/v1/auth/enroll` | POST | One-time: exchange an enrolment code (scanned from back office) for device credentials. Argon2id-hashed `api_key_hash` is stored; `api_secret` is returned exactly once. Rate-limited per IP. | Bootstrap |
| `/v1/auth/heartbeat` | POST | Cheap liveness + server-time sync; used by the connection indicator. | — |
| `/v1/auth/session/login` | POST | Staff email + password → session cookie. | Bootstrap |
| `/v1/auth/session/logout` | POST | Revoke session. | — |
| `/v1/auth/pin/verify` | POST | Unlock an inactive POS surface with the cashier's PIN. | — |
| `/v1/catalog/items` | GET | Delta pull of catalog, scoped to device outlet. | A |
| `/v1/catalog/items/:itemId` | GET | Single-item fetch (detail screens, receipt reprint). | A |
| `/v1/catalog/boms` | GET | Delta pull of BOMs. | A |
| `/v1/catalog/uoms` | GET | Reference data. | A |
| `/v1/catalog/modifiers` | GET | Reference data. | A |
| `/v1/outlets` | GET | Outlets the device/staff may switch to. | A |
| `/v1/outlets/:outletId` | GET | Single outlet (settings, receipt header). | A |
| `/v1/stock/snapshot` | GET | Per-outlet stock snapshot. | A |
| `/v1/stock/ledger` | GET | Filtered ledger for admin / reconciliation view. | A |
| `/v1/sales` | POST | Create a single sale. Idempotent on `local_sale_id`. | B |
| `/v1/sales/:saleId` | GET | Read a sale back (resend receipt, sync reconciliation). | B |
| `/v1/sales/:saleId/void` | POST | Void a same-day sale (pre-settlement). | B |
| `/v1/sales/:saleId/refund` | POST | Create a refund referencing an existing sale. | B |
| `/v1/sales/sync` | POST | Batched drain of the client outbox. | B |
| `/v1/payments/qris` | POST | Create a dynamic QRIS order via Midtrans. | C |
| `/v1/payments/qris/:orderId/status` | GET | Poll current status of a QRIS order. | C |
| `/v1/payments/webhooks/midtrans` | POST | Midtrans → API webhook; HMAC-verified; updates the tender row. | C |
| `/v1/eod/close` | POST | Close business day for outlet. | D |
| `/v1/eod/report` | GET | Fetch an EOD (reprint). | D |
| `/v1/eod/:eodId` | GET | Single EOD detail. | D |

**Authentication**:
- **Staff sessions**: HTTP-only, `SameSite=Lax`, `Secure`, signed cookie issued by `POST /v1/auth/session/login`. Rolling 30-day expiration. PIN unlock after 5 minutes of inactivity re-verifies the session client-side.
- **Device identity**: every device is enrolled once via `POST /v1/auth/enroll`, receiving short-lived rotatable credentials bound to a single outlet. The PWA attaches these on top of the staff session so the API can distinguish "this cashier" from "this tablet".
- **Webhook callers (Midtrans)**: HMAC signature verified per vendor contract.
- **Internal API-to-API** (worker → API for jobs that need HTTP context): short-lived (≤5 min) ES256 JWTs signed by an internal key. Not used between the web and worker processes when they share a DB — they call services directly.

**Versioning**: the URL is prefixed `/v1`. Backwards-incompatible changes mint `/v2` and run in parallel until the PWA is force-updated by service worker activation. We accept short-lived dual-deploy windows in exchange for not breaking offline tablets mid-shift.

**Error contract**: every error response is `{ error: { code: string, message: string, details?: unknown } }` with a 4xx/5xx HTTP status. Client treats 5xx and network errors as retriable; 4xx as terminal (except 409 on the sale idempotency key, which is a success in disguise and surfaces the existing server record).

**Rate limits**: `@fastify/rate-limit` applies a global per-device budget; heavier budgets for read endpoints, tighter for `POST /v1/sales*` and `POST /v1/auth/*`. Rates are tuned once real traffic is observable; v0 ships conservative defaults.

### 4.2 Internal boundaries (inside `@kassa/api`)

| Internal boundary | Callers | Purpose |
|-------------------|---------|---------|
| `services/sales` | `routes/v1/sales`, `services/eod` | Business rules: validate clerk + outlet + tenant, explode BOMs, enforce stock policy, write sale + ledger rows inside one transaction. |
| `services/payments` | `routes/v1/payments`, webhook handler, workers | Midtrans client wrapper (with signature verification), tender state machine. |
| `services/eod` | `routes/v1/eod`, `workers/eod-rollup` | EOD totaling, variance validation, lock management. |
| `services/catalog` | `routes/v1/catalog` | Delta query builder (cursor math) for catalog/BOM/stock. |
| `services/auth` | `routes/v1/auth`, every preHandler | Session issuance/verification, PIN verification, device enrolment, credential rotation. |
| `workers/*` | BullMQ | `sales-sync` (retry failed push chains), `eod-rollup` (denormalized reporting rows), `stock-reconcile` (snapshot rebuild), `sync-log-purge` (nightly cleanup). |

Rule: `routes/*` modules contain **no business logic** — they parse input, check auth, delegate to `services/*`, and format responses. Keeps the surface thin and the services unit-testable without the Fastify request context.

### 4.3 Third-party boundaries

| Integration | Protocol | Direction | Notes |
|-------------|----------|-----------|-------|
| **Midtrans Core API (QRIS)** | HTTPS REST, JSON, server auth-key | Outbound (create QR, check status); inbound webhook (paid/expired/cancelled) | Webhook signature verified with merchant server key. Sandbox ≠ prod keys; both configured via Fly secrets. |
| **Sentry** | HTTPS, DSN | Outbound | Separate DSNs for PWA (browser) and API (server). PII scrubbing on at the SDK level; API uses `sendDefaultPii: false`. |
| **Neon** | Postgres wire, TLS | Outbound | Connection string in Fly secrets. Per-PR branch created by CI and torn down on close. |
| **Resend** | HTTPS REST | Outbound | Transactional email (receipts, invites). |
| **Cloudflare Pages** | GitHub Actions → Cloudflare API | Build-time only | Token scoped to the Pages project. |
| **PostHog (EU cloud)** | HTTPS, project key | Outbound | Product analytics from PWA; flag evaluation pulled to the client. |

---

## 5. Deployment Model

### 5.1 Repository and artifacts

v0 ships as a **single TypeScript monorepo** (pnpm workspaces). Per [TECH-STACK.md](./TECH-STACK.md) §10.1, packages are:

| Package | Contents | Artifact |
|---------|----------|----------|
| `apps/api` | Fastify API + BullMQ workers + Drizzle schema & migrations. | Docker image → Fly.io (`web` + `worker` processes). |
| `apps/pos` *(upcoming)* | PWA source (TypeScript/React + Vite). | Static bundle → Cloudflare Pages. |
| `apps/back-office` *(upcoming)* | Staff admin UI. | Static bundle → Cloudflare Pages (separate project). |
| `packages/schemas` *(upcoming)* | Shared Zod request/response schemas consumed by API, PWA, and back-office. | npm-workspace-linked; published if a third-party ever needs it. |
| `packages/ui`, `packages/icons`, `packages/config` *(upcoming)* | Design-system primitives, icon wrappers, shared tsconfig / eslint bases. | Workspace-linked. |

The monorepo is the reason shared Zod schemas are low-cost (§2.2): one source of truth, typechecked across every package.

### 5.2 Build

**Root**:
```
pnpm install  →  turbo run lint typecheck test build
```

Turborepo caches per-package task outputs locally and in the remote cache. Biome covers lint + format in one pass.

**API (`apps/api`)**:
```
biome check  →  tsc --noEmit  →  vitest run  →  tsc -p tsconfig.build.json
```
Produces `dist/` consumed by the Dockerfile (`node dist/server.js` in the web process, `node dist/workers/index.js` in the worker process).

**PWA (`apps/pos`, when scaffolded)**:
```
biome check  →  tsc --noEmit  →  vitest run  →  vite build
```
Vite produces `dist/` with the Workbox service worker (`sw.js`) generated by `vite-plugin-pwa` (injectManifest strategy). Output is hashed; the service worker is served no-cache so updates activate within one navigation.

### 5.3 Test

| Layer | Tool | Gate |
|-------|------|------|
| API unit (services, helpers) | Vitest | Must pass in CI. |
| API integration | Vitest + `fastify.inject` against a Neon PR branch | Must pass in CI. |
| DB migration | `drizzle-kit check` + fresh-branch apply | Must pass in CI. |
| PWA unit + component | Vitest + React Testing Library | Must pass in CI. |
| PWA contract | Zod schema round-trip tests + MSW-mocked API responses | Must pass in CI. |
| PWA E2E | Playwright, incl. offline scenario | Runs on `main` and pre-release; informational on PRs for speed. |
| Visual | Playwright screenshot diffs for keypad, receipt, chips | Must pass in CI once the PWA scaffolds. |
| Cross-tier smoke | Playwright against a Fly preview app + Neon branch + Cloudflare Pages preview | Runs post-deploy to preview. |

The "full sales day offline" acceptance test (vision success metric) is a Playwright script that: enrols a device, pulls catalog, toggles network off, rings up 50 sales across 3 outlets, toggles network on, verifies all sales sync, runs EOD, asserts zero discrepancies.

### 5.4 Deploy

**API → Fly.io (Singapore)**:
- GitHub Actions on push to `main` builds the Docker image, runs `drizzle-kit migrate` against Neon (forward-only), and `fly deploy --ha` rolls the `web` + `worker` processes. Healthchecks hit `/health` (unversioned, see §4.1).
- PR preview: a Fly preview app scaled to 1, sleeping on idle, pointed at a Neon PR branch seeded with demo catalog.
- Rollback: `fly releases` + `fly deploy --image` pointed at the previous image digest; migrations are forward-only in v0 and reversal is manual and rare.

**PWA → Cloudflare Pages**:
- GitHub Actions on push to `main` runs build, then uses the Cloudflare Pages action to publish.
- Preview deploys per PR from Cloudflare's Pages preview URLs.
- Rollback = promote a prior deployment in the Cloudflare Pages UI.

**Environments**:
- `dev` — local `pnpm dev` starts Vite (PWA), Vite (back office), Fastify (API) with hot reload, and a local Postgres via `docker compose`.
- `preview` — ephemeral per-PR API on Fly + Neon branch + Cloudflare Pages preview.
- `prod` — single Fly app + Neon production DB + Cloudflare Pages production deployment.

### 5.5 Operations

- **Monitoring**: Sentry for errors (both tiers). Better Stack for synthetic checks on `POS shell` and API `/health`. Fly's built-in healthchecks + process restarts cover process-level failures.
- **Logging**: Pino JSON logs from the API go to Fly's log stream, shipped to Sentry (errors) and a log aggregator (operational logs). PWA logs to console in dev; Sentry breadcrumbs in prod.
- **Metrics**: OpenTelemetry (API) + provider-native ingest. Frontend RUM via PostHog (captured page views, custom events) until a dedicated RUM story is justified.
- **Backups**: Neon retains point-in-time recovery in its tier; we document the restore runbook in `docs/ops/` once it lands. Out-of-region export is a v1 concern.
- **Secrets**: Fly secrets for API, Cloudflare environment variables for Pages, GitHub Actions secrets for CI. No secrets in the repo, `.env` files are gitignored and only used for local dev. A `gitleaks` scan runs in CI.
- **On-call**: one engineer on the pilot. Escalation path documented in `docs/ops/on-call.md` once it lands.

---

## 6. Key Decisions (ADRs)

Architectural decisions we explicitly made, with the path-not-taken and why we'd revisit.

### ADR-001: Two-tier system; no BFF between the PWA and the API

**Context**: The POS PWA needs offline-first data, the API owns the data. A backend-for-frontend (BFF) sitting between them is a common pattern.
**Decision**: No BFF. The PWA talks directly to the Fastify API.
**Rationale**: Every tier added is a tier to deploy, monitor, and harden. Our Fastify endpoints are already shaped for the PWA — the schemas are shared via `packages/schemas`, so the API *is* the BFF in spirit. The only reason to add a BFF would be to bundle the 4–5 reference pulls into one — a perf optimisation we can defer past v0.
**Revisit when**: we add a second consumer whose query shape differs materially from the PWA's (partner integration, mobile-native wrapper) or the pull-fan-out becomes the slowest thing on the cold boot.

### ADR-002: Offline model is read-through + write-ahead queue, not full two-way sync

**Context**: Real offline-first systems (CouchDB, RxDB, Yjs) offer symmetric replication. We do not need that.
**Decision**: Reference data is pulled from the server (read-through). Transactions are created locally and pushed to the server (write-ahead). The server never originates a change that the client must merge.
**Rationale**: Merchant back-office edits (catalog/BOM/price) happen orders of magnitude less often than sales. A one-way pull of those edits every N seconds is sufficient. Symmetric replication would force us to model conflict resolution on catalog rows, which is not a real problem at v0 scale. LWW-per-field on the handful of concurrently edited fields (price, stock_snapshot) is the minimum CRDT-adjacent model that works here.
**Revisit when**: back-office staff start editing the catalog while a sale is in flight and conflicts become a real complaint, or when multiple devices per outlet begin mutating shared state.

### ADR-003: Multi-tenant from day one via `merchant_id` row scoping

**Context**: A common v0 shortcut is single-tenant per deployment and defer multi-tenancy to v1. We considered that.
**Decision**: The Postgres schema carries `merchant_id` on every tenant-owned row. A Fastify preHandler injects the caller's `merchant_id` into a `scope` helper, and all query-builder calls go through that helper; a query that bypasses it is a review-blocking bug.
**Rationale**: The VPS-per-merchant model loses us the single-deploy operational story (`fly deploy` once, not N times) and makes DB migrations N-times more expensive. Row-level scoping is a few hundred lines of preHandler and query-builder discipline; retrofitting it later would touch every query and every test. Postgres row-level security (RLS) is available if the scoping discipline ever fails us, but it is not the primary defence.
**Revisit when**: a merchant legitimately needs physical isolation for compliance (not just row isolation) — at which point per-merchant Fly apps + per-merchant Neon projects is the evolution, not schema-per-tenant.

### ADR-004: Client-generated UUIDv7 as idempotency key on writes

**Context**: Network retries cause duplicate POSTs. Server needs to collapse them without creating two sales.
**Decision**: The client generates a UUIDv7 `local_sale_id` when the sale is finalized locally. The server enforces `UNIQUE (merchant_id, local_sale_id)`; a duplicate POST returns the original `id` with `200 OK` (or `409` with the existing record if the client's payload diverges).
**Rationale**: The retry may happen from the service worker background-sync queue hours later; the `Idempotency-Key` HTTP header would require server-side storage of request fingerprints. Making the client produce the key is simpler and gives us a natural primary-in-client identifier that can be logged on receipts before the server has assigned its own `id`. UUIDv7 sorts lexicographically by time, which is useful for human-readable debugging and for Postgres B-tree locality.
**Revisit when**: we add a second writer per sale (unlikely in v0).

### ADR-005: Stock is optimistic on the client, authoritative on the server

**Context**: The client shows a stock figure. The server owns the ledger. They will drift.
**Decision**: The client's Dexie `stock_snapshot` is the value shown to clerks, decremented optimistically on sale and incremented on void. The server's `stock_ledger` is the truth; `stock_snapshot` on the server is a derived projection rebuilt by the `stock-reconcile` worker. Reconciliation on the next client pull overwrites the Dexie snapshot.
**Rationale**: Clerks need a number in front of them, now, to decide whether to ring up the last bowl of soto. Blocking on the server for that number is incompatible with offline. Drift between two offline devices at the same outlet is accepted as a v0 cost; it surfaces at pull time and never affects the server-side ledger.
**Revisit when**: two devices per outlet becomes normal and the drift is user-visible in complaints. Mitigation then is per-device stock locks or a short-polling outlet-level counter.

### ADR-006: BullMQ on Redis is the only async layer; no external broker

**Context**: Background sync of sales could go through a dedicated queue (SQS, Kafka, RabbitMQ).
**Decision**: The client's Workbox queue + the server's BullMQ (Redis-backed) is the entire async layer. No external broker.
**Rationale**: The only asynchrony in v0 is client→server sale pushes (client queue), scheduled maintenance (sync-log purge, nightly rollups), and reconciliation after Midtrans webhooks. BullMQ handles delayed, repeated, and rate-limited jobs with a job UI. Adding an external broker doubles the infra surface for zero benefit at v0 scale.
**Revisit when**: we need to fan out sale events to third-party consumers (accounting export, analytics pipeline) or workers need to span regions.

### ADR-007: QRIS strategy — dynamic via aggregator; static as offline fallback

**Context**: QRIS can be dynamic (per-transaction QR issued by Midtrans) or static (printed merchant QR). Both are official Bank Indonesia QRIS.
**Decision**: Dynamic QRIS is the default when online; static QRIS with manual confirm is the offline fallback.
**Rationale**: Dynamic closes the loop automatically (webhook → tender paid) and is the best clerk UX. Static works fully offline (no server roundtrip to pay) but requires manual confirmation and EOD-time reconciliation against Midtrans settlement. Supporting both covers the full connectivity spectrum at the cost of two code paths in `features/tender/qris`. Acceptable for v0. Midtrans is wrapped by a `payments` service so swapping aggregators (Xendit, DOKU) is a config change, not a rewrite.
**Revisit when**: Bank Indonesia certifies us as a direct QRIS merchant (out of v0 scope) or if static-mode reconciliation becomes a support burden.

### ADR-008: Single TypeScript monorepo, not per-package repos

**Context**: We could split PWA, API, and back-office into separate repos. The earlier v0 draft assumed this.
**Decision**: One pnpm-workspaces monorepo containing `apps/api`, `apps/pos`, `apps/back-office`, and `packages/*`. All licensed AGPL-3.0-or-later; one release cadence.
**Rationale**: The single biggest productivity multiplier in this stack is sharing Zod schemas between the PWA, back-office, and API so a request body type is declared exactly once and typechecked three times. That only works cheaply in a monorepo. Turborepo remote caching keeps CI fast even as packages multiply. The cost is that every change is "visible" to every package, but with strict typecheck and package-boundary rules this is a feature, not a bug.
**Revisit when**: we ship something with a genuinely different release cadence (e.g. an open-source SDK) that deserves its own repo for attention reasons.

### ADR-009: Drizzle + raw SQL migrations, not Prisma

**Context**: Prisma is the "default" ORM; Drizzle is newer.
**Decision**: Drizzle for schema + query building. `drizzle-kit generate` writes plain SQL migrations into `db/migrations/` which run in CI and on deploy.
**Rationale**: SQL we can read in production logs. No Rust query engine binary. Schema is TypeScript — one language across the stack, same as every other slot. Migrations are SQL files we can hand-edit when the generator does the wrong thing (always true in the long run). Prisma's schema DSL and engine would force us back into a separate mental model for the one layer of the stack where the underlying primitives are already standardized.
**Revisit when**: a feature we need (e.g. row-level security helpers) lands first in Prisma and the port is painful.

### ADR-010: No PII in Sentry events

**Context**: Sentry captures crashes with request/state context.
**Decision**: The PWA Sentry SDK is configured with a `beforeSend` that strips buyer-identifying data (name, phone, email) from breadcrumbs, and the API Sentry SDK uses `sendDefaultPii: false`. Sale amounts and item codes are retained as they are necessary for debugging and are not PII under Indonesian PDPA.
**Rationale**: Keeping Sentry out of the PII classification boundary lets us use the paid tier without a separate Data Protection Agreement review for each new merchant. We lose some debug detail; we keep onboarding friction-free.
**Revisit when**: legal review of a specific PII class needs Sentry coverage, or when we move off Sentry.

---

## 7. What Is Explicitly Out of Scope

Mirrors `TECH-STACK.md` §15 but from an architecture POV:

- **No microservices**: the back office is one Fastify process (web) + one worker process of the same image.
- **No GraphQL, no gRPC**: REST + JSON.
- **No websocket / SSE push**: clients pull. Webhooks are the only server-originated events and they terminate on the server, not on the client.
- **No feature flags service (yet)**: GrowthBook is picked but wiring is post-scaffold; until then, behaviour changes ship with a deploy.
- **No A/B experimentation**: v0 has one pilot merchant; statistical power is not available.
- **No data warehouse**: reporting reads directly from Postgres via denormalized rollup tables maintained by BullMQ jobs.
- **No separate analytics pipeline**: Sentry for errors; PostHog for product analytics; Postgres for operational reporting.
- **No background ML, no recommendations, no fraud scoring**: v0 is a system of record, not a system of intelligence.
- **No native iOS/Android apps**, **no SSR**, **no edge compute for API paths**, **no general CRDT runtime**. See `TECH-STACK.md` §15 for the full list.

Every item above has a clear upgrade path if needed; none are on the v0 critical path.

---

## 8. Implementation Order

The architecture must be buildable incrementally. The 30-day plan (mirrored to the milestones in `VISION.md`) is:

1. **M0 — Foundation (Days 1–7)**: monorepo scaffolded; `@kassa/api` Fastify skeleton with `/health` live and every business route returning `501` ([KASA-22](/KASA/issues/KASA-22), shipped); Biome ([KASA-13](/KASA/issues/KASA-13)/[KASA-14](/KASA/issues/KASA-14)), Vitest ([KASA-15](/KASA/issues/KASA-15)/[KASA-16](/KASA/issues/KASA-16)), build ([KASA-17](/KASA/issues/KASA-17)), Fly deploy ([KASA-18](/KASA/issues/KASA-18)/[KASA-19](/KASA/issues/KASA-19)) in place; PWA shell scaffolded with routing, Dexie schema, Sentry; CI green on every package.
2. **M1 — Core API (Days 8–14)**: Drizzle schema and migrations ([KASA-21](/KASA/issues/KASA-21)) for all §3.2 entities; catalog/outlet/stock/sales endpoints implemented ([KASA-23](/KASA/issues/KASA-23)) with shared Zod validation wiring ([KASA-24](/KASA/issues/KASA-24)); device enrolment + staff auth + RBAC ([KASA-25](/KASA/issues/KASA-25), [KASA-26](/KASA/issues/KASA-26)); OpenAPI-from-Zod ([KASA-27](/KASA/issues/KASA-27)); integration tests for Flow A + B ([KASA-28](/KASA/issues/KASA-28)).
3. **M2 — PWA shell (Days 15–21)**: catalog UI, cart, cash tender, sync engine live; PWA works fully offline; transactions reliably push on reconnect; receipts print via `window.print`.
4. **M3 — Multi-outlet + Reconciliation (Days 22–28)**: per-outlet stock snapshot and optimistic decrement; BOM-based consumption on sale commit; QRIS dynamic + static fallback; EOD close + variance report.
5. **M4 — Polish + Launch (Days 29–30)**: Playwright full-day offline acceptance test; onboarding runbook; staging test-day with pilot merchant data; promote to prod.

Each milestone produces a deployable increment; no milestone ends with a non-working system.

---

## Changelog

| Date | Change | Author |
|------|--------|--------|
| 2026-04-22 | v0 initial architecture, written from settled tech stack + vision. | Engineer (KASA-6) |
| 2026-04-22 | Refresh to match current tech stack — Fastify + Node 22 + Postgres + Drizzle + Fly.io; drop residual Frappe/ERPNext references; align route map with shipped `@kassa/api` scaffold. | Engineer ([KASA-51](/KASA/issues/KASA-51)) |
| 2026-04-22 | Review fixup: health endpoint is `/health` (unversioned) per [KASA-22](/KASA/issues/KASA-22) — corrected §2.2, §4.1, §5.4, §5.5, §8. Routes layout is `src/routes/*` with `/v1` applied by `routes/index.ts`. `transaction_event` → `transaction_events` aligned with [TECH-STACK.md](./TECH-STACK.md) §6.3. | Engineer ([KASA-51](/KASA/issues/KASA-51)) |

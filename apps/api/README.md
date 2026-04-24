# @kassa/api

Kassa back-office API. Fastify 5 + TypeScript, per [docs/TECH-STACK.md](../../docs/TECH-STACK.md) §5.

## Status

Scaffold ([KASA-22](/KASA/issues/KASA-22)) plus the device-enrolment pair of endpoints from [KASA-53](/KASA/issues/KASA-53) and the full v0 Drizzle schema + migrations from [KASA-21](/KASA/issues/KASA-21). Every other business endpoint is still a placeholder that returns HTTP 501 with `{ error: { code: "not_implemented", ... } }`. `GET /health` is the only live read endpoint and is intentionally **unversioned** so external uptime monitors ([docs/TECH-STACK.md](../../docs/TECH-STACK.md) §12, line "Synthetic checks on POS shell and API `/health`") never need to track API versions.

The device enrolment endpoints still use an in-memory `EnrolmentRepository`; the Postgres-backed repository (catching `23505` on the `enrolment_codes.code` insert and wrapping `createDevice + consumeEnrolmentCode` in one Drizzle transaction) lands in a follow-up. All enrolment writes already thread `merchantId` and persist `devices.fingerprint` so the swap is a drop-in.

Subsequent issues wire real behaviour in:

- [KASA-23](/KASA/issues/KASA-23) — CRUD endpoints using shared Zod schemas + Postgres-backed enrolment repo.
- [KASA-24](/KASA/issues/KASA-24) — Validation preHandler wiring.
- [KASA-25](/KASA/issues/KASA-25), [KASA-26](/KASA/issues/KASA-26) — Staff session + RBAC (replaces the `STAFF_BOOTSTRAP_TOKEN` shim).
- [KASA-27](/KASA/issues/KASA-27) — OpenAPI-from-Zod.

## Local development

Requires Node.js 22 LTS and pnpm 9+.

```bash
# from repo root
pnpm install

# run the API with hot reload
pnpm --filter @kassa/api dev

# run the smoke tests
pnpm --filter @kassa/api test

# typecheck
pnpm --filter @kassa/api typecheck
```

The server listens on `http://$HOST:$PORT` (defaults: `0.0.0.0:3000`). `GET /health` is mounted at the root for monitor stability; all domain routes live under the `/v1` prefix.

## Configuration

All configuration is via environment variables, validated by Zod on boot. Missing or malformed values exit non-zero before the server starts.

| Var | Default | Notes |
|-----|---------|-------|
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `HOST` | `0.0.0.0` | Bind host. |
| `PORT` | `3000` | Bind port. |
| `LOG_LEVEL` | `info` | Pino log level. |
| `STAFF_BOOTSTRAP_TOKEN` | _unset_ | Min 16 chars. Bearer token that gates `POST /v1/auth/enrolment-codes` until [KASA-25](/KASA/issues/KASA-25) staff sessions ship. When unset, the endpoint returns 503. |
| `ENROLMENT_CODE_TTL_MS` | `600000` | TTL for enrolment codes, in ms. |
| `MIDTRANS_SERVER_KEY` | _unset_ | Midtrans Core API server key. Blank/absent → `POST /v1/payments/webhooks/midtrans` answers 503 `payments_unavailable` instead of crashing boot. **Never** commit. Local sandbox key lives in `.env`; production key comes from Fly secrets (see rotation below). |
| `MIDTRANS_ENVIRONMENT` | `sandbox` | `sandbox` \| `production`. Switches the Midtrans base URL. Sandbox (`api.sandbox.midtrans.com`) for all non-production boots; production (`api.midtrans.com`) only on the `prd` Fly app. |
| `DATABASE_URL` | _unset_ | `postgres://user:pass@host:5432/db`. Optional in `development`/`test` so the enrolment in-memory path still boots; **required** in `production` (boot fails loudly otherwise). Repo swap + migration runner use it; the Fly `release_command` calls `pnpm --filter @kassa/api db:migrate` against it before the new image serves traffic. |
| `DATABASE_SSL` | `true` | Request TLS to Postgres. Neon + Fly Postgres require `true`; flip to `false` for a local loopback test instance. |

## Route map

| Method | Path | Status |
|--------|------|--------|
| GET | `/health` | Live (unversioned, for uptime monitors) |
| POST | `/v1/auth/enrolment-codes` | Live — staff-only, issues an 8-char code bound to an outlet (10-min TTL). |
| POST | `/v1/auth/enroll` | Live — exchanges a code + device fingerprint for `{ deviceId, apiKey, apiSecret, outlet, merchant }`. Rate-limited (10/min/IP, in-memory). |
| POST | `/v1/auth/heartbeat` | 501 |
| POST | `/v1/auth/pin/verify` | 501 |
| POST | `/v1/auth/session/login` | 501 |
| POST | `/v1/auth/session/logout` | 501 |
| GET | `/v1/catalog/items` | 501 |
| GET | `/v1/catalog/items/:itemId` | 501 |
| GET | `/v1/catalog/boms` | 501 |
| GET | `/v1/catalog/uoms` | 501 |
| GET | `/v1/catalog/modifiers` | 501 |
| GET | `/v1/outlets` | 501 |
| GET | `/v1/outlets/:outletId` | 501 |
| GET | `/v1/stock/snapshot` | 501 |
| GET | `/v1/stock/ledger` | 501 |
| POST | `/v1/sales` | 501 |
| GET | `/v1/sales/:saleId` | 501 |
| POST | `/v1/sales/:saleId/void` | 501 |
| POST | `/v1/sales/:saleId/refund` | 501 |
| POST | `/v1/sales/sync` | 501 |
| POST | `/v1/payments/qris` | 501 |
| GET | `/v1/payments/qris/:orderId/status` | 501 |
| POST | `/v1/payments/webhooks/midtrans` | Live — HMAC-SHA512 signature-verified; dedupes by `(orderId, normalized status)` so Midtrans's `capture + settlement` collapses to a single `tender.paid`. 503 `payments_unavailable` when `MIDTRANS_SERVER_KEY` is unset. |
| POST | `/v1/eod/close` | 501 |
| GET | `/v1/eod/report` | 501 |
| GET | `/v1/eod/:eodId` | 501 |

## Payments (Midtrans)

QRIS is the v0 payment rail and Midtrans is the v0 provider; the `@kassa/payments` package exposes a vendor-agnostic `PaymentProvider` interface so switching to Xendit or DOKU later is a configuration change (see [ARCHITECTURE.md](../../docs/ARCHITECTURE.md) ADR-008).

### Environment keys

- **Sandbox (local / staging)**: each engineer creates a personal sandbox account at [dashboard.sandbox.midtrans.com](https://dashboard.sandbox.midtrans.com/) → Settings → Access Keys and drops the server key into `.env` as `MIDTRANS_SERVER_KEY=SB-Mid-server-...`. `MIDTRANS_ENVIRONMENT=sandbox` (the default) keeps traffic on `api.sandbox.midtrans.com` — no real money moves.
- **Production**: the single tenant production server key lives only in Fly secrets on the `prd` app. It is never committed, never in `.env`, and never written to application logs. `MIDTRANS_ENVIRONMENT=production` must be set on the same app.

Set production secrets via:

```bash
fly secrets set -a kassa-api-prd \
  MIDTRANS_SERVER_KEY="Mid-server-…" \
  MIDTRANS_ENVIRONMENT=production
```

Omit both vars on dev/staging-equivalent instances; the webhook route answers `503 { error: { code: "payments_unavailable" } }` and `/v1/payments/qris` is still 501 until KASA-63.

### Webhook configuration

Point the Midtrans merchant console's "Payment notification URL" at `https://<api-host>/v1/payments/webhooks/midtrans`. The handler:

1. Verifies `signature_key = SHA-512(order_id + status_code + gross_amount + serverKey)` with a timing-safe compare; mismatches respond `401 invalid_signature` and emit nothing.
2. Normalizes `transaction_status + fraud_status` to one of `pending | paid | failed | expired | cancelled`.
3. Dedupes by `(order_id, normalized status)`, so Midtrans's `capture → settlement` sequence only emits `tender.paid` once.
4. Emits `tender.status_changed` (always) and `tender.paid` (when normalized to `paid`) on an in-process event bus.

### Key rotation runbook

1. In the Midtrans merchant console, generate a new server key. Midtrans allows two active keys during the rotation window.
2. `fly secrets set -a kassa-api-prd MIDTRANS_SERVER_KEY="<new-key>"` — Fly rolls instances with the new secret.
3. Send a test webhook from the Midtrans dashboard simulator to verify the new key verifies. Watch for `midtrans webhook signature rejected` in the API log; if you see any, the rollout is stuck on an old instance — retry `fly secrets set` or `fly apps restart`.
4. Once green for ≥5 minutes, retire the old key in the Midtrans console.
5. Update the Paperclip ops ticket with the rotation date and the key-ID tail.

Never rotate in the reverse order — retiring first produces signed webhooks the API cannot verify.

## Database

Postgres 16 via Drizzle ORM + `node-postgres`. The schema covers every v0 aggregate in [ARCHITECTURE.md §3.2](../../docs/ARCHITECTURE.md): `merchants`, `outlets`, `staff`, `devices`, `enrolment_codes`, `uoms`, `modifiers`, `items`, `boms` + `bom_components`, `stock_snapshots`, `stock_ledger`, `sales` + `sale_items`, `tenders`, `end_of_day`, `sync_log`, `transaction_events`. One file per aggregate under `src/db/schema/`; generated SQL is committed under `src/db/migrations/`.

Indexes land alongside the schema defs: every tenant-scoped table has a `(merchant_id, updated_at)` delta-pull index; `sales` has the load-bearing `(merchant_id, local_sale_id)` unique idempotency index; `end_of_day` has the `(outlet_id, business_date)` lock tuple; `stock_ledger` has `(outlet_id, item_id, created_at)` for reconciliation scans. Rupiah columns are `bigint` (integer IDR, safe under `Number.MAX_SAFE_INTEGER`); stock quantities are `numeric(18,6)` to represent sub-gram/ml without float drift.

### Scripts

```bash
# Generate a new migration after editing a schema file under src/db/schema/.
pnpm --filter @kassa/api db:generate

# Apply pending migrations against $DATABASE_URL. Idempotent — Drizzle's
# migrator keeps a `drizzle.__drizzle_migrations` table. Runs as Fly's
# `release_command` on deploy.
pnpm --filter @kassa/api db:migrate

# Interactive schema browser (dev only; never point at production).
pnpm --filter @kassa/api db:studio
```

### Testing against a real database

`pnpm --filter @kassa/api test` keeps the fresh-DB migration test in a gated suite that skips when `DATABASE_URL` is unset, so the default test run stays green on machines without Postgres. To exercise the migration against a disposable database:

```bash
# create a throwaway DB first (psql or any client)
createdb kassa_migrate_test

DATABASE_URL=postgres://localhost/kassa_migrate_test \
DATABASE_SSL=false \
pnpm --filter @kassa/api test
```

The suite asserts every expected v0 table lands and that a second `runMigrations` call is a no-op. CI will set `DATABASE_URL` to a per-job Neon branch under a follow-up infra ticket.

## Error contract

Every error response uses the shared shape:

```json
{ "error": { "code": "not_implemented", "message": "Endpoint POST /v1/sales is not implemented yet." } }
```

See `src/lib/errors.ts`. Client is expected to treat 5xx and network errors as retriable; 4xx as terminal (except 409 on idempotency keys once implemented).

## Deployment

Staging (`kassa-api-staging` on Fly.io, region `sin`) deploys automatically on every successful CI run against `main` via [`cd.yml` → `deploy-api-staging`](../../.github/workflows/cd.yml). The Dockerfile and fly.toml travel with the `api-dist` CI artifact so rollback replays the exact infra config each release shipped with — see [docs/CI-CD.md §3.7 and §3.8](../../docs/CI-CD.md) for the full deploy path and rollback runbook.

Migrations apply as Fly's `release_command` (`node apps/api/dist/db/migrate.js`); a failure here aborts the release before any new machine starts serving traffic. The runner is idempotent, so re-deploys do not re-apply already-applied migrations.

Local `flyctl deploy` (rare; prefer `workflow_dispatch`) runs from the **repo root** so the Docker build context has the full workspace:

```bash
# from repo root, with the workspace built (so dist/ is present)
pnpm -r build
flyctl deploy . \
  --app kassa-api-staging \
  --config apps/api/fly.toml \
  --dockerfile apps/api/Dockerfile \
  --local-only
```

Running `flyctl deploy` from `apps/api/` will fail — the Dockerfile needs `pnpm-lock.yaml` and the `packages/` tree, which only exist at the repo root.

Production (`kassa-api`) lands under [KASA-70](/KASA/issues/KASA-70) in M4 with a manual promotion gate.

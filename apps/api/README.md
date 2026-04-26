# @kassa/api

Kassa back-office API. Fastify 5 + TypeScript, per [docs/TECH-STACK.md](../../docs/TECH-STACK.md) §5.

## Status

Scaffold ([KASA-22](/KASA/issues/KASA-22)) plus the device-enrolment pair of endpoints from [KASA-53](/KASA/issues/KASA-53). Every other business endpoint is still a placeholder that returns HTTP 501 with `{ error: { code: "not_implemented", ... } }`. `GET /health` is the only live read endpoint and is intentionally **unversioned** so external uptime monitors ([docs/TECH-STACK.md](../../docs/TECH-STACK.md) §12, line "Synthetic checks on POS shell and API `/health`") never need to track API versions.

The device enrolment endpoints currently use an in-memory `EnrolmentRepository`; the Postgres-backed implementation lands in [KASA-21](/KASA/issues/KASA-21). Drizzle table definitions for `devices` and `enrolment_codes` already live in `src/db/schema/` so KASA-21 only adds the migration runner and connection wiring.

Subsequent issues wire real behaviour in:

- [KASA-21](/KASA/issues/KASA-21) — Drizzle migrations + Postgres connection.
- [KASA-23](/KASA/issues/KASA-23) — CRUD endpoints using shared Zod schemas.
- [KASA-24](/KASA/issues/KASA-24) — Validation preHandler wiring.
- [KASA-25](/KASA/issues/KASA-25), [KASA-26](/KASA/issues/KASA-26) — Staff session + RBAC (replaces the `STAFF_BOOTSTRAP_TOKEN` shim).

OpenAPI-from-Zod ([KASA-27](/KASA/issues/KASA-27)) is wired: every route registers a Zod schema (request body/params and response shapes) which `fastify-type-provider-zod` both validates at runtime and emits as the OpenAPI 3.1 spec served at `/docs/json`. As we replace `notImplemented` placeholders with real handlers the docs update automatically — there is no second copy of the contract to keep in sync.

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

## API documentation

The OpenAPI 3.1 spec is generated from the Zod schemas attached to every route at boot, and Swagger UI is mounted alongside it:

| Path | Returns |
|------|---------|
| `GET /docs` | Rendered Swagger UI (HTML). |
| `GET /docs/json` | OpenAPI 3.1 spec (JSON). |
| `GET /docs/yaml` | OpenAPI 3.1 spec (YAML). |

The spec is the source of truth for the API surface — anything not in `/docs/json` is not part of the contract. To export it to disk:

```bash
pnpm --filter @kassa/api dev &
curl -s http://localhost:3000/docs/json > openapi.json
```

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

## Error contract

Every error response uses the shared shape:

```json
{ "error": { "code": "not_implemented", "message": "Endpoint POST /v1/sales is not implemented yet." } }
```

See `src/lib/errors.ts`. Client is expected to treat 5xx and network errors as retriable; 4xx as terminal (except 409 on idempotency keys once implemented).

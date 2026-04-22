# @kassa/api

Kassa back-office API. Fastify 5 + TypeScript, per [docs/TECH-STACK.md](../../docs/TECH-STACK.md) §5.

## Status

Scaffold only ([KASA-22](/KASA/issues/KASA-22)). Every business endpoint is a placeholder that returns HTTP 501 with `{ error: { code: "not_implemented", ... } }`. `GET /health` is the only live endpoint and is intentionally **unversioned** so external uptime monitors ([docs/TECH-STACK.md](../../docs/TECH-STACK.md) §12, line "Synthetic checks on POS shell and API `/health`") never need to track API versions.

Subsequent issues wire real behaviour in:

- [KASA-21](/KASA/issues/KASA-21) — Drizzle schema + migrations.
- [KASA-23](/KASA/issues/KASA-23) — CRUD endpoints using shared Zod schemas.
- [KASA-24](/KASA/issues/KASA-24) — Validation preHandler wiring.
- [KASA-25](/KASA/issues/KASA-25), [KASA-26](/KASA/issues/KASA-26) — Auth + RBAC.
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

## Route map

| Method | Path | Status |
|--------|------|--------|
| GET | `/health` | Live (unversioned, for uptime monitors) |
| POST | `/v1/auth/enroll` | 501 |
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
| POST | `/v1/payments/webhooks/midtrans` | 501 |
| POST | `/v1/eod/close` | 501 |
| GET | `/v1/eod/report` | 501 |
| GET | `/v1/eod/:eodId` | 501 |

## Error contract

Every error response uses the shared shape:

```json
{ "error": { "code": "not_implemented", "message": "Endpoint POST /v1/sales is not implemented yet." } }
```

See `src/lib/errors.ts`. Client is expected to treat 5xx and network errors as retriable; 4xx as terminal (except 409 on idempotency keys once implemented).

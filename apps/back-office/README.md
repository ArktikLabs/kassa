# @kassa/back-office

Manager-facing admin UI for Kassa. The laptop-first counterpart to the POS PWA — catalog, BOM, outlet, staff, device, and reconciliation surfaces for owners and managers. This is the scaffold shell only: routes, tokens, shared primitives, login stub, and CRUD forms backed by a local store. Wiring to `@kassa/api` (delta-pull queries and mutations) ships in follow-up tickets.

## Run

```bash
pnpm --filter @kassa/back-office dev        # Vite dev server on :5174
pnpm --filter @kassa/back-office build      # Typecheck + production bundle
pnpm --filter @kassa/back-office preview    # Serve the production build on :4174
pnpm --filter @kassa/back-office typecheck
pnpm --filter @kassa/back-office test       # Vitest + RTL unit & component tests
pnpm --filter @kassa/back-office e2e        # Playwright laptop smoke
```

## Stack

- React 19 + TypeScript (strict) on Vite 7
- TanStack Router with code-based typed routes — see `src/router.tsx`
- Tailwind CSS v4 consuming the shared design tokens from `src/styles/tokens.css`
- `react-intl` (Format.JS) with `id-ID` primary / `en` fallback — see `src/i18n/`
- `@sentry/react` browser SDK with the same PII scrubbing as the POS app
- `@kassa/schemas` for shared Zod request/response types (used by the enrolment-code generator in the scaffold store)
- Vitest + jsdom + React Testing Library for unit/component tests; Playwright for golden-path end-to-end smoke

Tokens and fonts come from the same source as `apps/pos` so the two apps stay visually interchangeable. Keep them in sync by editing `docs/DESIGN-SYSTEM.md` and propagating to both `src/styles/tokens.css` files.

## Routes

| Path                         | Audience             | Purpose                                             |
| ---------------------------- | -------------------- | --------------------------------------------------- |
| `/login`                     | All staff            | Email + password sign-in (TECH-STACK §7.1 contract) |
| `/outlets`                   | Owner / manager      | Outlet CRUD, receipt header & tax profile, enrolment code issuance |
| `/catalog`                   | All authenticated    | Catalog CRUD with price, UoM, stock flag, activation |
| `/catalog/boms`              | All authenticated    | BOM CRUD (parent item + components + effective range) |
| `/staff`                     | Owner / manager      | Staff CRUD with role + PIN, reset PIN flow         |
| `/devices`                   | Owner / manager      | Enrolment code generator + device revoke            |
| `/reports/reconciliation`    | Owner / manager      | Static-QRIS reconciliation report (M3)              |

Guards are implemented as synchronous `beforeLoad` redirects against a localStorage session. When the real auth endpoint lands the guard swaps to a server check without changing route shape.

## Design primitives

- `DataTable` implements DESIGN-SYSTEM §6.13: sticky header, divider rows, numeric/tabular cells, row-hover + selected-row affordance, footer pagination.
- `Modal` implements §6.10: centered, 560px, ESC closes, focus-trapped, first focusable element focused on open.
- `Button`, `Field`, `TextInput`, `SelectInput`, `Checkbox` round out the form surface.

## Data store

`src/data/store.ts` is a thin reactive state container with localStorage persistence and a seed so every CRUD screen renders a realistic table on first load. It exposes `subscribe`/`getSnapshot` for `useSyncExternalStore` and per-resource CRUD helpers. When the delta-pull endpoints land, the store gets replaced by a TanStack Query wrapper with the same hook signatures.

## Bundle budget

Back-office JS budget: **< 350 KB gzipped** per KASA-67 acceptance criteria (looser than POS because it's laptop-first). Current production build stays well under budget at the scaffold stage; track the number as features land.

## i18n

Bahasa Indonesia is the primary copy; English is a switchable secondary. All user-visible strings go through `<FormattedMessage id="…">` from day one.

## Error tracking

`src/lib/sentry.ts` mirrors the POS app's PII posture (ARCHITECTURE.md ADR-010) — `sendDefaultPii: false`, cookies/headers stripped, and a `beforeSend`/`beforeBreadcrumb` scrubber masks Indonesian phone numbers, emails, Jl./Gg./No. addresses, and 12+ digit runs. Session replay is disabled. Set `VITE_SENTRY_DSN` at build time to enable reporting.

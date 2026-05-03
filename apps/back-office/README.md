# @kassa/back-office

Manager-facing admin UI for Kassa. The laptop-first counterpart to the POS PWA — catalog, BOM, outlet, staff, device, and reconciliation surfaces for owners and managers. The shell is wired to `@kassa/api` for staff session login (`POST /v1/auth/session/login`); the rest of the routes still read from the local scaffold store and swap to delta-pull queries in follow-up tickets.

## API base URL

The back-office reads the API host from `VITE_API_BASE_URL` (Vite build-time env). Set it at build/deploy time:

- **Local dev**: add `VITE_API_BASE_URL=http://localhost:3000` to `.env.local` (the API listens on :3000 by default).
- **Cloudflare Pages**: set the variable in the project's Production and Preview environments under *Settings → Environment variables*; the value should point at the API for that environment (prod: `https://kassa-api-prod.fly.dev`).

When the variable is empty the login screen surfaces a clear "API URL is not configured" error so ops can spot a misconfigured deploy without digging through devtools.

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
| `/login`                     | All staff            | Email + password sign-in (ARCHITECTURE §4.1 contract) |
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

## Preview deployments

Every pull request against `main` produces a back-office preview at `https://pr-<N>.kassa-back-office.pages.dev` via [`cd-preview.yml`](../../.github/workflows/cd-preview.yml). The preview alias is **public on `*.pages.dev`** — Cloudflare Pages does not gate preview URLs behind authentication. This is acceptable for M0 because the back-office shell carries no tenant data until a merchant is onboarded, but it means:

- **Do not share preview URLs externally** until the real auth lands. Reviewers and the team are the audience.
- **Do not seed the preview DB with realistic data.** The PR's Neon branch is parented off `main`, which itself only carries seeded fixtures pre-pilot; treat anything in the preview as throwaway.
- **Static assets, source code, and bundle behaviour are observable.** Anyone with the URL can read the JS bundle. No new secret material should be embedded in the build (the `VITE_*` channel is build-time-public by Vite's design).

When the staff-only auth surface lands, this caveat retires: the preview will require a login the same way production does, and the public URL becomes a non-issue.

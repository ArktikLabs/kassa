# @kassa/pos

Offline-first PWA the clerk runs at the counter. This is the app shell only — routing, tokens, locale, and service-worker wiring. Business logic (catalog sync, cart, tender, receipts, enrolment) ships in follow-up tickets.

## Run

```bash
pnpm --filter @kassa/pos dev        # Vite dev server on :5173 (SW disabled in dev)
pnpm --filter @kassa/pos build      # Typecheck + production bundle + SW precache
pnpm --filter @kassa/pos preview    # Serve the production build on :4173
pnpm --filter @kassa/pos typecheck
pnpm --filter @kassa/pos test       # Vitest + RTL smoke + Sentry scrubbing tests
```

## Stack

- React 19 + TypeScript (strict) on Vite 7
- TanStack Router for code-based, typed routes (see `src/router.tsx`)
- Tailwind CSS v4 (`@tailwindcss/vite`) consuming CSS custom properties from `src/styles/tokens.css`
- `vite-plugin-pwa` with `injectManifest` strategy, SW source at `src/sw.ts`
- `react-intl` (Format.JS) with `id-ID` primary / `en` fallback — see `src/i18n/`
- `@sentry/react` browser SDK with conservative PII scrubbing — see `src/lib/sentry.ts`
- Vitest + jsdom + React Testing Library for unit/component tests

See [`docs/TECH-STACK.md`](../../docs/TECH-STACK.md) §3 and [`docs/DESIGN-SYSTEM.md`](../../docs/DESIGN-SYSTEM.md) for rationale.

## Routes

| Path           | Purpose                                    |
| -------------- | ------------------------------------------ |
| `/`            | Redirect to `/catalog` if enrolled, else `/enrol` |
| `/enrol`       | Device enrolment                           |
| `/catalog`     | Product tile grid                          |
| `/cart`        | Cart composition                           |
| `/tender/cash` | Cash keypad + change calculation           |
| `/receipt/:id` | Rendered receipt for a completed sale      |
| `/admin`       | Outlet / cashier / device settings         |

## Design tokens

`src/styles/tokens.css` declares the DESIGN-SYSTEM §2–§4 tokens inside Tailwind v4's `@theme` block, which both publishes them as CSS custom properties on `:root` and generates matching utilities (`bg-primary-600`, `text-neutral-800`, `shadow-md`, `rounded-lg`, …). Reference tokens by name, never by hex.

## Fonts

Plus Jakarta Sans and JetBrains Mono must be self-hosted (DESIGN-SYSTEM §3.1 — the PWA works offline, we do not depend on the Google Fonts CDN at runtime). `@font-face` declarations in `src/styles/fonts.css` reference `/fonts/plus-jakarta-sans-var.woff2` and `/fonts/jetbrains-mono-var.woff2` with `font-display: swap`. The variable WOFF2 binaries themselves are vendored in a follow-up ticket; until then the `font-display: swap` fallback renders Plus Jakarta Sans → Inter → system-ui.

## i18n

Bahasa Indonesia (id-ID) is the primary copy; English is a switchable secondary. Inline message catalogues live in `src/i18n/messages.ts`; the provider in `src/i18n/IntlProvider.tsx` negotiates locale from `navigator.languages` with id-ID as the default. All user-visible strings go through `<FormattedMessage id="…">` from day one so we never ship copy that can't be translated.

## Error tracking

`src/lib/sentry.ts` initialises `@sentry/react` only when `VITE_SENTRY_DSN` is set, so dev and CI run silent. PII posture: `sendDefaultPii: false`, cookies/headers stripped from request payloads, and a `beforeSend`/`beforeBreadcrumb` scrubber masks Indonesian phone numbers, email addresses, street addresses (`Jl. / Gg. / No.`), and any 12+ digit run that could be a card or bank account number. Session replay is disabled — the clerk's screen contains attached-customer PII.

Set `VITE_SENTRY_DSN` and (optionally) `VITE_RELEASE` at build time to enable reporting.

## PWA

`vite-plugin-pwa` generates `manifest.webmanifest` from the Vite config and precaches the app shell via `src/sw.ts`. Runtime caching strategies (catalog images `CacheFirst`, allow-listed `GET /api/...` reads, …) land in this file as each feature arrives. Icons live at `public/icons/icon-{192,512,maskable-512}.svg` in Kassa primary teal (`#0D9488`).

## Bundle budget

Shell JS budget: < 220 KB gzipped (informational at M2). Current production build: ~108 KB gzipped. Watch this number as features land.

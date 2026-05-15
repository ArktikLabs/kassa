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

## Performance budgets

POS ships under three CI budgets (see [`docs/CI-CD.md`](../../docs/CI-CD.md) §8 for the full contract). The first two are **blocking**; Lighthouse is informational, and the RUM harness is telemetry, not a gate.

| Slice                                                              | Budget (gzip) | Tooling          | Source of truth                            |
| :----------------------------------------------------------------- | :------------ | :--------------- | :----------------------------------------- |
| Initial route — main JS + main CSS chunks                          | 200 KB        | `size-limit`     | [`.size-limit.json`](./.size-limit.json)   |
| Total route-loaded JS — every hashed JS chunk in `dist/assets/`    | 350 KB        | `size-limit`     | [`.size-limit.json`](./.size-limit.json)   |
| Lighthouse mobile (Performance ≥ 0.9, A11y ≥ 0.95, Best-Practices ≥ 0.95, PWA ≥ 0.9; LCP ≤ 2.5s, TBT ≤ 200ms, CLS ≤ 0.1) | — | `@lhci/cli` v11 | [`lighthouserc.json`](./lighthouserc.json) |

Run them locally:

```bash
pnpm --filter @kassa/pos build             # produces dist/
pnpm --filter @kassa/pos size              # asserts both .size-limit.json budgets
```

### Reading CI output

The PR check **Bundle-size budget (apps/pos)** in `.github/workflows/perf-budgets.yml` runs the same `pnpm --filter @kassa/pos size` against the production build. On overage, `size-limit` prints the slice name, the limit, the measured size, and the delta, and exits non-zero — the check goes red and the PR is merge-blocked. Sample failure output:

```
POS initial route — main JS + main CSS (gzip)
Package size limit has exceeded by 343.92 kB
Size limit: 200 kB
Size:       543.92 kB gzipped
```

The fix is either to reduce the regressing import (code-split, lazy-load, dynamic `import()`) or to raise the budget via the procedure in [`docs/CI-CD.md`](../../docs/CI-CD.md) §8.5 (PO sign-off required).

The PR check **Lighthouse CI (apps/pos)** uploads a temporary public artifact for each run; failures link to the full Lighthouse report. Lighthouse is currently informational because GitHub-runner variance is large enough to flake a `≥ 0.9` perf threshold — treat it as a per-PR signal, not a gate (see §8.4 for the rationale).

### Real-user Web Vitals (RUM)

`src/lib/web-vitals.ts` lazy-loads the `web-vitals` package after first paint and reports **LCP / INP / CLS** as Sentry breadcrumbs + info-level events. No-op when `VITE_SENTRY_DSN` is unset. This complements the synthetic Lighthouse run with real-merchant numbers; it is not a CI gate.

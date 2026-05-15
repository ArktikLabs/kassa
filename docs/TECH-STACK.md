# Kassa Tech Stack v0

Status: v0 (MVP, 30-day window). Owner: Engineer. Linked issues: [KASA-5](/KASA/issues/KASA-5), [KASA-51](/KASA/issues/KASA-51), [KASA-80](/KASA/issues/KASA-80).
Companion docs: [ARCHITECTURE.md](./ARCHITECTURE.md), [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md), [../README.md](../README.md).

This document is the decisive rationale for every technology choice in Kassa v0. [README.md](../README.md) lists the stack as a table; [ARCHITECTURE.md](./ARCHITECTURE.md) describes how the pieces fit together and names the architectural decisions; this file explains **why each slot was filled the way it was**, what we considered instead, and when we'd revisit. If a fact in this file disagrees with README or ARCHITECTURE.md, those win — the shape of the system is the source of truth; this is the commentary.

Every choice below earns its place by serving the v0 goal statement: **a merchant onboards, configures catalog and BOMs across multiple outlets, processes sales transactions on an unreliable network for a full business day, and performs end-of-day close without support intervention.**

---

## 1. Scope and non-goals of this document

This document:

- Names the specific tool, version floor, and rationale for each slot in the stack.
- Lists the credible alternatives considered and why they were not picked.
- Declares v0 deferrals in §15 so that "we considered it and said no, for now" is unambiguous.

This document **does not**:

- Repeat the full repository layout (see [README.md](../README.md) §Repository Layout and §10 below for the decisive summary).
- Repeat the full route map or data flow (see [ARCHITECTURE.md](./ARCHITECTURE.md) §3 and [apps/api/README.md](../apps/api/README.md)).
- List runtime library versions (see each package's `package.json`).

## 2. Shared language and runtime

### 2.1 TypeScript 5.x (strict)

**Pick**: TypeScript 5.x, `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`.
**Rationale**: One language across the full stack — POS PWA, back-office API, background workers, shared schemas, infra scripts — cuts the context-switch tax to zero and lets us share Zod schemas (see §4) as first-class types across network boundaries. Strict mode is not optional: half-typed code around money and stock is the same as untyped code in the parts that matter.
**Alternatives**: Plain JS (loses the cross-tier type contract), Kotlin/Server + TS/Client (two languages, two build toolchains, zero upside at v0 scale), Rust on the server (great language, wrong cost/benefit when the team is TS-native and the workload is not CPU-bound).
**Revisit when**: a workload appears that typed JavaScript cannot meet — none in v0.

### 2.2 Node.js 22 LTS

**Pick**: Node.js 22 LTS. `engines.node: ">=22.0.0"` is enforced at the workspace root.
**Rationale**: Current LTS, stable `fetch`, native test runner available as a fallback, best `undici` perf, first-class ESM. One version across API, workers, and tooling; no nvm juggling.
**Alternatives**: Bun (not yet a supported Fastify target at production maturity; we'd rather not own the "why did our payments webhook crash on Bun" debug tree in v0), Deno (ecosystem mismatch with our Node-first dependency tree), Node 20 LTS (end-of-life sooner; no v0 feature we need is 20-only).
**Revisit when**: Node 22 exits LTS, or a workload we ship (e.g., PDF rendering, heavy WASM) benefits from Bun's FFI story enough to justify the switch.

### 2.3 pnpm 9 workspaces

**Pick**: pnpm 9 as the package manager and workspace engine. `packageManager: "pnpm@9.12.0"` is pinned in `package.json`.
**Rationale**: Content-addressable store keeps CI fast and disk use sane once the monorepo grows past 3 packages. Strict hoisting discipline catches phantom-dependency bugs we'd pay for later.
**Alternatives**: npm workspaces (hoisting model permits phantom deps), Yarn 4 (no meaningful advantage; more moving parts for a team with zero Yarn muscle memory).
**Revisit when**: unlikely. pnpm + Turborepo is the default path for this stack shape.

---

## 3. POS client runtime

The POS PWA is the merchant's ten-hour-a-day surface. Every choice here is weighted toward (a) working fully offline, (b) never losing a transaction, and (c) shipping a bundle small enough to boot fast on the cheapest Android tablet we'd bless. [apps/pos/README.md](../apps/pos/README.md) carries the operational details; this section is the rationale.

### 3.1 React 19 + TypeScript 5

**Pick**: React 19, functional components only, hooks-based.
**Rationale**: The ecosystem mass around React (Tailwind, Headless UI, TanStack, Sentry browser SDK, React Testing Library) is the real deliverable. React 19 fixes enough of the stale-closure and transition-priority footguns we used to paper over with `useEffect` gymnastics to make the upgrade worth taking on day one.
**Alternatives**: Preact (swappable, but the Tailwind v4 + Headless UI + TanStack Router combo is React-first and the bytes saved don't change the bundle budget meaningfully), Vue 3 / Svelte 5 (excellent frameworks, wrong for a team with React reps).
**Revisit when**: bundle budget becomes dominated by React itself (it is not — see §3.2 numbers in `apps/pos/README.md`).

### 3.2 Vite 7

**Pick**: Vite 7 for dev server and production build.
**Rationale**: Near-instant HMR, first-class TypeScript, first-class PWA plugin, and a production Rollup build that tree-shakes aggressively. Config is the `vite.config.ts` we'd write anyway.
**Alternatives**: Next.js (SSR/RSC are overhead we don't want — the PWA is static, offline-first, and does not need server rendering), Remix (same critique), Webpack (slow, large config surface, Vite eats its lunch on this workload).
**Revisit when**: we ship a feature that needs SSR (marketing site, buyer-facing pages) — that stays on its own repo or framework and does not drag the POS bundle.

### 3.3 TanStack Router (code-based, typed)

**Pick**: TanStack Router with code-based route definitions (no file-system routing). Route tree lives in `src/router.tsx`.
**Rationale**: Full-path TypeScript inference on params and loaders, first-class `preload`/`prefetch` semantics for offline-before-online flows, and search-param schemas validated at the router boundary. Code-based routes are trivial to grep and refactor; file-based routes become a magic-folder convention the next new contributor has to learn.
**Alternatives**: React Router v6 (functional but weaker type story; no equivalent to TanStack's typed search-param schemas), Next's App Router (implies Next; see §3.2).
**Revisit when**: typed file-system routing becomes idiomatic in React 19 core and matches TanStack's type depth.

### 3.4 TanStack Query

**Pick**: TanStack Query for all server cache.
**Rationale**: The abstraction exists precisely for our problem shape: paged pulls with cursors, background refetch, retry-with-backoff, and a cache that survives route changes. Offline-aware (`networkMode: "offlineFirst"`), pairs cleanly with the Workbox background-sync queue (§3.8), and is Zod-parsed at every boundary so a bad server response is a crash, not a silent cache mutation.
**Alternatives**: SWR (less flexible retry/concurrency story), Redux Toolkit Query (more ceremony, larger surface than we need).
**Revisit when**: we outgrow the hook-per-endpoint model — not expected in v0.

### 3.5 Zustand (UI / cart state)

**Pick**: Zustand for client-owned state — cart, UI chrome, sync status, tender composition.
**Rationale**: Minimal boilerplate, no provider tree, selector-based re-renders, typed store composition. Pairs with TanStack Query's strict server-vs-client split.
**Alternatives**: Redux Toolkit (we don't need time-travel or middleware at v0 scale), Jotai/Recoil (atom-style models are elegant but the cart is a mutable machine, not a graph of atoms).
**Revisit when**: cart state machine grows complex enough to want XState; at that point we'd introduce XState *below* Zustand, not replace it.

### 3.6 IndexedDB via Dexie 4

**Pick**: Dexie 4 as the typed wrapper around IndexedDB. One file per local table under `src/data/db/`.
**Rationale**: IndexedDB is the only browser-native store that survives tab close, reload, and offline. Dexie gives us a typed schema, versioned migrations, efficient compound indexes, and a transactional API that matches what our sale commit actually needs (write sale + tender + optimistic stock decrement inside one tx). Reading raw IDB is possible and miserable.
**Alternatives**: LocalStorage (too small, synchronous, no indexes), RxDB (full sync engine — too much for our write-ahead queue model per [ARCHITECTURE.md](./ARCHITECTURE.md) ADR-002), PouchDB (pairs with CouchDB, which we are not running).
**Revisit when**: we ever need symmetric replication — at which point the "which CRDT-ish engine" conversation reopens.

### 3.7 Tailwind CSS v4 + Lucide icons

**Pick**: Tailwind CSS v4 via `@tailwindcss/vite`. Design tokens declared once in `src/styles/tokens.css` inside the `@theme` block; Tailwind generates matching utilities (`bg-primary-600`, etc.). Icons: Lucide React.
**Rationale**: Tokens live in one place that both CSS custom properties and Tailwind utilities read from — no parallel `tailwind.config.ts` drifting from `tokens.css`. Lucide is tree-shakable, consistent in stroke weight, and permissively licensed.
**Alternatives**: Tailwind v3 (older token model, doesn't play as well with CSS custom properties), CSS modules + hand-rolled tokens (works, but every component hand-wires its own tokens and drift is inevitable), styled-components / Emotion (runtime cost and SSR considerations we don't want).
**Revisit when**: Tailwind v5 ships a token story we prefer.

### 3.8 Service worker — Workbox via `vite-plugin-pwa` (`injectManifest`)

**Pick**: `vite-plugin-pwa` in `injectManifest` mode; service worker source at `apps/pos/src/sw.ts`. Strategies:
- **App shell**: precached (static asset manifest injected at build time).
- **Catalog images** (`/img/*`): `CacheFirst`, 30-day max, bounded entry count.
- **Catalog GETs** (`/v1/catalog/*`, `/v1/outlets*`, `/v1/stock/snapshot`): `StaleWhileRevalidate` with a short max-age — reads are fine stale for a few minutes; the sync engine pulls fresh in the background.
- **Sale writes** (`/v1/sales*`): `BackgroundSyncPlugin` queue, durable across browser restarts, replayed when online.
- **Auth / webhook / analytics**: always network, never cached.

**Rationale**: Workbox is the most battle-tested SW toolkit, and `injectManifest` keeps the SW *source* in our repo (reviewable, testable) while still letting the build inject the hashed asset list. `BackgroundSyncPlugin` is exactly the durable retry queue we'd have to write by hand otherwise, and it survives the tab being closed mid-queue.

We deliberately use `injectManifest`, not `generateSW`: the SW is complex enough (sale retry semantics, cache rotation policy) that code in a TS source file reviewed like any other is less risk than config-file magic.

**Alternatives**: Rolling our own SW (we've done it; it's always wrong on at least one of Android's weird edge cases), Firebase Messaging SW (not our use case).
**Revisit when**: Workbox is abandoned upstream, or the browser standard for background sync stabilizes enough that we can drop the polyfill layer.

### 3.9 Internationalization — `react-intl` (Format.JS)

**Pick**: `react-intl` with inline message catalogues in `src/i18n/messages.ts`. Primary locale `id-ID`, fallback `en`.
**Rationale**: Every user-visible string goes through `<FormattedMessage>` from day one — we never ship copy that can't be translated. ICU MessageFormat handles Indonesian pluralization cleanly; number and currency formatting use the browser's Intl API. Locale is negotiated from `navigator.languages` with `id-ID` as the default.
**Alternatives**: i18next (good; react-intl won on ICU quality + bundle), LinguiJS (nice ergonomics; smaller ecosystem).
**Revisit when**: we need extract-to-translator tooling more sophisticated than Format.JS's CLI.

---

## 4. Validation and forms

### 4.1 Zod (boundary validation everywhere)

**Pick**: Zod as the single schema tool. Request/response schemas, env validation, and sync-boundary validation all use Zod. Schemas live in `packages/schemas` (shared between API, PWA, back-office) once that package lands; until then they live in `apps/api/src/schemas/` and are imported where needed.
**Rationale**: One schema declaration → TypeScript type + runtime validator + (via `zod-to-openapi`) the OpenAPI spec. No second copy. No manual type/validator drift. This is the single biggest productivity multiplier in the whole stack and the reason the monorepo decision (§10) pays for itself.
**Alternatives**: io-ts (fp-ts-adjacent, more ceremony), Yup (weaker TS inference), hand-rolled type guards (unverifiable, error-prone).
**Revisit when**: a newer schema library ships a better OpenAPI emit story and a painless migration. Unlikely in v0.

### 4.2 React Hook Form

**Pick**: React Hook Form + `@hookform/resolvers/zod`.
**Rationale**: Uncontrolled-input performance, minimal re-renders, and the Zod resolver means the form validation is the same Zod schema the API validates on submit.
**Alternatives**: Formik (larger, slower), hand-rolled (re-renders everywhere, bad UX on the tender keypad).
**Revisit when**: React 19 native form actions mature enough to replace an external form library for our CRUD shapes.

---

## 5. Back-office API

Referenced from [apps/api/README.md](../apps/api/README.md) line 3.

### 5.1 Fastify 5

**Pick**: Fastify 5 as the HTTP framework. All routes under `/v1` (see `GET /health` carve-out in §12.4 and [apps/api/README.md](../apps/api/README.md)).
**Rationale**: Fastest mainstream Node HTTP framework; schema-first plugins (`fastify-type-provider-zod`) auto-validate requests and auto-emit OpenAPI; Pino logging built in; plugin system cleanly separates concerns (auth, rate-limit, CORS, tenant scope) into files that own one concern each. Error handling has one hook, not six.
**Alternatives**: Express (slower, weaker types, needs middleware zoo for schema validation), Koa (middleware-chain style we do not want), Hono (great on edge, not our target — we deploy on Fly VMs, not Workers), NestJS (DI framework we don't need; convention-over-configuration costs a learning tax and buys us nothing over Fastify + plugins).
**Revisit when**: we ever deploy on edge runtimes — at which point Hono becomes interesting, but we'd keep Fastify for the long-running VM path and let the two coexist.

### 5.2 Process model (web + worker in one image)

**Pick**: A single Docker image that runs one of two entrypoints — the Fastify web server (`node dist/server.js`) or the BullMQ worker (`node dist/workers/index.js`). Fly.io's `[processes]` section in `fly.toml` runs both from the same image with different commands.
**Rationale**: One image to build, one image to deploy; two processes so a slow job doesn't back up HTTP. Shared code (services, DB client, schemas) is imported by both. No network hop for a business flow that does not need one.
**Alternatives**: Separate images per process (duplicate build, duplicate deploy story for zero isolation benefit), in-process workers inside the web server (backpressure risk — we don't want a slow EOD rollup starving the `/v1/sales` hot path).
**Revisit when**: worker workload grows heterogeneous enough that one-image-many-processes is awkward — not in v0.

### 5.3 Logging — Pino (JSON)

**Pick**: Pino, JSON output, `info` default, `debug` in dev. Structured context carries `request_id`, `merchant_id`, `outlet_id`, `staff_id` where available. No PII in log fields.
**Rationale**: Fastify ships Pino native; JSON logs parse everywhere a log aggregator ever will; zero-cost when disabled.
**Alternatives**: Winston (slower, ergonomics weaker under load), console.log (not searchable, not leveled).
**Revisit when**: we move to a provider that wants OpenTelemetry logs natively — Pino has a bridge.

### 5.4 OpenAPI 3.1 from Zod

**Pick**: `zod-to-openapi` + Fastify's OpenAPI plugin. Specs are generated at boot from the same Zod schemas used for request/response validation.
**Rationale**: We never publish a spec that lies about the implementation because the implementation is the spec's source. Saves the "update the spec, forget to update the code" failure mode outright.
**Alternatives**: Hand-written OpenAPI YAML (drifts the second we change a schema), code-first annotations (`@Body()` etc.) — works in Nest but not where Zod is the boundary.
**Revisit when**: OpenAPI 4 lands and the tool chain moves.

---

## 6. Database and persistence

### 6.1 PostgreSQL 16 on Neon (Singapore)

**Pick**: PostgreSQL 16 hosted on Neon in the Singapore region.
**Rationale**: Postgres is the default relational store for a reason — ACID, strong indexes, rich types (`jsonb`, `timestamptz`, arrays), `ON CONFLICT` for our idempotency keys, and `pg_stat_statements` when we need to tune. Neon is Singapore-regional (latency-appropriate for Indonesian merchants), has branching on PR (cheap preview environments), and scales to zero between tests. Version 16 gives us `JSON_TABLE`, logical replication improvements, and multi-level partitioning headroom for `sale` and `stock_ledger` without further upgrade pressure in v0.
**Alternatives**: MySQL / MariaDB (weaker JSON and type story, our schema needs `jsonb`), CockroachDB / Yugabyte (distributed SQL is a v1+ concern), SQLite on server (single-writer, not compatible with multi-process + worker model), DynamoDB (document model forces us to re-normalize for ledger queries).
**Revisit when**: a multi-region story appears — unlikely in v0.

### 6.2 Drizzle ORM + drizzle-kit

**Pick**: Drizzle ORM for schema and queries. `drizzle-kit generate` emits plain SQL migrations into `apps/api/db/migrations/`; they run forward-only in CI and on deploy.
**Rationale**: SQL we can read in production logs. No Rust query engine binary. Schema is TypeScript — one language across the stack. Migrations are SQL files we can hand-edit when the generator does the wrong thing (always true eventually). See [ARCHITECTURE.md](./ARCHITECTURE.md) ADR-009 for the full rationale.
**Alternatives**: Prisma (separate schema DSL, Rust engine binary, less ergonomic when we want to hand-write SQL for a migration fixup), Knex + raw SQL (no type safety over the schema), TypeORM (heaviest DI surface, actively the wrong shape for this team).
**Revisit when**: a feature we need (e.g., row-level security helpers) lands first in Prisma and the port is painful.

### 6.3 Schema conventions

- One Drizzle schema file per domain aggregate (`merchant.ts`, `outlet.ts`, `item.ts`, `bom.ts`, `sale.ts`, `stock.ts`, `tender.ts`, `eod.ts`, `auth.ts`, `sync_log.ts`, `transaction_events.ts`).
- Primary keys are UUIDv7 unless otherwise justified.
- Every tenant-owned row carries `merchant_id` (see [ARCHITECTURE.md](./ARCHITECTURE.md) ADR-003).
- Money is `bigint` (integer IDR) in Postgres, branded `Rupiah` in TS.
- Timestamps are `timestamptz` (UTC at the wire); `business_date` on `sale` is the outlet's local calendar date.
- Client-originated writes carry an idempotency `local_*_id` with `UNIQUE (merchant_id, local_*_id)` (see [ARCHITECTURE.md](./ARCHITECTURE.md) ADR-004).

---

## 7. Async jobs — BullMQ on Redis 7

**Pick**: BullMQ on Redis 7 is the entire async layer. Workers live in `apps/api/src/workers/` and run as a separate Fly process (§5.2). Jobs in v0: `sales-sync`, `eod-rollup`, `stock-reconcile`, `sync-log-purge`.
**Rationale**: Delayed jobs, retries with backoff, repeating schedulers, and a job UI in a single library. Redis is already useful for rate-limiting and session cache — no new infrastructure. No external broker means one less AWS account, one less IAM policy, one less cost line.
**Alternatives**: SQS (great queue, bad ergonomics for our use case — cron-like repeat jobs, retry policies, and job inspection need bolt-ons), Kafka (massive overkill for the sub-1k msg/sec flows v0 will see), Rabbitmq (another daemon to operate for no gain), pg-boss (Postgres-backed queues; decent, but we'd lose the Redis rate-limit reuse).
**Revisit when**: we need cross-region or cross-tenant fan-out; see [ARCHITECTURE.md](./ARCHITECTURE.md) ADR-006.

---

## 8. Payments — Midtrans Core API (QRIS)

**Pick**: Midtrans Core API as the QRIS aggregator; dynamic QRIS online, static QRIS as offline fallback.
**Rationale**: Midtrans is the most widely-adopted QRIS aggregator among Indonesian merchants, handles settlement to merchant bank accounts, and has webhook semantics we can reason about. Dynamic QRIS (server issues a per-transaction QR) closes the loop via webhook → tender paid — ideal UX. Static QRIS (merchant prints one QR and the clerk confirms) works fully offline and reconciles at EOD against the Midtrans settlement report.
**Alternatives**: Xendit (comparable; Midtrans chosen on pricing and merchant-network coverage — trivial to swap, we wrap Midtrans behind a `payments` service), DOKU (same pattern), direct Bank Indonesia QRIS (we are not a direct acquirer in v0 and never will be without a compliance story).
**Revisit when**: a single merchant's volume makes the aggregator margin material — at that point we evaluate a second aggregator as a fallback, not a replacement.

---

## 9. Frontend design system and icons

The visual foundation (colors, type scale, spacing, components) is owned by [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md) and [BRAND-IDENTITY.md](./BRAND-IDENTITY.md). Tooling choices here are the *implementation* of those tokens.

- **Tokens**: declared once in `apps/pos/src/styles/tokens.css` inside Tailwind v4's `@theme` block. Never refer to tokens by hex; always by name.
- **Fonts**: Plus Jakarta Sans (sans) and JetBrains Mono (mono), self-hosted as variable WOFF2 at `apps/pos/public/fonts/` (vendored in [KASA-76](/KASA/issues/KASA-76)). No Google Fonts CDN at runtime — the PWA must work offline.
- **Icons**: Lucide React for UI glyphs; Kassa brand marks in `docs/brand/` (SVG only).
- **Primitives**: Headless UI for accessible interactive primitives (dialog, combobox, listbox); tokenized in Tailwind utilities, not styled with prose CSS.

---

## 10. Repository and package layout

### 10.1 Monorepo layout

A single TypeScript monorepo. pnpm 9 workspaces are the engine; Turborepo is the task runner (added in a later ticket — today `pnpm --filter` runs the scripts directly).

```
.
├── apps/
│   ├── api/                  # Fastify back-office API (KASA-22) + BullMQ workers
│   └── pos/                  # POS PWA (KASA-55, in review)
├── docs/                     # TECH-STACK, ARCHITECTURE, DESIGN-SYSTEM, BRAND-IDENTITY
├── legal/                    # ICLA, CCLA, NOTICE helpers
├── package.json              # Workspace root; engines.node ≥ 22
├── pnpm-workspace.yaml
└── README.md
```

**Planned additions as tickets land** (all under the same monorepo, same AGPL-3.0-or-later license, one release cadence):

```
apps/
  back-office/                # Staff admin UI (Vite + React + Tailwind, static)
packages/
  schemas/                    # Shared Zod request/response schemas (API + POS + back-office)
  ui/                         # Shared design-system primitives
  icons/                      # Icon wrappers
  config/                     # Shared tsconfig / eslint / biome bases
```

**Decisive rationale** (expanded in [ARCHITECTURE.md](./ARCHITECTURE.md) ADR-008): the single biggest productivity multiplier in this stack is sharing Zod schemas between the PWA, back-office, and API so a request body type is declared exactly once and typechecked three times. That only works cheaply in a monorepo. Turborepo remote caching keeps CI fast even as packages multiply. The cost — every change is visible to every package — is mitigated by strict typecheck and package-boundary rules; it is a feature for a v0 team with high cross-cutting change velocity.

### 10.2 Dependency policy

- **No dependency that is not on at least one of npm's Maintained / Popular / High-Quality signals** unless there is a written reason in the commit introducing it.
- **No patch-level pins unless required for a security advisory.** Minor-range (`^`) for first-party libraries we trust; exact-pin for anything security-critical (`zod`, `fastify`, `pino`, `@sentry/*`, `drizzle-orm`).
- **One version of React, one version of TypeScript, one version of Zod across the monorepo**, enforced by pnpm's `overrides` in the root `package.json` when drift appears.
- **Security scanning**: `pnpm audit` in CI; `gitleaks` in CI; Renovate (or Dependabot) for the automated bump PR cadence once infra is set up.

### 10.3 Licensing

- Kassa is **AGPL-3.0-or-later** (see [LICENSE](../LICENSE) and [NOTICE](../NOTICE)).
- No dependency with a GPL-incompatible or "non-commercial" license may be added without CTO sign-off.
- Font files (Plus Jakarta Sans, JetBrains Mono) are SIL OFL 1.1 — compatible and vendored per [KASA-76](/KASA/issues/KASA-76).

---

## 11. Build, lint, test

### 11.1 Build — Turborepo + native tools

- **Root**: `pnpm install` → `turbo run lint typecheck test build` (Turborepo wiring in a later ticket; today the scripts are invoked via `pnpm --filter`).
- **API**: Biome → `tsc --noEmit` → `vitest run` → `tsc -p tsconfig.build.json`. Produces `apps/api/dist/`.
- **PWA**: Biome → `tsc --noEmit` → `vitest run` → `vite build`. Produces `apps/pos/dist/` including the Workbox SW.

### 11.2 Lint / format — Biome

**Pick**: Biome as the single lint + format tool across the monorepo. Config at the root, extended per-package if needed.
**Rationale**: One pass covers both jobs; order-of-magnitude faster than ESLint+Prettier on our tree; Rust core means CI time is not burned on lint. The ESLint ecosystem's plugin depth is not load-bearing for us at v0 scale.
**Alternatives**: ESLint + Prettier + `@typescript-eslint` (the conventional pick; slower, three tools to keep in sync, but richer plugin ecosystem — we are willing to give that up for speed and simplicity). Biome is catching up on TypeScript-aware rules quickly.
**Revisit when**: a Biome limitation blocks a review-must-have rule we cannot write ourselves.

> Note: the company-level [docs/TECH-STACK.md](../../../docs/TECH-STACK.md) board summary still names ESLint + Prettier. The project-repo doc (this file) is the source of truth; the company summary will be reconciled in a follow-up.

### 11.3 Testing — Vitest + React Testing Library + Playwright

- **Vitest** for API unit + integration (uses `fastify.inject` against a Neon PR branch), PWA unit + component, and Zod schema contract tests.
- **React Testing Library** for PWA component tests — accessibility-first assertions, no snapshot-diff addiction.
- **Playwright** for PWA e2e, including the **offline acceptance test** (enrol, pull catalog, toggle network off, ring up 50 sales across 3 outlets, toggle on, verify all sync, run EOD, assert zero discrepancies). Runs on `main` + pre-release; informational on PRs for speed.

**Alternatives**: Jest (slower on this tree, Vitest is ESM-native), Cypress (Playwright has better offline-network simulation and is the default going forward), bespoke test harnesses (not worth writing).

### 11.4 CI — GitHub Actions

**Pick**: GitHub Actions as the CI runner; jobs are per-package and cache via Turborepo's remote cache.
**Rationale**: Repo already lives in GitHub; no reason to introduce a second provider. Matrix across Node 22 (prod) and Node 24 (forward-compat signal). Secrets live in GitHub Actions secrets + Fly secrets — never in the repo.
**Alternatives**: CircleCI (fine; no advantage here), GitLab CI (we are on GitHub), Buildkite (scale problem we don't have).
**Revisit when**: we outgrow Actions' self-hosted runner ergonomics at a cost we cannot absorb.

---

## 12. Observability and uptime

### 12.1 Errors — Sentry

**Pick**: Sentry for errors from both tiers. `@sentry/react` in the PWA; `@sentry/node` in the API. PII scrubbing is conservative by default: `sendDefaultPii: false` on the API; a `beforeSend` + `beforeBreadcrumb` scrubber on the PWA masks Indonesian phone numbers, emails, street addresses (`Jl. / Gg. / No.`), and any 12+ digit run that could be a card or bank account number. Session replay is disabled — the clerk's screen contains attached-customer PII.
**Rationale**: See [ARCHITECTURE.md](./ARCHITECTURE.md) ADR-010. Keeping PII out of Sentry lets us use the paid tier without a separate Data Protection Agreement review for every new merchant.
**Alternatives**: Self-hosted GlitchTip (open-source Sentry-compatible; viable if Sentry pricing ever bites), Rollbar / Bugsnag (comparable; Sentry's SDK depth on React + Node is the decider).

### 12.2 Logs — Pino (JSON) → Fly log stream

**Pick**: Pino JSON logs from the API go to Fly's log stream; errors are forwarded to Sentry via the transport. Operational logs ship to a log aggregator (chosen in the infra ticket).
**Rationale**: JSON is machine-parseable by any aggregator. Pino is zero-cost when disabled. Fly's built-in log stream is adequate for v0 diagnostic work.
**Alternatives**: Logtail / BetterStack logs (paid, post-v0 discussion), self-hosted Loki (infra overhead we don't want at v0).

### 12.3 Metrics — OpenTelemetry (API) + PostHog RUM (PWA)

**Pick**: API emits OpenTelemetry traces and a minimal set of counters (HTTP reqs, sale count by status, queue lag); provider-native ingest (the exporter is swappable). PWA uses PostHog for page views and custom events (sale finalized, sync cycle, offline duration).
**Rationale**: OpenTelemetry is the portable wire format — the *exporter* is the infra choice, which we make separately in the infra ticket. PostHog doubles as product analytics + feature flagging, cutting the "which tool owns what" decisions.
**Alternatives**: Datadog (great; expensive for a bootstrapped v0), New Relic (same critique), Grafana Cloud (good, infra-ticket conversation).

### 12.4 Synthetic checks and uptime

- **Better Stack** (or equivalent) synthetic checks on POS shell (root URL of Cloudflare Pages) and API `/health`.
- **`GET /health` is intentionally unversioned** — it is mounted at the server root, not under `/v1`, so external uptime monitors never need to track API versions across `/v1` → `/v2` migrations. The endpoint returns `200 { status: "ok" }` with no auth and no rate limit and has no downstream dependency (it does not touch the DB). Its sole job is to answer "is the process up?" for the monitor.
- **Fly healthchecks** target `/health` too and are what Fly uses to decide whether to route traffic to a new deploy.

Synthetic checks on POS shell and API `/health` are the two monitors we run. Everything else (DB health, Redis health, Midtrans webhook replay lag) is observable from inside Sentry + logs and does not need to wake an engineer.

How a fired alert becomes an incident response — severity ladder, paging, comms, post-mortem flow — is defined in [RUNBOOK-INCIDENT.md](./RUNBOOK-INCIDENT.md); the tactical "an alert just fired, what do I type" playbook lives in [RUNBOOK-ONCALL.md](./RUNBOOK-ONCALL.md). The Better Stack workspace and monitor provisioning ticket is [KASA-198](/KASA/issues/KASA-198).

---

## 13. Security and secrets

- **Secrets**: Fly secrets for API runtime; Cloudflare environment variables for Pages; GitHub Actions secrets for CI. No `.env` files committed; `.env.example` is the template.
- **Secret scanning**: `gitleaks` runs in CI and locally via a pre-commit hook.
- **HTTPS everywhere**: Fly terminates TLS; Cloudflare Pages serves over HTTPS. No plaintext HTTP is accepted by any production surface.
- **Cookies**: sessions are HTTP-only, `SameSite=Lax`, `Secure`, signed. CSRF protection is built into the session cookie + same-site policy; a CSRF-token double-submit is added if we ever need cross-site writes.
- **Rate limits**: `@fastify/rate-limit` applies per-device budgets (tighter on `POST /v1/auth/*` and `POST /v1/sales*`).
- **CORS**: allow-list of the PWA origin(s) only. No wildcard origin, no `Access-Control-Allow-Credentials: true` without an explicit origin match.
- **Dependencies**: see §10.2 dependency policy.
- **Incidents**: see [RUNBOOK-INCIDENT.md](./RUNBOOK-INCIDENT.md) (policy) and [RUNBOOK-ONCALL.md](./RUNBOOK-ONCALL.md) (pilot-week tactical playbook).

---

## 14. Hosting and deployment

See [ARCHITECTURE.md](./ARCHITECTURE.md) §5 for the deployment model in full. Summary:

- **API** → Fly.io, Singapore (`sin`). Two processes (web + worker) from one Docker image.
- **PWA** → Cloudflare Pages, production deploy on `main`, per-PR preview deploys.
- **Database** → Neon (Postgres 16), Singapore region; per-PR branch created by CI.
- **Redis** → Fly Redis or Upstash (decided in the infra ticket); one instance in v0.
- **Email** → Resend (transactional: receipts, invites).
- **CDN** → Cloudflare (in front of Pages by default).
- **Domain / DNS** → Cloudflare DNS.

Every environment (`dev`, `preview`, `prod`) is parameterized via environment variables only; no code differs between them.

---

## 15. Out of scope for v0

These were considered and deliberately deferred. Each has a clear upgrade path; none is on the v0 critical path. Architectural impact of each is described in [ARCHITECTURE.md](./ARCHITECTURE.md) §7.

- **No microservices.** The back office is one Fastify process (web) + one worker process of the same image.
- **No GraphQL, no gRPC.** REST + JSON. Shared Zod schemas keep the client/server contract tight without a second transport.
- **No websocket / SSE push.** Clients pull; webhooks are the only server-originated events, and they terminate on the server, not on the client.
- **No BFF between the PWA and the API.** The Fastify API is shaped for the PWA via shared schemas; a second tier earns its keep the day a second consumer appears.
- **No general CRDT runtime, no symmetric replication.** Offline model is read-through + write-ahead queue (see [ARCHITECTURE.md](./ARCHITECTURE.md) ADR-002).
- **No feature flags service.** GrowthBook is the probable pick when it's needed; until then, behaviour changes ship with a deploy.
- **No A/B experimentation.** One pilot merchant; no statistical power.
- **No data warehouse, no analytics pipeline.** Reporting reads directly from Postgres via denormalized rollups maintained by BullMQ. PostHog covers product analytics; Sentry covers errors.
- **No background ML, recommendations, or fraud scoring.** v0 is a system of record, not a system of intelligence.
- **No native iOS/Android apps.** The PWA is installable; Capacitor/TWA wrappers are a v1 conversation.
- **No SSR, no RSC, no edge compute for API paths.** The PWA is a static bundle; the API is a long-running Fly VM.
- **No hardware integrations** beyond what the browser offers (camera for barcode scan). Receipt printers, cash drawers, and dedicated scanners come in v1.
- **No multi-merchant SaaS.** Multi-tenant schema is in place (ADR-003); onboarding a second merchant is a v1 product decision, not a v0 code change.
- **No direct Bank Indonesia QRIS acquirer relationship.** Midtrans is the aggregator; see §8.
- **No advanced observability** (APM, distributed tracing dashboards, log aggregator beyond Sentry + platform logs). OpenTelemetry emit is in place so the upgrade is wiring, not a rewrite.
- **No dark mode, no localized wordmarks, no marketing site.** Deferred per [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md) §12 and [BRAND-IDENTITY.md](./BRAND-IDENTITY.md).

---

## Changelog

| Date | Change | Author |
|------|--------|--------|
| 2026-04-23 | Initial project-repo TECH-STACK.md. Decisive rationale per slot; restores the file that [README.md](../README.md), [ARCHITECTURE.md](./ARCHITECTURE.md), and [apps/api/README.md](../apps/api/README.md) have been linking to since the [KASA-51](/KASA/issues/KASA-51) refresh. | Engineer ([KASA-80](/KASA/issues/KASA-80)) |

# Kassa v0 Roadmap

Status: v0 (live). Owner: Product Owner. Source issue: [KASA-10](/KASA/issues/KASA-10).
Companion docs: [VISION.md](../../../docs/VISION.md), [TECH-STACK.md](./TECH-STACK.md), [ARCHITECTURE.md](./ARCHITECTURE.md), [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md), [MARKET-ANALYSIS.md](../../../docs/MARKET-ANALYSIS.md).

This is the authoritative v0 plan. It decomposes the company goal — **Ship Kassa v0 POS MVP in 30 days so Indonesian merchants can operate a full sales day offline** — into five milestones, each a deployable increment. Every backlog issue cites the milestone it serves, and every milestone has an acceptance bar tied to a vision success metric.

The tech stack ([TECH-STACK.md](./TECH-STACK.md)) is the binding source of truth for implementation decisions. [ARCHITECTURE.md](./ARCHITECTURE.md) is kept aligned with it (last refreshed under [KASA-51](/KASA/issues/KASA-51)).

---

## North Star

A clerk at an Indonesian warung on a flaky 4G connection can:

1. Onboard a new tablet in under 15 minutes without support.
2. Ring up sales continuously through a network outage with zero data loss.
3. Take both cash and QRIS tenders (dynamic when online, static fallback when offline).
4. Close the day and hit zero variance between expected and counted cash + QRIS.

Every milestone below is graded against this sentence.

---

## Milestones

| # | Milestone | Window | Acceptance bar |
|:--|:----------|:-------|:---------------|
| M0 | Foundation | Days 1–7 | Monorepo building green in CI; API, PWA, and back-office apps scaffolded; preview deploys working on PR. |
| M1 | Core API | Days 8–14 | Auth, RBAC, device enrolment, catalog/BOM/outlet/stock CRUD endpoints live with integration tests. |
| M2 | POS PWA Shell | Days 15–21 | Installable PWA on Android Chrome; catalog → cart → cash tender → receipt print works fully offline; sync engine drains on reconnect. |
| M3 | Multi-outlet + Reconciliation | Days 22–28 | Per-outlet stock + BOM deduction; QRIS dynamic + static; end-of-day close with zero-variance path. |
| M4 | Polish + Launch | Days 29–30 | Full-day offline Playwright acceptance run passes; staging test day with pilot merchant data; promoted to production Fly.io deployment. |

Each milestone produces a working, deployable system. No milestone ends with the product non-functional.

### M0 — Foundation (Days 1–7)

**Goal:** the team can push a change and see it deploy; there is nothing bespoke to reinvent.

Key deliverables:

- Monorepo scaffolded per [TECH-STACK.md](./TECH-STACK.md) §10.1 (`apps/pos`, `apps/back-office`, `apps/api`, `packages/schemas`, `packages/ui`).
- GitHub repo with branch protection, PR template, and CODEOWNERS.
- CI lanes: install → lint → typecheck → test → build, all green on PR.
- Preview deploys on PR: Cloudflare Pages (PWA) + Fly.io staging app (API) + Neon branch (DB).
- Fastify app scaffolded with `/health` endpoint, OpenAPI bootstrap, Pino logging, Sentry backend SDK.
- PWA scaffold (Vite + React 19 + TanStack Router) with Workbox service worker, design token CSS file, id-ID locale loader, Sentry browser SDK.

Issues already in flight: [KASA-8](/KASA/issues/KASA-8), [KASA-9](/KASA/issues/KASA-9), [KASA-12](/KASA/issues/KASA-12), [KASA-13](/KASA/issues/KASA-13), [KASA-14](/KASA/issues/KASA-14), [KASA-15](/KASA/issues/KASA-15), [KASA-16](/KASA/issues/KASA-16), [KASA-17](/KASA/issues/KASA-17), [KASA-18](/KASA/issues/KASA-18), [KASA-19](/KASA/issues/KASA-19), [KASA-22](/KASA/issues/KASA-22), [KASA-51](/KASA/issues/KASA-51).

Exit criteria: a no-op PR turns CI green, gets a preview URL, and merges without manual steps.

### M1 — Core API (Days 8–14)

**Goal:** the PWA has an API that it can talk to for every v0 flow.

Key deliverables:

- Drizzle schema covering merchants, outlets, devices, staff, catalog items, modifiers, BOMs, stock ledger, sales, tenders, sync events, end-of-day.
- Auth primitives: session cookies (Argon2id passwords), PIN unlock, device enrolment codes + short-lived device tokens.
- RBAC (owner, manager, cashier, read_only) enforced in Fastify preHandlers.
- REST endpoints for: merchant/outlet/device admin, catalog pull (delta), BOM pull, stock snapshot pull, sale submit (idempotent on `local_sale_id`), EOD close.
- OpenAPI doc generated from shared Zod schemas, published at `/openapi.json`.
- Integration tests with `fastify.inject` for auth, catalog pull, sale submit round-trip, and idempotency.

Issues already in flight: [KASA-20](/KASA/issues/KASA-20), [KASA-21](/KASA/issues/KASA-21), [KASA-23](/KASA/issues/KASA-23), [KASA-24](/KASA/issues/KASA-24), [KASA-25](/KASA/issues/KASA-25), [KASA-26](/KASA/issues/KASA-26), [KASA-27](/KASA/issues/KASA-27), [KASA-28](/KASA/issues/KASA-28).

New issues generated under KASA-10: device enrolment endpoint, catalog delta cursor contract, Midtrans server keys + webhook skeleton.

Exit criteria: a curl script can enrol a fresh device, pull a catalog delta, submit a sale, and read it back; re-submitting the same `local_sale_id` returns the original sale, not a duplicate.

### M2 — POS PWA Shell (Days 15–21)

**Goal:** a clerk can complete a cash sale on an offline tablet and see it synced when the network returns.

Key deliverables:

- PWA routes: `/enrol`, `/catalog`, `/cart`, `/tender/cash`, `/receipt`, `/admin`.
- Dexie 4 schema mirror of catalog, BOM, stock snapshot, pending sales outbox, sync metadata.
- Sync engine: read-through cursor pull for reference data; write-ahead outbox for sale pushes; Workbox BackgroundSync for retry.
- Cart state (Zustand), totals + discount + tender split math, rupiah formatting via `Intl.NumberFormat('id-ID', { currency: 'IDR' })`.
- Cash tender flow with numeric keypad, quick-tender chips, change calculation, receipt preview.
- Web Bluetooth ESC/POS 58 mm receipt print, with a print-to-PDF fallback for iPadOS / unsupported printers.
- Connection-state pill wired to sync engine events (online, syncing-N, offline, sync-failed).
- Onboarding device enrolment UX (scan QR from back office → API exchange → bound to outlet).

Exit criteria: Playwright smoke test toggles network off, rings up 20 sales, toggles network on, asserts all 20 sales appear server-side with matching totals.

### M3 — Multi-outlet + Reconciliation (Days 22–28)

**Goal:** BOM-based consumption, QRIS, and end-of-day all work end-to-end across more than one outlet.

Key deliverables:

- Per-outlet stock snapshot served and rendered; optimistic client-side decrement on sale, reconciled on next pull.
- BOM explosion service on `sale.submit`: authoritative Stock Ledger writes per component, not per menu item.
- QRIS integration:
  - Dynamic: `payments.create_qris` (Midtrans Core API), PWA QR display, status polling, webhook-driven tender update.
  - Static fallback: printed merchant QR path with manual last-4 confirm; reconciled at EOD against Midtrans settlement.
- End-of-day flow: client drains outbox → server validates all `local_sale_id`s known → EOD doc created → cash+QRIS breakdown + variance report returned + printed.
- Back-office admin app (apps/back-office) for catalog, BOM, outlet, and staff management (Next-step back-office is part of M3 because clerks need to be able to set up a second outlet to test multi-outlet).

Exit criteria: on a fresh merchant seed, a manager can create 2 outlets + 10 items + 2 BOMs via the back office; a clerk can ring sales at both outlets (offline for one, online for the other); end-of-day closes at both with zero rupiah variance.

### M4 — Polish + Launch (Days 29–30)

**Goal:** one pilot merchant is on production with the team ready to support them.

Key deliverables:

- Full Playwright acceptance test: enrol → sync catalog → 50 sales across 3 outlets offline → reconnect → verify → EOD → zero variance. This is the vision metric gate and MUST pass on `main` before launch.
- Staging test day with pilot merchant data: real catalog, real BOM, real QRIS sandbox keys, shadow-run of a full shift.
- Merchant onboarding runbook (printed and PWA-accessible): enrol tablet, connect printer, add first items, take first sale, close day.
- Production deploy: Fly.io production app + Neon production branch + Cloudflare Pages `main` target + Midtrans production keys (rotated from sandbox).
- Sentry release tagging, source-map upload, and alert routing.
- Uptime checks (Better Stack) on `GET /health` and PWA shell URL.
- Incident runbook + on-call rotation for the pilot week.

Exit criteria: pilot merchant opens their shop on Day 31 with Kassa as their only POS and closes the day with zero variance and zero P0 incidents.

---

## Cross-milestone tracks

Some work does not fit a single milestone and runs alongside the main pipeline.

| Track | Owner | Cadence | Description |
|:------|:------|:--------|:------------|
| Brand identity rollout | UI Designer | M0 → M4 | [KASA-11](/KASA/issues/KASA-11) produces logo, app icon, splash, wordmark, tone-of-voice. Assets land in `packages/ui` as tokens/components. |
| Observability | Engineer | M1 → M4 | Sentry (FE+BE) wired early; Pino structured logs; OTEL traces for sale-submit and EOD paths. |
| Pilot merchant ops | Product Owner | M0 → M4 | Identify pilots ([KASA-50](/KASA/issues/KASA-50)), negotiate access, prep their catalog. |
| Performance budgets | Engineer | M2 → M4 | Bundle size, Lighthouse, and Web Vitals gates enforced in CI. |
| Acceptance test suite | Engineer + Product Owner | M2 → M4 | Playwright full-day offline scenario built incrementally, run in CI on `main`. |

---

## Dependencies and sequencing

- **M0 gates M1**: no API routes until the Fastify app and Drizzle migrations ship.
- **M1 gates M2**: no sync engine until the API has auth, catalog pull, and sale submit live on staging.
- **M2 gates M3**: no QRIS/EOD until the cash-tender path is provably reliable offline.
- **M3 gates M4**: no launch until multi-outlet + reconciliation passes on staging.
- **[KASA-11](/KASA/issues/KASA-11) (brand)** is not a hard gate on any milestone, but the pilot test day (M4) should ship with final logo and app icon.
- **[KASA-50](/KASA/issues/KASA-50) (pilot merchant identification)** is a hard gate on M4; no launch without a signed pilot.

---

## Risk register (roadmap-level)

Stack-level risks are captured per slot as `Revisit when` triggers throughout [TECH-STACK.md](./TECH-STACK.md). Roadmap-level risks are scope+time bets:

1. **M1 scope creep into M2.** The API surface already has 14 open issues. If any slip past Day 14, M2 must cut scope, not extend the window.
2. **Web Bluetooth printer support.** If fewer than 3 printer models survive M2 smoke testing, M4 acceptance must include a PDF-receipt-only fallback path.
3. **Midtrans sandbox → production cutover.** Production QRIS approval can take days. File the paperwork during M1, not M3.
4. **Pilot merchant availability.** If [KASA-50](/KASA/issues/KASA-50) does not land a signed pilot by end of M2, M4 shifts from "launch" to "soft-launch dogfood" with an internal merchant.
5. **Shared Zod schemas drift.** The monorepo bets that `@kassa/schemas` stays the single source of request types. If drift appears, add a contract-test gate in CI before M3.

---

## How to read the backlog against this roadmap

- Every issue must cite its milestone (M0–M4) in the description.
- Priority (`critical` / `high` / `medium` / `low`) encodes roadmap urgency, not absolute importance:
  - `critical` — blocks the current milestone window (e.g., CI broken).
  - `high` — must land in the current or next milestone.
  - `medium` — needed by v0 launch but not on the critical path this week.
  - `low` — scope buffer; ok to cut if schedule slips.
- The Product Owner grooms the backlog on every heartbeat ([backlog-process.md](../../../docs/backlog-process.md)). If fewer than 3 unassigned `todo` issues exist for the next milestone, more are generated.
- Issues that describe work already completed by an agent (e.g., infra set-up) are closed rather than re-opened when the roadmap evolves. The roadmap is a map; the backlog is the ledger.

---

## Revision log

| Date | Author | Change |
|------|--------|--------|
| 2026-04-22 | Product Owner | v0 — initial roadmap authored from vision + market analysis + tech stack + architecture. Generated M2–M4 backlog issues. Linked to [KASA-10](/KASA/issues/KASA-10). |

# Kassa

[![CI](https://github.com/ArktikLabs/kassa/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ArktikLabs/kassa/actions/workflows/ci.yml)

Offline-capable Progressive Web App POS terminal for Indonesian merchants, backed by a TypeScript + Fastify back-office API.

## Vision

Every Indonesian merchant — from warung to chain — runs a reliable, offline-capable POS that just works, regardless of connectivity.

## v0 Scope (30 days)

- Multi-outlet operations under a single merchant
- Catalog and menu management
- Bill-of-materials (BOM) inventory with per-outlet stock
- Cash and QRIS tender types (Midtrans)
- End-of-day reconciliation
- Full sales day on unreliable network, zero data loss

## Stack

| Layer | Tech |
|-------|------|
| Shared language | TypeScript 5.x (strict) |
| Backend runtime | Node.js 22 LTS |
| API framework | Fastify 5 (REST + JSON, OpenAPI 3.1 from Zod) |
| Database | PostgreSQL 16 (Neon, Singapore) |
| ORM / migrations | Drizzle ORM + drizzle-kit |
| Cache / queue | Redis 7 + BullMQ |
| POS runtime | Installable PWA (Workbox service worker) |
| POS frontend | React 19 + Vite 7 |
| Client routing | TanStack Router |
| Offline store | IndexedDB via Dexie 4 |
| UI | Tailwind CSS v4 + Lucide |
| State | Zustand + TanStack Query |
| Forms / validation | React Hook Form + Zod (shared via `@kassa/schemas`) |
| Payments | Midtrans Core API (QRIS) |
| Lint / format | Biome |
| Testing | Vitest + React Testing Library + Playwright |
| CI / CD | GitHub Actions (see [docs/CI-CD.md](./docs/CI-CD.md)); Turborepo remote cache planned |
| Hosting | Fly.io (API, `sin`) + Neon (Postgres) + Cloudflare Pages (PWA) |

See [docs/TECH-STACK.md](./docs/TECH-STACK.md) for decisive rationale on every slot, [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for system shape and data flow, and [docs/DESIGN-SYSTEM.md](./docs/DESIGN-SYSTEM.md) for the visual foundation.

## Repository Layout

TypeScript monorepo driven by pnpm workspaces (Turborepo integration lands in a later ticket). Subsystems are scaffolded incrementally.

```text
.
├── apps/
│   └── api/                   # Fastify back-office API (scaffolded in KASA-22)
├── packages/
│   └── payments/              # Vendor-agnostic payment provider abstraction + Midtrans QRIS (KASA-54)
├── docs/                      # Tech stack, architecture, design system, workflows
├── legal/                     # CLAs and legal notices
├── package.json               # Workspace root
├── pnpm-workspace.yaml
└── README.md
```

Planned additions as tickets land: `apps/pos` (PWA client), `apps/back-office` (staff admin UI), `packages/schemas` (shared Zod), `packages/ui`, `packages/config`.

## Workflow

- Conventional Commits on all commits
- Branch naming: `kasa-<N>/<short-description>` (lowercase issue prefix)
- PR-based review for code/schema/infra changes; direct-to-main for typos and doc fixes
- Two required approvals: Code Reviewer + Product Owner
- See [docs/git-workflow.md](./docs/git-workflow.md) and [docs/pr-conventions.md](./docs/pr-conventions.md)

## Operations

- **Incident response policy** (severity ladder, comms templates, post-mortem flow): [docs/RUNBOOK-INCIDENT.md](./docs/RUNBOOK-INCIDENT.md).
- **On-call playbook** (alert routing, escalation, what to do at 02:00): [docs/RUNBOOK-ONCALL.md](./docs/RUNBOOK-ONCALL.md).
- **Production deploys** (promotion, [rollback](./docs/RUNBOOK-DEPLOY.md#4-rollback), pause/cancel): [docs/RUNBOOK-DEPLOY.md](./docs/RUNBOOK-DEPLOY.md).
- **Post-mortems** are filed under [docs/post-mortems/](./docs/post-mortems/) using [TEMPLATE.md](./docs/post-mortems/TEMPLATE.md).

## Contributing

We welcome contributions. Before your first PR, please read [CONTRIBUTING.md](./CONTRIBUTING.md) and sign the applicable Contributor License Agreement ([ICLA](./legal/ICLA.md) for individuals, [CCLA](./legal/CCLA.md) for corporate contributors). All participation is governed by our [Code of Conduct](./CODE_OF_CONDUCT.md).

## License

Kassa is licensed under the **GNU Affero General Public License, version 3 or (at your option) any later version** (AGPL-3.0-or-later). See [LICENSE](./LICENSE) for the full text and [NOTICE](./NOTICE) for attribution.

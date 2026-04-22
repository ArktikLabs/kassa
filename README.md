# Kassa

Offline-capable Progressive Web App POS terminal for Indonesian merchants, backed by a Frappe/ERPNext back office.

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
| Back office | Frappe 15 + ERPNext 15 (Python 3.11, MariaDB 10.6, Redis 7) |
| POS runtime | Installable PWA (service worker + Workbox) |
| POS frontend | React 18 + TypeScript 5 (strict) + Vite 5 |
| Offline store | IndexedDB via Dexie.js |
| UI | Tailwind CSS + Headless UI |
| State | Zustand + TanStack Query |
| Forms | react-hook-form + Zod |
| Payments | Midtrans Core API (QRIS) |
| CI | GitHub Actions |
| Hosting | Single VPS (Frappe) + Cloudflare Pages (PWA) |

See [docs/](./docs/) for the full tech stack, design system, market analysis, and vision.

## Repository Layout

This repository will host both the PWA frontend and Frappe back-office customisations as subsystems are scaffolded in upcoming tickets.

```
.
├── docs/        # Design system, tech stack, workflows
└── README.md
```

## Workflow

- Conventional Commits on all commits
- Branch naming: `kasa-<N>/<short-description>` (lowercase issue prefix)
- PR-based review for code/schema/infra changes; direct-to-main for typos and doc fixes
- Two required approvals: Code Reviewer + Product Owner
- See [docs/git-workflow.md](./docs/git-workflow.md) and [docs/pr-conventions.md](./docs/pr-conventions.md) once added

## Contributing

We welcome contributions. Before your first PR, please read [CONTRIBUTING.md](./CONTRIBUTING.md) and sign the applicable Contributor License Agreement ([ICLA](./legal/ICLA.md) for individuals, [CCLA](./legal/CCLA.md) for corporate contributors). All participation is governed by our [Code of Conduct](./CODE_OF_CONDUCT.md).

## License

Kassa is licensed under the **GNU Affero General Public License, version 3 or (at your option) any later version** (AGPL-3.0-or-later). See [LICENSE](./LICENSE) for the full text and [NOTICE](./NOTICE) for attribution.

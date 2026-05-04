# Kassa dependency security audit — 2026-05-04

Status: v0 (KASA-185). Owner: Engineer. Companion docs: [TECH-STACK.md](./TECH-STACK.md), [RUNBOOK-ONCALL.md](./RUNBOOK-ONCALL.md), [CI-CD.md](./CI-CD.md).

This is a point-in-time snapshot of `pnpm audit` results across the Kassa monorepo at commit `9f4858b` (origin/main). The audit was run with the lockfile as committed; no changes were applied. Production-only audit is clean (0 advisories across 236 prod dependencies). All five flagged advisories live in dev/build/test tooling and are not reachable from deployed artifacts (Fly API, Cloudflare Pages POS / back-office). Remediation is tracked under child issues of KASA-185.

---

## 1. Method

Commands run from the workspace root with `NODE_ENV` unset:

```sh
pnpm install --frozen-lockfile
pnpm audit --json --prod   > audit-prod.json
pnpm audit --json          > audit-all.json
pnpm outdated --recursive
pnpm why <module> -r       # for each flagged module
```

`pnpm` resolves the GitHub Advisory Database via the npm registry. The audit was run on 2026-05-04. The next audit should run no later than 2026-06-01 (monthly cadence; see §5).

---

## 2. Result summary

| Scope                    | Total deps | Critical | High | Moderate | Low | Info |
|:-------------------------|-----------:|---------:|-----:|---------:|----:|-----:|
| `--prod` (deployed code) |        236 |        0 |    0 |        0 |   0 |    0 |
| Full tree (incl. dev)    |        868 |        0 |    1 |        4 |   0 |    0 |

**Headline.** Nothing reaches a deployed surface. The five advisories live exclusively in test runners (`vitest`), build tooling (`drizzle-kit`, `vite-plugin-pwa`), and their transitive dev deps.

---

## 3. Advisories

### 3.1 esbuild ≤0.24.2 — moderate (CVSS 5.3) — GHSA-67mh-4wv8-2f99

Dev server returns `Access-Control-Allow-Origin: *` on every request, so any visited site can read the local source served by `esbuild --serve`.

Reachable paths (all dev-only):

- `apps/api > drizzle-kit@0.31.10 > @esbuild-kit/esm-loader@2.6.5 > @esbuild-kit/core-utils@3.3.2 > esbuild@0.18.20`
- `apps/{api,back-office,pos,packages/payments,packages/schemas} > vitest@2.1.9 > vite@5.4.21 > esbuild@0.21.5`

Patched in `esbuild@0.25.0`. The workspace already pulls `esbuild@0.25.12` and `0.27.7` directly via newer paths (drizzle-kit, vite 7.3.2, tsx); only the legacy `@esbuild-kit/*` shim and the vitest-pinned `vite@5.4.21` keep the old versions alive.

Practical risk for Kassa: low. We do not run `esbuild --serve` in any developer or CI workflow. `vite dev` and `vitest` use their own dev servers (which carry the §3.4 advisory).

### 3.2 serialize-javascript ≤7.0.2 — high (CVSS 8.1) — GHSA-5c6j-r48x-rmvq

Code injection via crafted `RegExp.flags` / `Date.toISOString` when output is later `eval`-ed or embedded in a `<script>` tag.

Reachable path (single, dev-only):

- `apps/pos > vite-plugin-pwa@0.21.2 > workbox-build@7.4.0 > @rollup/plugin-terser@0.4.4 > serialize-javascript@6.0.2`

Patched in `serialize-javascript@7.0.3`.

Practical risk for Kassa: low. The serialized input is the workbox precache manifest assembled from our own POS asset list at build time (CI runner). Exploitation would require an attacker to compromise the CI input, at which point dependency code injection is not the binding constraint. Still worth fixing — `vite-plugin-pwa@1.2.0` (current latest) ships an updated `workbox-build` that pulls `@rollup/plugin-terser@0.5.x` → `serialize-javascript@7.0.5`.

### 3.3 serialize-javascript <7.0.5 — moderate (CVSS 5.9) — GHSA-qj8w-gfj5-8c6v

CPU-exhaustion DoS via array-like objects with very large `length`. Same path as §3.2; same fix (bump `vite-plugin-pwa`).

### 3.4 vite ≤6.4.1 — moderate — GHSA-4w7w-66w2-5vf9

Dev server `.map` request handler does not strip `../` segments, so any `.map` outside the project root is readable when the dev server is exposed via `--host`.

Reachable paths (all dev-only):

- All five workspaces: `vitest@2.1.9 > vite@5.4.21`

Patched in `vite@6.4.2`. Apps directly use `vite@7.3.2` for runtime build (back-office, pos), which is unaffected; only the vitest-pinned `5.4.21` is exposed.

Practical risk for Kassa: low. We do not run `vite dev --host` on the network during normal development; CI uses headless test runs only. The advisory becomes meaningful if a developer exposes the test runner UI on a shared network.

---

## 4. Remediation plan

The five advisories collapse to three independent dependency bumps. Each is its own PR / child issue so a regression can be reverted in isolation.

| Track | Bump                                                | Clears advisories         | Notes                                                                                          | Child issue |
|:------|:----------------------------------------------------|:--------------------------|:-----------------------------------------------------------------------------------------------|:------------|
| A     | `vitest` 2.1.9 → 3.x (or 4.x)                       | §3.1 (vitest path), §3.4  | vitest 3 supports vite 5 + 6; vitest 4 drops Node 18 — workspace is on Node 22, so safe. Test-config drift expected; verify each `vitest.config.ts`. | new         |
| B     | `vite-plugin-pwa` 0.21.2 → 1.2.0                    | §3.2, §3.3                | Major bump; review `vite.config.ts` in `apps/pos` for breaking config changes (workbox-build 7.x → 7.5.x, plugin API rename for `injectManifest`). | new         |
| C     | `drizzle-kit` 0.31.10 → latest (drop esbuild-kit)   | §3.1 (drizzle-kit path)   | Newer drizzle-kit no longer depends on `@esbuild-kit/*`. Verify `pnpm drizzle-kit generate` and `migrate` still work against the dev DB.            | new         |

Fallback if any track stalls: pin transitive `serialize-javascript` and `vite` via `pnpm.overrides` in the root `package.json`. Avoid overriding `esbuild` globally — multiple consumers (vite 5, vite 7, tsx) need different majors.

Track A and B together clear all five advisories. Track C is a hygiene cleanup that removes a stale unmaintained shim (`@esbuild-kit/esm-loader` was archived in 2024).

---

## 5. Cadence

- Run `pnpm audit --prod` and `pnpm audit` on every PR that touches `pnpm-lock.yaml`; gate CI on critical/high in `--prod`. Tracked as a child issue of KASA-185.
- Refresh this document monthly. Next refresh due **2026-06-01**.
- Any new high or critical against a prod path is a P1 in [RUNBOOK-ONCALL.md](./RUNBOOK-ONCALL.md) §1; engineer triages within one business day.

---

## 6. Out of scope for this revision

- Static analysis (ESLint security plugin, Semgrep) — separate epic.
- Dependency-freshness policy and Renovate/Dependabot configuration — captured in CI-CD.md §TBD; tracked separately.
- License audit — Kassa is AGPL-3.0; downstream license compatibility is a legal review, not a security audit.

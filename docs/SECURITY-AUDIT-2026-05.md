# Kassa dependency security audit — 2026-05-04

Status: v2 (re-audit KASA-331, 2026-05-25). Prior revisions: KASA-288 / 2026-05-18 (§7) and KASA-185 / 2026-05-04 (§§1–6). Owner: Engineer. Companion docs: [TECH-STACK.md](./TECH-STACK.md), [RUNBOOK-ONCALL.md](./RUNBOOK-ONCALL.md), [CI-CD.md](./CI-CD.md).

Latest re-audit (2026-05-25, origin/main `ab968a1`): production tree picked up its **first advisory** since v0 — `brace-expansion` GHSA-jxxr-4gwj-5jf2 (moderate, CVSS 6.5, CVE-2026-45149, published 2026-05-18) reaches via `@fastify/swagger-ui → @fastify/static → glob → minimatch`. Full-tree count is 2 high + 4 moderate across 908 deps. Net movement vs. KASA-288: two new moderates (`brace-expansion`, `ws`), no advisory resolutions. New remediation tracked under KASA-332 (brace-expansion override) and KASA-333 (ws override); existing KASA-187 / KASA-188 / KASA-189 unchanged. See §8 for the diff. Severity stays sub-P1 per RUNBOOK-ONCALL §1 (no prod-reachable high or critical).

Original v0 (2026-05-04, commit `9f4858b`) text follows below.

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

---

## 7. Re-audit log — 2026-05-18 (KASA-288)

Routine monthly audit (`Dependency and security audit`, originId `e00493d6`). Run against `origin/main` at commit `9e9113d` with a fresh `pnpm install --frozen-lockfile` and `NODE_ENV` unset.

### 7.1 Result summary

| Scope                    | Total deps | Critical | High | Moderate | Low | Info |
|:-------------------------|-----------:|---------:|-----:|---------:|----:|-----:|
| `--prod` (deployed code) |        299 |        0 |    0 |        0 |   0 |    0 |
| Full tree (incl. dev)    |        908 |        0 |    2 |        2 |   0 |    0 |

**Headline.** Production tree remains clean. The four remaining full-tree advisories all live in the `vite-plugin-pwa@0.21 → workbox-build@7.4` chain (high + moderate) or the legacy `drizzle-kit → @esbuild-kit/*` shim (moderate). No new prod-reachable surface introduced since v0.

### 7.2 Diff vs. v0 (2026-05-04)

| Advisory                                  | Module                                   | v0 (2026-05-04) | v1 (2026-05-18) | Why                                                                                                                            |
|:------------------------------------------|:-----------------------------------------|:----------------|:----------------|:-------------------------------------------------------------------------------------------------------------------------------|
| GHSA-67mh-4wv8-2f99 (moderate)            | `esbuild` ≤0.24.2                         | present (2 paths) | present (1 path) | KASA-186 landed: vitest 2.1.9 → 3.2.4 cleared the vitest path. Only `drizzle-kit > @esbuild-kit/esm-loader > esbuild@0.18.20` remains. KASA-188 closes this. |
| GHSA-5c6j-r48x-rmvq (high, CVSS 8.1)      | `serialize-javascript` ≤7.0.2             | present           | present           | Same path as v0 (`vite-plugin-pwa → workbox-build → @rollup/plugin-terser`). KASA-187 closes this.                              |
| GHSA-qj8w-gfj5-8c6v (moderate)            | `serialize-javascript` <7.0.5             | present           | present           | Same chain as ↑. KASA-187 closes this.                                                                                          |
| GHSA-4w7w-66w2-5vf9 (moderate)            | `vite` ≤6.4.1                             | present (5 paths) | **resolved**      | vitest 3.2.4 pulls `vite@7.3.2`; no path to the vulnerable 5.4.x remains.                                                       |
| GHSA-fv7c-fp4j-7gwp (high, CVSS 8.2)      | `@babel/plugin-transform-modules-systemjs` 7.12.0–7.29.3 | not yet published (2026-05-04 audit) | **new**           | Advisory published 2026-05-08. Reaches via the same `vite-plugin-pwa@0.21 → workbox-build@7.4 → @babel/preset-env@7.29.2` chain. KASA-187 closes this. |

### 7.3 GHSA-fv7c-fp4j-7gwp — `@babel/plugin-transform-modules-systemjs` (high, CVSS 8.2)

The SystemJS module-format transform inlines source-derived identifiers into the emitted module wrapper without escaping; compiling attacker-influenced source can therefore inject arbitrary code into the build output. Reachable path:

- `apps/pos > vite-plugin-pwa@0.21.2 > workbox-build@7.4.0 > @babel/preset-env@7.29.2 > @babel/plugin-transform-modules-systemjs@7.29.0`

Patched in `@babel/plugin-transform-modules-systemjs@7.29.4` (shipped via `@babel/preset-env@7.29.5`, pulled by `workbox-build@7.5.x` in `vite-plugin-pwa@1.x`).

Practical risk for Kassa: **low**. Workbox uses SystemJS output only when `injectManifest` targets a SystemJS bundle, which we don't configure (`apps/pos` uses the default `generateSW` strategy). Build-time exposure would additionally require an attacker-controlled npm dependency. Worth fixing alongside §3.2 / §3.3 — KASA-187 is the single tracker.

### 7.4 Remediation status

| Track | Child issue | Title                                             | Status     | Notes (2026-05-18)                                                                          |
|:------|:------------|:--------------------------------------------------|:-----------|:--------------------------------------------------------------------------------------------|
| A     | KASA-186    | Bump vitest 2.1.9 → 3.x                            | **done**   | Merged; vitest 3.2.4 + vite 7.3.2 in tree. Cleared GHSA-4w7w-66w2-5vf9 + vitest esbuild path. |
| B     | KASA-187    | Bump vite-plugin-pwa 0.21.2 → 1.x                  | backlog    | Now also clears the new GHSA-fv7c-fp4j-7gwp. Single bump closes 3 of the 4 open advisories.  |
| C     | KASA-188    | Drop @esbuild-kit shim from drizzle-kit dep tree   | backlog    | Last remaining path for GHSA-67mh-4wv8-2f99.                                                |
| D     | KASA-189    | CI gate: `pnpm audit` on every lockfile change     | backlog    | Would have caught the new GHSA-fv7c-fp4j-7gwp at the lockfile-bump PR rather than at the routine audit. |

No new child issues filed for this re-audit. The newly-published GHSA-fv7c-fp4j-7gwp folds into KASA-187 because it shares the `workbox-build@7.4` root cause; opening a parallel issue would split a single bump into two trackers.

### 7.5 Next refresh

- Cadence unchanged: next routine audit due **2026-06-01** (monthly), per §5.
- Any high or critical against `--prod` between now and then is P1 in [RUNBOOK-ONCALL.md](./RUNBOOK-ONCALL.md) §1 and should reopen this doc out-of-cycle.

---

## 8. Re-audit log — 2026-05-25 (KASA-331)

Routine weekly audit (`Dependency and security audit`, originId `e00493d6`). Run against `origin/main` at commit `ab968a1` with a fresh `pnpm install --frozen-lockfile` and `NODE_ENV` unset.

### 8.1 Result summary

| Scope                    | Total deps | Critical | High | Moderate | Low | Info |
|:-------------------------|-----------:|---------:|-----:|---------:|----:|-----:|
| `--prod` (deployed code) |        299 |        0 |    0 |        1 |   0 |    0 |
| Full tree (incl. dev)    |        908 |        0 |    2 |        4 |   0 |    0 |

**Headline.** Production tree picks up its first advisory since v0: `brace-expansion` GHSA-jxxr-4gwj-5jf2 (moderate, CVSS 6.5, CVE-2026-45149) via the `@fastify/swagger-ui → @fastify/static` chain on `apps/api`. A second new advisory — `ws` GHSA-58qx-3vcg-4xpx (moderate, CVSS 4.4) — appears only in the vitest jsdom test environment and has no prod path. The four prior open advisories (high serialize-javascript, high @babel/plugin-transform-modules-systemjs, moderate vite-plugin-pwa-chain serialize-javascript, moderate drizzle-kit-shim esbuild) are unchanged.

Severity remains **sub-P1** under [RUNBOOK-ONCALL.md](./RUNBOOK-ONCALL.md) §1 (no prod-reachable high/critical). Worth noting that the new prod-path moderate would have been caught at lockfile-bump PR time if KASA-189 (CI `pnpm audit` gate) had landed — this is the second routine audit where KASA-189's absence let a new advisory slip in undetected.

### 8.2 Diff vs. KASA-288 (2026-05-18)

| Advisory                                  | Module                                    | KASA-288 (2026-05-18) | KASA-331 (2026-05-25) | Why                                                                                                                            |
|:------------------------------------------|:------------------------------------------|:----------------------|:----------------------|:-------------------------------------------------------------------------------------------------------------------------------|
| GHSA-jxxr-4gwj-5jf2 (moderate, CVSS 6.5)  | `brace-expansion` 5.0.0–5.0.5             | not yet published     | **new (prod + dev)**  | Advisory published 2026-05-18 (post-KASA-288 audit). Reaches prod via `apps/api > @fastify/swagger-ui@5.2.6 > @fastify/static@9.1.3 > glob@13.0.6 > minimatch@10.2.5 > brace-expansion@5.0.5`. KASA-332 covers a precise pnpm override. |
| GHSA-58qx-3vcg-4xpx (moderate, CVSS 4.4)  | `ws` 8.0.0–8.20.0                         | not present           | **new (dev only)**    | New transitive via `jsdom@25.0.1 > ws@8.20.0`, pulled by vitest test envs across all five workspaces. KASA-333 covers a precise pnpm override. |
| GHSA-67mh-4wv8-2f99 (moderate)            | `esbuild` ≤0.24.2                          | present (1 path)      | present (1 path)      | Unchanged — `drizzle-kit > @esbuild-kit/esm-loader > esbuild@0.18.20`. KASA-188 closes this.                                    |
| GHSA-5c6j-r48x-rmvq (high, CVSS 8.1)      | `serialize-javascript` ≤7.0.2              | present               | present               | Unchanged — `vite-plugin-pwa@0.21 > workbox-build@7.4` chain. KASA-187 closes this.                                             |
| GHSA-qj8w-gfj5-8c6v (moderate)            | `serialize-javascript` <7.0.5              | present               | present               | Unchanged — same chain as ↑. KASA-187 closes this.                                                                              |
| GHSA-fv7c-fp4j-7gwp (high, CVSS 8.2)      | `@babel/plugin-transform-modules-systemjs` | present (new in v1)   | present               | Unchanged — same `vite-plugin-pwa@0.21 > workbox-build@7.4 > @babel/preset-env@7.29.2` chain. KASA-187 closes this.             |

### 8.3 GHSA-jxxr-4gwj-5jf2 — `brace-expansion` (moderate, CVSS 6.5, prod-reachable)

`brace-expansion@5.0.0–5.0.5` generates the full intermediate array for a numeric range like `{1..10000000}` before applying the documented `max` cap, so a crafted pattern can allocate ~500MB and burn ~800ms before the cap kicks in.

Reachable paths in the workspace (3, one in `--prod`):

- **prod** — `apps/api > @fastify/swagger-ui@5.2.6 > @fastify/static@9.1.3 > glob@13.0.6 > minimatch@10.2.5 > brace-expansion@5.0.5`
- dev — `apps/pos > @kassa/api@link:../api > @fastify/swagger-ui@5.2.6 > @fastify/static@9.1.3 > glob@13.0.6 > minimatch@10.2.5 > brace-expansion@5.0.5`
- dev — `apps/pos > vite-plugin-pwa@0.21.2 > workbox-build@7.4.0 > glob@11.1.0 > minimatch@10.2.5 > brace-expansion@5.0.5` (also cleared by KASA-187)

Patched in `brace-expansion@5.0.6`.

Practical risk for Kassa: **low**. `@fastify/swagger-ui` invokes `brace-expansion` indirectly through `@fastify/static`'s asset-glob resolution; the patterns are fixed at install time (the bundled UI's `static-csp.json` + the JS/CSS asset names) and never derive from request data. The advisory becomes meaningful only if a future change starts passing user-controlled patterns into swagger-static, or if `glob` is invoked at request time with a tainted pattern (it currently isn't). Still worth fixing — a one-line `pnpm.overrides` entry clears all three paths at zero ergonomic cost (KASA-332).

### 8.4 GHSA-58qx-3vcg-4xpx — `ws` (moderate, CVSS 4.4, dev-only)

`ws@8.0.0–8.20.0` can leak uninitialized memory in outbound WebSocket frames under specific conditions. Reachable paths (all via vitest's jsdom test environment):

- `apps/api > vitest@3.2.4 > jsdom@25.0.1 > ws@8.20.0`
- `apps/back-office > jsdom@25.0.1 > ws@8.20.0`
- `apps/back-office > vitest@3.2.4 > jsdom@25.0.1 > ws@8.20.0`
- `apps/pos > jsdom@25.0.1 > ws@8.20.0`
- `apps/pos > vitest@3.2.4 > jsdom@25.0.1 > ws@8.20.0`
- `packages/payments > vitest@3.2.4 > jsdom@25.0.1 > ws@8.20.0`
- `packages/schemas > vitest@3.2.4 > jsdom@25.0.1 > ws@8.20.0`

Patched in `ws@8.20.1`.

Practical risk for Kassa: **very low**. `ws` is only loaded by jsdom during vitest test bootstrap; Kassa runtime never imports it (POS uses native browser `WebSocket`; the API does pull `ws@8.x` through `@fastify/websocket`, but that resolution is already `>=8.20.1` per the lockfile). No prod surface, no CI exposure. Cleared by a one-line `pnpm.overrides` entry (KASA-333).

### 8.5 Remediation status

| Track | Child issue | Title                                                            | Status     | Notes (2026-05-25)                                                                                          |
|:------|:------------|:-----------------------------------------------------------------|:-----------|:------------------------------------------------------------------------------------------------------------|
| A     | KASA-186    | Bump vitest 2.1.9 → 3.x                                          | **done**   | No change since KASA-288.                                                                                    |
| B     | KASA-187    | Bump vite-plugin-pwa 0.21.2 → 1.x                                | backlog    | No change. Still clears 3 advisories (high serialize-javascript, moderate serialize-javascript, high @babel SystemJS).         |
| C     | KASA-188    | Drop @esbuild-kit shim from drizzle-kit dep tree                 | backlog    | No change.                                                                                                   |
| D     | KASA-189    | CI gate: `pnpm audit` on every lockfile change                   | backlog    | **Increasingly load-bearing** — second routine audit where it would have caught a new advisory at PR time.   |
| E     | KASA-332    | Override `brace-expansion` ≥5.0.6 (GHSA-jxxr-4gwj-5jf2, prod)    | backlog    | **new** — only prod-reachable advisory open. Single `pnpm.overrides` entry; can ship in same PR as KASA-333. |
| F     | KASA-333    | Override `ws` ≥8.20.1 (GHSA-58qx-3vcg-4xpx, dev jsdom)           | backlog    | **new** — dev-only; trivially batched with KASA-332.                                                         |

### 8.6 Cadence note

This audit ran on the routine's actual weekly cadence (KASA-288 was 2026-05-18, this run is 2026-05-25 = T+7d). §5 still documents the monthly refresh target (2026-06-01) for the doc itself — that target is unchanged; this re-audit landed early because Paperclip fires the `Dependency and security audit` routine weekly. Either tighten §5 to match the actual cadence, or relax the routine — flagging as a follow-up but not creating a tracker.

### 8.7 Next refresh

- Next routine audit: **2026-06-01** (routine cadence; aligns with §5 monthly target this once).
- Any new high or critical against `--prod` between now and then escalates to P1 per [RUNBOOK-ONCALL.md](./RUNBOOK-ONCALL.md) §1.

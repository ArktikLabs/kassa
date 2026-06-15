# Kassa dependency security audit — 2026-05-04

Status: v4 (re-audit KASA-389, 2026-06-15). Prior revisions: KASA-373 / 2026-06-12 (§9), KASA-331 / 2026-05-25 (§8), KASA-288 / 2026-05-18 (§7), KASA-185 / 2026-05-04 (§§1–6). Owner: Engineer. Companion docs: [TECH-STACK.md](./TECH-STACK.md), [RUNBOOK-ONCALL.md](./RUNBOOK-ONCALL.md), [CI-CD.md](./CI-CD.md).

Latest re-audit (2026-06-15, origin/main `47047ea`): **no movement in the prod tree** — still the two KASA-373 `@grpc/grpc-js@1.14.3` crash-DoS highs (`GHSA-5375-pq7m-f5r2` + `GHSA-99f4-grh7-6pcq`, both CVSS 7.5, still gated by KASA-378 with the same near-zero practical exploitability — `apps/api/src/lib/otel.ts` instantiates the OTLP/HTTP exporter only). Full-tree picks up two **new dev-only** esbuild advisories: `GHSA-gv7w-rqvm-qjhr` (high, Deno-only RCE — Kassa runs Node, **practical risk zero**) and `GHSA-g7r4-m6w7-qqqr` (low, Windows dev-server-only — Kassa deploys Linux). Both clear with a single `pnpm.overrides` pin `esbuild >=0.28.1`; tracked under **KASA-390**. No advisories resolved vs. KASA-373 (KASA-187 / 378 / 379 still backlog). See §10 for the diff. Per [RUNBOOK-ONCALL](./RUNBOOK-ONCALL.md) §1 nothing has flipped severity: the two prod highs were already known and the new high is dev-only Deno-only.

Prior headline (KASA-373, 2026-06-12): production tree picked up its **first high-severity advisories** since v0 — two `@grpc/grpc-js@1.14.3` crash-DoS bugs (`GHSA-5375-pq7m-f5r2` + `GHSA-99f4-grh7-6pcq`, both CVSS 7.5) reach via `@opentelemetry/sdk-node → @opentelemetry/exporter-*-otlp-grpc`. Full-tree added a new **critical** dev advisory (`GHSA-5xrq-8626-4rwp` on `vitest@3.2.4`, CVSS 9.8). Net movement vs. KASA-331: three new advisories (two prod high, one dev critical), three resolved (brace-expansion via KASA-332, ws via KASA-333, esbuild ≤0.24.2 via KASA-188). Remediation tracked under KASA-378 / KASA-379; KASA-187 / KASA-189 unchanged. Per [RUNBOOK-ONCALL](./RUNBOOK-ONCALL.md) §1 the two prod highs are technically **P1**, but `apps/api/src/lib/otel.ts` instantiates the **OTLP/HTTP** exporter only — the gRPC client is in the tree but never `require()`d at runtime, so practical exploitability is near zero.

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

---

## 9. Re-audit log — 2026-06-12 (KASA-373)

Routine audit (`Dependency and security audit`, originId `e00493d6`). Run against `origin/main` at commit `8656493` with a fresh `pnpm install --frozen-lockfile` and `NODE_ENV` unset. Workspace dependency count dropped from 908 → 885 between KASA-331 and this run, mostly from the KASA-188 esbuild-kit shim removal.

### 9.1 Result summary

| Scope                    | Total deps | Critical | High | Moderate | Low | Info |
|:-------------------------|-----------:|---------:|-----:|---------:|----:|-----:|
| `--prod` (deployed code) |        299 |        0 |    2 |        0 |   0 |    0 |
| Full tree (incl. dev)    |        885 |        1 |    4 |        1 |   0 |    0 |

**Headline.** Two new prod-reachable high advisories on `@grpc/grpc-js@1.14.3` (both CVSS 7.5) land via the OTLP gRPC exporters that ship inside `@opentelemetry/sdk-node`. Full-tree picks up a new critical (`vitest@3.2.4`, CVSS 9.8) that only fires when `vitest --ui` is exposed — which Kassa never runs. Three KASA-331 advisories are now resolved (brace-expansion via KASA-332, ws via KASA-333, esbuild ≤0.24.2 via KASA-188). The three vite-plugin-pwa-chain advisories (KASA-187) remain unchanged.

Severity classification: the two prod highs are **technically P1** under [RUNBOOK-ONCALL.md](./RUNBOOK-ONCALL.md) §1, but **practical exploitability is near zero** — see §9.3 below for the reachability analysis. KASA-378 ships a precise `pnpm.overrides` pin as the durable fix. KASA-189 (CI audit gate) remains backlog; this is the **third consecutive routine audit** where it would have caught a new advisory at PR time, and the first where the slipped advisory is high-severity prod-reachable.

### 9.2 Diff vs. KASA-331 (2026-05-25)

| Advisory                                  | Module                                    | KASA-331 (2026-05-25) | KASA-373 (2026-06-12) | Why                                                                                                                            |
|:------------------------------------------|:------------------------------------------|:----------------------|:----------------------|:-------------------------------------------------------------------------------------------------------------------------------|
| GHSA-5375-pq7m-f5r2 (high, CVSS 7.5)      | `@grpc/grpc-js` 1.14.0–1.14.3              | not present           | **new (prod)**        | OTel SDK 0.218.0 pulls grpc-js 1.14.3. Reaches via `apps/api > @opentelemetry/sdk-node > @opentelemetry/exporter-*-otlp-grpc`. KASA-378 covers a precise pnpm override. |
| GHSA-99f4-grh7-6pcq (high, CVSS 7.5)      | `@grpc/grpc-js` 1.14.0–1.14.3              | not present           | **new (prod)**        | Same path as ↑; same fix. Bundled into KASA-378.                                                                                |
| GHSA-5xrq-8626-4rwp (critical, CVSS 9.8)  | `vitest` <3.2.6                            | not present           | **new (dev only)**    | Affects `vitest --ui` only; Kassa runs `vitest run` exclusively. Patched in 3.2.6. KASA-379 covers the bump.                     |
| GHSA-jxxr-4gwj-5jf2 (moderate, CVSS 6.5)  | `brace-expansion` 5.0.0–5.0.5              | present (prod + dev)  | **resolved**          | KASA-332 landed the `pnpm.overrides` pin `brace-expansion@>=5.0.0 <5.0.6 → >=5.0.6`. Verified via `pnpm audit --prod`.            |
| GHSA-58qx-3vcg-4xpx (moderate, CVSS 4.4)  | `ws` 8.0.0–8.20.0                          | present (dev only)    | **resolved**          | KASA-333 landed the `pnpm.overrides` pin `ws@>=8.0.0 <8.20.1 → >=8.20.1`.                                                        |
| GHSA-67mh-4wv8-2f99 (moderate)            | `esbuild` ≤0.24.2                          | present (1 path)      | **resolved**          | KASA-188 landed: drizzle-kit dropped the `@esbuild-kit/*` shim. No remaining sub-0.25 esbuild paths.                            |
| GHSA-5c6j-r48x-rmvq (high, CVSS 8.1)      | `serialize-javascript` ≤7.0.2              | present               | present               | Unchanged — `vite-plugin-pwa@0.21 > workbox-build@7.4` chain. KASA-187 closes this.                                             |
| GHSA-qj8w-gfj5-8c6v (moderate)            | `serialize-javascript` <7.0.5              | present               | present               | Unchanged — same chain. KASA-187 closes this.                                                                                   |
| GHSA-fv7c-fp4j-7gwp (high, CVSS 8.2)      | `@babel/plugin-transform-modules-systemjs` | present               | present               | Unchanged — same `vite-plugin-pwa@0.21 > workbox-build@7.4 > @babel/preset-env` chain. KASA-187 closes this.                    |

### 9.3 GHSA-5375-pq7m-f5r2 + GHSA-99f4-grh7-6pcq — `@grpc/grpc-js` (high, CVSS 7.5, prod-reachable)

Two distinct advisories in the same patch: `@grpc/grpc-js@1.14.0–1.14.3` crashes on a malformed gRPC request (GHSA-5375-pq7m-f5r2) and on a malformed compressed message (GHSA-99f4-grh7-6pcq). Both are denial-of-service via uncaught exception. Both patched in `@grpc/grpc-js@1.14.4`.

Reachable paths (12 each, all via the OpenTelemetry SDK on `apps/api`):

- `apps/api > @opentelemetry/sdk-node@0.218.0 > @opentelemetry/exporter-trace-otlp-grpc@0.218.0 > @grpc/grpc-js@1.14.3`
- `apps/api > @opentelemetry/sdk-node@0.218.0 > @opentelemetry/exporter-metrics-otlp-grpc@0.218.0 > @grpc/grpc-js@1.14.3`
- `apps/api > @opentelemetry/sdk-node@0.218.0 > @opentelemetry/exporter-logs-otlp-grpc@0.218.0 > @grpc/grpc-js@1.14.3`
- …and the `@opentelemetry/otlp-grpc-exporter-base` re-export of each
- The same 6 paths repeat via `apps/pos > @kassa/api@link:../api > …` (workspace link, identical code; only the API process actually loads node modules)

**Practical risk for Kassa: near zero.**

`apps/api/src/lib/otel.ts` is the only OTel boot site. It constructs the SDK as:

```ts
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
…
traceExporter: new OTLPTraceExporter(),
```

The exporter is `@opentelemetry/exporter-trace-otlp-http` — the HTTP/Protobuf variant — and no other code in `apps/api/src` imports `@grpc/grpc-js`, `exporter-*-otlp-grpc`, or `otlp-grpc-exporter-base`. The gRPC exporter modules are pulled into `node_modules` as transitive deps of `@opentelemetry/sdk-node` (which bundles HTTP, gRPC, and Proto variants for convenience) but are never `require()`d at runtime. There is no listening gRPC port and no outbound gRPC channel.

The HTTP exporter has no path through `@grpc/grpc-js`, so neither advisory is reachable on a running Kassa API process. The CVSS 7.5 ratings are nominally accurate for any deployment that does use the gRPC exporter — we do not.

Still: the advisory shows up in `pnpm audit --prod`, will trip any CI audit gate (KASA-189), and is a prod-tree red mark. Fix is a one-line `pnpm.overrides` entry that pins all transitive `@grpc/grpc-js` to ≥1.14.4. KASA-378 carries this.

### 9.4 GHSA-5xrq-8626-4rwp — `vitest` (critical, CVSS 9.8, dev-only)

When `vitest --ui` is running, the local UI server (default `127.0.0.1:51204`) accepts a websocket call that reads + executes an arbitrary file. A malicious page open in the same browser can therefore drop a file via the API and execute it on the developer's machine. Patched in `vitest@3.2.6`.

Reachable paths (5, all dev-only):

- `apps/api > vitest@3.2.4`
- `apps/back-office > vitest@3.2.4`
- `apps/pos > vitest@3.2.4`
- `packages/payments > vitest@3.2.4`
- `packages/schemas > vitest@3.2.4`

**Practical risk for Kassa: very low.**

- Every workspace `package.json` script runs `vitest run` (CI mode); no `--ui` flag, no `test:ui` script.
- `@vitest/ui` is **not installed** anywhere in the monorepo (grep across all `package.json` files and the lockfile).
- CI uses `vitest run` exclusively (no UI).

The CVSS 9.8 reflects the worst-case (developer with `vitest --ui` open and visiting an attacker-controlled page in the same browser session). Kassa's actual exposure is the *possibility* of a developer manually opting in. Fix is a one-liner — the workspaces already declare `vitest: ^3.2.0`, so `pnpm update -r vitest` should lift to 3.2.6 (or a precise override mirrors KASA-332 / KASA-333). KASA-379 tracks it.

### 9.5 Remediation status

| Track | Child issue | Title                                                            | Status     | Notes (2026-06-12)                                                                                          |
|:------|:------------|:-----------------------------------------------------------------|:-----------|:------------------------------------------------------------------------------------------------------------|
| A     | KASA-186    | Bump vitest 2.1.9 → 3.x                                          | **done**   | Unchanged from KASA-331.                                                                                     |
| B     | KASA-187    | Bump vite-plugin-pwa 0.21.2 → 1.x                                | backlog    | **Still backlog.** Now the last open multi-advisory bump (clears high serialize-javascript, moderate serialize-javascript, high @babel SystemJS). Three routine audits in a row this has carried over.       |
| C     | KASA-188    | Drop @esbuild-kit shim from drizzle-kit dep tree                 | **done**   | Landed since KASA-331. Cleared the remaining `esbuild` ≤0.24.2 path.                                         |
| D     | KASA-189    | CI gate: `pnpm audit` on every lockfile change                   | backlog    | **Increasingly load-bearing**: third routine audit where it would have caught a new advisory at PR time, **first** where the slipped advisory is **prod-reachable high**. |
| E     | KASA-332    | Override `brace-expansion` ≥5.0.6                                | **done**   | Landed since KASA-331. Prod tree now clean of brace-expansion.                                               |
| F     | KASA-333    | Override `ws` ≥8.20.1                                            | **done**   | Landed since KASA-331.                                                                                       |
| G     | KASA-378    | Override `@grpc/grpc-js` ≥1.14.4 (GHSA-5375-pq7m-f5r2 + GHSA-99f4-grh7-6pcq, prod) | backlog | **new** — both new prod-reachable advisories. Single `pnpm.overrides` entry clears all 12 paths × 2 advisories. |
| H     | KASA-379    | Bump `vitest` ≥3.2.6 (GHSA-5xrq-8626-4rwp, dev `--ui` only)      | backlog    | **new** — critical CVSS but no live attack surface in Kassa's flows. `pnpm update -r vitest` is likely enough. |

### 9.6 KASA-189 escalation note

Three routine audits in a row (KASA-288, KASA-331, KASA-373) have surfaced advisories that landed in `pnpm-lock.yaml` between routine runs, and that a `pnpm audit --prod` gate on the lockfile-bump PR would have caught at merge time:

- KASA-288 → GHSA-fv7c-fp4j-7gwp (high) via `@babel/preset-env`
- KASA-331 → GHSA-jxxr-4gwj-5jf2 (moderate, prod) via `brace-expansion`
- KASA-373 → GHSA-5375-pq7m-f5r2 + GHSA-99f4-grh7-6pcq (both high, prod) via `@grpc/grpc-js`

KASA-189's cost has not changed; its value has gone up. Recommend the next audit cycle promote KASA-189's priority from `medium` → `high` if it is still backlog by KASA-396 (next routine).

### 9.7 Cadence note

This run lands 2026-06-12, eighteen days after KASA-331 (2026-05-25). The Paperclip routine fires the `Dependency and security audit` more frequently than §5's monthly cadence target — there have now been four runs in 39 days. §5 still documents the monthly intent; the audit doc treats the routine cadence as canonical and updates §9 each time. No tracker filed for this cadence drift; flag as a follow-up only.

### 9.8 Next refresh

- Next routine audit: whenever the Paperclip routine next fires.
- Out-of-cycle: any new high or critical against `--prod` between now and then escalates to **P1** per [RUNBOOK-ONCALL.md](./RUNBOOK-ONCALL.md) §1 and should reopen this doc.
- KASA-378 should land before the next routine to clear the prod high; KASA-379 should land before any developer turns on `vitest --ui`.

---

## 10. Re-audit log — 2026-06-15 (KASA-389)

Routine audit (`Dependency and security audit`, originId `e00493d6`). Run against `origin/main` at commit `47047ea` with a fresh `pnpm install --frozen-lockfile` and `NODE_ENV` unset. Workspace dependency count unchanged from KASA-373 (885 full / 299 prod).

### 10.1 Result summary

| Scope                    | Total deps | Critical | High | Moderate | Low | Info |
|:-------------------------|-----------:|---------:|-----:|---------:|----:|-----:|
| `--prod` (deployed code) |        299 |        0 |    2 |        0 |   0 |    0 |
| Full tree (incl. dev)    |        885 |        1 |    5 |        1 |   1 |    0 |

**Headline.** **Prod tree unchanged** vs. KASA-373: same two `@grpc/grpc-js@1.14.3` highs (KASA-378). Full tree picks up two new **dev-only esbuild** advisories — `GHSA-gv7w-rqvm-qjhr` (high, Deno-only RCE) and `GHSA-g7r4-m6w7-qqqr` (low, Windows dev-server-only). Both share the same fix (`esbuild >=0.28.1`); bundled under KASA-390. No advisories were resolved between KASA-373 and this run — KASA-187 / KASA-378 / KASA-379 are all still backlog three days after the previous audit, which is below the round-trip latency the routine cadence (currently ~weekly) can compress.

Severity classification: no flips vs. KASA-373. The two prod highs are the same near-zero-exploitability set described in §9.3 (still gated by KASA-378). The new high (`GHSA-gv7w-rqvm-qjhr`) is dev-only AND Deno-only — Kassa runs Node exclusively (verified: no `deno.json`, no Deno binary in CI, no `deno run` script in any `package.json`), so it is non-exploitable on our paths. The new low is Windows-only; production deploys to Fly.io (Linux).

### 10.2 Diff vs. KASA-373 (2026-06-12)

| Advisory                                  | Module                                    | KASA-373 (2026-06-12) | KASA-389 (2026-06-15) | Why                                                                                                                            |
|:------------------------------------------|:------------------------------------------|:----------------------|:----------------------|:-------------------------------------------------------------------------------------------------------------------------------|
| GHSA-gv7w-rqvm-qjhr (high, Deno RCE)       | `esbuild` 0.17.0–0.28.0                   | not present           | **new (dev only)**    | Published 2026-06-13. Patched in 0.28.1. Reaches via drizzle-kit, tsx, vite 7.3.2, vitest 3.2.4. Deno-specific exploit; **N/A to Kassa** (Node-only). KASA-390. |
| GHSA-g7r4-m6w7-qqqr (low, Windows dev-server) | `esbuild` 0.27.3–0.28.0                | not present           | **new (dev only)**    | Same vendor advisory bundle as ↑; Windows-only. Same fix. Bundled into KASA-390.                                                |
| GHSA-5375-pq7m-f5r2 (high, CVSS 7.5)      | `@grpc/grpc-js` 1.14.0–1.14.3             | present (prod)        | present (prod)        | Unchanged — KASA-378 still backlog. Three calendar days since previous audit, no remediation churn expected.                    |
| GHSA-99f4-grh7-6pcq (high, CVSS 7.5)      | `@grpc/grpc-js` 1.14.0–1.14.3             | present (prod)        | present (prod)        | Unchanged — same as ↑, same KASA-378.                                                                                           |
| GHSA-5xrq-8626-4rwp (critical, CVSS 9.8)  | `vitest` <3.2.6                           | present (dev)         | present (dev)         | Unchanged — KASA-379 still backlog. No `vitest --ui` usage in repo; non-exploitable.                                            |
| GHSA-5c6j-r48x-rmvq (high, CVSS 8.1)      | `serialize-javascript` ≤7.0.2             | present (dev)         | present (dev)         | Unchanged — same `vite-plugin-pwa@0.21 > workbox-build@7.4` chain. KASA-187.                                                    |
| GHSA-qj8w-gfj5-8c6v (moderate)            | `serialize-javascript` <7.0.5             | present (dev)         | present (dev)         | Unchanged — same chain. KASA-187.                                                                                               |
| GHSA-fv7c-fp4j-7gwp (high, CVSS 8.2)      | `@babel/plugin-transform-modules-systemjs` | present (dev)         | present (dev)         | Unchanged — same `vite-plugin-pwa@0.21 > workbox-build@7.4 > @babel/preset-env` chain. KASA-187.                                |

### 10.3 GHSA-gv7w-rqvm-qjhr — `esbuild` (high, Deno-only, dev-only)

The advisory describes a Deno-runtime issue: esbuild's Deno entry point downloads its native binary from `NPM_CONFIG_REGISTRY` without integrity verification, so a hostile registry can serve a malicious binary that runs at install time. Patched in `esbuild@0.28.1`.

Reachable paths (47, all dev/build/test, all Node-side): the same `drizzle-kit > tsx > esbuild@0.25.12 / 0.27.7` chain plus every workspace's `vitest@3.2.4 > vite@7.3.2 > esbuild@0.27.7` and tooling chain. Two finding versions land: `0.25.12` (drizzle-kit pull-through, single path) and `0.27.7` (everything else).

**Practical risk for Kassa: zero.**

- No `deno.json` / `deno.lock` / `deno.lockb` anywhere in the repo.
- No `deno` binary required by any CI workflow (`grep -r 'deno' .github/workflows` returns nothing).
- No `deno run` / `deno install` / `deno task` in any `package.json` script.
- All esbuild invocations go through the Node-native binary (`esbuild` postinstall picks `@esbuild/linux-x64` / `darwin-arm64`), which is unaffected by the Deno-loader path.

The fix is a single `pnpm.overrides` pin to `>=0.28.1`. KASA-390 carries it.

### 10.4 GHSA-g7r4-m6w7-qqqr — `esbuild` (low, Windows dev-server)

When `esbuild --serve` runs on Windows, a crafted request can read arbitrary files outside the served directory. Patched in `esbuild@0.28.1` (same release as ↑).

Reachable paths: identical to §10.3 minus the `0.25.12` drizzle-kit chain (this advisory's vulnerable range starts at `0.27.3`).

**Practical risk for Kassa: very low.**

- Production deploys to Fly.io (Linux). No esbuild dev server runs anywhere in prod.
- CI runs on Ubuntu runners. No Windows in CI.
- Developer machines may include Windows, but `vite dev` / `esbuild --serve` are local-loopback by default (no `--host`).

Same fix as §10.3, same KASA-390.

### 10.5 Remediation status

| Track | Child issue | Title                                                            | Status     | Notes (2026-06-15)                                                                                          |
|:------|:------------|:-----------------------------------------------------------------|:-----------|:------------------------------------------------------------------------------------------------------------|
| A     | KASA-186    | Bump vitest 2.1.9 → 3.x                                          | **done**   | Unchanged from KASA-373.                                                                                     |
| B     | KASA-187    | Bump vite-plugin-pwa 0.21.2 → 1.x                                | backlog    | Unchanged. Still clears 3 advisories (high serialize-javascript, moderate serialize-javascript, high @babel SystemJS). Four routine audits in a row this has carried over. |
| C     | KASA-188    | Drop @esbuild-kit shim from drizzle-kit dep tree                 | **done**   | Unchanged from KASA-373.                                                                                     |
| D     | KASA-189    | CI gate: `pnpm audit` on every lockfile change                   | backlog    | **Promote to high.** Per §9.6 escalation criterion: four consecutive routine audits with at least one slipped advisory each. Filed PATCH below. |
| E     | KASA-332    | Override `brace-expansion` ≥5.0.6                                | **done**   | Unchanged from KASA-373.                                                                                     |
| F     | KASA-333    | Override `ws` ≥8.20.1                                            | **done**   | Unchanged from KASA-373.                                                                                     |
| G     | KASA-378    | Override `@grpc/grpc-js` ≥1.14.4                                 | backlog    | Unchanged. Three calendar days since KASA-373 filed it — within normal triage latency.                       |
| H     | KASA-379    | Bump `vitest` ≥3.2.6                                             | backlog    | Unchanged. Same triage window as KASA-378.                                                                   |
| I     | KASA-390    | Override `esbuild` ≥0.28.1 (GHSA-gv7w-rqvm-qjhr + GHSA-g7r4-m6w7-qqqr) | backlog | **new** — both new dev-only advisories. Single `pnpm.overrides` entry; also removes the now-obsolete `@esbuild-kit/core-utils>esbuild` override left over from KASA-185 (the shim was deleted by KASA-188). |

### 10.6 KASA-189 escalation

This is the **fourth** consecutive routine audit (KASA-288, KASA-331, KASA-373, KASA-389) where a `pnpm audit` gate on the lockfile-bump PR would have caught a slipped advisory before merge. KASA-373 §9.6 set the trigger as "promote KASA-189 medium → high if still backlog by KASA-389." That trigger is met. PATCHing KASA-189 priority to `high` as part of this PR (separately from the doc).

### 10.7 Cadence note

This run lands 2026-06-15, three days after KASA-373 (2026-06-12). That is well below the §5 monthly intent. Per the §9.7 follow-up flag, the routine cadence is the canonical schedule and the §5 paragraph remains stale — still not creating a tracker for it; the cost of the routine fire is a single `pnpm audit` + a doc append, which is cheap.

### 10.8 Next refresh

- Next routine audit: whenever the Paperclip routine next fires.
- Out-of-cycle: any new high or critical against `--prod` between now and then escalates to **P1** per [RUNBOOK-ONCALL.md](./RUNBOOK-ONCALL.md) §1 and should reopen this doc.
- KASA-378 should land before the next routine to clear the prod highs (still the only prod-reachable open items).
- KASA-379 should land before any developer turns on `vitest --ui`.
- KASA-390 has no immediate exploitability deadline (Deno-only / Windows-only); pair with the next lockfile-touching PR to minimise churn.
- KASA-189 (now high-priority) should land before the next routine audit, after which the value of routine audits drops sharply.

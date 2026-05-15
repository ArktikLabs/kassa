# Kassa CI/CD Pipeline

Status: v0 (CI + CD — POS / Back Office in Cloudflare Pages production, API in Fly.io staging on every green main, API production via manual gate; preview-per-PR deferred). Owner: DevOps. Source issues: [KASA-12](/KASA/issues/KASA-12) (pipeline), [KASA-17](/KASA/issues/KASA-17) (deployable build artifacts), [KASA-18](/KASA/issues/KASA-18) (production CD — static surfaces), [KASA-107](/KASA/issues/KASA-107) (staging CD — API), [KASA-19](/KASA/issues/KASA-19) (post-deploy smoke tests), [KASA-70](/KASA/issues/KASA-70) (production CD — API), [KASA-139](/KASA/issues/KASA-139) (Playwright E2E gate on `main`).
Companion docs: [TECH-STACK.md](./TECH-STACK.md), [ARCHITECTURE.md](./ARCHITECTURE.md), [ROADMAP.md](./ROADMAP.md), [RUNBOOK-DEPLOY.md](./RUNBOOK-DEPLOY.md), [RUNBOOK-ONCALL.md](./RUNBOOK-ONCALL.md), [RUNBOOK-INCIDENT.md](./RUNBOOK-INCIDENT.md).

This is the authoritative description of how Kassa code moves from a contributor's branch into `main` and into production. v0 covers **CI** (lint/typecheck/test/build on every PR and every push to `main`, with compiled outputs preserved as workflow artifacts) and **CD** for four surfaces: the POS PWA and Back Office SPA deploy to Cloudflare Pages production and the API deploys to a Fly.io staging app on every successful CI run against `main`; the API ships to Fly.io production via a manual promotion gate (`deploy-prod.yml`) with required-reviewer approval. Preview-per-PR environments remain a follow-up ticket under M0. Operator playbook for production lives in [RUNBOOK-DEPLOY.md](./RUNBOOK-DEPLOY.md).

---

## 1. Pipeline overview

| Concern           | Tool                                    |
|:------------------|:----------------------------------------|
| CI orchestrator   | GitHub Actions                          |
| Runner            | `ubuntu-latest` (GitHub-hosted)         |
| Node version      | `22` (pinned via `.nvmrc`)              |
| Package manager   | `pnpm@9.12.0` (pinned via `packageManager`) |
| Dependency cache  | `actions/setup-node`'s built-in pnpm cache (keyed on `pnpm-lock.yaml`) |
| Lint/format       | Biome 2.x (`pnpm lint` / `pnpm format`; config in [`biome.json`](../biome.json)) |
| Typecheck         | `tsc --noEmit` per package (`pnpm -r typecheck`) |
| Test              | Vitest (`pnpm -r test`)                 |
| Build             | `tsc -p tsconfig.build.json` (packages) + Vite (apps) (`pnpm -r build`) |
| Build artifacts   | `actions/upload-artifact` — one per deployable, 7-day retention (see §2.3) |
| E2E gate          | Playwright — `e2e.yml` on push to `main` + `workflow_dispatch` (see §2.5); KASA-68 acceptance suite is its own job in `ci.yml` (see §2.6) |
| CD orchestrator   | GitHub Actions (see [`cd.yml`](../.github/workflows/cd.yml)) |
| CD targets (live) | Cloudflare Pages — `kassa-pos`, `kassa-back-office`; Fly.io — `kassa-api-staging` (`sin`); Fly.io — `kassa-api-prod` (`sin`, manual gate) |
| CD targets (deferred) | Per-PR preview environments (KASA-108) |

All workflows live in [`.github/workflows/`](../.github/workflows). The CI workflow is [`ci.yml`](../.github/workflows/ci.yml).

---

## 2. CI workflow (`ci.yml`)

**Triggers**

- `pull_request` targeting `main`
- `push` to `main`

**Concurrency**

Runs on the same ref cancel each other so only the newest PR push is executing. Pushes to `main` are never cancelled.

**Permissions**

`contents: read` only. No token surface for workflow-level mutation.

**Job order**

1. **Checkout** — `actions/checkout`.
2. **Install pnpm** — `pnpm/action-setup` with `run_install: false` so `setup-node` owns cache restoration.
3. **Setup Node.js** — `actions/setup-node` reads `.nvmrc` and restores the pnpm store from the cache keyed on `pnpm-lock.yaml`.
4. **Install dependencies** — `pnpm install --frozen-lockfile`. This is deliberate: it turns any drift between `package.json` and `pnpm-lock.yaml` into a red CI run instead of a silent `pnpm install` that mutates the lockfile on the runner.
5. **Lint (Biome)** — `pnpm lint --reporter=github`. Biome scans the whole tree from the repo root (see §2.4); the `github` reporter annotates violations on the PR diff. Runs before build because it has no artifacts dependency and fails fast on style/correctness regressions.
6. **Build workspace** — `pnpm -r build`. `pnpm -r` is topology-aware, so `packages/*` (no internal deps) build before `apps/*` (which depend on them).
7. **Typecheck** — `pnpm -r typecheck`.
8. **Test** — `pnpm -r test` (Vitest only; Playwright runs in `e2e.yml`, see §2.5).
9. **Upload build artifacts** — `actions/upload-artifact` for each deployable. See §2.3.

**Timeout**: 15 minutes. A healthy run is ~2 minutes today (see §4).

### 2.1 Why build runs before typecheck

The skill guidance "put fastest checks first" normally means `typecheck` before `build`. Kassa inverts this because **`apps/api` imports from `@kassa/payments` and `@kassa/schemas`**, and those workspace packages publish only compiled types:

```json
// packages/payments/package.json (excerpt)
"exports": {
  ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
}
```

On a cold checkout there is no `dist/`, so `tsc --noEmit` in `apps/api` fails with `Cannot find module '@kassa/payments'`. `pnpm -r build` primes the `dist/` folders in topology order, after which typecheck and test succeed.

If we later move the shared packages to source-first exports (an `exports.source` condition pointing at `./src/index.ts`), we can flip the order back to lint → typecheck → test → build. Tracked for a future ticket; not worth blocking M0 CI on.

### 2.2 Action pinning

All actions are pinned to full commit SHAs with a trailing comment naming the tag they resolved to:

```yaml
uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
uses: actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4.1.0
uses: pnpm/action-setup@fe02b34f77f8bc703788d5817da081398fad5dd2 # v4.0.0
uses: actions/upload-artifact@b4b15b8c7c6ac21ea08fcf65892d2ee8f75cf882 # v4.4.3
```

Renovate/Dependabot may bump these; reviewers must verify the SHA against the upstream tag before approving a bump.

### 2.3 Build artifacts

After `pnpm -r build` succeeds, CI uploads one artifact per deployable so that:

- reviewers can download the compiled output of a PR and inspect what will actually ship, and
- CD (future ticket) can pull the exact bytes produced on `main` instead of rebuilding from source on the deploy runner, eliminating any build-vs-deploy drift.

| Artifact name     | Contents                                                                                       | Consumed by                            |
|:------------------|:-----------------------------------------------------------------------------------------------|:---------------------------------------|
| `pos-dist`        | `apps/pos/dist/` (Vite PWA output — HTML, hashed JS/CSS, service worker, manifest, icons)      | Cloudflare Pages (POS PWA)             |
| `back-office-dist`| `apps/back-office/dist/` (Vite SPA output)                                                     | Cloudflare Pages (Back Office SPA)     |
| `api-dist`        | `apps/api/dist/` + `apps/api/{package.json,Dockerfile,fly.toml}` + `packages/{payments,schemas}/dist/` + their `package.json` + root `package.json` + `pnpm-lock.yaml` + `pnpm-workspace.yaml` | Fly.io deploy (`kassa-api-staging`)    |

**Why `api-dist` ships the workspace scaffolding, not just `apps/api/dist/`.** The API imports from `@kassa/payments` and `@kassa/schemas` via `workspace:*`. A Fly.io runtime needs enough of the workspace to resolve those deps and run `pnpm install --prod --frozen-lockfile` before `node apps/api/dist/index.js`. Bundling the two packages' compiled `dist/` folders + `package.json` + the root lockfile and `pnpm-workspace.yaml` (and the root `package.json`, which pnpm requires to recognise the workspace) gives the deployer a self-contained artifact. Third-party runtime deps (fastify, drizzle-orm, argon2, etc.) are installed on the deploy side — they are intentionally not in the artifact because argon2 is a native addon and must be compiled for the deploy target's glibc/musl.

**Source maps in artifacts** ([KASA-140](/KASA/issues/KASA-140)). All three artifact `dist/` trees carry `*.js.map` files alongside the emitted JS:

- `apps/pos` and `apps/back-office` configure Vite with `build.sourcemap: 'hidden'`, which emits the maps **without** the `//# sourceMappingURL=` comment in the bundled JS — the public bundle never advertises a source-map URL even before the strip step in `cd.yml` runs. The two Vite configs also derive `VITE_RELEASE = kassa-{pos,back-office}@<sha12>` from the CI runner's `GITHUB_SHA` so `Sentry.init({ release })` tags every event with the same string the deploy job uploads source maps under.
- `apps/api` and the workspace packages (`packages/payments`, `packages/schemas`) have `sourceMap: true` in their `tsconfig.build.json`, so `tsc` emits `.js.map` next to every `.js` file. The API's Fly container runs Node with `--enable-source-maps` (set in `apps/api/Dockerfile`) so server-side stack traces in pino logs are symbolicated locally — the maps stay in the deployed image (see §3.6, `strip-source-maps: false`).

A dedicated CI step (`Verify source maps emitted` after `pnpm -r test`) walks each `dist/` tree and fails the run with `::error::` if any artifact has zero `*.js.map` files. This catches a regression on PR (a flipped `sourcemap` flag, a dropped `sourceMap` setting) before it lands on `main` and a deploy ships an un-symbolicatable bundle. PR runs do not upload to Sentry — that step lives in `cd.yml` / `deploy-prod.yml` and is gated on `SENTRY_AUTH_TOKEN` — but every PR run still proves the maps exist.

The artifact also ships the Dockerfile and fly.toml from `apps/api/` so a rolled-back deploy replays the exact infra config the build shipped with — infra config is versioned alongside the bytes it deploys.

**Settings shared by all three uploads**:

- `if-no-files-found: error` — a missing `dist/` almost always means the build silently skipped a workspace. Fail loudly.
- `retention-days: 7` — short by GitHub's standards (default is 90) because v0 has no CD consuming them yet. Bump this when CD lands and wants to replay a prior build.

**Uploaded on both PR and `push: main`.** PR uploads let reviewers pull a preview build locally (`gh run download <run-id>`) without running `pnpm build` themselves. Main-branch uploads are the input to CD. The overhead is ~5 s per artifact at ~2–5 MB per deployable — negligible against the 15-min timeout.

**Consistency across environments.** The artifact is produced from:

- a pinned Node version (`.nvmrc` → `22`),
- a pinned pnpm version (`packageManager` field → `9.12.0`),
- a frozen lockfile (`--frozen-lockfile`),
- a fixed `ubuntu-latest` runner image,
- no environment variables leaking in from the runner (CI sets none beyond GitHub defaults).

Two runs of the same SHA must therefore produce byte-identical `dist/` output modulo timestamps; any drift is a bug in the build toolchain. This is the guarantee CD (once live) will rely on for preview/staging/prod parity.

### 2.4 Lint (Biome)

Biome is the single lint + format tool for the whole tree, per [TECH-STACK.md §11.2](./TECH-STACK.md). Config lives in [`biome.json`](../biome.json) at the repo root; there is intentionally no per-package `biome.json` and no per-package `lint` script.

**Why one root scan, not `pnpm -r lint`.** Biome was designed to walk the workspace from a single entry point — it reads `biome.json` once, shares the parser and ignore lists across the whole tree, and parallelises internally. Fanning out via `pnpm -r` would re-initialise Biome per package, re-read the same config, and lose Biome's cross-file diagnostics. The root `pnpm lint` (`biome check`) covers 180+ files in well under a second; per-package scripts would be slower and add surface area without catching anything extra.

**Local workflow**:

| Script              | What it does                                              |
|:--------------------|:----------------------------------------------------------|
| `pnpm lint`         | `biome check` — lint + format-diagnostic, read-only.      |
| `pnpm lint:fix`     | `biome check --write` — apply safe lint + format fixes.   |
| `pnpm format`       | `biome format` — formatter diagnostics only, read-only.   |
| `pnpm format:write` | `biome format --write` — apply formatter fixes.           |

**CI step.** `pnpm lint --reporter=github` in `ci.yml` (step 5 above). The `github` reporter emits `::error` annotations so violations render inline on the PR diff. The step fails the run on any violation — there is no warning tier.

**Editing `biome.json`.** Any change to lint rule severity needs a quick justification in the PR description (why the rule is being loosened or tightened) and a `pnpm lint` run against `main` to confirm no pre-existing violations are hidden by the change.

### 2.5 E2E gate ([`e2e.yml`](../.github/workflows/e2e.yml), [KASA-139](/KASA/issues/KASA-139), [KASA-238](/KASA/issues/KASA-238))

Playwright runs in its own workflow rather than as a step in `ci.yml` because (a) the browser install adds ~30–60 s that PR CI does not need to pay for and (b) the E2E lane has its own posture (push-only, retry policy, artifact retention) that does not match the `ci.yml` pipeline.

The workflow is split into three jobs that share an install/build but have different blocking postures:

| Job          | Trigger                                | Specs                              | Blocks `main`? |
|:-------------|:---------------------------------------|:-----------------------------------|:---------------|
| `gate`       | `push` to `main`, `workflow_dispatch`  | All specs except `@flaky`-tagged   | Yes            |
| `quarantine` | `push` to `main`, `workflow_dispatch`  | Only `@flaky`-tagged specs         | No (observation only) |
| `nightly`    | `schedule` (`0 17 * * *` UTC), dispatch| **All** specs (incl. `@flaky`)     | No (observation only) |

`gate` is the blocking lane. `quarantine` and `nightly` produce JSON outcome artifacts (30-day retention) consumed by [`scripts/qa/flake-report.ts`](../scripts/qa/flake-report.ts) for the weekly QA review. The full policy that governs which specs may be tagged `@flaky`, when they earn the tag, and how long they may stay tagged lives in [docs/E2E-FLAKE-POLICY.md](./E2E-FLAKE-POLICY.md).

**Triggers**

- `push` to `main` — runs `gate` (blocks the trunk on a regression) and `quarantine`.
- `workflow_dispatch` — operator can run on demand against `main`, e.g. before kicking off `deploy-prod.yml`.
- `schedule` (`0 17 * * *` UTC = 00:00 WIB next day) — runs `nightly` only.

It does **not** run on `pull_request`. Keeping E2E off the PR lane preserves PR latency per [TECH-STACK.md §9](./TECH-STACK.md). Branch-protection wiring to make `gate` a required check on `main` is a separate Repo Admin step (see [§6 follow-up #9](#6-follow-ups-tracked-against-this-doc)) — gated on the flake policy being in force per [E2E-FLAKE-POLICY.md §7](./E2E-FLAKE-POLICY.md#7-branch-protection-enabling-the-gate).

**Scope**

| App         | Specs                                                        | Posture                |
|:------------|:-------------------------------------------------------------|:-----------------------|
| `apps/pos`  | `e2e/offline.spec.ts`, `e2e/tender-cash.spec.ts`, `e2e/tender-qris.spec.ts` | Service-worker shell + tender flows |
| `apps/back-office` | `e2e/admin-smoke.spec.ts`                              | Owner sign-in + catalog create golden path |

The POS `playwright.config.ts` excludes `e2e/full-day-offline.spec.ts` via `testIgnore` so the default `pnpm test:e2e` invocation skips it. That spec is the KASA-68 vision-metric acceptance suite and runs from `playwright.full-day-offline.config.ts` against an in-memory API harness — see §2.6 below.

**Job order**

1. Checkout, install pnpm, setup Node 22 with the pnpm cache.
2. `pnpm install --frozen-lockfile`.
3. `pnpm -r build` — primes `dist/` for the Vite preview servers (the back-office config does not run `pnpm build` inside its `webServer` command, so the dist must be there in advance).
4. `pnpm --filter @kassa/pos exec playwright install --with-deps chromium` — only Chromium; both configs project to a single chromium target.
5. `pnpm --filter @kassa/pos exec playwright test` — POS suite.
6. `pnpm --filter @kassa/back-office exec playwright test` — back-office suite.
7. Upload `playwright-report` artifact (HTML report + traces from both apps) on failure, 7-day retention.

The two suites run sequentially rather than in parallel jobs so a single chromium install + warm pnpm cache cover both, keeping total wall-clock under the 10-minute budget set in the [KASA-139](/KASA/issues/KASA-139) acceptance criteria. A healthy run is closer to 5–7 minutes.

**Retry posture**

Each app's `playwright.config.ts` sets `retries: 2` when `CI=true`. This is the ceiling for the `gate` lane: a spec that fails after two retries is treated as a regression, not a flake, and re-running the workflow is **not** the first response (see [E2E-FLAKE-POLICY.md §5](./E2E-FLAKE-POLICY.md#5-zero-tolerance-on-main)).

A spec that retry-passes in two distinct runs within a 14-day window earns the `@flaky` tag and moves to the `quarantine` lane under the rules in [E2E-FLAKE-POLICY.md §3](./E2E-FLAKE-POLICY.md#3-the-two-failure-rule-when-does-a-spec-become-flaky). Quarantine is bounded: each `@flaky` spec carries a 14-day deadline to ship a fix or revert the originating feature, with no extension.

The KASA-68 acceptance suite (`apps/pos/e2e/full-day-offline.spec.ts`, §2.6) does not participate in `@flaky` quarantine — a flake there is a v0 release-gate failure and is escalated immediately rather than tagged.

### 2.6 KASA-68 acceptance suite (in `ci.yml`)

The full-day offline acceptance suite (`apps/pos/e2e/full-day-offline.spec.ts`) is the v0 release-gate vision metric and ships under its own job (`acceptance-full-day-offline`) inside `ci.yml`, not in `e2e.yml`. It is informational on PR (`continue-on-error: true`) and blocking on `main`. The `deploy-prod.yml` production gate reads its conclusion separately and refuses to promote unless it was green on the cited CI run — see §3.11.

`e2e.yml` and the acceptance job do not overlap: `playwright.config.ts` excludes the full-day-offline spec, and the acceptance job uses `playwright.full-day-offline.config.ts` which `testMatch`-restricts to that one spec.

### 2.7 Schema-drift contract gate ([KASA-179](/KASA/issues/KASA-179))

The `Contract gate (KASA-179)` step in `ci.yml` defends the bet that `@kassa/schemas` stays the single source of request/response Zod schemas across the API, the PWA, and the back office. The bet is in [ROADMAP.md §Risk register #5](./ROADMAP.md), and prior incidents (KASA-121 wire-shape gap, KASA-125 OpenAPI redecoration) confirmed drift can land without a structural guard.

The gate is a vitest suite at [`apps/api/test/contract-gate.test.ts`](../apps/api/test/contract-gate.test.ts) and runs in two places: bundled into `pnpm -r test`, then re-run as a named `Contract gate (KASA-179)` step so a drift failure surfaces as a distinct red-X in the GitHub UI.

It enforces three assertions:

1. **Static — no inline Zod in route files.** A regex sweep of `apps/api/src/routes/*.ts` forbids `const xxx = z.<method>(...)` declarations outside the `health.ts` allowlist. Inline `z.union([…])` composition over already-imported schemas is tolerated; bare inline `const itemSchema = z.object({...})` is not.

2. **Identity — every route schema is a `@kassa/schemas` export.** The suite boots the API via the `onCreate` test seam in `buildApp`, installs an `onRoute` Fastify hook that captures every registered route, and asserts each Zod schema attached to `schema.body | querystring | params | response.<code>` is *reference-equal* to a schema exported by `@kassa/schemas`. A route that re-declares a wire shape inline produces a fresh Zod instance that is not in the exported set, and the gate fails.

3. **Drift — OpenAPI surface matches the committed snapshot.** The rendered OpenAPI document at `/docs/json` is normalised (volatile `info.version` + `servers` stripped) and compared against [`apps/api/test/__contract__/openapi.snapshot.json`](../apps/api/test/__contract__/openapi.snapshot.json). Any schema-shape change (renamed field, new endpoint, dropped status code) trips the test until the snapshot is refreshed.

#### Running locally

```sh
# Just the gate:
pnpm --filter @kassa/api test contract-gate

# After an intentional schema change, refresh the OpenAPI snapshot and review the diff:
UPDATE_OPENAPI_SNAPSHOT=1 pnpm --filter @kassa/api test contract-gate
```

#### What a failure looks like

| Failure mode                                    | Gate that fires                                              | Fix |
|:------------------------------------------------|:-------------------------------------------------------------|:----|
| New route declares `const x = z.object(...)`    | §1 static — `Inline Zod schemas in route files`              | Move the schema into `packages/schemas/src/<module>.ts`, export it, and import the named export from the route. |
| Route hands an inline Zod to `schema.response`  | §2 identity — `Zod schemas not sourced from @kassa/schemas`  | Same as above; the assertion lists `<METHOD> <url> schema.response.<code>` so the offending operation is obvious. |
| Field added to an existing schema               | §3 drift — `OpenAPI surface drifted from the committed snapshot` | Refresh the snapshot with `UPDATE_OPENAPI_SNAPSHOT=1` and commit the diff. The PR review then sees the wire surface change. |
| New endpoint added                              | §3 drift — same as above                                     | Refresh the snapshot. Confirm the new endpoint imports its schemas from `@kassa/schemas`; otherwise §1/§2 will also fire. |

The snapshot diff is the review surface — drift doesn't get rubber-stamped on a refresh because the diff itself shows the wire-contract change.

---

## 3. CD workflow (`cd.yml`)

v0 CD is **live for all four target environments**: the POS PWA and Back Office SPA ship to Cloudflare Pages production, the API ships to `kassa-api-staging` on Fly.io on every successful CI run against `main`, every PR gets its own Cloudflare Pages preview aliases plus a Fly staging redeploy against an ephemeral Neon branch, and the API ships to `kassa-api-prod` via a manually-gated promotion. The four workflows are siblings: [`cd.yml`](../.github/workflows/cd.yml) (auto on green main), [`cd-preview.yml`](../.github/workflows/cd-preview.yml) (per-PR previews), [`deploy-prod.yml`](../.github/workflows/deploy-prod.yml) (manual API prod gate), and [`backup-prod.yml`](../.github/workflows/backup-prod.yml) (nightly Neon → S3 backup).

The main-deploy workflow file is [`cd.yml`](../.github/workflows/cd.yml).

### 3.1 Target shape vs. v0 status

| Environment | Target                                    | Trigger                                  | v0 status |
|:------------|:------------------------------------------|:-----------------------------------------|:----------|
| Preview     | Cloudflare Pages (PWA), Fly.io staging app (API), Neon branch DB | PR opened/updated/closed | **Live** ([KASA-108](/KASA/issues/KASA-108), this section §3.13) |
| Staging — API       | Fly.io `kassa-api-staging` (`sin`)         | Successful CI run on `main`              | **Live** ([KASA-107](/KASA/issues/KASA-107), this section §3.7) |
| Production — static | Cloudflare Pages (`kassa-pos`, `kassa-back-office`) | Successful CI run on `main`       | **Live** ([KASA-18](/KASA/issues/KASA-18), this section §3.2–§3.6) |
| Production — API    | Fly.io `kassa-api-prod` + Neon production branch | Manual promotion via `deploy-prod.yml` (CEO/CTO required reviewer) | **Live** ([KASA-70](/KASA/issues/KASA-70), this section §3.11; runbook at [RUNBOOK-DEPLOY.md](./RUNBOOK-DEPLOY.md)) |

### 3.2 Triggers

- **`workflow_run`** on `CI` with `branches: [main]` and `types: [completed]`. The job gate requires `conclusion == 'success'` so a red CI run never deploys. The CD run consumes the CI run's uploaded `pos-dist` / `back-office-dist` artifacts directly — **no rebuild on the deploy runner** — so the bytes served in production are the exact bytes CI exercised in the lint → build → typecheck → test chain.
- **`workflow_dispatch`** with a single `ci_run_id` input. This is the in-repo rollback path: provide the CI run id of a known-good prior main commit and CD re-downloads those artifacts and redeploys. The Cloudflare-dashboard rollback is the UI-driven equivalent; use whichever is more convenient on the day (§3.5).

### 3.3 Jobs

1. **`preflight`** — checks the `DEPLOY_ENABLED` repository variable and resolves the source CI run id / commit SHA. If `DEPLOY_ENABLED != true`, emits a notice and sets `ready=false`; downstream deploy jobs are skipped. This keeps main green during the pre-provisioning window and while secrets are rotated.
2. **`deploy-pos`** — `needs: preflight`, `if: ready`. Downloads `pos-dist` via `actions/download-artifact` with `run-id` pointing at the CI run, then runs `wrangler pages deploy` for project `kassa-pos`. Environment: `production`, URL `https://kassa-pos.pages.dev`.
3. **`deploy-back-office`** — same shape, artifact `back-office-dist`, project `kassa-back-office`, URL `https://kassa-back-office.pages.dev`.
4. **`deploy-api-staging`** — `needs: preflight`, `if: ready`. Downloads `api-dist`, installs `flyctl`, runs `flyctl deploy --local-only --env KASSA_API_VERSION=staging-<sha12>` against `kassa-api-staging` using the Dockerfile and fly.toml shipped in the artifact. Environment: `production`, URL `https://kassa-api-staging.fly.dev`. See §3.7 for the full path.
5. **`smoke-tests`** — `needs: [preflight, deploy-pos, deploy-back-office, deploy-api-staging]`. Runs [`scripts/deploy-smoke.sh`](../scripts/deploy-smoke.sh) to probe the three deployed surfaces and assert the API reports the commit SHA it was deployed with. See §3.9.

All four deploy jobs pass the source commit SHA through to their provider (Cloudflare `--commit-hash`, Fly `--image-label staging-<sha12>`) so every deployment is traceable back to the exact SHA that produced the artifact. The API also surfaces that SHA at runtime via `/health.version` (see §3.9) so the smoke tests can prove the new bits are actually serving traffic.

### 3.4 Enablement (one-time setup by the board / ops)

The workflow is inert until these three steps complete. This is intentional: it lets the workflow YAML land before the Cloudflare account + GitHub secrets are provisioned, and it lets CD be turned off by flipping a single variable if we ever need to.

1. **Create the Cloudflare Pages projects** (in the Cloudflare dashboard, once):
   - `kassa-pos` — production branch `main`, framework "None" (artifact is pre-built), build command empty, output directory `/` (we upload the artifact contents directly).
   - `kassa-back-office` — same settings.
   Projects can be created empty; the first deploy fills them.
2. **Create the Fly.io staging app** (once):

   ```sh
   flyctl apps create kassa-api-staging --org kassa
   # Seed required app secrets before the first deploy so /health starts clean:
   flyctl secrets set --app kassa-api-staging \
     LOG_LEVEL=info \
     STAFF_BOOTSTRAP_TOKEN="$(openssl rand -base64 24)" \
     MIDTRANS_ENVIRONMENT=sandbox
   # MIDTRANS_SERVER_KEY stays unset on staging until payments testing starts
   # (the /v1/payments/webhooks/midtrans handler will 503 by design).
   ```
2a. **Provision the staging Redis instance** (once, before the first PR that
    enqueues real work — see §3.10 for the decision rationale):

   ```sh
   # Creates an Upstash-managed Redis attached to the kassa-api-staging app
   # in the same region (sin). Returns a `redis://default:<token>@<host>:6379`
   # URL printed once on stdout; capture it.
   #
   # Plan choice: `3G` is the smallest fixed-price Upstash tier on Fly. We do
   # NOT use `--plan free` (or any pay-as-you-go tier) for any Kassa Redis,
   # even on staging — BullMQ's worker polls Redis on a 5s `BZPOPMIN` timer
   # (~17.3k commands/day per queue) plus a 30s `stalledInterval` check
   # (~2.9k/day). That ~20k/day floor is independent of business traffic and
   # alone exhausts the 500K-commands/month free tier in roughly one day per
   # month; Fly's own Upstash docs explicitly call this out
   # (https://fly.io/docs/reference/redis/). Verify the current fixed-price
   # tiers and dollar figures against `flyctl redis plans` at provisioning
   # time — the cost rollup in §3.10 carries the rationale, not the live
   # pricing.
   flyctl redis create \
     --org kassa \
     --name kassa-redis-staging \
     --region sin \
     --no-replicas \
     --plan 3G
   # Bind the URL on the app so both the web and worker process groups read it.
   flyctl secrets set --app kassa-api-staging \
     REDIS_URL="redis://default:<token>@<host>:6379"
   ```

   The production `kassa-api` app gets its own separate Redis — see
   [KASA-70](/KASA/issues/KASA-70). Staging and production must never share a
   broker; queue state crossing tiers is the kind of bug that paginates EOD
   reports against the wrong merchant.
3. **Provision secrets in the GitHub `production` environment** (Settings → Environments → `production`):
   - `CLOUDFLARE_API_TOKEN` — a token with `Account.Cloudflare Pages: Edit` on the Kassa Cloudflare account (scope narrowly).
   - `CLOUDFLARE_ACCOUNT_ID` — the account id owning the two Pages projects.
   - `FLY_API_TOKEN` — a Fly organisation token scoped to the `kassa-api-staging` app with Deploy permissions. Create via `flyctl tokens create deploy -a kassa-api-staging`.
4. **Flip the enablement variable** (Settings → Variables → Repository):
   - `DEPLOY_ENABLED=true`.

From that point forward, every green CI run on `main` triggers a production Pages deploy for the two static surfaces and a Fly.io deploy for `kassa-api-staging`.

> **Status (2026-04-24):** all four enablement steps are complete. This commit is the no-op main push that exercises the CD pipeline end-to-end for [KASA-107](/KASA/issues/KASA-107) AC 6 (dry-run → `/health = 200`).

### 3.5 Rollback procedure

A deploy is considered bad when any of these signal (within ~10 min of the deploy landing):

- Sentry error-rate spike on the tenant(s) using the deployed surface.
- The Better Stack synthetic check against the POS shell URL fails two checks in a row.
- A reproducible functional regression is observed by the on-call merchant or the team.

The rollback goal is **restore service first, root-cause after**. Do not wait for the fix PR.

#### Option A — Cloudflare dashboard (preferred, fastest)

Cloudflare Pages retains every deployment indefinitely. Rolling back does not require a new artifact build.

1. Open the Cloudflare dashboard → Pages → `kassa-pos` (or `kassa-back-office`) → Deployments.
2. Find the last known-good production deployment (timestamp / commit hash columns).
3. Click the `…` menu → **Rollback to this deployment**. Cloudflare promotes the older deployment atomically; the `kassa-pos.pages.dev` alias flips within seconds.
4. Verify:
   - Hard-refresh the POS shell URL; confirm the asset hashes and app shell match the prior build.
   - Sentry error rate subsides within a minute.
   - Better Stack check flips green on the next cycle.
5. Open a follow-up issue citing the failing commit SHA; block further merges to `main` until the fix lands.

#### Option B — GitHub `workflow_dispatch` (auditable, when the dashboard is unavailable)

Useful when the dashboard is rate-limited, when you want the rollback recorded in GitHub's Actions history, or when you need to rollback both surfaces in lock-step from one operator action.

1. In GitHub: Actions → `CI` → find the run id of the known-good main commit (column: "Run number" is not the id; copy the numeric id from the URL `/actions/runs/<id>`).
2. Actions → `CD` → Run workflow → paste the CI run id into `ci_run_id` → Run.
3. `workflow_dispatch` re-resolves the commit SHA for that CI run, downloads the same artifacts CI produced, and redeploys to both Pages projects.
4. Verify as in Option A step 4.

#### Option C — revert-and-deploy-forward (when the bad build was pushed minutes ago)

If the failing deploy is the most recent merge and the fix is trivially "undo the merge", open a revert PR. On merge, CI runs, CD fires, and production flips back. This is slower than A/B because it waits for CI (~2 min), but it records the rollback in git history — preferred when the defect is a code defect rather than a build/infra defect.

#### What never to do

- **Do not manually edit the Pages deployment via the Cloudflare API** without a corresponding workflow run — the deployed bytes would not be reproducible from a CI artifact, defeating the provenance guarantee in §2.3.
- **Do not disable CD by deleting the workflow file.** Flip `DEPLOY_ENABLED=false` instead; that leaves the YAML reviewable and re-enables with one variable flip.
- **Do not skip the follow-up issue.** A rollback without a written root cause is how the same regression ships twice.

### 3.5b Sentry release tagging + source-map upload ([KASA-140](/KASA/issues/KASA-140))

Every CD deploy creates a Sentry release, attaches the source commit, uploads source maps, finalizes the release, and (for public surfaces only) deletes the `.map` files plus strips `//# sourceMappingURL=` references from the dist tree before the deploy step runs. This shape is shared across all three deploy paths via the `./.github/actions/sentry-release` composite action.

**Release naming.** Each surface uses a per-Sentry-project release identifier so a single Sentry org can keep three independent release streams without collisions:

| Surface     | Release name                          | Sentry project (variable)        |
|:------------|:--------------------------------------|:---------------------------------|
| POS PWA     | `kassa-pos@<sha12>`                   | `vars.SENTRY_PROJECT_POS`        |
| Back Office | `kassa-back-office@<sha12>`           | `vars.SENTRY_PROJECT_BACK_OFFICE`|
| API         | `kassa-api@<sha12>`                   | `vars.SENTRY_PROJECT_API`        |

The SHA is the first 12 chars of `github.sha` for `cd.yml` (the CI run's head SHA via `workflow_run`) or the verified `head_sha` of the cited CI run for `deploy-prod.yml`. The same string is injected into the **runtime** `Sentry.init({ release })` call:

- POS / Back Office: each Vite config writes `process.env.VITE_RELEASE = "kassa-{pos|back-office}@<sha12>"` from the CI runner's `GITHUB_SHA` before `defineConfig` runs, and `apps/{pos,back-office}/src/lib/sentry.ts` reads `import.meta.env.VITE_RELEASE`. Local `vite build` / `vite dev` leave `VITE_RELEASE` unset so events from a developer machine are not falsely attributed to a CI release.
- API: the Fly deploy passes `--env KASSA_API_VERSION=prod-<sha12>` (and `staging-<sha12>` on `cd.yml`'s staging path); `apps/api/src/lib/sentry.ts` (KASA-143) reads that env var, strips the tier prefix, and tags every event with `release: kassa-api@<sha12>` so the runtime release matches the source-map upload. The release name on Sentry (`kassa-api@<sha12>`) and the runtime version (`prod-<sha12>` / `staging-<sha12>`) intentionally diverge — Sentry indexes events by the source commit; the runtime version reads back via `/health.version` and is what the smoke tests assert. `SENTRY_ENVIRONMENT` (set in `apps/api/fly.toml` / `fly.prod.toml`) tags events with `staging` vs `production` even though `NODE_ENV` stays `production` on every Fly tier; cross-tier filtering on Sentry distinguishes events the staging deploy emits from the production deploy. `SENTRY_DSN` is a Fly secret bound on `kassa-api-staging` and `kassa-api-prod` separately; when unset (dev / CI / preview without a DSN bound), `initSentry()` is a no-op so the API still boots.

**Composite action contract** (`.github/actions/sentry-release/action.yml`):

1. Validate `dist-path` exists.
2. If `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, and the project slug are all present, run `sentry-cli releases new` → `set-commits --commit owner/repo@<sha> --ignore-missing` → `sourcemaps inject` → `sourcemaps upload --release <name>` → `releases finalize`. If any of the three Sentry inputs is empty, emit a `::warning::` and skip the upload — the parent workflow stays green during the pre-provisioning window.
3. **Always**, regardless of upload path:
   - When `strip-source-maps: 'true'` (default for POS + Back Office), delete every `*.map` under `dist-path` and strip `//# sourceMappingURL=` references from `*.js`. This is the AC: deployed bundles never advertise source maps publicly. Sentry's Debug ID injected in step 2 is sufficient for symbolication, so once Sentry has the maps the public dist tree no longer needs them.
   - When `strip-source-maps: 'false'` (only the API), leave the `.map` files in place. The API's Fly container runs Node with `--enable-source-maps`, which reads `*.js.map` next to `*.js` to symbolicate stack traces in pino logs. The container is never reachable as a CDN, so the maps staying in the image is an internal-only artefact.

**Source-map provenance.** Source maps are emitted **at CI build time**, not at deploy time — so the bytes Sentry receives are the same bytes CI exercised in lint → build → typecheck → test. `apps/pos` / `apps/back-office` set Vite's `build.sourcemap: 'hidden'` (emit `.map` files but omit the `sourceMappingURL` comment in JS). `apps/api`, `packages/payments`, and `packages/schemas` set `sourceMap: true` in `tsconfig.build.json`. CI's `Verify source maps emitted` step (§2.3) fails the run if any artifact's `dist/` is missing `*.js.map`, so a config regression is caught on PR before main even sees it.

#### `SENTRY_AUTH_TOKEN` rotation ([KASA-283](/KASA/issues/KASA-283))

The token is a Sentry **org-level user auth token** with `project:releases`, `project:read`, `project:write`, and `org:read` scopes — the minimum the composite action's `releases new → set-commits → sourcemaps inject → sourcemaps upload → releases finalize` flow needs. It is bound on two GitHub Environments — `production` (POS + Back Office in `cd.yml`, API staging in `cd.yml`) and `production-prod` (API prod in `deploy-prod.yml`) — and is the same secret value in both. Rotate on a regular cadence (every 6 months, or immediately on suspected leak / contributor departure / token surfaced in an error trace).

The rotation is overlap-then-revoke: the new token coexists with the old token long enough to verify the next deploy uploads source maps, then the old token is revoked. Skipping the overlap window is how a deploy lands on `main` with a broken Sentry release.

1. **Generate the new token.** In Sentry, *User Settings → User Auth Tokens → Create New Token*. Scopes: `project:releases`, `project:read`, `project:write`, `org:read`. Label it `kassa-cd-<YYYY-MM-DD>` so the audit trail in Sentry shows when each token entered service. Copy the token immediately — Sentry shows it once.
2. **Write the new token to both GitHub Environments.** In *Repo Settings → Environments → production → Environment secrets*, edit `SENTRY_AUTH_TOKEN` and paste the new value. Repeat in *production-prod*. Both environments must update in the same window — they are gates for separate workflows (`cd.yml` and `deploy-prod.yml`) but expect the same token.
3. **Verify with a no-op redeploy.** Pick the most recent green CI run on `main` and trigger `cd.yml` via *Actions → CD → Run workflow → `ci_run_id=<id>`*. This re-runs the deploy against the same artifacts and re-runs the `Sentry release` step. A successful run is one where the `Sentry release` step in the POS + Back Office jobs ends with `Stripped sourceMappingURL refs from dist and removed N .map file(s).` and no `::warning title=Sentry not configured::` line. Confirm in Sentry that the release `kassa-pos@<sha12>` / `kassa-back-office@<sha12>` has new "Artifacts" entries with the current ISO timestamp.
4. **Verify the API prod path separately** (if rotating the production-prod copy concurrently): trigger `deploy-prod.yml` via *Actions → Deploy Prod → Run workflow* with the same CI run id and confirm `kassa-api@<sha12>` shows fresh artifacts in Sentry. The `deploy-prod.yml` job is gated on a `production-prod` reviewer approval; skip this step if no reviewer is available and record the partial rotation in step 6.
5. **Revoke the old token.** Back in Sentry, *User Settings → User Auth Tokens*, identify the previous `kassa-cd-*` token by label or creation date, and delete it. After deletion, the next deploy must still succeed — if it doesn't, the new token was not actually saved in GitHub (step 2). The composite action's `::warning::`-and-skip path keeps the workflow green even if both tokens are revoked, but the deploy will ship without source maps; do not rely on that path during rotation.
6. **Record the rotation.** Update [RUNBOOK-DEPLOY.md §6](./RUNBOOK-DEPLOY.md) with the date and operator. If the token was rotated because of suspected leak, also open a security follow-up issue and link it.

**Failure modes and recovery**

- Step 3 verification surfaces `::warning title=Sentry not configured::` → the new token wasn't saved on the `production` environment (most often: the token was pasted into *Repo secrets* instead of *Environment secrets → production*). Re-paste in the right place, re-run the workflow.
- Step 3 verification surfaces `error: Invalid token (http status: 401)` from `sentry-cli` → the new token's scopes are insufficient. Generate a replacement with the four scopes above, repeat step 2.
- An emergency deploy lands with a broken token → the source-map upload is skipped (`::warning::`) but the deploy still ships. Symbolicated stack traces for that release will be missing until the token is fixed and the release is rebuilt. There is no in-place repair for a release whose maps were not uploaded — redeploy the same artifacts via `cd.yml`'s `workflow_dispatch` after fixing the token; `sentry-cli releases new` is idempotent and `sourcemaps upload` populates the existing release.

### 3.6 Secrets and variables (reference)

| Key                          | Scope                      | Purpose                                         | Status |
|:-----------------------------|:---------------------------|:------------------------------------------------|:-------|
| `CLOUDFLARE_API_TOKEN`       | Env: `production` (secret) | `wrangler pages deploy` auth                    | Required for current CD |
| `CLOUDFLARE_ACCOUNT_ID`      | Env: `production` (secret) | Cloudflare account scoping                      | Required for current CD |
| `FLY_API_TOKEN`              | Env: `production` (secret) | `flyctl deploy` auth for `kassa-api-staging`    | Required for current CD |
| `DEPLOY_ENABLED`             | Repo (variable)            | Master switch — `true` turns on deploy jobs     | Required for current CD |
| `NEON_API_KEY`               | Env: `preview` (secret)    | Ephemeral Neon branch per PR                    | Required for preview CD ([KASA-108](/KASA/issues/KASA-108)) |
| `STAGING_NEON_URL`           | Env: `preview` (secret)    | Persistent staging Neon connection — fallback when PR-branch creation fails AND restore target on PR close | Required for preview CD ([KASA-108](/KASA/issues/KASA-108)) |
| `NEON_PROJECT_ID`            | Repo (variable)            | Kassa Neon project id used by `neonctl` calls   | Required for preview CD ([KASA-108](/KASA/issues/KASA-108)) |
| `PREVIEW_DEPLOY_ENABLED`     | Repo (variable)            | Master switch — `true` turns on preview deploys | Required for preview CD ([KASA-108](/KASA/issues/KASA-108)) |
| `SENTRY_AUTH_TOKEN`          | Env: `production` + `production-prod` (secret) | Source map uploads on every prod deploy (POS, Back Office, API). Rotation procedure: §3.5b → "SENTRY_AUTH_TOKEN rotation". | Required for current CD ([KASA-70](/KASA/issues/KASA-70)) |
| `SENTRY_ORG`                 | Repo (variable)            | Sentry org slug used by all release uploads     | Required for current CD ([KASA-70](/KASA/issues/KASA-70)) |
| `SENTRY_PROJECT_POS`         | Repo (variable)            | Sentry project slug for POS PWA releases        | Required for current CD ([KASA-70](/KASA/issues/KASA-70)) |
| `SENTRY_PROJECT_BACK_OFFICE` | Repo (variable)            | Sentry project slug for Back Office releases    | Required for current CD ([KASA-70](/KASA/issues/KASA-70)) |
| `SENTRY_PROJECT_API`         | Repo (variable)            | Sentry project slug for API releases            | Required for current CD ([KASA-70](/KASA/issues/KASA-70)) |
| `FLY_API_TOKEN_PROD`         | Env: `production-prod` (secret) | `flyctl deploy` auth for `kassa-api-prod`  | Required for current CD ([KASA-70](/KASA/issues/KASA-70)) |
| `DEPLOY_PROD_ENABLED`        | Repo (variable)            | Master switch for `deploy-prod.yml`             | Required for current CD ([KASA-70](/KASA/issues/KASA-70)) |

Secrets never live in workflow YAML; the workflow references them via `${{ secrets.NAME }}` and GitHub injects them at runtime.

App-side secrets for `kassa-api-staging` (what the runtime actually needs) live in Fly, not GitHub: `STAFF_BOOTSTRAP_TOKEN`, `MIDTRANS_SERVER_KEY` (optional on staging), `MIDTRANS_ENVIRONMENT`, `LOG_LEVEL`, `DATABASE_URL`, `REDIS_URL` (BullMQ broker — see §3.10). Rotate with `flyctl secrets set` — no redeploy needed; Fly restarts machines automatically.

### 3.7 API staging deploy path (`deploy-api-staging`)

The `deploy-api-staging` job lives in [`cd.yml`](../.github/workflows/cd.yml) and differs from the Pages deploys in three ways: it builds a Docker image, it compiles a native addon (`argon2`) inside that image, and it runs a smoke check after the rollout settles. The shape:

1. **Download** the `api-dist` artifact (produced by CI) into `api-image/`. That folder reconstructs the workspace layout pnpm expects: root `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `apps/api/{dist,package.json,Dockerfile,fly.toml}`, and `packages/{payments,schemas}/{dist,package.json}`.
2. **Install `flyctl`** — pinned `superfly/flyctl-actions/setup-flyctl@<sha>` with an explicit version.
3. **Build + deploy** — `flyctl deploy --local-only --app kassa-api-staging --config apps/api/fly.toml --dockerfile apps/api/Dockerfile --image-label staging-<sha12> --env KASSA_API_VERSION=staging-<sha12> --strategy rolling --wait-timeout 300`.
   - `--local-only` keeps the Docker build on the GitHub runner (no Fly remote builder charge, faster feedback when secrets aren't yet wired for the remote builder).
   - `--image-label staging-<sha12>` tags the image with the first 12 chars of the source commit so rollbacks can target a known-good image by SHA — see below.
   - `--env KASSA_API_VERSION=staging-<sha12>` sets a deploy-time env var that `apps/api/src/routes/health.ts` reads and surfaces at `/health.version`. The smoke-tests job (§3.9) matches this against the commit SHA; a mismatch means the deploy did not roll over. This replaces the inline `/health` curl that used to live in this job (KASA-19).
   - `--strategy rolling` replaces machines one at a time; `--wait-timeout 300` blocks the job until Fly reports the new release healthy (or fails it).

**Dockerfile shape** (`apps/api/Dockerfile`): two-stage `deps → runtime` on `node:22-bookworm-slim`. The `deps` stage installs `python3 make g++` and runs `pnpm install --prod --frozen-lockfile` so `argon2` compiles against the runtime's glibc/Node ABI (the CI runner's libc is irrelevant — only the image's matters). The `runtime` stage copies the prepared `/build` tree, drops to a non-root `kassa` user, and exposes port 8080. `CMD` defaults to the web process; fly.toml's `[processes]` block overrides with the worker command.

**Two processes from one image.** `fly.toml` declares:

- `web = "node apps/api/dist/index.js"` — Fastify server, `[http_service]` fronted, `/health` checked.
- `worker = "node apps/api/dist/workers/index.js"` — background process group, no HTTP. Connects to `REDIS_URL` and runs a BullMQ worker over the `kassa.system.heartbeat` queue (a placeholder consumer until per-feature queues land — see §3.10 and [KASA-111](/KASA/issues/KASA-111)). When `REDIS_URL` is unset the process falls back to a logged idle loop so the topology is still exercised end-to-end without a broker.

**Cost posture.** `auto_stop_machines = "stop"` + `min_machines_running = 0` on staging: machines stop when idle and wake on the next request. Expect a ~1 s cold-start on the first hit after idleness. Production (KASA-70) will flip `min_machines_running = 2` for HA.

### 3.8 API staging rollback

Fly does not keep every deployment indefinitely the way Cloudflare Pages does, but `flyctl releases` records each release with its image label. Since we label every image `staging-<sha12>`, rolling back is "redeploy an earlier image".

#### Option A — `flyctl releases` (preferred)

```sh
# Identify the last known-good release (by date or by image label → commit SHA).
flyctl releases --app kassa-api-staging

# Redeploy the image from that release. The --image flag skips the Docker build
# entirely; Fly just pulls the tagged image and rolls the machines.
flyctl deploy --app kassa-api-staging \
  --image registry.fly.io/kassa-api-staging:staging-<prev-sha12> \
  --strategy immediate
```

`--strategy immediate` is fine for rollback because the old image is known-good. Verify `/health` with `curl https://kassa-api-staging.fly.dev/health` and watch `flyctl logs --app kassa-api-staging` for clean boot lines.

#### Option B — GitHub `workflow_dispatch`

The same `cd.yml` `workflow_dispatch` trigger that rolls back the Pages deploys also re-runs `deploy-api-staging` against the named CI run's `api-dist` artifact. Useful when the rollback should cover all three surfaces in lock-step from one operator action, or when you want an audit trail in Actions.

#### Option C — revert-and-deploy-forward

Same shape as §3.5 Option C. Preferred when the defect is a code defect: open a revert PR, let CI run, let CD fire.

#### What never to do

- **Do not deploy a local `flyctl deploy` against `kassa-api-staging` from a developer laptop.** The deployed bytes must be reproducible from a CI artifact (§2.3). Use `workflow_dispatch` with a CI run id instead.
- **Do not disable the staging app to "take pressure off" a failing release.** Rollback to the prior image; keep the app addressable so dashboards and alerts keep working.
- **Do not skip the follow-up issue** — rollback without a written root cause is how the same regression ships twice.

### 3.9 Post-deploy smoke tests ([KASA-19](/KASA/issues/KASA-19))

The `smoke-tests` job is the last gate in `cd.yml`. It runs only after all three deploy jobs report success, and it fails the CD run if any deployed surface is unreachable, returning the wrong content, or serving a prior release. The logic lives in [`scripts/deploy-smoke.sh`](../scripts/deploy-smoke.sh) so the exact checks can also be run from an operator laptop against any environment.

**What it asserts**

| Surface             | URL                                           | Check                                                                           |
|:--------------------|:----------------------------------------------|:--------------------------------------------------------------------------------|
| API (Fly.io)        | `https://kassa-api-staging.fly.dev/health`    | HTTP 200, body contains `"status":"ok"`, `version == staging-<sha12>` (the deployed SHA). |
| POS PWA             | `https://kassa-pos.pages.dev/`                | HTTP 200, body contains `<title>Kassa POS</title>`.                             |
| Back Office SPA     | `https://kassa-back-office.pages.dev/`        | HTTP 200, body contains `<title>Kassa Back Office</title>`.                     |

Each surface is retried up to 5 times with 6 s between attempts (~30 s per surface) so a Cloudflare Pages edge propagation or a Fly machine cold-start does not fail the gate on its own. The API version check is the only one that can catch "deploy succeeded but the old machines are still serving traffic"; the title marker for the two static surfaces catches "deploy succeeded but the project is configured to serve the wrong directory".

**How "alert on failure" works today**

The job exits non-zero on any failed surface and emits `::error::` annotations that surface in the CD run summary and the GitHub Checks UI. GitHub's default notification settings page the DevOps assignee and anyone watching the repo. Provider-side alerting (Better Stack synthetic probes, Sentry) lands in [KASA-71](/KASA/issues/KASA-71) (pilot-week observability); the smoke-tests job is the on-deploy gate and is intentionally in-repo so it ships with the release.

**Running locally**

```sh
# Against staging, with no version pin (just checks reachability):
scripts/deploy-smoke.sh \
  --api-url https://kassa-api-staging.fly.dev \
  --pos-url https://kassa-pos.pages.dev \
  --back-office-url https://kassa-back-office.pages.dev

# Pinned to an expected commit (what CD does):
scripts/deploy-smoke.sh \
  --api-url https://kassa-api-staging.fly.dev \
  --pos-url https://kassa-pos.pages.dev \
  --back-office-url https://kassa-back-office.pages.dev \
  --expected-version staging-abc123456789
```

The script exits 0 on success, 1 on any surface/version failure, 2 on bad usage.

**When a smoke-test failure is legitimate**

- **Cloudflare Pages deploy queueing.** Pages occasionally queues a deploy behind a prior build that is still propagating. Re-running just the `smoke-tests` job via the Actions UI usually passes; investigate further only if two sequential reruns fail.
- **Fly machine cold-start past the 30 s envelope.** Auto-stopped staging machines can take longer than the retry window after a long idle period. If the API check is the only failure and the `/health` body becomes `status=ok` seconds later, bump `--attempts` in the CD job before chasing an app-level cause.
- **Genuine regression.** API returns an old `version`, POS/Back Office returns the default Pages placeholder, or any surface returns 5xx: treat as a bad release and rollback per §3.5 / §3.8.

**Scope boundaries**

- This job does **not** exercise authenticated paths, mutate data, or run E2E flows — those belong in the Playwright workflow (`e2e.yml`, §2.5). It is deliberately a "did the deploy land and is the right code serving" gate, nothing deeper.
- The script only checks the three surfaces `cd.yml` deploys. When production API (KASA-70) or per-PR preview environments (KASA-108) land, each adds its own invocation of the same script with different URLs rather than forking the checks.

### 3.10 Redis broker for the worker process group ([KASA-111](/KASA/issues/KASA-111))

The `worker` Fly process group consumes BullMQ jobs off Redis. [TECH-STACK.md §7](./TECH-STACK.md) commits to BullMQ on Redis 7 as the entire async layer; this section is the provisioning decision and the cost rollup that landed it.

**Decision: Upstash Redis via `flyctl redis create`.**

The candidates were:

| Option                                     | Pro                                                                                          | Con                                                                                                              |
|:-------------------------------------------|:---------------------------------------------------------------------------------------------|:-----------------------------------------------------------------------------------------------------------------|
| **Upstash via `flyctl redis create`** (chosen) | One CLI, one bill, same Fly org as the app. Co-located in `sin` (sub-ms RTT to the worker). Persistent + replicated by default on paid plans. Free tier covers staging on day one. | Vendor-locked to Upstash's command-set caveats (no `MONITOR`/`DEBUG`/`SCRIPT` — not blockers for BullMQ).         |
| Upstash direct (no Fly mediation)          | Same engine; slightly more flexibility in region/replica selection.                          | Second account, second bill, second IAM surface. No upside over the Fly-mediated path at v0 scale.                |
| Self-hosted Redis on a Fly Machine         | Full Redis feature set, no per-command billing.                                              | We'd own backups, persistence config, failover, OOM tuning, version upgrades. Operational tax with no v0 benefit. |
| AWS ElastiCache / GCP Memorystore          | Mature managed offerings.                                                                    | Cross-cloud network hop adds latency and a second cloud account; only sane if we already lived there.            |

The Redis 7 surface BullMQ relies on (`XADD`/`XREAD` streams, `BRPOPLPUSH`-equivalent blocking ops, Lua scripts via `EVAL`) is fully supported on Upstash; the unsupported commands in the table above are operator/diagnostic tooling that we do not invoke from the worker.

**BullMQ polling floor.** Before the cost table, two BullMQ behaviours need to be made explicit because they invalidate any "free tier" or "pay-as-you-go" framing for either tier:

- The `Worker` polls Redis with `BZPOPMIN` on a 5-second `drainDelay` (BullMQ v5 default) — that is ~17,280 commands/day per queue, **per worker**, regardless of whether any jobs are produced.
- The `stalledInterval` check fires every 30s, adding ~2,880 commands/day.

The floor is therefore ~20,000 commands/day per worker process, **independent of business traffic**. Upstash's Fly free tier is 500,000 commands/month (~16,600/day on average) — the placeholder consumer alone exhausts it in ~24h, then either hard-fails or burns pay-as-you-go credit. Fly's own Upstash docs are explicit about this:

> If you're using Sidekiq, BullMQ or similar software, consider switching your database to a fixed price plan to avoid running up your pay-as-you-go bill.
> — <https://fly.io/docs/reference/redis/>

So both Kassa Redis instances are provisioned on **fixed-price** Upstash plans, not Free or Pay-as-you-go. Staging is no exception: the failure mode "free tier exhausted → BullMQ poller hard-errors → worker process restart loop → Sentry noise" is worse than spending the fixed-tier dollars.

**Cost rollup** (Upstash via Fly, two separate instances per the ACs; verify live dollars against `flyctl redis plans` at provisioning time):

| Tier                              | Plan                                      | Workload model (v0)                                                                                                                                                                                                                                  | Monthly cost (verify with `flyctl redis plans`) |
|:----------------------------------|:------------------------------------------|:------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|:------------------------------------------------|
| `kassa-redis-staging` (KASA-111)  | Smallest fixed tier (`3G`)                | BullMQ polling floor (~20k commands/day) dominates; heartbeat queue + occasional CI replays add a rounding-error increment.                                                                                                                          | Fixed; sized to handle the polling floor.       |
| `kassa-redis-prod` (KASA-70)      | Fixed tier sized to projected throughput  | BullMQ polling floor (~20k commands/day) plus per-merchant business volume: ~1k sales/day × ~10 BullMQ commands per sale lifecycle (enqueue + retry/ack + EOD/reconciliation jobs) ≈ ~10k commands/day on top of the floor → ~30k commands/day total. | Fixed; smallest tier that covers floor + headroom for queue growth and replicas if/when prod takes a real load. |

The "appropriate fixed tier" for `kassa-redis-prod` is sized at provisioning time on KASA-70, against `flyctl redis plans`'s then-current command/storage caps and the merchant count in flight. Day-one single-merchant traffic fits inside `3G` with room to spare; we expect to step up at the first sustained sales spike that pushes the daily floor above ~80% of the tier cap.

Conclusion: Redis is **not a meaningful line item** in the v0 infra budget at the corrected fixed-tier level either — both instances combined sit in the low double-digit dollars/month at v0 traffic. The decision was about operational simplicity (one Fly bill, `flyctl` everywhere) far more than dollars.

**Provisioning** is one-time, by ops. Step 2a in §3.4 above is the staging command (`--plan 3G`); production gets its own equivalent in [KASA-70](/KASA/issues/KASA-70) using `--name kassa-redis-prod` and a fixed tier sized against `flyctl redis plans` at the time.

**App-side wiring**:

- `apps/api/src/config.ts` reads `REDIS_URL` (optional in dev/test; the worker logs and idles when unset). The first PR that lands a real consumer ([KASA-120](/KASA/issues/KASA-120) is the leading candidate) is expected to tighten the Zod refinement to required-in-production, in lock-step with both Fly apps having the secret bound.
- `apps/api/src/workers/index.ts` is the BullMQ bootstrap: connects to `REDIS_URL`, registers the `kassa.system.heartbeat` placeholder consumer, propagates `error`/`failed` events to stdout, and drains in-flight jobs on `SIGTERM`/`SIGINT` via `Worker.close()` → `Queue.close()` → `connection.quit()`.
- Staging and production must point at separate Redis instances. The two Fly secrets are separate by construction (each app has its own secret store), but the rule is documented here so it survives the `flyctl secrets list` audit.

**What is *not* in scope here**:

- Specific job implementations (nightly reconciliation, EOD rollup, sync-log purge, webhook replay, …) — each follow-up issue ships its own queue + processor in `apps/api/src/workers/<feature>.ts`.
- Redis observability (queue-depth dashboards, Sentry alerts on stuck jobs) — folded into [KASA-71](/KASA/issues/KASA-71) once the first real consumer is producing real signal.

### 3.11 API production deploy path ([KASA-70](/KASA/issues/KASA-70))

The `deploy-prod.yml` workflow is the manual-promotion gate for the API. It is intentionally separate from `cd.yml` (which auto-deploys to Cloudflare Pages production and Fly.io staging on every green main) because the production-API deploy needs three things the staging path does not: (1) deliberate operator action per release, (2) required-reviewer approval from CEO/CTO, and (3) re-verification that the cited CI run had a green KASA-68 acceptance suite.

**Trigger.** `workflow_dispatch` only. The operator pastes a CI run id from the Actions UI; the workflow promotes the `api-dist` artifact from that exact run. There is no `workflow_run` trigger — production never deploys automatically.

**Preflight gates** (in order):

1. `DEPLOY_PROD_ENABLED == true` repository variable. Until set, the workflow is inert (notice + skip), exactly the same shape as `cd.yml`'s `DEPLOY_ENABLED` flag.
2. The cited CI run is on `main` (`gh api repos/:owner/:repo/actions/runs/$ID --jq .head_branch`).
3. The cited CI run conclusion is `success`.
4. The cited CI run's `Acceptance — full-day offline (KASA-68)` job conclusion is `success` (read separately because the parent run reports `success` even when a `continue-on-error` job is red, and we explicitly want to block on the acceptance gate).

**Manual approval.** The `deploy-api-prod` job lives in the GitHub `production-prod` environment, which carries a required-reviewer rule including CEO + CTO. After preflight passes, the run pauses at the environment gate; one of the named reviewers clicks **Review deployments → Approve and deploy**. The approval is recorded on the run and is the audit trail for the deploy.

**Sentry release.** Before the Fly deploy, the workflow creates a Sentry release `kassa-api@<sha12>`, attaches the source commit (`releases set-commits --commit owner/repo@<sha> --ignore-missing`), uploads the source maps from `apps/api/dist`, and finalizes the release. Static-surface releases (POS + Back Office) get the same treatment in `cd.yml` on every main deploy. The shared composite action lives at `.github/actions/sentry-release/action.yml` so the four call sites (POS + Back Office in `cd.yml`, API in `deploy-prod.yml`, plus future ones) cannot drift. The action no-ops with a `::warning::` when `SENTRY_AUTH_TOKEN`/`SENTRY_ORG`/project slug is unset, so the workflows stay green during the pre-provisioning window.

**Deploy command.**

```sh
flyctl deploy . \
  --app kassa-api-prod \
  --config apps/api/fly.prod.toml \
  --dockerfile apps/api/Dockerfile \
  --local-only \
  --image-label "prod-<sha12>" \
  --env "KASSA_API_VERSION=prod-<sha12>" \
  --strategy rolling \
  --wait-timeout 600
```

`--wait-timeout 600` is double the staging budget because the production fly file pins `min_machines_running = 2` — a rolling deploy replaces both web machines one at a time, and the `release_command` (Drizzle migrate) runs first.

**Production fly file** ([`apps/api/fly.prod.toml`](../apps/api/fly.prod.toml)) diverges from staging only on prod-only dimensions:

- `auto_stop_machines = "off"` (no cold-starts on a merchant tap).
- `min_machines_running = 2` (HA floor; survives a single-machine crash and a rolling deploy without downtime).
- Web VM memory bumped to 1 GB (staging is 512 MB) for argon2 + Fastify + pino headroom.

**Smoke tests.** The same `scripts/deploy-smoke.sh` from KASA-19, parameterised with the production URLs (`kassa-api-prod.fly.dev`, the production Pages URLs for POS + Back Office). The API check asserts `version == prod-<sha12>` so a stuck rollout (old machines still serving) fails the gate. POS + Back Office checks are cross-tier: they prove the static surfaces the API serves are still reachable on the production URLs, which catches "API works but PWA is stale" cases.

**Provisioning, secrets, and the operator runbook (rollback, pause/cancel, post-incident)** all live in [RUNBOOK-DEPLOY.md](./RUNBOOK-DEPLOY.md). This doc covers the pipeline shape; the runbook covers the on-call playbook.

### 3.12 Nightly Neon → S3 backup ([KASA-70](/KASA/issues/KASA-70))

[`backup-prod.yml`](../.github/workflows/backup-prod.yml) runs a daily logical backup of the production Neon branch. It calls [`scripts/db-backup.sh`](../scripts/db-backup.sh), which streams `pg_dump | gzip | aws s3 cp -` into `s3://kassa-backups/prod/<UTC-date>.sql.gz` and then asserts via `s3api head-object` that the resulting object is non-empty before exiting.

**Trigger.** `schedule: 0 2 * * *` (02:00 UTC = 09:00 WIB, comfortably before the Indonesian pilot's open) plus `workflow_dispatch` for ad-hoc dumps. The `label` input on `workflow_dispatch` overrides the `<UTC-date>` portion of the S3 key for DR-rehearsal snapshots that must not collide with the daily key.

**Preflight gate.** `BACKUP_PROD_ENABLED == true` repository variable. Until set, the workflow is inert (notice + skip), same shape as `cd.yml` / `deploy-prod.yml`.

**Auth path.**

- AWS credentials via OIDC federation (`aws-actions/configure-aws-credentials`, SHA-pinned to v4.3.1) — no long-lived keys in GitHub. The IAM role's permissions are scoped to `s3:PutObject` + `s3:HeadObject` on `arn:aws:s3:::kassa-backups/prod/*`.
- Postgres credentials via the `BACKUP_DATABASE_URL` secret in the `production-prod` environment, scoped to a Neon read-only role (`GRANT pg_read_all_data`). A runner compromise must not be able to mutate prod.

The `production-prod` environment also gates the deploy workflow, so the same approval/secret blast radius covers the credentials that can read prod data.

**Why GitHub Actions and not a Neon scheduled job / Fly Machine cron.** Same dashboard as deploys (operators see backup runs in one place), same notification channel as a failed deploy, no new infra to provision, and the minutes are negligible (~5 min × 30/month). A Neon-side or Fly-side scheduler is a viable second copy if backup durability ever becomes business-critical (M5+).

**Provisioning checklist (S3 bucket + IAM role + Neon read-only role + GH secrets/vars)** lives in [RUNBOOK-DEPLOY.md §2 step 3](./RUNBOOK-DEPLOY.md). Restore path also lives in the runbook.

### 3.13 Preview-per-PR environments ([KASA-108](/KASA/issues/KASA-108))

Every pull request against `main` gets its own previewable surfaces and an ephemeral database, torn down on PR close. The workflow file is [`cd-preview.yml`](../.github/workflows/cd-preview.yml).

**Trigger.** `pull_request` against `main`, types `[opened, synchronize, reopened, closed]`. PRs from forks are skipped at preflight (forks do not receive secrets). Disabled until the repo variable `PREVIEW_DEPLOY_ENABLED=true` is set — same enablement shape as `cd.yml` / `deploy-prod.yml`.

**What gets provisioned per PR**:

| Surface     | URL                                                              | Mechanism                                                                                  |
|:------------|:-----------------------------------------------------------------|:-------------------------------------------------------------------------------------------|
| POS PWA     | `https://pr-<N>.kassa-pos.pages.dev`                             | `wrangler pages deploy --branch=pr-<N>` against the existing `kassa-pos` Pages project.    |
| Back Office | `https://pr-<N>.kassa-back-office.pages.dev`                     | `wrangler pages deploy --branch=pr-<N>` against the existing `kassa-back-office` project.  |
| API         | `https://kassa-api-staging.fly.dev` (shared)                     | `flyctl deploy` redeploys the existing `kassa-api-staging` app with the PR's image.        |
| Database    | Neon branch `pr-<N>` (parent: `main`)                            | `neonctl branches create --parent main`. Deleted on PR close.                              |

**Workflow shape** (open / sync / reopen path):

1. `preflight` — gates on `PREVIEW_DEPLOY_ENABLED`, fork status, computes `pr_number` / `branch_alias` / `commit_sha`.
2. `build` — installs the workspace and runs `pnpm -r build`. Uploads `apps/pos/dist`, `apps/back-office/dist`, and a tarred API build context as artifacts. `GITHUB_SHA` is overridden to the PR head SHA so the Vite-injected `VITE_RELEASE` matches the deploy's image label.
3. `neon-branch` (parallel with `build`) — `neonctl branches create --name=pr-<N> --parent=main` (idempotent — list first, create only if absent), then fetches the pooled connection string for the PR's Postgres role. `continue-on-error: true` so a Neon-side failure (rate limit, quota) doesn't fail the workflow; the resolved fallback path is below.
4. `deploy-pos-preview` / `deploy-back-office-preview` — `wrangler pages deploy dist --project-name=kassa-{pos,back-office} --branch=pr-<N> --commit-hash=<sha>`.
5. `deploy-api-preview` — stages `DATABASE_URL` (PR Neon branch URL if present, else `STAGING_NEON_URL`) on `kassa-api-staging` via `flyctl secrets set --stage`, then `flyctl deploy --image-label=preview-pr-<N>-<sha12> --env KASSA_API_VERSION=preview-pr-<N>-<sha12>`. Job-level `concurrency: cd-preview-fly-staging` (cancel-in-progress: false) serializes Fly redeploys across PRs so two simultaneous pushes can't race the rolling deploy.
6. `pr-comment` (with `if: always()`) — upserts a sticky PR comment marked `<!-- kassa-preview-deploy -->` listing the three URLs, the Neon branch, the commit short SHA, and a per-surface deploy status. Subsequent pushes update the same comment in place.

**Workflow shape** (closed path):

1. `teardown-neon` — list-then-delete `neonctl branches delete pr-<N>`. `continue-on-error: true` so a stale branch (already deleted) doesn't fail PR close.
2. `teardown-fly` — `flyctl secrets set DATABASE_URL=$STAGING_NEON_URL --detach` on `kassa-api-staging`, which restores the persistent staging connection string. Same `cd-preview-fly-staging` concurrency group as `deploy-api-preview` to avoid racing an in-flight rollout.
3. `pr-comment-teardown` — replaces the sticky comment body with a teardown summary.

**Trade-offs intentionally accepted at v0**:

- **Single shared `kassa-api-staging` app.** Two PRs open at once means whichever PR pushed last "owns" which Neon branch the staging API reads from. The Pages preview URLs remain isolated per-PR, but the API URL is shared — reviewers must know that "API behaviour" reflects the most recent push across all open PRs. The acceptance criteria explicitly defers the per-PR Fly app design ("If cost becomes material, switch to one staging app per PR with auto-stop; revisit in a follow-up").
- **Closed-PR Fly state.** On PR close, `DATABASE_URL` is restored to `STAGING_NEON_URL`, but the running image is whatever the last preview deploy shipped. The next merge to `main` triggers `cd.yml`'s `deploy-api-staging`, which redeploys the main bytes against the restored DB. We accept the brief window between close and next-main-merge where the staging app runs PR code against the staging DB.
- **Pages preview retention.** `pr-<N>.kassa-{pos,back-office}.pages.dev` aliases auto-expire on Cloudflare's Pages retention schedule; the workflow does not actively delete them on PR close. They are never linked from the production deployment list once the PR closes.
- **Public preview URLs.** Cloudflare Pages preview aliases under `pages.dev` are publicly accessible by default. The POS preview is fine to share (no tenant data in the shell). The Back Office is staff-only, so reviewers must not share its preview URL externally until the real auth lands; this is documented in [`apps/back-office/README.md`](../apps/back-office/README.md).
- **Neon-creation fallback.** If `neonctl branches create` fails (rate limit, API key revoked, project misconfigured), the API deploy proceeds against `STAGING_NEON_URL` and the sticky comment surfaces a `⚠ Preview API is using the staging Neon branch` warning. The deploy never silently runs against production data because (a) `STAGING_NEON_URL` is the staging branch, not production, and (b) any usage outside that branch is loud.

**Enablement (one-time, by the board / ops)**: covered in the workflow header. Summary:

1. Reuse the existing `kassa-pos` and `kassa-back-office` Cloudflare Pages projects from KASA-18 — preview aliases use the same projects under `--branch=pr-<N>`. No additional Cloudflare provisioning is needed.
2. Create a Neon API key with **Branch Admin** scope on the Kassa Neon project. Capture the Neon project id.
3. In the GitHub `preview` environment (Settings → Environments → preview), provision the secrets listed in §3.6: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `FLY_API_TOKEN`, `NEON_API_KEY`, `STAGING_NEON_URL`. The first three are reuses of the `production` environment's secrets; the last two are net-new.
4. Set repository variables `NEON_PROJECT_ID=<project-id>` and `PREVIEW_DEPLOY_ENABLED=true`.

Until `PREVIEW_DEPLOY_ENABLED` is flipped, every PR's `cd-preview.yml` run emits a notice and skips all jobs — `main` stays green, the workflow stays reviewable.

**Rollback**: there is no rollback for a preview deploy. A red preview is fixed forward by another push to the same PR (which retriggers the workflow), or by closing the PR (which tears the preview down). Production is unaffected by preview activity — `cd.yml` and `deploy-prod.yml` are entirely independent code paths.

### 3.14 PWA security headers ([KASA-180](/KASA/issues/KASA-180))

The POS PWA ships with a strict CSP, a deny-by-default Permissions-Policy, and cross-origin isolation headers via [`apps/pos/public/_headers`](../apps/pos/public/_headers). Cloudflare Pages reads `_headers` from the deploy root; Vite copies anything under `public/` to `dist/_headers` byte-for-byte at build time, so the file rides along on every `wrangler pages deploy` (§3.3) without a separate publish step.

Verify after deploy:

```bash
curl -sI https://kassa-pos.pages.dev/ | grep -iE 'content-security-policy|permissions-policy|cross-origin-(opener|embedder|resource)-policy|strict-transport-security|x-(content-type-options|frame-options)|referrer-policy'
```

Each header should appear once. If a value is missing, the `_headers` file did not make it into `dist/` — check the build artifact (`apps/pos/dist/_headers`).

**What the policy allows and why:**

| Directive                  | Value                                                                                          | Rationale                                                                                              |
|:---------------------------|:-----------------------------------------------------------------------------------------------|:-------------------------------------------------------------------------------------------------------|
| `default-src`              | `'self'`                                                                                       | Fail-closed baseline. Every other directive narrows from here.                                         |
| `script-src`               | `'self' 'sha256-…'`                                                                            | Same-origin Vite bundles + the inline LCP-skeleton remover in `index.html` (KASA-157), pinned by hash. |
| `style-src`                | `'self' 'unsafe-inline'`                                                                       | Tailwind bundle + inline `<style>` block + React `style={{}}` attributes. CSS cannot execute script.   |
| `connect-src`              | `'self' https://*.sentry.io`                                                                   | Same-origin API (default `VITE_API_BASE_URL=""`) + Sentry ingest. Midtrans is server-proxied.          |
| `img-src`                  | `'self' data: blob:`                                                                           | App icons + receipt/export blobs.                                                                      |
| `font-src`                 | `'self'`                                                                                       | Self-hosted Plus Jakarta Sans + JetBrains Mono woff2 in `apps/pos/public/fonts/`.                      |
| `worker-src`, `manifest-src` | `'self'`                                                                                     | Workbox SW (bundled) + Vite-PWA-emitted `manifest.webmanifest`.                                        |
| `frame-src`, `object-src`  | `'none'`                                                                                       | POS embeds no third-party frames or plugins.                                                           |
| `frame-ancestors`          | `'none'` (+ legacy `X-Frame-Options: DENY`)                                                    | Clickjacking defense — POS must never render inside another origin.                                    |
| `Permissions-Policy`       | `camera=(self)`, all of `geolocation=()` / `microphone=()` / `payment=()` plus other sensors denied | QR scanner (`apps/pos/src/components/QrScanner.tsx`) needs camera; nothing else.                       |
| `Cross-Origin-Opener-Policy` | `same-origin`                                                                                | Window isolation. Compatible with the same-origin SW registration in `apps/pos/src/lib/pwa.ts`.        |
| `Cross-Origin-Embedder-Policy` | `credentialless`                                                                           | Cross-origin isolation in supporting browsers without forcing CORP on every Sentry response. iOS Safari ignores the unknown value and falls back to `unsafe-none`, which we accept — POS uses no `SharedArrayBuffer`. |
| `Cross-Origin-Resource-Policy` | `same-origin`                                                                              | Defense-in-depth: our shell assets cannot be embedded by third-party origins.                          |
| `Strict-Transport-Security`| `max-age=31536000; includeSubDomains`                                                          | Cloudflare Pages is HTTPS-only; the header makes the upgrade sticky for one year.                      |

**Adding an exception** (the supported workflow):

1. **Identify the directive** that blocked the resource. Open DevTools → Console — Chromium logs `Refused to … because it violates the following Content Security Policy directive: "<directive>"`. The directive name (e.g. `connect-src`) is the field to widen.
2. **Edit `apps/pos/public/_headers`** and add the smallest origin that unblocks the resource. Prefer host-only allowlists (`https://example.com`) over wildcards; prefer per-directive (`connect-src`) over `default-src`.
3. **If the new resource is an inline `<script>` or `<style>` block**, recompute the hash with the snippet in the comment at the top of `_headers` and replace the existing `'sha256-…'` token. **Never** add `'unsafe-inline'` to `script-src` — that defeats the purpose of the policy.
4. **If the new resource is a third-party iframe** (e.g. a Midtrans Snap host, payment redirect), add it to `frame-src` AND review whether `Cross-Origin-Embedder-Policy: credentialless` will strip the credentials the iframe needs — switch to `unsafe-none` for that path if so.
5. **Verify locally** with `pnpm --filter @kassa/pos build && pnpm --filter @kassa/pos preview` and a `curl -I` against the preview port — Vite preview does not honour `_headers`, so production verification still requires a Cloudflare Pages preview deploy.
6. **Run the offline E2E** (`pnpm --filter @kassa/pos test:e2e -- offline.spec.ts`) to confirm the SW shell still installs, and `tender-qris.spec.ts` to confirm QRIS create + status polling still work end-to-end against the harness.
7. **Re-run Lighthouse** (`apps/pos/lighthouserc.json`, §8.1) — Best-Practices score must stay ≥ 0.95.
8. **Document the exception** in the PR description: which origin, which directive, and the user-visible feature it unblocks.

**What `_headers` does not cover:**

- Back-office app — separate Cloudflare Pages project (`kassa-back-office`), separate `_headers` (not in scope for KASA-180).
- WAF / Cloudflare bot rules / rate-limiting — managed in the Cloudflare dashboard, not in this repo.
- API responses — Hono-side security headers live in `apps/api/src/app.ts` and follow a separate review track.

---

## 4. Pipeline health (v0 baselines)

Local measurements on a GitHub-equivalent Linux machine, `main` at the time this doc was written, cold caches:

| Stage                           | Time   |
|:--------------------------------|:-------|
| `pnpm install --frozen-lockfile` (cold) | ~15 s  |
| `pnpm -r build`                 | ~40 s  |
| `pnpm -r typecheck`             | ~31 s  |
| `pnpm -r test` (Vitest, 113 tests across 5 packages) | ~35 s  |
| **Total**                       | **~2 min** |

Budget: **under 5 minutes**. If a job routinely exceeds 5 min, add caching or split stages before shipping new features.

---

## 5. Pipeline hygiene rules

These are non-negotiable:

- **Fail fast.** The job stops at the first red step.
- **`--frozen-lockfile` everywhere.** Any PR that changes `package.json` without regenerating `pnpm-lock.yaml` fails CI. This is the whole point — don't weaken it.
- **Pin action versions to full SHAs.** Tag-only references (`@v4`) are mutable and a supply-chain risk.
- **Secrets never live in workflow YAML.** Use GitHub Secrets, reference via `${{ secrets.NAME }}`.
- **`main` is always green.** If CI breaks `main`, the fix is the next PR — no stacking unrelated work.
- **No E2E in the PR gate.** Playwright runs in its own workflow (`e2e.yml`, §2.5) on push to `main` + `workflow_dispatch`. Keeping it off PRs preserves PR latency; the trade-off is that an E2E regression first surfaces on `main`, which is acceptable because the suite is fast (≤ 10 min) and the runbook for a red `main` is to revert and re-land.

---

## 6. Follow-ups tracked against this doc

These are out of scope for the initial CI + static-surface CD setup but are **prerequisites to finishing M0**. Each gets its own child issue under [KASA-12](/KASA/issues/KASA-12) or [KASA-18](/KASA/issues/KASA-18):

1. ~~**Lint lane (Biome)**~~ — landed via [KASA-13](/KASA/issues/KASA-13) (PR #18) with root-scan wiring documented in §2.4; doc reconciliation closed out by [KASA-101](/KASA/issues/KASA-101).
2. ~~**Build artifacts**~~ — landed via [KASA-17](/KASA/issues/KASA-17).
3. ~~**Production CD for static surfaces**~~ — landed via [KASA-18](/KASA/issues/KASA-18) (this section).
4. ~~**API → Fly.io staging deploy**~~ — landed via [KASA-107](/KASA/issues/KASA-107) (this section §3.7–§3.8).
5. ~~**API → Fly.io production deploy**~~ — landed via [KASA-70](/KASA/issues/KASA-70) (this section §3.11; runbook at [RUNBOOK-DEPLOY.md](./RUNBOOK-DEPLOY.md)). Production Fly app, Neon production branch, Sentry release tagging, manual promotion gate, Midtrans prod keys (provisioned out-of-band per RUNBOOK-DEPLOY.md §1).
6. ~~**Preview-per-PR environments**~~ — landed via [KASA-108](/KASA/issues/KASA-108) (`cd-preview.yml`, this section §3.13). Cloudflare Pages preview deploys for both static surfaces, Fly.io staging redeploy for the API, Neon branch DB per PR, sticky PR comment, teardown on PR close.
7. ~~**Worker queue broker + real workers**~~ — broker provisioning + BullMQ bootstrap landed via [KASA-111](/KASA/issues/KASA-111) (this section §3.10). The first real consumer (nightly reconciliation) is tracked in [KASA-120](/KASA/issues/KASA-120); subsequent per-feature consumers fan out from there.
8. ~~**Production promotion gate**~~ — landed via [KASA-70](/KASA/issues/KASA-70) (`deploy-prod.yml`, §3.11): `workflow_dispatch` with environment protection rules (CEO + CTO required reviewers) on the `production-prod` env, gated on a green KASA-68 acceptance run.
9. ~~**Playwright E2E workflow**~~ — landed via [KASA-139](/KASA/issues/KASA-139) (`e2e.yml`, §2.5); flake policy + quarantine + nightly lane landed via [KASA-238](/KASA/issues/KASA-238) ([docs/E2E-FLAKE-POLICY.md](./E2E-FLAKE-POLICY.md)). Branch-protection wiring to make `gate` a required check on `main` is a follow-up Repo Admin step.
10. **Turborepo remote cache** — named in [TECH-STACK.md §10.3](./TECH-STACK.md); wire it once CI is live and we have a signal on cold vs warm install time.

---

## 7. Where to look when CI is red

1. **Lockfile error (`ERR_PNPM_OUTDATED_LOCKFILE`)** — the PR changed `package.json` but not `pnpm-lock.yaml`. Run `pnpm install` locally, commit the lockfile, push.
2. **Typecheck failure in `apps/*` citing `Cannot find module '@kassa/*'`** — the build step didn't run or was silently cancelled. Re-run the job; if it persists, check whether the package's `exports` field changed.
3. **Vitest failure that only fails in CI** — 95% of the time this is `NODE_ENV=production` (React test-helpers require the dev build). The runner inherits no custom env, so this usually means the test itself sets `NODE_ENV` and forgets to reset it.
4. **Flake on `actions/setup-node` cache restore** — rare, transient. Re-run. If it becomes a pattern, open an issue and bump the action pin.

---

## 8. Performance budgets ([KASA-141](/KASA/issues/KASA-141), [KASA-199](/KASA/issues/KASA-199), [KASA-282](/KASA/issues/KASA-282))

The cross-milestone Performance budgets track in [ROADMAP.md](./ROADMAP.md) commits to `Bundle size, Lighthouse, and Web Vitals gates enforced in CI`. KASA-141 landed the POS-only baseline; [KASA-199](/KASA/issues/KASA-199) folds `apps/back-office` into the same gate; [KASA-282](/KASA/issues/KASA-282) finalises the cross-track by flipping the POS bundle-size gate to blocking and adding the RUM web-vitals harness in §8.6. The API is server-side and not bundle-budgeted.

The gates live in their own workflow, [`.github/workflows/perf-budgets.yml`](../.github/workflows/perf-budgets.yml), and run in parallel with `ci.yml` so they don't extend the critical-path PR latency. The workflow's `paths:` filter limits `pull_request` runs to PRs that touch `apps/pos/**`, `apps/back-office/**`, `pnpm-lock.yaml`, or the workflow file itself — docs-only PRs skip the gate entirely.

### 8.1 Lighthouse CI (apps/pos)

`treosh/lighthouse-ci-action` (pinned to v11.4.0 SHA per §2.2 — v11 is the last Lighthouse line that scores the PWA category, which we keep so the PWA ≥ 90 contract from KASA-141 stays expressible without falling back to per-audit checks). Configured at [`apps/pos/lighthouserc.json`](../apps/pos/lighthouserc.json).

Trigger: `pull_request` (and `workflow_dispatch`). Not on push-to-main — Lighthouse runs are noisy and the per-PR signal is what we use to catch regressions before they land.

Asserts (mobile form factor with simulated slow-4G throttling, median of 3 runs — `@lhci/cli` only ships `perf` / `experimental` / `desktop` presets, so we set `formFactor: "mobile"` + `throttlingMethod: "simulate"` directly instead of a `preset:` shortcut):

| Metric / category            | Threshold | Why                                                                                          |
|:-----------------------------|:----------|:---------------------------------------------------------------------------------------------|
| `categories:performance`     | ≥ 0.90    | Indonesian merchants run on entry-level Android tablets; sub-90 perf is a noticeable lag.    |
| `categories:accessibility`   | ≥ 0.95    | The clerk operates the POS during every customer interaction; a11y regressions slow service. |
| `categories:best-practices`  | ≥ 0.95    | Catches console errors, mixed-content, and deprecated APIs before they hit the field.        |
| `categories:pwa`             | ≥ 0.90    | Installability + offline shell are core to the v0 product; a PWA regression is a P1.         |
| `largest-contentful-paint`   | ≤ 2500 ms | Catalog browse must feel responsive on slow-4G; 2.5 s is Google's "good" threshold.          |
| `total-blocking-time`        | ≤ 200 ms  | Tap-to-add latency budget — anything longer feels like the app froze on the tablet.          |
| `cumulative-layout-shift`    | ≤ 0.1     | Buttons must not jump under the clerk's finger mid-tap.                                      |

### 8.2 Bundle-size budget (apps/pos)

`size-limit` (devDep on `@kassa/pos`) reads [`apps/pos/.size-limit.json`](../apps/pos/.size-limit.json). Trigger: `pull_request` and `push` to `main` (the latter records a trendline so we can see whether the trunk is drifting upward over time, even when individual PRs stay green).

| Slice                                                  | Limit (gzip) | Why                                                                                          |
|:-------------------------------------------------------|:-------------|:---------------------------------------------------------------------------------------------|
| Initial route — main JS + main CSS chunks              | 200 KB       | What the browser parses before first paint on slow-4G; above 200 KB the cold-start lags.     |
| Total route-loaded JS — every hashed JS chunk in `dist/assets/` | 350 KB | Caps post-paint lazy-load, including the workbox SW shim. Headroom for code-split routes.    |

### 8.3 Bundle-size budget (apps/back-office) — [KASA-199](/KASA/issues/KASA-199)

`size-limit` (devDep on `@kassa/back-office`) reads [`apps/back-office/.size-limit.json`](../apps/back-office/.size-limit.json). Same trigger shape as POS: `pull_request` (gate) and `push` to `main` (trendline).

| Slice                                     | Limit (gzip) | Why                                                                                                 |
|:------------------------------------------|:-------------|:----------------------------------------------------------------------------------------------------|
| Initial route — main JS + main CSS chunks | 350 KB       | Owner-side app on a merchant laptop; SLO is "snappy on a 4G hotspot", not "fast on slow-4G tablet". |

The back-office app is not a PWA and ships only an `index-*` bundle (no code-split routes today), so a single budget on the initial route is enough to cover the surface. Add additional rows here when route-level code-splitting lands.

### 8.4 Posture: informational vs. blocking

| Job                                | Posture       | Why                                                                                                       |
|:-----------------------------------|:--------------|:----------------------------------------------------------------------------------------------------------|
| Bundle-size budget (apps/pos)      | Blocking      | Post-KASA-157 code-split brought initial to ~166 KB / 200 KB and total to ~234 KB / 350 KB; flipped under KASA-282. |
| Bundle-size budget (apps/back-office) | Blocking   | Current build ~146 KB / 350 KB; never had a day-zero failure to absorb.                                   |
| Lighthouse CI (apps/pos)           | Informational | GitHub runners have meaningful variance on category scores even with simulated throttling; flake risk against a `≥ 0.9` perf threshold outweighs the merge-block value. Treated as a per-PR red-flag signal rather than a gate. |

Flip mechanism for any informational gate: delete the `continue-on-error: true` line from the relevant job in `perf-budgets.yml`. No workflow restructuring required.

A budget regression PR adding ~500 KB of dead-weight to `apps/pos/src/main.tsx` was used during KASA-282 to verify the POS bundle-size gate exits non-zero (Exit status 1) on overage — see KASA-282 PR description for the local trace.

### 8.5 Procedure to raise (or lower) a budget

Budgets are a contract with the user (Indonesian merchant on entry-level hardware for POS; back-office staff on a laptop). Bumping a number is allowed but never silent.

1. Open a PR that edits the budget in `apps/pos/.size-limit.json`, `apps/back-office/.size-limit.json`, or `apps/pos/lighthouserc.json` and the matching row in §8.1 / §8.2 / §8.3 above.
2. The PR description must include:
   - **Before / after numbers** (e.g. "initial route 200 → 220 KB gzip").
   - **What changed in the bundle** that justifies the bump (a new route, a vendored dep, an unavoidable polyfill).
   - **SLO impact note** — projected effect on cold-start LCP on the target hardware (Android tablet on slow-4G for POS; merchant laptop on 4G hotspot for back-office). If unknown for POS, run a manual Lighthouse against the preview from the PR's CI artifact and paste the numbers.
3. PO sign-off comment on the PR ("budget bump approved") is required before merge — same gating rule as any other roadmap-level commitment change.
4. Lowering a budget (tightening the gate) doesn't need PO sign-off, but must include a commit message that names the win that made the headroom possible (e.g. "post-route-split, initial bundle dropped to 140 KB; tighten budget to 160 KB").

### 8.6 RUM: web-vitals harness (apps/pos) — [KASA-282](/KASA/issues/KASA-282)

The synthetic Lighthouse run in §8.1 measures one cold load on a CI runner. To complement it with real-merchant data we ship a lightweight web-vitals reporter in [`apps/pos/src/lib/web-vitals.ts`](../apps/pos/src/lib/web-vitals.ts):

- Lazy-loaded from `main.tsx` inside the existing `deferUntilIdle` block, after Sentry init — never on the LCP-critical chunk (verified: initial route unchanged at ~166 KB gzip; the web-vitals SDK ships as its own ~2.3 KB gzip chunk).
- Subscribes to **LCP**, **INP**, and **CLS** via the `web-vitals` npm package.
- Emits each metric as a Sentry `info`-level breadcrumb (so subsequent error events carry page-load perf context) plus an info-level `captureMessage` tagged `web-vitals.metric` / `web-vitals.rating` (so it can be aggregated when the dashboards ticket wires up).
- No-op when `VITE_SENTRY_DSN` is unset — keeps dev, CI, and unconfigured deployments quiet.

This is telemetry, not a gate. Dashboards + alerting on RUM web vitals are a separate observability ticket.

### 8.7 Out of scope

- Real-device verification on physical Android / iOS hardware — tracked in [KASA-131](/KASA/issues/KASA-131) (v1).
- Lighthouse for `apps/back-office` — back-office is not a PWA (so the PWA ≥ 90 contract from §8.1 doesn't apply) and ships behind owner auth, so a synthetic Lighthouse against a preview doesn't model the real cold-start path. Revisit when staff-facing UX SLOs land.

---

## 9. Pilot-week observability ([KASA-71](/KASA/issues/KASA-71))

The on-call runbook lives at [`docs/RUNBOOK-ONCALL.md`](./RUNBOOK-ONCALL.md). This section documents only the CI/CD-touching pieces of the observability lane.

| Concern                       | Where it lives                                                          |
|:------------------------------|:------------------------------------------------------------------------|
| Better Stack monitor configs  | [`infra/observability/better-stack-monitors.json`](../infra/observability/better-stack-monitors.json) |
| Sentry alert rule configs     | [`infra/observability/sentry-alert-rules.json`](../infra/observability/sentry-alert-rules.json) |
| Apply / dry-run script        | [`scripts/observability-apply.sh`](../scripts/observability-apply.sh) |
| Synthetic test sale (every 15 min) | [`.github/workflows/synthetic-sale.yml`](../.github/workflows/synthetic-sale.yml) |
| Synthetic-sale probe script   | [`scripts/synthetic-sale.sh`](../scripts/synthetic-sale.sh) |
| Severity / rollback / escalation (operator playbook) | [`docs/RUNBOOK-ONCALL.md`](./RUNBOOK-ONCALL.md) |
| Incident response policy (severity definitions, comms templates, post-mortem flow) | [`docs/RUNBOOK-INCIDENT.md`](./RUNBOOK-INCIDENT.md) |

Both the apply script and the synthetic-sale workflow follow the same enablement-gate pattern as `cd.yml` / `deploy-prod.yml` — they run unconditionally but no-op with a `::notice::` until the corresponding repository variable (`SYNTHETIC_PROBE_ENABLED`) and environment secrets land. This keeps `main` green during the pre-pilot provisioning window.

The synthetic sale depends on a backend `synthetic` tender method (excludes itself from EOD totals while still writing a balancing ledger entry) that is not yet implemented. That work is tracked under a child Engineer issue; the workflow stays gated until it lands.

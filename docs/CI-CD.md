# Kassa CI/CD Pipeline

Status: v0 (CI + CD — POS / Back Office in Cloudflare Pages production, API in Fly.io staging; preview-per-PR deferred). Owner: DevOps. Source issues: [KASA-12](/KASA/issues/KASA-12) (pipeline), [KASA-17](/KASA/issues/KASA-17) (deployable build artifacts), [KASA-18](/KASA/issues/KASA-18) (production CD — static surfaces), [KASA-107](/KASA/issues/KASA-107) (staging CD — API), [KASA-19](/KASA/issues/KASA-19) (post-deploy smoke tests).
Companion docs: [TECH-STACK.md](./TECH-STACK.md), [ARCHITECTURE.md](./ARCHITECTURE.md), [ROADMAP.md](./ROADMAP.md).

This is the authoritative description of how Kassa code moves from a contributor's branch into `main` and — in later milestones — into production. v0 covers **CI** (lint/typecheck/test/build on every PR and every push to `main`, with compiled outputs preserved as workflow artifacts) and **CD** for three surfaces: the POS PWA and Back Office SPA deploy to Cloudflare Pages, and the API deploys to a Fly.io staging app, on every successful CI run against `main`. Preview-per-PR environments and the production promotion gate for the API remain in follow-up tickets under M0.

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
| E2E (deferred)    | Playwright — separate workflow in a later ticket |
| CD orchestrator   | GitHub Actions (see [`cd.yml`](../.github/workflows/cd.yml)) |
| CD targets (live) | Cloudflare Pages — `kassa-pos`, `kassa-back-office`; Fly.io — `kassa-api-staging` (`sin`) |
| CD targets (deferred) | Fly.io production (`kassa-api`, KASA-70), per-PR preview environments (KASA-108) |

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
8. **Test** — `pnpm -r test` (Vitest only; Playwright E2E is deferred).
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

---

## 3. CD workflow (`cd.yml`)

v0 CD is **live for three surfaces**: the POS PWA and Back Office SPA ship to Cloudflare Pages production, and the API ships to the `kassa-api-staging` Fly.io app, on every successful CI run against `main`. Preview-per-PR environments and the production promotion gate for the API are tracked as follow-ups (see §6).

The workflow file is [`cd.yml`](../.github/workflows/cd.yml).

### 3.1 Target shape vs. v0 status

| Environment | Target                                    | Trigger                                  | v0 status |
|:------------|:------------------------------------------|:-----------------------------------------|:----------|
| Preview     | Cloudflare Pages (PWA), Fly.io staging app (API), Neon branch DB | PR opened/updated            | Deferred ([KASA-108](/KASA/issues/KASA-108)) |
| Staging — API       | Fly.io `kassa-api-staging` (`sin`)         | Successful CI run on `main`              | **Live** ([KASA-107](/KASA/issues/KASA-107), this section §3.7) |
| Production — static | Cloudflare Pages (`kassa-pos`, `kassa-back-office`) | Successful CI run on `main`       | **Live** ([KASA-18](/KASA/issues/KASA-18), this section §3.2–§3.6) |
| Production — API    | Fly.io `kassa-api` + Neon main (Postgres) | Manual promotion from staging            | Deferred ([KASA-70](/KASA/issues/KASA-70), M4) |

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

### 3.6 Secrets and variables (reference)

| Key                          | Scope                      | Purpose                                         | Status |
|:-----------------------------|:---------------------------|:------------------------------------------------|:-------|
| `CLOUDFLARE_API_TOKEN`       | Env: `production` (secret) | `wrangler pages deploy` auth                    | Required for current CD |
| `CLOUDFLARE_ACCOUNT_ID`      | Env: `production` (secret) | Cloudflare account scoping                      | Required for current CD |
| `FLY_API_TOKEN`              | Env: `production` (secret) | `flyctl deploy` auth for `kassa-api-staging`    | Required for current CD |
| `DEPLOY_ENABLED`             | Repo (variable)            | Master switch — `true` turns on deploy jobs     | Required for current CD |
| `NEON_API_KEY`               | Env: `preview` (secret)    | Ephemeral Neon branch per PR                    | Deferred (KASA-108)      |
| `SENTRY_AUTH_TOKEN`          | Env: `production` (secret) | Source map uploads (both PWA and API)           | Deferred (KASA-70)       |

Secrets never live in workflow YAML; the workflow references them via `${{ secrets.NAME }}` and GitHub injects them at runtime.

App-side secrets for `kassa-api-staging` (what the runtime actually needs) live in Fly, not GitHub: `STAFF_BOOTSTRAP_TOKEN`, `MIDTRANS_SERVER_KEY` (optional on staging), `MIDTRANS_ENVIRONMENT`, `LOG_LEVEL`. Rotate with `flyctl secrets set` — no redeploy needed; Fly restarts machines automatically.

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
- `worker = "node apps/api/dist/workers/index.js"` — background process group, no HTTP. Currently a no-op loop pending BullMQ/Redis provisioning (follow-up). The process group exists now so the two-process topology is validated end-to-end before KASA-108 adds real work.

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

- This job does **not** exercise authenticated paths, mutate data, or run E2E flows — those belong in the Playwright workflow (deferred). It is deliberately a "did the deploy land and is the right code serving" gate, nothing deeper.
- The script only checks the three surfaces `cd.yml` deploys. When production API (KASA-70) or per-PR preview environments (KASA-108) land, each adds its own invocation of the same script with different URLs rather than forking the checks.

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
- **No E2E in the PR gate (for now).** Playwright adds ~2 min of browser install and has not earned its place as a blocker yet. It will run in its own workflow once the PWA is stable enough for E2E to be meaningful.

---

## 6. Follow-ups tracked against this doc

These are out of scope for the initial CI + static-surface CD setup but are **prerequisites to finishing M0**. Each gets its own child issue under [KASA-12](/KASA/issues/KASA-12) or [KASA-18](/KASA/issues/KASA-18):

1. ~~**Lint lane (Biome)**~~ — landed via [KASA-13](/KASA/issues/KASA-13) (PR #18) with root-scan wiring documented in §2.4; doc reconciliation closed out by [KASA-101](/KASA/issues/KASA-101).
2. ~~**Build artifacts**~~ — landed via [KASA-17](/KASA/issues/KASA-17).
3. ~~**Production CD for static surfaces**~~ — landed via [KASA-18](/KASA/issues/KASA-18) (this section).
4. ~~**API → Fly.io staging deploy**~~ — landed via [KASA-107](/KASA/issues/KASA-107) (this section §3.7–§3.8).
5. **API → Fly.io production deploy** — tracked in [KASA-70](/KASA/issues/KASA-70) (M4). Production Fly app, Neon production branch, Midtrans prod keys, Sentry release tagging, manual promotion gate.
6. **Preview-per-PR environments** — tracked in [KASA-108](/KASA/issues/KASA-108) (M0, unblocked by KASA-107). Cloudflare Pages preview deploys for both static surfaces, Fly.io staging redeploy for the API, Neon branch DB per PR, teardown on PR close.
7. **Worker queue broker + real workers** — Redis/BullMQ provisioning, replace the `kassa-api-staging` `worker` process-group stub with a real consumer. Open when the first background job lands.
8. **Production promotion gate** — `cd-prod.yml` with `workflow_dispatch` and environment protection rules (required reviewers) for the API cutover once staging/preview are live.
9. **Playwright E2E workflow** — nightly + on-merge run, not on PR.
10. **Turborepo remote cache** — named in [TECH-STACK.md §10.3](./TECH-STACK.md); wire it once CI is live and we have a signal on cold vs warm install time.

---

## 7. Where to look when CI is red

1. **Lockfile error (`ERR_PNPM_OUTDATED_LOCKFILE`)** — the PR changed `package.json` but not `pnpm-lock.yaml`. Run `pnpm install` locally, commit the lockfile, push.
2. **Typecheck failure in `apps/*` citing `Cannot find module '@kassa/*'`** — the build step didn't run or was silently cancelled. Re-run the job; if it persists, check whether the package's `exports` field changed.
3. **Vitest failure that only fails in CI** — 95% of the time this is `NODE_ENV=production` (React test-helpers require the dev build). The runner inherits no custom env, so this usually means the test itself sets `NODE_ENV` and forgets to reset it.
4. **Flake on `actions/setup-node` cache restore** — rare, transient. Re-run. If it becomes a pattern, open an issue and bump the action pin.

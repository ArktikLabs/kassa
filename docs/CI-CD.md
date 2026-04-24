# Kassa CI/CD Pipeline

Status: v0 (CI only). Owner: DevOps. Source issue: [KASA-12](/KASA/issues/KASA-12).
Companion docs: [TECH-STACK.md](./TECH-STACK.md), [ARCHITECTURE.md](./ARCHITECTURE.md), [ROADMAP.md](./ROADMAP.md).

This is the authoritative description of how Kassa code moves from a contributor's branch into `main` and — in later milestones — into production. v0 scope covers **CI only** (lint/typecheck/test/build on every PR and every push to `main`). Continuous **deployment** (Cloudflare Pages for the POS PWA, Fly.io for the API) lands in follow-up tickets under the M0 milestone.

---

## 1. Pipeline overview

| Concern           | Tool                                    |
|:------------------|:----------------------------------------|
| CI orchestrator   | GitHub Actions                          |
| Runner            | `ubuntu-latest` (GitHub-hosted)         |
| Node version      | `22` (pinned via `.nvmrc`)              |
| Package manager   | `pnpm@9.12.0` (pinned via `packageManager`) |
| Dependency cache  | `actions/setup-node`'s built-in pnpm cache (keyed on `pnpm-lock.yaml`) |
| Lint/format       | Biome (not yet installed — see §6 follow-ups) |
| Typecheck         | `tsc --noEmit` per package (`pnpm -r typecheck`) |
| Test              | Vitest (`pnpm -r test`)                 |
| Build             | `tsc -p tsconfig.build.json` (packages) + Vite (apps) (`pnpm -r build`) |
| E2E (deferred)    | Playwright — separate workflow in a later ticket |
| CD (deferred)     | Cloudflare Pages (PWA) + Fly.io (API)   |

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
5. **Build workspace** — `pnpm -r build`. `pnpm -r` is topology-aware, so `packages/*` (no internal deps) build before `apps/*` (which depend on them).
6. **Typecheck** — `pnpm -r typecheck`.
7. **Test** — `pnpm -r test` (Vitest only; Playwright E2E is deferred).

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
```

Renovate/Dependabot may bump these; reviewers must verify the SHA against the upstream tag before approving a bump.

---

## 3. CD workflow (deferred to follow-up tickets)

v0 CD is **not yet live**. The target shape, per [TECH-STACK.md](./TECH-STACK.md) and [ROADMAP.md](./ROADMAP.md) M0 exit criteria, is:

| Environment | Target                                    | Trigger                      |
|:------------|:------------------------------------------|:-----------------------------|
| Preview     | Cloudflare Pages (PWA), Fly.io staging app (API), Neon branch DB | PR opened/updated            |
| Staging     | Same as preview, pinned to `main`         | Merge to `main`              |
| Production  | Cloudflare Pages (PWA), Fly.io (`sin` region) + Neon main (Postgres) | Manual promotion from staging |

Secrets required (to be set in GitHub Secrets at CD time, not committed anywhere):

| Variable                     | Purpose                                     |
|:-----------------------------|:--------------------------------------------|
| `CLOUDFLARE_API_TOKEN`       | Cloudflare Pages deploys (POS PWA)          |
| `CLOUDFLARE_ACCOUNT_ID`      | Cloudflare Pages project scoping            |
| `FLY_API_TOKEN`              | Fly.io deploy for `apps/api`                |
| `NEON_API_KEY`               | Ephemeral Neon branch per PR (preview DBs)  |
| `SENTRY_AUTH_TOKEN`          | Source map uploads (both PWA and API)       |

See §6 for the child issues that will land each piece.

### Rollback procedure (target state)

1. Identify the failing deployment via Sentry alerts or the Fly.io/Cloudflare deploy log.
2. `fly deploy --image <last-known-good>` for the API, or re-publish the prior Cloudflare Pages deployment from the dashboard (or trigger the CD workflow on the known-good SHA).
3. Verify via `/health` (API) and the POS PWA load test.
4. Open a follow-up issue for the root cause; a rollback is not the fix.

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

These are out of scope for the initial CI setup but are **prerequisites to finishing M0**. Each gets its own child issue under [KASA-12](/KASA/issues/KASA-12):

1. **Lint lane (Biome)** — add `@biomejs/biome` to the workspace, a root `biome.json`, `lint` scripts in each package, and a `lint` step in `ci.yml` ahead of typecheck.
2. **Preview deploys for the POS PWA** — Cloudflare Pages project + preview-per-PR workflow.
3. **Preview + staging deploys for the API** — Fly.io app (`kassa-api-staging`, region `sin`), Neon branch per PR.
4. **Playwright E2E workflow** — nightly + on-merge run, not on PR.
5. **Production promotion** — workflow-dispatch `cd-prod.yml` with environment protection rules.
6. **Turborepo remote cache** — named in [TECH-STACK.md §10.3](./TECH-STACK.md); wire it once CI is live and we have a signal on cold vs warm install time.

---

## 7. Where to look when CI is red

1. **Lockfile error (`ERR_PNPM_OUTDATED_LOCKFILE`)** — the PR changed `package.json` but not `pnpm-lock.yaml`. Run `pnpm install` locally, commit the lockfile, push.
2. **Typecheck failure in `apps/*` citing `Cannot find module '@kassa/*'`** — the build step didn't run or was silently cancelled. Re-run the job; if it persists, check whether the package's `exports` field changed.
3. **Vitest failure that only fails in CI** — 95% of the time this is `NODE_ENV=production` (React test-helpers require the dev build). The runner inherits no custom env, so this usually means the test itself sets `NODE_ENV` and forgets to reset it.
4. **Flake on `actions/setup-node` cache restore** — rare, transient. Re-run. If it becomes a pattern, open an issue and bump the action pin.

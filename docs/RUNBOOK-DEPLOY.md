# Kassa Production Deploy Runbook

Status: v0 (KASA-70 — initial production pipeline). Owner: DevOps. Companion docs: [CI-CD.md](./CI-CD.md), [TECH-STACK.md](./TECH-STACK.md), [ARCHITECTURE.md](./ARCHITECTURE.md).

This runbook is the operator's reference for promoting code to production, recovering from a bad release, and provisioning the production environment for the first time. It is intentionally narrow: only what an on-call operator needs at 02:00 in front of a flat green Better Stack board.

For the day-in / day-out CI + staging pipeline see [CI-CD.md](./CI-CD.md). This file picks up at the production-promotion gate.

---

## 1. Production environment overview

| Surface         | Provider           | Resource                                        | URL                                |
|:----------------|:-------------------|:------------------------------------------------|:-----------------------------------|
| API             | Fly.io             | App `kassa-api-prod` (`sin`, 2× HA)             | `https://kassa-api-prod.fly.dev`   |
| API DB          | Neon               | Branch `production` (PITR enabled)              | bound via `DATABASE_URL`           |
| API queue       | Upstash via Fly    | Redis `kassa-redis-prod` (`sin`)                | bound via `REDIS_URL`              |
| POS PWA         | Cloudflare Pages   | Project `kassa-pos`, production branch `main`   | `https://kassa-pos.pages.dev` (custom: `app.kassa.id`) |
| Back Office SPA | Cloudflare Pages   | Project `kassa-back-office`, production branch `main` | `https://kassa-back-office.pages.dev` |
| Errors          | Sentry             | Releases `kassa-{api,pos,back-office}@<sha>`    | Sentry org `kassa`                 |
| Payments        | Midtrans           | Production merchant keys (sandbox stays on staging) | bound via `MIDTRANS_SERVER_KEY` Fly secret |

**Trigger model.**

- **Static surfaces (POS + Back Office)** auto-deploy to Cloudflare Pages production on every successful CI run on `main` (`.github/workflows/cd.yml`). Sentry release + source maps are uploaded as part of the same job.
- **API** is **manual-only** via `.github/workflows/deploy-prod.yml`. The operator picks an exact CI run id; the workflow re-verifies the run is on `main`, succeeded, and had a green `acceptance-full-day-offline` job; the GitHub `production-prod` environment then waits for required-reviewer approval (CEO + CTO) before the deploy job runs.

**Sentry separation.** Production and staging events live in the same Sentry project per surface but are split by **two** tags so on-call alert rules and release-health dashboards can scope to one tier (KASA-150):

| Surface         | Release tag (sha-pinned)        | Environment tag                 | Set by                                                     |
|:----------------|:--------------------------------|:--------------------------------|:-----------------------------------------------------------|
| POS PWA         | `kassa-pos@<sha12>`             | `production` / `staging`        | `VITE_SENTRY_ENVIRONMENT` baked at CI build time           |
| Back Office SPA | `kassa-back-office@<sha12>`     | `production` / `staging`        | `VITE_SENTRY_ENVIRONMENT` baked at CI build time           |
| API             | `kassa-api@<sha12>`             | `production` / `staging`        | `SENTRY_ENVIRONMENT` from `apps/api/fly{,.prod}.toml [env]` |

The release ID alone is not enough to distinguish tiers — preview/staging deploys can replay the exact same SHA that prod ships, and `import.meta.env.MODE` is `production` for any `vite build` regardless of where it lands. CI's build step (`.github/workflows/ci.yml`) sets `VITE_SENTRY_ENVIRONMENT=production` on push-to-main and `staging` otherwise; cd.yml re-uses the artifact byte-identically rather than rebuilding, so the tag travels with the bundle. The API tag lives in the fly toml `[env]` block of each app and will be picked up once the `@sentry/node` runtime init lands (gated on KASA-7c59dfe5).

When writing a Sentry alert rule that should only page on production, filter on **both** the project AND `environment:production`; the release tag alone matches every replay.

---

## 2. First-time provisioning checklist

Before the production deploy pipeline can run, ops completes this list once. After it lands, day-to-day operation only needs §3 (promote) and §4 (rollback).

1. **Fly.io app** — `flyctl apps create kassa-api-prod --org kassa`. Bind app secrets:
   ```sh
   flyctl secrets set --app kassa-api-prod \
     LOG_LEVEL=info \
     STAFF_BOOTSTRAP_TOKEN="$(openssl rand -base64 24)" \
     MIDTRANS_ENVIRONMENT=production \
     MIDTRANS_SERVER_KEY="<rotated production server key from Midtrans dashboard>"
   ```
   The `MIDTRANS_SERVER_KEY` value is the merchant's production server key from the Midtrans dashboard's Settings → Access Keys. Sandbox keys MUST stay on `kassa-api-staging` — do not reuse.
2. **Neon production branch** — in the Neon console, create a new branch named `production` off the staging branch (or off `main` if no parent makes sense). Enable Point-in-Time Recovery (Branch settings → PITR). Generate a connection string and bind:
   ```sh
   flyctl secrets set --app kassa-api-prod \
     DATABASE_URL="postgres://...@<prod-neon-host>/...?sslmode=require"
   ```
3. **Nightly `pg_dump` to S3.** Provisioned via `.github/workflows/backup-prod.yml` (calls `scripts/db-backup.sh`). The workflow streams `pg_dump | gzip | aws s3 cp -` daily at 02:00 UTC (09:00 WIB) to `s3://kassa-backups/prod/<UTC-date>.sql.gz` and is also available as `workflow_dispatch` for ad-hoc / DR-rehearsal dumps. One-time setup:
   - Provision an S3 bucket `kassa-backups` in `ap-southeast-1` with SSE-S3 (or KMS) at-rest encryption, Versioning ON, Public Access Block all on, and a lifecycle rule that expires `prod/*` after 35 days.
   - Create a Neon read-only role on the production branch (`GRANT pg_read_all_data` to a dedicated role) and add its connection string as `BACKUP_DATABASE_URL` in the `production-prod` GitHub environment. Read-only is mandatory — a runner compromise must not be able to mutate prod.
   - Create an AWS IAM role for OIDC federation (trust `token.actions.githubusercontent.com` for `repo:ArktikLabs/kassa:*`; permissions limited to `s3:PutObject` + `s3:HeadObject` on `arn:aws:s3:::kassa-backups/prod/*`). Add the role ARN as `AWS_BACKUP_ROLE_ARN` in the same environment.
   - Set repository variable `BACKUP_PROD_ENABLED=true`.

   Verify the first scheduled (or `workflow_dispatch`) run completes green and the object appears in S3 at the expected key with `> 0 bytes`. The workflow's final `aws s3api head-object` step asserts non-empty before exiting.
4. **Production Redis broker** — `flyctl redis create --org kassa --name kassa-redis-prod --region sin --no-replicas --plan 3G`. Bind:
   ```sh
   flyctl secrets set --app kassa-api-prod REDIS_URL="redis://default:<token>@<host>:6379"
   ```
   Staging and production must point at separate Redis instances. See [CI-CD.md §3.10](./CI-CD.md) for the BullMQ-polling-floor rationale and the fixed-tier requirement.
5. **Cloudflare custom domain** — in the Cloudflare dashboard, attach the chosen production domain (e.g. `app.kassa.id`) to the `kassa-pos` Pages project. Configure DNS as instructed by the dashboard, wait for the certificate to issue, and verify `https://app.kassa.id/` returns the POS shell. Repeat on `kassa-back-office` if the back office is exposed externally; otherwise leave it on the `pages.dev` URL.
6. **GitHub `production-prod` environment** — create it under Settings → Environments. Add required-reviewer rule listing both CEO and CTO. Add secrets:
   - `FLY_API_TOKEN_PROD` — `flyctl tokens create deploy -a kassa-api-prod`.
   - `SENTRY_AUTH_TOKEN` — Sentry → Settings → Internal Integrations → create one with `Releases: Admin` scope on the Kassa org.
7. **GitHub `production` environment** — already exists for `cd.yml` (KASA-18 / KASA-107). Add the same `SENTRY_AUTH_TOKEN` secret here so the POS and Back Office Sentry releases on cd.yml can fire.
8. **Repository variables** — Settings → Variables:
   - `DEPLOY_PROD_ENABLED=true` (master switch for `deploy-prod.yml`).
   - `SENTRY_ORG=<kassa-org-slug>` (e.g. `kassa`).
   - `SENTRY_PROJECT_API=<api-project-slug>` (e.g. `kassa-api`).
   - `SENTRY_PROJECT_POS=<pos-project-slug>` (e.g. `kassa-pos`).
   - `SENTRY_PROJECT_BACK_OFFICE=<back-office-project-slug>` (e.g. `kassa-back-office`).

When all eight steps are done, run §3 against an arbitrary recent green main CI run as a dry-run to exercise the full pipeline including the Sentry release UI and the smoke tests.

---

## 3. Promote a release to production

Production-API promotion is always operator-initiated. Static surfaces ride on every successful main CI run automatically — only the API needs a deliberate gate.

### 3.1 Pre-flight checks (operator)

Before triggering the workflow, confirm:

- [ ] The CI run id is on `main` and the run is green (overall conclusion = success).
- [ ] The same run's `Acceptance — full-day offline (KASA-68)` job is green. The deploy workflow re-checks this independently, but a quick visual saves a wasted approval.
- [ ] Staging has been on the same SHA for at least 30 minutes with no Sentry error spike.
- [ ] No active Better Stack incident on staging or any production surface.
- [ ] If the change touches the database schema (Drizzle migration in `apps/api/src/db/migrations/`), the migration has been validated on staging by inspecting the Neon staging branch's schema before promotion. Drizzle migrations are forward-only; rollback is a deploy-forward, never a `DROP` (see §4.4).

### 3.2 Trigger the deploy

1. GitHub → Actions → `Deploy Prod (API)` → **Run workflow**.
2. Branch: `main` (the workflow file is on main; the deployed bytes come from the artifact, not this branch).
3. `ci_run_id`: paste the numeric id from the Actions URL of the chosen CI run (e.g. from `…/actions/runs/12345678` paste `12345678`).
4. Run.

### 3.3 What happens

1. **Preflight job** verifies the cited CI run is on `main`, succeeded, and that its `Acceptance — full-day offline (KASA-68)` job conclusion is `success`. Fails the workflow with `::error::` if any check fails.
2. **`deploy-api-prod` job** waits at the GitHub-environment gate. Required reviewers (CEO + CTO) get a notification; one of them clicks **Review deployments** → **Approve and deploy**. Approval is recorded on the run for audit.
3. After approval, the job:
   - Downloads the `api-dist` artifact from the cited CI run.
   - Creates a Sentry release `kassa-api@<sha12>`, attaches the commit, uploads the source maps from `apps/api/dist`, and finalizes the release.
   - Runs `flyctl deploy --app kassa-api-prod --config apps/api/fly.prod.toml --image-label prod-<sha12> --strategy rolling --wait-timeout 600`. The release_command (`drizzle-orm` migrate) runs first; failure aborts the deploy with the old machines still serving.
4. **Smoke-tests job** probes the production API, POS, and Back Office URLs via `scripts/deploy-smoke.sh`, asserting the API reports `version=prod-<sha12>`. A failure here means rollback (§4) immediately.

### 3.4 Verify after green

- Sentry: open the new release `kassa-api@<sha12>`; confirm "Source maps" shows the uploaded artifacts and "Commits" shows the SHA.
- Fly: `flyctl status --app kassa-api-prod` shows two web machines and one worker, all `passing` health.
- Better Stack: the synthetic check on `kassa-api-prod.fly.dev/health` flips green within ~1 min.
- Staging is still on the prior SHA (the prod promotion does not touch it).

---

## 4. Rollback

**Goal: restore service first, root-cause after.** Do not wait for the fix PR.

The decision policy ("when to rollback vs hotfix", "who needs to know") lives in [RUNBOOK-INCIDENT.md §5](./RUNBOOK-INCIDENT.md#5-rollback-procedures); the symptom → procedure mapping the on-call uses at 02:00 lives in [RUNBOOK-ONCALL.md §5](./RUNBOOK-ONCALL.md#5-rollback-matrix). This section is the source of truth for the **commands themselves**.

### 4.1 When to rollback

Rollback when any of these signal within ~10 min of the deploy landing:

- Sentry error rate on `kassa-api@<new-sha>` spikes ≥3× the baseline of the prior release.
- Better Stack synthetic check on `kassa-api-prod.fly.dev/health` fails two checks in a row.
- A reproducible functional regression observed on the production POS.
- Drizzle migration succeeded but downstream behaviour is wrong (rare; see §4.4 — rollback is deploy-forward in this case).

### 4.2 API rollback — `flyctl releases` (preferred)

Each prod deploy is image-labelled `prod-<sha12>`, and `flyctl releases` records every release. Rolling back is "redeploy a prior labelled image".

```sh
# Identify the last known-good release.
flyctl releases --app kassa-api-prod

# Redeploy that release. --image skips the Docker build entirely.
flyctl deploy --app kassa-api-prod \
  --config apps/api/fly.prod.toml \
  --image registry.fly.io/kassa-api-prod:prod-<prev-sha12> \
  --strategy immediate
```

`--strategy immediate` is fine on rollback because the prior image is known-good. Verify:

```sh
curl -fsS https://kassa-api-prod.fly.dev/health   # status=ok, version=prod-<prev-sha12>
flyctl logs --app kassa-api-prod                  # no boot errors
flyctl status --app kassa-api-prod                # both web machines passing
```

### 4.3 Static surface rollback — Cloudflare dashboard

POS and Back Office rollback uses the Cloudflare Pages UI (same path as staging — KASA-18 / [CI-CD.md §3.5](./CI-CD.md)):

1. Cloudflare dashboard → Pages → `kassa-pos` (or `kassa-back-office`) → Deployments.
2. Find the last known-good production deployment.
3. `…` menu → **Rollback to this deployment**. Cloudflare promotes the older build atomically.

The Sentry release for the prior deployment is already finalized, so error grouping reverts cleanly without re-uploading source maps.

### 4.4 Rolling back a Drizzle migration

Drizzle migrations are forward-only. **Do not** hand-edit the production database to reverse a migration; the `__drizzle_migrations` table will go out of sync and the next deploy will fail at `release_command`.

If a migration shipped that needs to be undone, the rollback is:

1. Open a revert PR that adds a **compensating forward migration** (a new file in `apps/api/src/db/migrations/` that undoes the schema change). Land it on main, let CI go green.
2. Run §3 to promote the revert. The compensating migration applies as a normal forward migration; the schema lands back where it started without history-rewriting.

For a destructive migration (column drop) that has already happened, restore from the most recent Neon PITR snapshot (Neon console → Branch → Restore) onto a new branch, sanity-check the data, and cut `kassa-api-prod` over to it via `flyctl secrets set DATABASE_URL=...`. This is a recovery path, not a routine rollback — talk to the CTO before doing it.

### 4.5 What never to do on production

- **Do not deploy a local `flyctl deploy` against `kassa-api-prod` from a developer laptop.** Production bytes must come from a CI artifact via `deploy-prod.yml`. Use the workflow's `workflow_dispatch` re-run to redeploy the same artifact if the original run was interrupted.
- **Do not disable `kassa-api-prod`** (`flyctl scale count 0`) to "take pressure off" a failing release. Rollback to the prior image; keep the app addressable so dashboards and alerts keep working.
- **Do not skip the post-incident issue.** A rollback without a written root cause is how the same regression ships twice. File it under the milestone the bad commit belonged to.
- **Do not flip `DEPLOY_PROD_ENABLED=false` to "pause" deploys.** The flag is for the pre-provisioning window; pausing routine promotion is a process decision, not a CI variable.
- **Do not bypass the required-reviewer gate.** GitHub allows admins to override; doing so on production deletes the whole point of the gate. Wake CEO or CTO instead.

---

## 5. Pause / cancel of in-flight deploys

The `deploy-prod-api` concurrency group serializes deploys: only one can be in flight. To cancel an in-flight rollout that has not yet rolled all machines:

```sh
# List in-flight machines for the latest release.
flyctl status --app kassa-api-prod

# If only one of two web machines has rolled and you want to abort:
flyctl deploy --app kassa-api-prod \
  --config apps/api/fly.prod.toml \
  --image registry.fly.io/kassa-api-prod:prod-<prev-sha12> \
  --strategy immediate
```

There is no "pause" — Fly's rolling deploy advances on its own once started. The fastest abort is to redeploy the prior image immediately.

---

## 6. Better Stack synthetic monitors and status page

The two production-tier synthetic checks named in [TECH-STACK.md §12.4](./TECH-STACK.md) and [ARCHITECTURE.md §5.5](./ARCHITECTURE.md) — API `/health` and the POS PWA shell — are the live signal that production is reachable from outside. Their config is in [`infra/observability/better-stack-monitors.json`](../infra/observability/better-stack-monitors.json) (KASA-71 wired the schema; KASA-198 tightened the body keyword + 30 s timeout). Apply with [`scripts/observability-apply.sh`](../scripts/observability-apply.sh) — see [`infra/observability/README.md`](../infra/observability/README.md).

### 6.1 Monitor inventory

| Monitor                  | Probe URL                                                  | Body assertion                  | Cadence | Timeout | Pages after  | Better Stack ID |
|:-------------------------|:-----------------------------------------------------------|:--------------------------------|:--------|:--------|:-------------|:----------------|
| `kassa-api-prod-health`  | `https://kassa-api-prod.fly.dev/health` *(cutover: `https://api.kassa.id/health`)* | body contains `"status":"ok"`   | 60 s    | 30 s    | 2 fails (~2 min) | _filled by ops post-apply_ |
| `kassa-pos-prod-shell`   | `https://kassa-pos.pages.dev/` *(cutover: `https://app.kassa.id/`)*               | body contains `<title>Kassa POS</title>` | 60 s    | 30 s    | 2 fails (~2 min) | _filled by ops post-apply_ |

The two-consecutive-failure rule is deliberate (see [RUNBOOK-ONCALL.md §3.2](./RUNBOOK-ONCALL.md#32-better-stack-uptime-monitors)) — it absorbs single Cloudflare-edge or Fly-router blips without paging.

The `Better Stack ID` column is filled by ops after the first `--apply` run. Read the IDs out of the apply log line (`[create] monitor name=kassa-api-prod-health` is followed by the new record's `id` in the API response — the script logs the name, but the ID is on the `id` field of the POST response body) or look them up in the dashboard URL (`uptime.betterstack.com/team/<team>/monitors/<id>`). PR them into this table the same day.

### 6.2 Secret references

| Secret / variable         | Where it lives                                             | What it lets the operator do                |
|:--------------------------|:-----------------------------------------------------------|:--------------------------------------------|
| `BETTER_STACK_API_TOKEN`  | Local: `~/.kassa/observability.env`. CI: GitHub `production-prod` environment secret. | Run `scripts/observability-apply.sh --apply` to reconcile monitors + heartbeats. Scope at issue time: `Manage monitors + heartbeats`. |
| `BETTER_STACK_HEARTBEAT_URL` | GitHub repo secret (already wired in `synthetic-sale.yml`). | Lets the synthetic-sale workflow ping the heartbeat record. |
| Slack workspace install   | Better Stack → Integrations → Slack                        | Routes step-1 escalation to `#kassa-pilot-oncall`. |
| Email alias `oncall@kassa.id` | Better Stack → Account → Email aliases                  | Routes step-2 escalation. |
| CTO user email            | Better Stack → Team members                                | Routes step-3 escalation. |

The token never appears in code, in this runbook, or in any issue comment. Rotation procedure: regenerate in Better Stack → Account → API Tokens, update the GitHub environment secret and the operator's local `~/.kassa/observability.env`, re-run `scripts/observability-apply.sh` to confirm the new token still reconciles. Old token revokes itself after the rotation window.

### 6.3 Override procedure for false alerts during a deploy

A production deploy briefly bounces machines (rolling strategy, ≤60 s per machine; the second machine keeps serving). Better Stack's two-consecutive-failure rule is sized so a routine rolling deploy does **not** page. **Do not pre-mute for a routine deploy** — the alert quieting itself is part of the safety net.

Mute only if a deploy is expected to take a monitor down for **longer than the alert window** (≥120 s on `/health`, ≥120 s on the POS shell). Examples that warrant a mute: a Fly machine-resize that requires `flyctl scale memory`, a Cloudflare Pages project rename, a DNS cutover. A rolling `flyctl deploy` does not.

To mute during a planned event, **before** triggering the destructive change:

1. Better Stack dashboard → Monitors → select the monitor (`kassa-api-prod-health` and/or `kassa-pos-prod-shell`).
2. **Pause monitoring** → set duration to **30 minutes** (or the planned window + 10 min buffer; never indefinite).
3. Note the unmute time in the deploy issue thread, with monitor name and operator handle. The deploy issue is the source of truth for "did we remember to unmute".
4. Run the deploy. Watch `flyctl status` / Cloudflare Pages dashboard directly — you have removed the safety net.
5. **Unmute as soon as the surface is back up**, even if before the auto-expiry. The dashboard's `Resume monitoring` button is the same place as `Pause`. The free tier's auto-expiry is the safety net for "operator forgot to unmute" — do not lean on it.

If a false page fires from a ≤2 minute blip during a deploy:

1. **Acknowledge** the incident in the Slack thread (`#kassa-pilot-oncall`) so the rest of the pod knows it's spurious.
2. Do **not** disable the monitor. Acknowledging suppresses paging on the same incident; disabling would also suppress the next, real failure.
3. File a follow-up ticket if the same blip pages twice in a week — that is the threshold to widen `confirmation_period` or add a second region (PR to `infra/observability/better-stack-monitors.json`, dry-run, merge, re-apply).

### 6.4 Maintenance windows

Better Stack's free tier does **not** support scheduled maintenance windows (recurring or one-shot mute schedules). The substitutes are:

- **Routine rolling deploys** — no action needed; the two-fail threshold absorbs them (see §6.3).
- **Planned destructive change >2 min** — manual mute via the Pause button per §6.3 step 2.
- **Recurring-schedule mutes** (e.g. nightly index rebuild that takes the API down for 3 min at 03:00 WIB) — not built. If we ever need this, the upgrade path is either: (a) Better Stack paid tier with Scheduled maintenance windows; or (b) a small workflow that calls the Better Stack API to pause + un-pause around a cron. Neither is justified at pilot scale; revisit when the pilot's incident log shows recurring window-clash flaps.

The deliberate omission means: any planned outage that would last longer than ~2 min on a monitor's surface is operator-driven, manually muted, and noted in the deploy issue. There is no quiet-by-cron path.

### 6.5 Status page

Better Stack hosts a public-or-private status page per workspace. The Kassa pilot status page exposes the same uptime feed the on-call sees, scoped down to the merchant-visible surfaces (POS PWA shell, API `/health`, payments).

| Field                    | Value                                                                |
|:-------------------------|:---------------------------------------------------------------------|
| Status page URL          | _filled by ops post-creation_ (Better Stack → Status pages → +New)   |
| Visibility               | **Private** during pilot week (single merchant) → **Public** post-pilot |
| Components surfaced      | `kassa-api-prod-health`, `kassa-pos-prod-shell` (back-office monitor stays internal) |
| Subscribed escalations   | None at pilot (single-merchant; out-of-band WhatsApp suffices)       |

Provisioning steps for the operator (one-time, not in the apply script — Better Stack's status-page API is on the paid tier; the pilot uses dashboard click-ops with the URL captured back into this section):

1. Better Stack dashboard → **Status pages** → **+ Create status page**. Name `Kassa pilot`. Subdomain `kassa.betteruptime.com` (free) or skip and use the random URL.
2. Visibility → **Password-protected**. Share the password with the pilot merchant via the same channel as the §6.6 of `RUNBOOK-ONCALL.md` merchant contact card.
3. **Add resources** → select `kassa-api-prod-health` and `kassa-pos-prod-shell`. Group both under a single section "Kassa POS service".
4. Save. Copy the page URL into the table above and PR it (this same file).
5. Open the URL once from a non-VPN connection to confirm it loads and the password gate works.

Status-page incidents auto-publish from the same monitor failures that page on-call. No extra wiring.

### 6.6 First-time apply playbook (KASA-198 acceptance)

The operator running this for the first time after the secrets land:

1. Set `BETTER_STACK_API_TOKEN` in `~/.kassa/observability.env` (or export inline).
2. `scripts/observability-apply.sh` — dry-run, confirm the diff matches the JSON.
3. `scripts/observability-apply.sh --apply` — reconcile.
4. Capture the two new monitor IDs into §6.1's table; PR.
5. In the dashboard, complete the Slack + email + status-page provisioning per §6.2 and §6.5.
6. Wait 30 minutes; confirm both monitors show `up` (the KASA-198 acceptance check).
7. Run the §3.4 dry-fire from `RUNBOOK-ONCALL.md` (Better Stack `Test alert` button) — confirm the page reaches `#kassa-pilot-oncall` within 2 min.
8. Close KASA-198 with the monitor IDs, the status-page URL, and a screenshot of the Better Stack dashboard showing both green.

If the deploy-prod cutover URL changes (KASA-149: `kassa-api-prod.fly.dev` → `api.kassa.id`, `kassa-pos.pages.dev` → `app.kassa.id`), update the JSON's `url` fields, re-run `--apply`, and update §6.1's URL column in the same PR. The monitor records survive the URL change — `pronounceable_name` is the idempotency key, not the URL.

---

## 7. Where this runbook is wrong

Update this file whenever any of the following changes:

- A new Fly app, Neon branch, Cloudflare project, or third-party integration becomes part of production.
- The required-reviewer composition for `production-prod` changes.
- The Sentry org slug, project slugs, or auth-token rotation procedure changes.
- A rollback in the field exposes a step that was missing from §4.

The PR that changes the corresponding behaviour also updates this file. A stale runbook is worse than none — operators trust it under pressure.

# Kassa Disaster Recovery Runbook

Status: v0 (KASA-181 — staging Neon PITR drill + DR procedure). Owner: DevOps. Companion docs: [RUNBOOK-DEPLOY.md](./RUNBOOK-DEPLOY.md), [RUNBOOK-INCIDENT.md](./RUNBOOK-INCIDENT.md), [RUNBOOK-ONCALL.md](./RUNBOOK-ONCALL.md), [CI-CD.md](./CI-CD.md), [ARCHITECTURE.md](./ARCHITECTURE.md).

This runbook is the operator's reference for **restoring Kassa's Postgres state after data loss or corruption**. It covers the two recovery surfaces v0 actually supports — Neon point-in-time recovery (PITR) into a fresh branch, and the nightly `pg_dump → S3` snapshot from [KASA-70](/KASA/issues/KASA-70) — plus the decision tree for choosing between them, and the cut-over commands that re-point the API at the restored database.

It closes the `docs/ops/` restore-runbook commitment in [ARCHITECTURE.md §5.5](./ARCHITECTURE.md#55-operations) (was: "we document the restore runbook in `docs/ops/` once it lands"). The `docs/ops/` path was abandoned in favour of the flat `docs/RUNBOOK-*.md` family established by [KASA-70](/KASA/issues/KASA-70) / [KASA-71](/KASA/issues/KASA-71) / [KASA-200](/KASA/issues/KASA-200); ARCHITECTURE.md L423 was updated in the same change.

For the on-call's "an alert just fired, what do I type" tree, start at [RUNBOOK-ONCALL.md](./RUNBOOK-ONCALL.md). For severity policy and comms cadence, [RUNBOOK-INCIDENT.md](./RUNBOOK-INCIDENT.md). This file is the **DB-recovery** layer of those.

---

## 1. What we recover from, and how

| Failure mode                                                  | Detection                                                   | Recovery surface                       | Typical RTO    | Notes                                                     |
|:--------------------------------------------------------------|:------------------------------------------------------------|:---------------------------------------|:---------------|:----------------------------------------------------------|
| Bad migration (column dropped, data destructively transformed) | `release_command` failed or post-deploy verification finds the wrong shape | Neon PITR → fresh branch → cutover     | 10–30 min      | First-class path. See §3.                                 |
| Operator typo (`UPDATE` without `WHERE`, `DELETE FROM x`)      | Merchant report or row-count alert                          | Neon PITR → fresh branch → cutover     | 10–30 min      | Same path as bad migration. See §3.                       |
| Application bug wrote wrong rows for hours/days                | Sentry / merchant report                                    | Forward-fix in code; targeted UPDATE; rarely PITR | App-dependent | PITR loses any *good* writes since the chosen timestamp; only restore if the bad data exceeds the good. See §2. |
| Region-wide Neon outage in `aws-ap-southeast-1`                | Better Stack synthetic-check failure on `/health`           | Wait on Neon; if >2 h, restore S3 dump into a Neon branch in another region | 1–4 h          | Out-of-region export is a v1 concern (ARCHITECTURE.md §5.5). The `pg_dump.sql.gz` in S3 is the lifeboat. See §4. |
| Logical Neon project loss (deletion, payment lapse, account compromise) | Console shows project missing                               | S3 dump → fresh Neon project → cutover | 1–4 h          | Same lifeboat as above. See §4.                            |
| Partial schema corruption inside a single table               | Read failures on specific endpoints                         | Neon PITR (target table only via `COPY`) | 30–60 min      | See §3.6 — PITR a sibling branch, then `COPY` the rescued table back into prod. |

PITR window is bounded by the Neon plan's retention. v0 carries the default 7-day window on the Neon branch. Anything older than that requires the S3 dump (§4) or is unrecoverable.

---

## 2. Decision tree — restore vs. fix-forward

**Restore from PITR if all are true:**

- The damage is *bounded in time* — you can name a "good before, bad after" timestamp.
- The bad writes since the bad timestamp outweigh the good writes that would be lost.
- The schema at the bad timestamp is compatible with current application code, OR you are willing to also roll the deploy back to a compatible release.
- You can absorb the cutover window (§3.4) without merchant-visible impact, or you have already paged the merchant.

**Fix forward (do not restore) if any are true:**

- Every minute of recent writes is genuinely valuable (mid-trading-day, sales committing) and the damage is reversible by a targeted SQL or a code fix.
- The damage is in the *application layer* — wrong amounts, wrong line items — not in the database substrate. Restoring would silently delete good sales along with the bad rows.
- You're not sure when the bad writes started. PITR without a confident timestamp is a coin flip.
- The data loss is from a code regression that has already been fixed and rolled out; the bad rows can be `UPDATE`d in place with the correct values.

**When in doubt:** open a fresh PITR branch (it is free and non-destructive), inspect the historical state side-by-side, and *then* decide. PITR creates a branch — it does not touch the production branch until you cut `DATABASE_URL` over.

**Escalation contract.** A restore is a human decision and always loops in the CTO before the cut-over (§3.4). If CTO is unreachable for >15 min during a P0 (incident severity per [RUNBOOK-INCIDENT.md §1](./RUNBOOK-INCIDENT.md#1-severity-ladder)), the on-call may proceed and notify CEO in the same step.

---

## 3. Neon PITR drill / recovery procedure

This is the **primary** recovery path. Practised quarterly against staging (§5); referenced verbatim from production at incident time. The drill produces the wall-clock numbers that go into §6.

**Pre-flight (operator):**

- [ ] You have Neon admin on the project (CEO holds account; CTO and DevOps are admins on the `kassa` Neon project — see §7 escalation table).
- [ ] You have the Fly token for the target app (`kassa-api-staging` for the drill, `kassa-api-prod` for a real recovery).
- [ ] `flyctl` is authenticated (`flyctl auth whoami`).
- [ ] `neonctl` is installed and authenticated (`neonctl auth`); a Neon API key is in your shell (`NEON_API_KEY`).
- [ ] `psql` (Postgres ≥16 client) is on PATH for the verification queries.
- [ ] An incident scratch channel is open and you have a place to paste timing.

### 3.1 Identify the parent branch and timestamp

The "bad timestamp" is the moment just before the bad write. Pick a timestamp **5 minutes earlier** to absorb clock skew between the writer and Neon's WAL.

```sh
# List branches; production data lives on `main` (or `production` per RUNBOOK-DEPLOY.md §1).
neonctl branches list --project-id "$NEON_PROJECT_ID"

# Inspect retention window for the parent branch — restoration anywhere inside.
neonctl branches get <parent-branch-id> --project-id "$NEON_PROJECT_ID"
```

For the drill:

- Parent branch: the staging branch (the one bound by `kassa-api-staging`'s `DATABASE_URL`).
- Fixture row: created deliberately at the start of the drill (§3.2) so the timestamp is known to the second. The [`scripts/seed-pilot.ts`](../scripts/seed-pilot.ts) seed script only writes reference data (merchants, outlets, items, BOMs, staff, stock snapshots) and never inserts into `sales` — verify with `grep "insert(sales" scripts/seed-pilot.ts`. We mint the canary row by calling the API.

### 3.2 Mint the canary row (drill only)

In a real incident the "row to verify" is whichever bad write you are restoring around — skip this step. For the drill, write a deterministic canary with the API:

```sh
# Capture the moment BEFORE the canary is written. Use UTC, second-precision.
T_BEFORE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "T_BEFORE=$T_BEFORE"

# Hit the staging API with a real sale via a known-enrolled device session.
# (See apps/api/src/routes/sales.ts for the request shape.) The drill tracks
# this exact UUID in the verification step.
SALE_ID=$(uuidgen)
curl -fsS -X POST "https://kassa-api-staging.fly.dev/v1/sales" \
  -H "Authorization: Bearer $STAGING_DEVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"id\":\"$SALE_ID\",\"outletId\":\"...\",\"items\":[...],\"tender\":\"cash\"}"

# Capture the moment AFTER the canary is committed.
T_AFTER=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Restore target = T_BEFORE minus 5 min for skew.
T_RESTORE=$(date -u -d "$T_BEFORE - 5 min" +%Y-%m-%dT%H:%M:%SZ)
echo "T_RESTORE=$T_RESTORE  SALE_ID=$SALE_ID"
```

Record the four values (`T_BEFORE`, `T_AFTER`, `T_RESTORE`, `SALE_ID`) in the §6 capture table.

### 3.3 Create the restored branch

```sh
START=$(date +%s)

# Branch off the parent at the chosen timestamp. Neon copies metadata
# instantly; data is copy-on-write so this returns in seconds, not minutes.
neonctl branches create \
  --project-id "$NEON_PROJECT_ID" \
  --parent <parent-branch-id> \
  --parent-timestamp "$T_RESTORE" \
  --name "dr-drill-$(date -u +%Y%m%dT%H%M%SZ)" \
  --output json > /tmp/dr-branch.json

RESTORED_BRANCH_ID=$(jq -r '.branch.id' /tmp/dr-branch.json)
RESTORED_HOST=$(jq -r '.endpoints[0].host' /tmp/dr-branch.json)

# Build the restored DATABASE_URL. Username/password and dbname come from the
# parent branch — Neon shares the role across branches.
RESTORED_DATABASE_URL="postgres://<role>:<password>@${RESTORED_HOST}/<db>?sslmode=require"

END_BRANCH=$(date +%s)
echo "branch_create_seconds=$((END_BRANCH - START))"
```

If the operator prefers the dashboard: Neon console → Project → Branches → **Create branch** → **From a point in time** → paste `T_RESTORE` (UTC) → name. Same outcome; the CLI is faster and scripted.

### 3.4 Cut the staging API to the restored branch (drill only)

```sh
# Capture the pre-drill DATABASE_URL BEFORE overwriting it — §3.7 teardown
# needs this to roll staging back. flyctl secrets list redacts values, so the
# source-of-truth is the local provisioning record. By convention, the same
# DATABASE_URL secret value lives in this repo's GitHub `staging` env (set
# during initial provisioning per RUNBOOK-DEPLOY.md §2). Pull it from the
# operator's password manager / 1Password vault item "Kassa Neon staging
# DATABASE_URL" — do NOT shell-out to GitHub here (the secret is masked in
# Actions logs and unreadable from the API).
ORIGINAL_STAGING_DATABASE_URL="<paste from password manager>"
test -n "$ORIGINAL_STAGING_DATABASE_URL" || { echo "refusing: capture rollback URL first"; exit 1; }

CUTOVER_START=$(date +%s)

# Override DATABASE_URL on the staging Fly app. This triggers a rolling
# restart; both web and worker process groups pick up the new value.
flyctl secrets set --app kassa-api-staging \
  DATABASE_URL="$RESTORED_DATABASE_URL"

# Wait for healthchecks to flip green on the new machines.
flyctl status --app kassa-api-staging
# Repeat until both `web` machines show `passing` on the new release.

END_CUTOVER=$(date +%s)
echo "cutover_seconds=$((END_CUTOVER - CUTOVER_START))"
```

> **Production cutover** uses the identical command against `kassa-api-prod` — but only after the CTO has signed off (§2 escalation contract) AND the operator has paused traffic by stopping the worker process group:
>
> ```sh
> flyctl scale count worker=0 --app kassa-api-prod   # drain queue first
> # ...verify queue depth is zero in BullMQ dashboard...
> flyctl secrets set --app kassa-api-prod DATABASE_URL="$RESTORED_DATABASE_URL"
> flyctl scale count worker=1 --app kassa-api-prod   # resume processing
> ```

### 3.5 Verify the restore

The restored branch's state should be: row absent at `T_RESTORE`, present at `T_AFTER`.

```sh
# Connect directly to the restored branch (do NOT go via the API — the goal
# is to prove the substrate state, independent of the application).
psql "$RESTORED_DATABASE_URL" -c "
  SELECT id, occurred_at FROM sales WHERE id = '$SALE_ID';
"
# EXPECTED: 0 rows. The sale was committed AFTER T_RESTORE, so the restored
# branch must not have it.

# Then forward-replay the sale via the staging API (same body as §3.2)
# against the restored DATABASE_URL (the API is already pointed at it after
# §3.4's cutover):
curl -fsS -X POST "https://kassa-api-staging.fly.dev/v1/sales" \
  -H "Authorization: Bearer $STAGING_DEVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"id\":\"$SALE_ID\",\"outletId\":\"...\",\"items\":[...],\"tender\":\"cash\"}"

# Re-query: should now find the row.
psql "$RESTORED_DATABASE_URL" -c "
  SELECT id, occurred_at FROM sales WHERE id = '$SALE_ID';
"
# EXPECTED: 1 row.

END_VERIFY=$(date +%s)
echo "total_drill_seconds=$((END_VERIFY - START))"
```

The forward-replay step proves the cutover took: the API is committing into the restored branch, not into a stale copy.

For non-drill (real-incident) restores, the equivalent verification is whichever query reproduces the original bug — confirm the bad data is gone, and confirm legitimate writes since the cutover are landing.

### 3.6 Selective restore (single table)

If only one table is bad, prefer restoring just that table rather than cutting the whole API over. The branch gives you a sibling Postgres; `COPY` is the bridge:

```sh
# Dump the rescued table from the PITR branch.
pg_dump --table=<schema>.<table> --data-only --no-owner \
  "$RESTORED_DATABASE_URL" > /tmp/rescued-table.sql

# Inspect the dump before applying — never blind-apply rescued data.
wc -l /tmp/rescued-table.sql

# In production, truncate-and-restore the bad table inside one transaction.
# Compose any FK considerations first; Drizzle migrations are forward-only
# so a TRUNCATE-CASCADE is the operator's call, not the migration system's.
psql "$DATABASE_URL_PROD" <<SQL
BEGIN;
TRUNCATE <schema>.<table> CASCADE;
\i /tmp/rescued-table.sql
COMMIT;
SQL
```

Selective restore stays inside the existing app/branch — no Fly cutover required.

### 3.7 Tear down the drill branch

Drill branches are billed per active hour like any Neon compute. Delete after the drill closes:

```sh
# Cut staging back to the parent branch using the URL captured at the top of
# §3.4. If you started this shell after the cutover (operator handoff), re-pull
# it from the same source §3.4 names (password manager / 1Password item
# "Kassa Neon staging DATABASE_URL").
flyctl secrets set --app kassa-api-staging DATABASE_URL="$ORIGINAL_STAGING_DATABASE_URL"

# Then delete the drill branch.
neonctl branches delete "$RESTORED_BRANCH_ID" --project-id "$NEON_PROJECT_ID"
```

In a real incident, do **not** delete the restored branch until the incident retro is closed — it is the audit trail.

---

## 4. Restoring from S3 dump (lifeboat path)

When the Neon project itself is gone, or PITR retention has aged out, the recovery surface is the nightly `pg_dump` in S3 — landed by [KASA-70](/KASA/issues/KASA-70), workflow [`backup-prod.yml`](../.github/workflows/backup-prod.yml), script [`scripts/db-backup.sh`](../scripts/db-backup.sh).

### 4.1 Locate the dump

```sh
# Highest-fidelity restore = most recent dump. Backups are kept 35 days
# (lifecycle rule on s3://kassa-backups/prod/*; see RUNBOOK-DEPLOY.md §2 step 3).
aws s3 ls s3://kassa-backups/prod/ --region ap-southeast-1 | tail -10
```

The objects are named `prod/<UTC-date>.sql.gz` (plain SQL, gzip-compressed — see the header of `scripts/db-backup.sh`).

### 4.2 Provision a fresh Neon target

If the original Neon project is intact but you want a clean substrate, create a new branch off the schema-empty root. If the project itself is gone, create a new project:

```sh
# Path A — same project, new branch (most common):
neonctl branches create --project-id "$NEON_PROJECT_ID" \
  --name "restore-$(date -u +%Y%m%dT%H%M%SZ)" --output json > /tmp/restore-branch.json

# Build the restored DATABASE_URL the same way §3.3 does — Neon shares the
# role across branches, so role/password/dbname come from the parent.
RESTORED_HOST=$(jq -r '.endpoints[0].host' /tmp/restore-branch.json)
RESTORED_DATABASE_URL="postgres://<role>:<password>@${RESTORED_HOST}/<db>?sslmode=require"

# Path B — new project (only if the old project is unrecoverable):
neonctl projects create --name kassa-restored --region-id aws-ap-southeast-1 \
  --output json > /tmp/restore-project.json

# A brand-new project has fresh role+password+db; `neonctl projects create`
# returns them inline under `connection_uris[].connection_uri` (the only
# field with the password — `endpoints[].host` is also present but lacks
# credentials). Prefer the canonical URI.
RESTORED_DATABASE_URL=$(jq -r '.connection_uris[0].connection_uri' /tmp/restore-project.json)
# Sanity check before piping a multi-GB dump into it.
test -n "$RESTORED_DATABASE_URL" && [ "$RESTORED_DATABASE_URL" != "null" ] \
  || { echo "refusing: connection_uris missing — re-check neonctl output"; exit 1; }
```

The dump is plain SQL, so the target needs the same Postgres major version the dump was taken on (Neon defaults track Postgres 16 in v0). Verify before piping:

```sh
psql "$RESTORED_DATABASE_URL" -c "SHOW server_version;"
```

### 4.3 Stream the restore

```sh
# Restore is `psql`, not `pg_restore` — the dump format is plain (--format=plain
# in scripts/db-backup.sh), and pg_restore rejects plain dumps. The streaming
# pipeline mirrors the backup pipeline so a 5 GB merchant DB never lands on
# the operator's disk.
aws s3 cp s3://kassa-backups/prod/<UTC-date>.sql.gz - --region ap-southeast-1 \
  | gunzip -c \
  | psql "$RESTORED_DATABASE_URL"
```

This applies schema + data in one shot. The dump is taken with the read-only `BACKUP_DATABASE_URL` role (per [RUNBOOK-DEPLOY.md §2 step 3](./RUNBOOK-DEPLOY.md#2-first-time-provisioning-checklist)), so it does not include role definitions; the restored target uses the role grants of the new branch / project, not the original.

### 4.4 Cut the API over

Same `flyctl secrets set DATABASE_URL=...` flow as §3.4. For production, drain the worker process group first (§3.4 production note).

### 4.5 Migrations gap

The S3 dump is captured at 02:00 UTC daily. Any Drizzle migration shipped *after* the dump but *before* the failure has already been applied to the original DB and is captured *in the dump's schema*. New migrations shipped *after* the dump are absent — re-deploy the API once cut over so `release_command` (`drizzle-orm` migrate) re-applies the pending migrations on the restored target.

---

## 5. Drill cadence

| When                                 | What                                                | Owner   | Output                                      |
|:-------------------------------------|:----------------------------------------------------|:--------|:--------------------------------------------|
| Initial (KASA-181, this runbook)     | Full §3.1–§3.7 against staging Neon project         | DevOps  | Capture table in §6 filled in               |
| Every quarter                        | Repeat §3 against staging                           | DevOps  | New row in §6; PR amends timing fields      |
| Before every milestone cut to prod   | §3.1 + §3.2 + §3.3 only (branch-create, no cutover) | DevOps  | Confirms PITR window covers the milestone   |
| After any change to Neon plan, region, or backup script | Full §3 + §4 dry-run                  | DevOps  | New row in §6; new row in §4 dry-run log    |
| After any production restore         | §6 row marked `incident:<incident-id>`              | On-call | Becomes part of the post-mortem             |

Drills go on the calendar at quarter starts. A skipped drill is a P2 ticket against DevOps; two consecutive skips auto-promote (per [RUNBOOK-INCIDENT.md §1](./RUNBOOK-INCIDENT.md#1-severity-ladder) demotion-noise rule applied to ops cadence).

---

## 6. Drill capture table

Each drill / restore appends one row. Fill the four timing fields from §3.3 / §3.4 / §3.5; fill `Notes` with the canary `SALE_ID` and the parent branch the drill was rooted on. Empty until the first drill run lands.

| Date (UTC) | Type        | Parent branch | T_RESTORE (UTC) | Branch-create (s) | Cutover (s) | Total drill (s) | Operator | Notes |
|:-----------|:------------|:--------------|:----------------|------------------:|------------:|----------------:|:---------|:------|
| _TBD — first drill run_ | drill | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ | DevOps | First execution scheduled — see [KASA-181](/KASA/issues/KASA-181) follow-up. |

**Why empty.** This runbook lands the *procedure* at PR-time; the live drill against the real staging Neon project is operator-executed because credentials (Neon admin, Fly deploy token, staging device-session token) are not in CI's hands. The follow-up child issue tracks the first run and the operator amends this row in the same change.

---

## 7. Escalation owners

| Surface                  | Primary               | Backup                | Notes                                                                                                            |
|:-------------------------|:----------------------|:----------------------|:-----------------------------------------------------------------------------------------------------------------|
| Neon project admin       | CEO                   | CTO                   | Account holder is the CEO; CTO + DevOps are admins on the `kassa` Neon project.                                   |
| Fly app secrets / deploy | DevOps                | CTO                   | `FLY_API_TOKEN` is in the GitHub `production` env; rotation lives in [`.github/workflows/rotate-staging-secret.yml`](../.github/workflows/rotate-staging-secret.yml). |
| AWS S3 backup bucket     | DevOps                | CTO                   | Bucket `kassa-backups` (`ap-southeast-1`); access via OIDC role `AWS_BACKUP_ROLE_ARN` in `production-prod` env.   |
| Decision: restore vs. fix-forward | CTO         | CEO (if CTO unreachable >15 min, P0 only) | See §2 escalation contract.                                                                       |
| Merchant comms during cutover | CEO              | CTO                   | Pilot is single-merchant; comms template in [RUNBOOK-INCIDENT.md §6](./RUNBOOK-INCIDENT.md#6-comms-templates).    |

---

## 8. Where this runbook is wrong

Update this file whenever any of the following changes:

- Neon plan tier or PITR retention window.
- The S3 backup bucket name, region, or prefix layout.
- The format of the dump (`pg_dump --format=plain` → anything else means §4.3 changes from `psql` to `pg_restore`).
- The escalation tree in §7 (e.g. when the post-pilot rotation lands).
- A real production restore reveals a step that was missing from §3 or §4.

The PR that changes the corresponding behaviour also updates this file. A stale DR runbook is the worst kind: operators trust it under pressure.

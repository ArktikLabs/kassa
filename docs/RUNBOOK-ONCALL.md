# Kassa Pilot On-Call Runbook

Status: v0 (KASA-71 — pilot-week observability). Owner: DevOps. Companion docs: [RUNBOOK-INCIDENT.md](./RUNBOOK-INCIDENT.md), [RUNBOOK-DEPLOY.md](./RUNBOOK-DEPLOY.md), [CI-CD.md](./CI-CD.md), [TECH-STACK.md](./TECH-STACK.md).

This runbook is what an on-call engineer reads at 02:00 when a page fires. It is the **tactical** layer — what to type, what to click, who to wake. The **policy** layer (canonical severity definitions, comms templates beyond the pilot WhatsApp note, post-mortem flow) lives in [RUNBOOK-INCIDENT.md](./RUNBOOK-INCIDENT.md); the production-deploy / promotion procedure lives in [RUNBOOK-DEPLOY.md](./RUNBOOK-DEPLOY.md). This file picks up at "an alert just fired, what do I do".

The pilot is one week, one merchant. Everything below is sized to that. Post-pilot, sections marked **(pilot only)** are revisited.

---

## 1. Severity definitions

| Sev  | Meaning                                                  | Examples                                                   | Page on-call? | Wake CTO/CEO?           | First response  |
|:-----|:---------------------------------------------------------|:-----------------------------------------------------------|:--------------|:------------------------|:----------------|
| P0   | Pilot merchant cannot transact. Revenue stops.            | API down, POS fails to load, EOD close fails, payments offline | Yes, immediately | CTO immediately; CEO if >15 min unresolved | <5 min     |
| P1   | Pilot can transact but with degraded UX or risk.          | Sentry error rate ≥1% on `/v1/sales/submit` or `/v1/eod/close`, frontend `TypeError` spike, sync queue backing up | Yes, immediately | CTO if >30 min unresolved | <15 min |
| P2   | Operational concern, no merchant-visible impact.          | Backup job missed, source-map upload failed, single Better Stack flap | No (ticket only) | No                      | Next business day |
| P3   | FYI / informational.                                     | Deploy succeeded, weekly metric report                     | No            | No                      | Best effort     |

**P0 contract.** A P0 page must reach a human on-call within 2 minutes of the underlying signal. The §3 dry-run verifies that contract on every revision of this runbook.

---

## 2. On-call rotation (pilot week)

**(pilot only)** During pilot week the rotation is one engineer, full week, with the CTO as the named secondary. Post-pilot we move to a 24-hour shared rotation across the engineering pod.

| Slot         | Primary             | Secondary | Hours (WIB)         |
|:-------------|:--------------------|:----------|:--------------------|
| Pilot week   | Engineer (Khaer)    | CTO       | 24×7 for 7 days     |

**Handoff.** None for the pilot — single primary. If the primary becomes unavailable for >2 h, the secondary picks up and the CEO is notified by email.

CEO confirmed the Engineer-primary / CTO-secondary assignment on 2026-04-28 in the KASA-71 thread. Post-pilot rotation is out of scope for this runbook revision.

**On-call kit (primary keeps to hand):**

- A laptop with `flyctl`, `gh`, `psql`, and `node` ≥22 installed.
- GitHub access to `ArktikLabs/kassa` with permission to trigger the `Deploy Prod (API)` workflow and to approve the `production-prod` environment (or the CTO does the approval — primary does not need to be a required reviewer).
- Sentry login on the `kassa` org with the `kassa-api`, `kassa-pos`, `kassa-back-office` projects visible.
- Better Stack login on the `kassa` workspace with read access to monitors and incidents.
- This runbook bookmarked.

---

## 3. Alert routing

### 3.1 Channel

**(pilot only)** Two destinations, one policy. CEO confirmed on 2026-04-28:

| Step | Destination                                | Wait before     | Purpose                                       |
|:-----|:-------------------------------------------|:----------------|:----------------------------------------------|
| 1    | Slack channel `#kassa-pilot-oncall`        | 0 (immediate)   | Primary signal — visible to the whole pilot pod |
| 2    | Email alias `oncall@kassa.id`              | 15 min          | Escalation if Step 1 is unacknowledged (off-hours, missed Slack) |

The `kassa-pilot-oncall` Better Stack on-call policy in [`infra/observability/better-stack-monitors.json`](../infra/observability/better-stack-monitors.json) encodes these two steps; the Sentry alert rules route to the same destinations via Sentry's Slack + email integrations.

Provisioning checklist (one-time, by ops, before pilot day):

- Better Stack → Integrations → Slack → install on the Kassa workspace; add `#kassa-pilot-oncall` as an integration target.
- Better Stack → Account → Email aliases → add `oncall@kassa.id`.
- Sentry → Settings → Integrations → Slack → install; in each project (`kassa-api`, `kassa-pos`, `kassa-back-office`) add `#kassa-pilot-oncall` as an alert action.
- Sentry → per project → add `oncall@kassa.id` as an alert email destination.
- Run the §3.4 dry-run end-to-end before the first pilot day.

If Slack itself is the outage (rare, but Slack has gone down during pilot windows before), the email alias is the failover and §7 escalation table picks up at the 15 min mark.

### 3.2 Better Stack uptime monitors

Defined as code in [`infra/observability/better-stack-monitors.json`](../infra/observability/better-stack-monitors.json). Apply with [`scripts/observability-apply.sh`](../scripts/observability-apply.sh) (see [`infra/observability/README.md`](../infra/observability/README.md)).

| Monitor                  | URL                                                     | Cadence | Probes (regions)            | Alert after     |
|:-------------------------|:--------------------------------------------------------|:--------|:----------------------------|:----------------|
| `api-prod-health`        | `https://kassa-api-prod.fly.dev/health`                 | 60 s    | Singapore + Jakarta         | 2 consecutive failures |
| `pos-prod-shell`         | `https://app.kassa.id/` (fallback `kassa-pos.pages.dev`) | 60 s    | Singapore + Jakarta         | 2 consecutive failures |
| `back-office-prod-shell` | `https://kassa-back-office.pages.dev/`                  | 60 s    | Singapore                   | 2 consecutive failures |
| `synthetic-sale-heartbeat` | Better Stack heartbeat URL pinged by the synthetic-sale workflow (§4) | every 15 min ±5 min grace | n/a (heartbeat) | 1 missed window |

The `2 consecutive failures` rule is deliberate — single-failure flaps from Cloudflare edge or Fly router blips would page on-call too often. Two failures × 60 s cadence = up to ~2 minutes from outage to page, which fits the P0 contract.

### 3.3 Sentry alert rules

Defined as code in [`infra/observability/sentry-alert-rules.json`](../infra/observability/sentry-alert-rules.json). Apply with [`scripts/observability-apply.sh`](../scripts/observability-apply.sh).

| Rule                                | Project        | Trigger                                                              | Severity |
|:------------------------------------|:---------------|:---------------------------------------------------------------------|:---------|
| `api-sales-submit-error-rate`       | `kassa-api`    | Error rate on `/v1/sales/submit` >1% over 5 min (min 50 events)      | P0       |
| `api-eod-close-error-rate`          | `kassa-api`    | Error rate on `/v1/eod/close` >1% over 5 min (min 10 events)         | P0       |
| `api-unhandled-exception-spike`     | `kassa-api`    | New issue with ≥5 events in 5 min, environment=production            | P1       |
| `pos-frontend-typeerror-spike`      | `kassa-pos`    | Issues with `TypeError` substring, ≥10 events in 5 min, env=production | P1     |
| `back-office-frontend-typeerror-spike` | `kassa-back-office` | Same shape as POS, ≥5 events in 5 min                            | P2       |

The min-events floor on P0 rules avoids paging on the first error after a quiet hour (a legitimate one-off 5xx during a low-traffic window would otherwise compute a 100% error rate). 50 events on `/v1/sales/submit` is roughly 5 minutes of pilot-merchant traffic; tune after one week of real volume.

### 3.4 Dry-run (run before any pilot day)

Per the KASA-71 acceptance criterion, prove the channel works before each pilot day:

1. **Better Stack** — open the `api-prod-health` monitor, click `Test alert`. Observe the page hits the on-call channel within 2 min. Capture the screenshot in the pilot-day prep doc.
2. **Sentry** — `npx @sentry/cli send-event --release kassa-api@dryrun-$(date +%s) --message "dryrun-page" --level error -p kassa-api` against an issue rule wired to a 1-event threshold for the dry-run alert; observe the page hits the channel within 2 min.
3. Re-fire the synthetic-sale workflow (§4) on `workflow_dispatch` and confirm Better Stack records the heartbeat.

If the dry-run fails, the pilot day does not start until the routing is fixed. There is no "we'll watch it manually" fallback during a pilot.

---

## 4. Synthetic test sale

A scheduled GitHub Actions workflow [`/.github/workflows/synthetic-sale.yml`](../.github/workflows/synthetic-sale.yml) rings up a test sale against production every 15 min and pings a Better Stack heartbeat URL on success. Failures fall through to the heartbeat-missed alert (§3.2).

**Status:** workflow scaffold lands with KASA-71. The required backend support (a `synthetic: true` tender method that auto-reconciles at EOD) is tracked under a child Engineer issue and gated by the `SYNTHETIC_PROBE_ENABLED=true` repository variable. Until the variable flips, the workflow no-ops with a `::notice::` and the heartbeat is paused on the Better Stack side.

GitHub Actions cron is best-effort — schedules can drift several minutes under platform load. The Better Stack heartbeat grace window is set to 5 min on top of the 15 min cadence (so a 20 min gap pages, but a routine 17 min gap does not).

---

## 5. Rollback matrix

This is the "what to do" table once you've decided to rollback. The full procedure for each row lives in [RUNBOOK-DEPLOY.md §4](./RUNBOOK-DEPLOY.md#4-rollback) — do not duplicate it here.

| Symptom                                                                | Surface              | Rollback path                                                  | Where                                          | Time-to-recover (typical) |
|:-----------------------------------------------------------------------|:---------------------|:---------------------------------------------------------------|:-----------------------------------------------|:--------------------------|
| Sentry error rate on `/v1/sales/submit` ≥3× baseline within 10 min of API deploy | API                  | `flyctl deploy --image` to the prior `prod-<sha12>`            | [RUNBOOK-DEPLOY.md §4.2](./RUNBOOK-DEPLOY.md#42-api-rollback--flyctl-releases-preferred) | 3–5 min                   |
| Better Stack `api-prod-health` red for 2 checks                        | API                  | Same as above. If `flyctl logs` shows DB error, also check Neon status. | [RUNBOOK-DEPLOY.md §4.2](./RUNBOOK-DEPLOY.md#42-api-rollback--flyctl-releases-preferred) | 3–5 min                   |
| `pos-prod-shell` red OR POS reports white-screen / chunk-load errors   | POS PWA              | Cloudflare Pages → `kassa-pos` → previous deployment → Rollback | [RUNBOOK-DEPLOY.md §4.3](./RUNBOOK-DEPLOY.md#43-static-surface-rollback--cloudflare-dashboard) | 1–2 min                   |
| `back-office-prod-shell` red                                           | Back Office          | Cloudflare Pages → `kassa-back-office` → previous deployment → Rollback | [RUNBOOK-DEPLOY.md §4.3](./RUNBOOK-DEPLOY.md#43-static-surface-rollback--cloudflare-dashboard) | 1–2 min                   |
| Drizzle migration applied that needs reversing                         | API DB               | Compensating forward migration; PR + `Deploy Prod (API)`        | [RUNBOOK-DEPLOY.md §4.4](./RUNBOOK-DEPLOY.md#44-rolling-back-a-drizzle-migration) | 15–30 min (PR turnaround) |
| Production data corrupted (rare; requires CTO call)                    | API DB               | Neon PITR restore onto a new branch, swap `DATABASE_URL`        | [RUNBOOK-DEPLOY.md §4.4](./RUNBOOK-DEPLOY.md#44-rolling-back-a-drizzle-migration) | 30–60 min                 |
| Midtrans webhook spam or unexpected charges                            | Payments             | Disable Midtrans webhook in Midtrans dashboard; pause API consumer; call CTO | n/a (manual)                            | 5–10 min                  |
| Sync queue backing up (BullMQ depth growing)                           | API queue            | Inspect `flyctl logs --app kassa-api-prod`; if backed up due to deploy bug, rollback API per row 1 | [RUNBOOK-DEPLOY.md §4.2](./RUNBOOK-DEPLOY.md#42-api-rollback--flyctl-releases-preferred) | 3–5 min                   |

**Rollback first, RCA after.** Restore service in <10 minutes; root-cause investigation begins after the green Better Stack board is restored. File a follow-up issue under the milestone the bad commit belonged to before going back to bed.

---

## 6. Pilot-merchant contact card

**(pilot only)** During the pilot week we proactively notify the merchant when we trigger a rollback that changes their experience (data unavailability, app reload required). Do **not** notify on routine deploys or rollbacks that are merchant-invisible.

CEO is filling in the values below in a follow-up commit before the first pilot day (confirmed 2026-04-28 — the data is in the CEO's merchant-relationship system and is not safe to copy via interaction payloads). On-call must verify this card is fully populated as part of the §3.4 dry-run on pilot day; if any row still reads `_pending CEO commit_`, treat it as a launch blocker.

| Field                  | Value                                                |
|:-----------------------|:-----------------------------------------------------|
| Merchant name          | _pending CEO commit_                                 |
| Primary contact (name) | _pending CEO commit_                                 |
| WhatsApp               | _pending CEO commit_                                 |
| Email                  | _pending CEO commit_                                 |
| Best contact window (WIB) | _pending CEO commit_                              |
| Outlets in pilot       | _pending CEO commit_ (count + names)                 |
| Backup contact         | _pending CEO commit_                                 |

**Notification template (WhatsApp / email):**

> Halo <name>, ini tim Kassa. Kami baru saja memulihkan layanan setelah issue singkat di [POS / pembayaran / EOD] pukul <HH:MM WIB>. Mohon **logout dan login ulang** di aplikasi POS sebelum transaksi berikutnya. Tidak ada data hilang dan EOD malam ini akan tetap berjalan normal. Terima kasih atas kesabarannya. — <oncall name>

Do not copy the merchant name, contact numbers, or email outside this file — the repo is private and that is the contract. Public artifacts (issue threads, PR descriptions, public dashboards) reference "the pilot merchant" only.

---

## 7. Escalation table

| When                                                | Wake                              | How                                                  |
|:----------------------------------------------------|:----------------------------------|:-----------------------------------------------------|
| P0 — pilot cannot transact                          | CTO immediately, CEO at 15 min    | WhatsApp first, then phone if no ack within 5 min    |
| P1 — degraded but transacting                       | CTO at 30 min if unresolved       | WhatsApp                                             |
| Suspected data loss or financial impact (any sev)   | CTO and CEO immediately           | Phone call (not message); start an incident doc      |
| Security incident (suspected breach, leaked secret) | CTO and CEO immediately, no exceptions | Phone call; rotate any exposed secret before continuing |
| Suspected Midtrans / Bank issue (not Kassa-side)    | CTO at start; CEO if customer-impacting | WhatsApp; pull the Midtrans dashboard transaction log |

CTO/CEO contact details live in `~/.kassa/oncall.local` (gitignored), not in this file. The on-call kit setup populates that file during onboarding.

---

## 8. After the page is resolved

Within 24 hours of any P0 or P1:

1. File a follow-up issue with label `incident` summarising: trigger, detection time, recovery time, customer impact, root cause (or RCA-pending), and the PR that fixed it (or "rollback only").
2. If the alert was a false positive, tune the threshold (PR to `infra/observability/`) before the next pilot day. Do not silence — tune.
3. If a section of this runbook was wrong, missing, or slow to find, PR the fix in the same change as the post-mortem. **A stale runbook is worse than none.**

---

## 9. What this runbook deliberately omits

- **Multi-region failover.** Pilot is single-region (Singapore). Failover is a v1 concern.
- **Customer-self-service status page.** The merchant has a direct WhatsApp line to on-call during pilot. A public status page lands post-pilot.
- **PagerDuty / Opsgenie integration.** Pilot uses Better Stack's built-in on-call paging plus a single named channel. Multi-rotation paging tooling is a v1 concern.
- **Long-form post-mortem template.** Pilot-week incidents are short. The bullet list in §8 is the post-mortem; a full template lands when we move to multi-merchant.

If you find yourself wanting any of these during pilot week, file the gap as a v1 issue rather than expanding scope mid-pilot.

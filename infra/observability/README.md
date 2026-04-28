# Observability config

Owner: DevOps. Source issue: [KASA-71](../../docs/RUNBOOK-ONCALL.md). Companion docs: [`docs/RUNBOOK-ONCALL.md`](../../docs/RUNBOOK-ONCALL.md), [`docs/RUNBOOK-DEPLOY.md`](../../docs/RUNBOOK-DEPLOY.md).

This folder is the source-of-truth for Better Stack monitors and Sentry alert rules. Apply with `scripts/observability-apply.sh` — never click-edit in the SaaS dashboards (the next apply will revert your change and silently delete custom routing).

---

## Files

| File                          | Purpose                                                      |
|:------------------------------|:-------------------------------------------------------------|
| `better-stack-monitors.json`  | Uptime monitors + heartbeats + on-call notification policy. Schema mirrors the Better Stack v2 API. Keys with `_` prefix are local annotations only — the apply script strips them before POSTing. |
| `sentry-alert-rules.json`     | Issue + metric alert rules across the three Sentry projects. Keys with `_` prefix are local annotations. |

Names (`pronounceable_name`, `name`) are idempotency keys. The apply script reconciles by name within scope; **renaming** a record creates a duplicate. Delete the old record in the dashboard before renaming.

---

## Apply

```sh
# Dry-run (default): prints the diff against current SaaS state, makes no changes.
scripts/observability-apply.sh

# Real apply (idempotent — safe to re-run):
scripts/observability-apply.sh --apply
```

Required environment variables (kept out of the repo; provided by the operator's local `~/.kassa/observability.env` or by the GitHub Actions environment):

| Variable                          | Source                                                              |
|:----------------------------------|:--------------------------------------------------------------------|
| `BETTER_STACK_API_TOKEN`          | Better Stack → Account → API Tokens. Scope: `Manage monitors + heartbeats`. |
| `SENTRY_AUTH_TOKEN`               | Sentry → Settings → Internal Integrations. Scope: `Alerts: Admin`. |
| `SENTRY_ORG`                      | Repo variable (also used by `cd.yml`). Default `kassa`.             |
| `SENTRY_PROJECT_API`              | Repo variable. Default `kassa-api`.                                 |
| `SENTRY_PROJECT_POS`              | Repo variable. Default `kassa-pos`.                                 |
| `SENTRY_PROJECT_BACK_OFFICE`      | Repo variable. Default `kassa-back-office`.                         |
| `SENTRY_SLACK_INTEGRATION_ID`     | Sentry → Settings → Integrations → Slack → integration ID. Required for the metric-alert Slack action target. No default — unset substitutes a sentinel that fails apply with a 400 rather than mis-routing. |
| `SENTRY_ONCALL_TEAM_ID`           | Sentry → Settings → Teams → Kassa team that owns `oncall@kassa.id` → numeric team ID. Required for the metric-alert email action target. No default — same sentinel-on-unset behavior. |

The apply script behavior on a missing token is asymmetric:

- `BETTER_STACK_API_TOKEN` unset → Better Stack provider no-ops with a `::notice::` (no GET, no POST).
- `SENTRY_AUTH_TOKEN` unset → Sentry provider prints the resolved payload bodies it would POST and skips network calls. This lets on-call sanity-check the metric-alert envelope shape before provisioning the token (KASA-153).

---

## Adding or changing a monitor / rule

1. Edit the JSON in this folder.
2. Run the dry-run locally; review the diff.
3. Open a PR. CI runs the dry-run as a check (no apply).
4. After merge, run `scripts/observability-apply.sh --apply` from a workstation (or via the `Apply Observability` workflow once it lands; tracked under KASA-71 follow-ups).
5. If the change affected severity routing, rerun the dry-run dry-fire from [`docs/RUNBOOK-ONCALL.md` §3.4](../../docs/RUNBOOK-ONCALL.md#34-dry-run-run-before-any-pilot-day).

---

## Why config-as-code, not click-ops

A dashboard click is invisible to the next on-call engineer. A JSON diff in `git log` is not. The whole pilot-week premise rests on "if it broke, what changed in the last hour" — alert rules silently changing in the dashboard makes that question unanswerable. Pay the small upfront cost of the apply script to keep the audit trail intact.

If a dashboard hand-edit is the only practical fix in an incident (rare; usually a temporary mute), open a follow-up PR within 24 h that ports the change into JSON and re-applies. Drift is a P2.

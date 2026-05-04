# Kassa Incident Response

Status: v0 (KASA-200). Owner: CTO. Companion docs: [RUNBOOK-ONCALL.md](./RUNBOOK-ONCALL.md), [RUNBOOK-DEPLOY.md](./RUNBOOK-DEPLOY.md), [CI-CD.md](./CI-CD.md), [TECH-STACK.md](./TECH-STACK.md).

This doc defines **incident response policy** at Kassa: what counts as an incident, how we classify it, who is paged, how we communicate during it, and how we close it out. It is the source of truth for the severity ladder, the comms template library, and the post-mortem flow.

This doc is the **process** layer. The two operational layers it sits on top of are:

- [RUNBOOK-ONCALL.md](./RUNBOOK-ONCALL.md) — the tactical "an alert fired, what do I type" playbook on-call reads at 02:00. Pilot-week-specific.
- [RUNBOOK-DEPLOY.md §4](./RUNBOOK-DEPLOY.md#4-rollback) — the rollback commands themselves.

If the two operational runbooks disagree with this doc on a definition (severity, escalation timer, comms cadence), this doc wins and the runbooks must PR a fix in the same change.

---

## 1. Severity ladder

The ladder is **scope-of-impact-based**, not effort-based. A 2-line code fix that restores a P0 is still a P0 retrospectively.

| Sev  | Definition                                                      | Examples                                                                                       | Page on-call?       | Wake CTO          | Wake CEO              |
|:-----|:----------------------------------------------------------------|:-----------------------------------------------------------------------------------------------|:--------------------|:------------------|:----------------------|
| P0   | POS down for **any** merchant during business hours, or **any** suspected data loss / financial impact, or any suspected security incident. Revenue stops or merchant cannot trust the system. | API down, POS fails to load, EOD close fails, payments offline, secret leaked, double-charge | Yes, immediately    | Immediately       | At 15 min unresolved (immediately if data-loss, financial, or security) |
| P1   | Sync degraded **>15 min**, elevated error rate (Sentry ≥1% on a critical endpoint), or partial functionality loss that the merchant can work around. Pilot merchant can still transact but with risk or degraded UX. | `/v1/sales/submit` error rate ≥1%, sync queue backing up, frontend `TypeError` spike | Yes, immediately    | At 30 min unresolved | No                    |
| P2   | Single-merchant cosmetic issue or operational concern with no merchant-visible impact. Not blocking transactions. | One outlet's printer stopped, backup job missed, source-map upload failed, single Better Stack flap | No (ticket only)    | No                | No                    |
| P3   | Telemetry-only / FYI. The system noticed something; no human action required this shift. | Deploy succeeded, weekly metric report, expected log volume                                    | No                  | No                | No                    |

**Promotion rules.** A P1 that has been unresolved for 60 minutes auto-promotes to P0 (the merchant has now lost a meaningful transaction window). A P2 that recurs ≥3× in a week auto-promotes to P1 — the noise is the signal.

**Demotion rules.** Sev only goes down after the page is acknowledged AND the on-call has confirmed scope. Don't demote in the heat — the post-mortem can reclassify.

**Pilot-week deviation.** The pilot is single-merchant by definition, so the "any merchant" P0 rule and the "single-merchant" P2 rule collapse. During pilot, ONCALL §1 narrows P0 to "the pilot merchant cannot transact" and treats every cosmetic issue as P1+ because we have one shop and no blast-radius dilution. After pilot ends this section is the ladder.

---

## 2. Detection paths

We do not rely on humans to notice outages. Three independent paths feed the on-call channel:

| Path                          | What it catches                                                  | Latency to page          | Configured in                                                 |
|:------------------------------|:-----------------------------------------------------------------|:-------------------------|:--------------------------------------------------------------|
| Sentry alert rules            | Error-rate spikes on critical endpoints, frontend `TypeError` spikes, new high-frequency issues | ≤5 min from first event   | [`infra/observability/sentry-alert-rules.json`](../infra/observability/sentry-alert-rules.json) — table in [RUNBOOK-ONCALL.md §3.3](./RUNBOOK-ONCALL.md#33-sentry-alert-rules) |
| Better Stack synthetic checks | API `/health` and POS / Back Office shell unreachable; missed synthetic-sale heartbeat | ≤2 min for `/health`, ≤20 min for synthetic-sale | [`infra/observability/better-stack-monitors.json`](../infra/observability/better-stack-monitors.json) — table in [RUNBOOK-ONCALL.md §3.2](./RUNBOOK-ONCALL.md#32-better-stack-uptime-monitors) |
| Merchant report               | Anything the synthetic checks miss — printer issues, cash-drawer drift, "the receipt looks weird" | Variable; aim ≤5 min from merchant message | Pilot week: WhatsApp line to on-call. Post-pilot: support inbox routed to on-call. |

A merchant report is **never** lower than P2 on first triage. Promote up if a synthetic check confirms.

The dry-run procedure that proves all three paths work end-to-end before pilot day lives at [RUNBOOK-ONCALL.md §3.4](./RUNBOOK-ONCALL.md#34-dry-run-run-before-any-pilot-day). Run it after any change to alert rules, monitors, or the on-call channel.

---

## 3. Paging path

The destinations and escalation timers below are the **policy**. The Better Stack on-call configuration that implements them lives at [RUNBOOK-ONCALL.md §3.1](./RUNBOOK-ONCALL.md#31-channel) and the per-incident escalation table at [§7](./RUNBOOK-ONCALL.md#7-escalation-table).

| Sev | Hop 1 (immediate)                | Hop 2 (after wait) | Wait before hop 2 | Quiet-hours policy                              |
|:----|:---------------------------------|:-------------------|:------------------|:------------------------------------------------|
| P0  | Slack `#kassa-pilot-oncall` + page primary on-call | Email `oncall@kassa.id` + WhatsApp CTO | 5 min unack       | None — P0 ignores quiet hours                   |
| P1  | Slack `#kassa-pilot-oncall` + page primary on-call | Email `oncall@kassa.id`              | 15 min unack      | Honour 22:00–06:00 WIB unless cumulative duration >2 h |
| P2  | Ticket only (label `incident:p2`) | n/a                | n/a               | Always honour quiet hours                       |
| P3  | Log only                          | n/a                | n/a               | n/a                                             |

**Quiet-hours policy.** During pilot week (single primary, no shared rotation), the primary opts in to 24×7 paging by accepting the on-call slot. P1s during 22:00–06:00 WIB hold for the 06:00 wake unless they cross the cumulative-duration threshold (2 h sustained = wake). P0s always wake. Post-pilot, the shared rotation publishes its own quiet-hours policy in this table.

**On the absence of paging tooling.** v0 does not run PagerDuty/Opsgenie. Better Stack's built-in on-call paging plus a single named Slack channel is the entire surface. Adding a paging tier is deferred until pilot scale forces it ([KASA-200 out-of-scope](#)). The decision is reversible — switching to PagerDuty later is a configuration change in `infra/observability/`, not a code change.

---

## 4. On-call rotation

The pilot-week rotation lives at [RUNBOOK-ONCALL.md §2](./RUNBOOK-ONCALL.md#2-on-call-rotation-pilot-week) and is one engineer + CTO secondary, full week. Below is the **post-pilot** rotation table the CEO populates before each week begins. Empty until the first non-pilot week is scheduled.

| Week of (Mon, WIB) | Primary | Secondary | Handoff time (WIB) | Notes |
|:-------------------|:--------|:----------|:-------------------|:------|
| _TBD — CEO populates before week begins_ | _TBD_ | _TBD_ | Mon 10:00 | First post-pilot rotation |

**Rotation rules.**

- One primary, one secondary, full week. No mid-week swaps without CEO sign-off — pager fatigue is real and rotation predictability is what makes it tolerable.
- A primary may not be the on-call **and** the deploy operator on the same week — those roles can collide during a rollback. If we are short-staffed, the secondary covers deploys.
- Carry-over: any P0 or P1 that opens within 2 h of a handoff stays with the previous shift's primary until resolved. Avoids the "I just got paged on my way to bed" handoff problem.
- Vacation conflicts: surface 2 weeks ahead in the engineering standup; CEO swaps the table.

---

## 5. Rollback procedures

**Decision: rollback first, root-cause after.** If a deploy correlates with a P0 or P1 within 10 min of landing, roll back immediately. Do not wait for a fix PR.

The full step-by-step procedure for each surface lives in [RUNBOOK-DEPLOY.md §4](./RUNBOOK-DEPLOY.md#4-rollback). The symptom → procedure mapping lives in [RUNBOOK-ONCALL.md §5](./RUNBOOK-ONCALL.md#5-rollback-matrix). Below is the policy view: which tier to touch and the source-of-truth command line.

| Tier         | Authoritative command                                                                                                  | Procedure                                                  | Typical time-to-recover |
|:-------------|:-----------------------------------------------------------------------------------------------------------------------|:-----------------------------------------------------------|:------------------------|
| API          | `flyctl deploy --app kassa-api-prod --config apps/api/fly.prod.toml --image registry.fly.io/kassa-api-prod:prod-<prev-sha12> --strategy immediate` | [RUNBOOK-DEPLOY.md §4.2](./RUNBOOK-DEPLOY.md#42-api-rollback--flyctl-releases-preferred) | 3–5 min                 |
| POS PWA      | Cloudflare Pages dashboard → `kassa-pos` → previous deployment → **Rollback to this deployment**. (`wrangler pages deployment activate <id>` is the CLI equivalent if the dashboard is unreachable — verify the deployment id with `wrangler pages deployment list --project-name kassa-pos` first.) | [RUNBOOK-DEPLOY.md §4.3](./RUNBOOK-DEPLOY.md#43-static-surface-rollback--cloudflare-dashboard) | 1–2 min                 |
| Back Office  | Same as POS PWA, project `kassa-back-office`.                                                                          | [RUNBOOK-DEPLOY.md §4.3](./RUNBOOK-DEPLOY.md#43-static-surface-rollback--cloudflare-dashboard) | 1–2 min                 |
| API DB (Drizzle migration) | Compensating forward migration via revert PR; **never** hand-edit the DB. Drizzle is forward-only.        | [RUNBOOK-DEPLOY.md §4.4](./RUNBOOK-DEPLOY.md#44-rolling-back-a-drizzle-migration) | 15–30 min (PR turnaround) |
| API DB (data corruption — emergency) | Neon point-in-time recovery: Neon console → Branch → Restore to timestamp → cut `DATABASE_URL` over via `flyctl secrets set`. **Wake CTO before doing this.** | KASA-181 will land `docs/RUNBOOK-DR.md` with the drilled procedure; until then follow [RUNBOOK-DEPLOY.md §4.4](./RUNBOOK-DEPLOY.md#44-rolling-back-a-drizzle-migration) and call CTO. | 30–60 min               |

**Rollback gates the post-mortem, not the other way around.** Restore service inside 10 min, then start writing the post-mortem (§7). A rollback without a written root cause is how the same regression ships twice.

---

## 6. Comms templates

These are **internal** templates — for the on-call channel, the engineering pod, and the CEO. The pilot-merchant-facing WhatsApp/email template lives at [RUNBOOK-ONCALL.md §6](./RUNBOOK-ONCALL.md#6-pilot-merchant-contact-card) because it is pilot-specific (one named merchant, contact card not in this repo).

### 6.1 Initial post (within 5 min of confirming the incident)

Post in `#kassa-pilot-oncall`. Reuse the same thread for all updates — do not start a new thread per update.

```text
:rotating_light: INCIDENT — Sev <P0|P1|P2> — <one-line title>
Status: investigating
Scope: <what is affected — endpoints / surfaces / merchants>
Detected: <HH:MM WIB> via <Sentry rule | Better Stack monitor | merchant report>
On-call: @<primary>
Next update: <HH:MM WIB> (in 30 min)
Incident issue: <KASA-XXX or "filing now">
```

### 6.2 Follow-up cadence

| Severity | Update cadence during incident                      | Format                                    |
|:---------|:----------------------------------------------------|:------------------------------------------|
| P0       | Every 30 min until resolved, **even if no new info** | Threaded reply to the initial post        |
| P1       | Every 30 min until resolved                          | Threaded reply                            |
| P2       | At resolution only                                   | Single resolution message                 |

A "no new info" update is still an update. Silence reads as "the on-call has lost the plot" to anyone watching, and the CEO/CTO are watching during a P0.

```text
:hourglass_flowing_sand: UPDATE — <HH:MM WIB>
Status: <investigating | mitigating | monitoring | resolved>
What we know: <one or two sentences>
What we're trying: <current action>
ETA to next update: <HH:MM WIB>
```

### 6.3 All-clear

```text
:white_check_mark: RESOLVED — <HH:MM WIB>
Total duration: <HH:MM>
Resolution: <rollback to <sha> | hotfix #<PR> | external dependency recovered | …>
Customer impact: <none | <N> merchants affected for <duration> | data loss: <scope>>
Post-mortem: <link to docs/post-mortems/YYYY-MM-DD-slug.md, due in 5 business days for P0/P1>
```

### 6.4 CEO email (P0 only, or any data-loss / financial / security incident)

Send within 30 min of confirming. Plaintext, no HTML.

```text
Subject: [Kassa P0] <one-line title> — <status>

Halo <CEO name>,

We are responding to a P0 incident.

What: <one-paragraph plain-language description>
When detected: <HH:MM WIB> via <source>
Current status: <investigating | mitigating | resolved at HH:MM WIB>
Customer impact: <one paragraph — what merchants experienced>
Action you should take: <none | "approve deploy-prod redeploy of <sha>" | "be reachable for 30 min" | …>
Next update: <HH:MM WIB>

— <on-call name>
Incident issue: KASA-XXX
```

### 6.5 Public / merchant comms

- **Pilot week:** use the WhatsApp/email template at [RUNBOOK-ONCALL.md §6](./RUNBOOK-ONCALL.md#6-pilot-merchant-contact-card). Notify only when the rollback is merchant-visible (data unavailability, app reload required). Do not notify on routine deploys.
- **Post-pilot:** a public status page (Better Stack hosted) lands with the multi-merchant rollout. Until then, named merchant contact lists are out of scope.

---

## 7. Post-mortem flow

A post-mortem is **mandatory** for:

- Any P0.
- Any P1 that exceeded 30 min from page to all-clear.
- Any data-loss, financial, or security event regardless of sev.
- Any P2 that recurs ≥3× in a week.

Optional but encouraged: any incident where a near-miss happened (the on-call almost made the wrong rollback, or the alert almost didn't fire).

**Owner:** the on-call who handled the page. **Reviewer:** CTO. **Due:** 5 business days from all-clear. **Filed at:** `docs/post-mortems/YYYY-MM-DD-<slug>.md`, copying [`docs/post-mortems/TEMPLATE.md`](./post-mortems/TEMPLATE.md).

The template enforces the four parts that matter:

1. **Timeline** — UTC and WIB columns. Anchor every entry to a wall-clock minute, not "around then". Sources: Slack messages, Sentry events, Better Stack incident records, deploy run URLs.
2. **5-whys** — until you reach a root cause that is a system or process gap, not a person. "An engineer pushed the wrong button" is not a root cause; "the button is dangerously close to the right one and there is no confirmation step" is.
3. **What went well / what didn't** — both halves, every time. The "what went well" half is what we keep; deleting it makes post-mortems feel punitive and they stop happening.
4. **Action items** — every action item has an **owner** (single named agent), a **due date** (absolute, not "next sprint"), and a **link** (issue in Paperclip, PR, or doc PR). Action items without all three do not count.

**Action item tracking.** Each action item is filed as a Paperclip issue with the `incident-action` label and linked from the post-mortem. The CTO reviews open `incident-action` issues weekly; any issue past its due date is escalated to CEO.

**Blameless contract.** Post-mortems are blameless by policy. Names appear only as owners of action items going forward — never as "X caused this". If an investigation surfaces a real personnel concern (repeated negligence, deliberate sabotage), it is handled out-of-band by the CEO and does not appear in the post-mortem.

---

## 8. Post-mortem index

New post-mortems are filed under [`docs/post-mortems/`](./post-mortems/) and listed below in reverse-chronological order. Add a row in the same PR that lands the post-mortem.

| Date       | Severity | Title                                                  | File                                                   | Action items |
|:-----------|:---------|:-------------------------------------------------------|:-------------------------------------------------------|:-------------|
| _none yet_ | _n/a_    | _Pilot has not started; post-mortems begin from KASA-149_ | _n/a_                                                  | _n/a_        |

---

## 9. Where this runbook is wrong

Update this file whenever any of the following changes:

- Severity definitions (§1) — and PR a matching change to [RUNBOOK-ONCALL.md §1](./RUNBOOK-ONCALL.md#1-severity-definitions) so the operator table agrees.
- Paging destinations (§3) — and PR the matching change to [RUNBOOK-ONCALL.md §3.1](./RUNBOOK-ONCALL.md#31-channel) and `infra/observability/` configs.
- Comms cadence (§6) — and brief the on-call rotation in standup before the change takes effect.
- Post-mortem flow (§7) — and PR a matching change to [`docs/post-mortems/TEMPLATE.md`](./post-mortems/TEMPLATE.md).
- A real incident exposes that this doc was wrong, missing, or slow to find — fix it in the same PR as the post-mortem. **A stale runbook is worse than none.**

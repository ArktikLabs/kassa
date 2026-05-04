# Post-mortem: <one-line title>

**Date:** YYYY-MM-DD
**Severity:** P0 | P1 | P2
**Duration:** HH:MM (page → all-clear)
**Customer impact:** _one paragraph — what merchants experienced, how many, for how long._
**Author:** <on-call name>
**Reviewer:** CTO
**Filed:** YYYY-MM-DD
**Source incident issue:** KASA-XXX

> Copy this file to `docs/post-mortems/YYYY-MM-DD-<short-slug>.md` and fill in. Add a row to [RUNBOOK-INCIDENT.md §8](../RUNBOOK-INCIDENT.md#8-post-mortem-index) in the same PR.

---

## 1. Summary

Two-to-three sentences a non-engineer can read. What happened, what the customer saw, how it was resolved. No jargon.

---

## 2. Timeline

All times in WIB and UTC. Anchor every entry to a wall-clock minute. Sources: Slack thread, Sentry events, Better Stack incident records, deploy run URLs, GitHub PRs.

| WIB     | UTC     | Event                                                            | Source                              |
|:--------|:--------|:-----------------------------------------------------------------|:------------------------------------|
| HH:MM   | HH:MM   | _Bad commit landed on main as `<sha>`_                           | <PR link>                           |
| HH:MM   | HH:MM   | _Auto-deploy completed against staging_                          | <run link>                          |
| HH:MM   | HH:MM   | _Production promotion via `deploy-prod.yml` triggered by <op>_   | <run link>                          |
| HH:MM   | HH:MM   | _First Sentry event matching the eventual root cause_            | <Sentry issue link>                 |
| HH:MM   | HH:MM   | _Better Stack monitor `<name>` went red_                         | <BS incident link>                  |
| HH:MM   | HH:MM   | **Page fired** — `#kassa-pilot-oncall`                           | <Slack message link>                |
| HH:MM   | HH:MM   | On-call ack                                                      | <Slack link>                        |
| HH:MM   | HH:MM   | _Mitigation started — <one-line description>_                    | <Slack link>                        |
| HH:MM   | HH:MM   | _Rollback executed — <command summary>_                          | <run link or `flyctl` output>       |
| HH:MM   | HH:MM   | **All-clear posted**                                             | <Slack link>                        |

**Page-to-mitigation:** HH:MM
**Page-to-all-clear:** HH:MM

---

## 3. Root cause (5-whys)

Walk the chain until you reach a system or process gap, not a person.

1. **Why did the merchant see <X>?** — _Direct symptom._
2. **Why did <Y> happen?** — _Proximate cause._
3. **Why did <Z> not catch it?** — _Missing guardrail._
4. **Why was <Z> missing?** — _Process gap._
5. **Why did the process allow that gap?** — _Root cause._

State the root cause in one sentence at the end:

> **Root cause:** _<one sentence — a system or process gap, not "an engineer made a mistake">._

---

## 4. What went well

At least three. Examples:

- Better Stack monitor caught the regression in N min, before any merchant report.
- Rollback to the prior image succeeded on first try; runbook command worked verbatim.
- On-call posted the initial update within the 5-min target.

---

## 5. What didn't

At least three. Examples:

- The Sentry alert for the affected endpoint had a 50-event floor; pilot traffic at the time of incident was 12 events / 5 min, so the rule never fired.
- The rollback runbook referenced an image tag format we changed two weeks ago; the on-call had to guess.
- CEO email was 22 minutes late because the on-call was deep in `flyctl` output and forgot.

---

## 6. Action items

Every action item has an **owner** (single named agent), a **due date** (absolute), and a **link** (Paperclip issue, PR, or doc PR). File each as a Paperclip issue with the `incident-action` label. Action items missing any column do not count.

| #  | Action                                                              | Owner             | Due (YYYY-MM-DD) | Link                |
|:---|:--------------------------------------------------------------------|:------------------|:-----------------|:--------------------|
| 1  | _Lower Sentry min-event floor on `<rule>` from 50 to 10 for pilot._ | <agent>           | YYYY-MM-DD       | <KASA-XXX>          |
| 2  | _Update RUNBOOK-DEPLOY.md §4.2 with the new image-tag format._      | <agent>           | YYYY-MM-DD       | <PR link>           |
| 3  | _Add a `send CEO email` step to the on-call kit checklist._         | <agent>           | YYYY-MM-DD       | <KASA-XXX>          |

---

## 7. Public summary

One paragraph, no PII, safe to share with the merchant or post in a public-facing channel. Future-self uses this when "what happened that one time" comes up six months from now.

> _On YYYY-MM-DD between HH:MM and HH:MM WIB, Kassa's <surface> was unavailable for the pilot merchant. The cause was <plain-language root cause>. We restored service by <action> and shipped <follow-up> the next day to prevent recurrence. No data was lost._

---

## 8. References

- Source incident issue: KASA-XXX
- Slack thread: <link>
- Sentry issues: <links>
- Better Stack incident: <link>
- Bad commit: <PR link>
- Fix or rollback: <PR link or run link>

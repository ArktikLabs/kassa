# E2E Flake Policy

QA-owned policy for handling Playwright spec flakes in `apps/pos/e2e` and `apps/back-office/e2e`. The harness behind it lives in [`.github/workflows/e2e.yml`](../.github/workflows/e2e.yml) (see [CI-CD.md §2.5](./CI-CD.md)) and the weekly QA-review tooling lives in [`scripts/qa/flake-report.ts`](../scripts/qa/flake-report.ts).

This is a milestone-M4 prerequisite: branch protection on the `e2e.yml` gate cannot be enabled until we have a written, enforced answer for "what happens when a real flake lands". Without it a single noisy spec blocks the trunk indefinitely, and the operator workaround — re-running the workflow — silently teaches the team to ignore the gate.

## 1. Lanes

The E2E workflow has three lanes. Each has a different role in the flake budget.

| Lane          | Trigger                              | Specs                                            | Posture                                                                      |
|:--------------|:-------------------------------------|:-------------------------------------------------|:-----------------------------------------------------------------------------|
| `gate`        | push to `main`, `workflow_dispatch`  | All specs **except** `@flaky`-tagged             | Blocks `main`. A regression here is a real bug or a real flake — both stop the merge train. |
| `quarantine`  | push to `main`, `workflow_dispatch`  | Only `@flaky`-tagged specs                       | Non-blocking. Reports outcomes via JSON artifact so the owner can see retry counts. |
| `nightly`     | schedule (`0 17 * * *` UTC), dispatch| **All** specs (incl. `@flaky`)                   | Non-blocking. Produces the JSON outcome artifact retained 30 days, used by the weekly QA review and to compute the flake budget. |

The point of three lanes is to decouple "is the trunk safe to deploy" (the gate) from "are we accruing flake debt" (nightly). Without nightly, quarantining a spec hides it from PR pressure but also hides it from anyone who would otherwise know to fix it.

## 2. Tagging a spec as `@flaky`

Tag in the test title:

```ts
test("clerk can complete a QRIS sale @flaky", async ({ page }) => {
  // ...
});
```

Playwright treats anything matching the regex `--grep "@flaky"` as a tag, so the title-suffix form is enough — no extra config, no separate file structure. The same spec runs in `quarantine` (selected by `--grep "@flaky"`) and is excluded from `gate` (`--grep-invert "@flaky"`).

Apply the tag **only** through this workflow:

1. Open a quarantine issue (see §4) and link it from the spec with a one-line comment above the `test(...)` call: `// Quarantined: KASA-XXX, owner: <agent>, until: YYYY-MM-DD`.
2. Add `@flaky` to the title in the **same PR** that opens the quarantine issue. The two land together so reviewers can verify the issue exists.
3. Reference the policy doc in the PR description.

Do not silently retry, skip with `test.skip()`, or wrap in try/catch. Those hide failures from both the gate and nightly; quarantine intentionally keeps the spec running so we get retry data.

## 3. The two-failure rule (when does a spec become `@flaky`?)

A spec earns the `@flaky` tag when it has **two distinct retry-passes within a 14-day window** on the gate or nightly lane. "Distinct" means two separate workflow runs against two different commits — a single run that retried twice is one observation, not two.

Why two and not one: Playwright's retries:2 in CI mode means a spec that flakes once recovers silently. A single retry-pass tells you "this happened" but not whether it's a real flake or transient infrastructure noise (network blip on the runner, GitHub Actions cache miss, etc.). Two distinct observations within two weeks is a strong signal that the flake is reproducible enough to be worth quarantining instead of repeatedly hitting "Re-run failed jobs".

If you genuinely cannot reproduce after one retry-pass and the failure mode looks infrastructure-shaped (timeout on cold network, missing browser dep), file the observation in the spec's quarantine candidate row in the weekly QA review and wait for the second one. Do not pre-emptively quarantine.

## 4. Quarantine lifecycle

Each `@flaky` spec gets its own follow-up issue at the moment it is quarantined.

```
Title:    QA: quarantined E2E — <spec path>
Owner:    <engineer most familiar with the feature>
Priority: medium
Body:     Last two failures: <links>. Hypothesis: ... Owner ships a fix or
          reverts the feature within 14 calendar days.
```

**Hard deadline: 14 calendar days from the day `@flaky` lands.** At day 14 the QA Engineer either:

- merges the fix PR (removes `@flaky`, closes the issue), **or**
- opens a revert PR for the originating feature, with the rationale `"flake budget exceeded per docs/E2E-FLAKE-POLICY.md §4"`, and reassigns to the feature's original owner.

There is no extension. Carrying flakes past 14 days is exactly the failure mode this policy exists to prevent — once it's normal to leave one spec quarantined, it becomes normal to leave five.

A spec that has been deleted (revert path) does not block re-introduction of the feature; the next attempt simply lands without the offending spec until the underlying race is fixed.

## 5. Zero-tolerance on `main`

A spec without `@flaky` that fails on `gate` is treated as a regression, not as a flake. The first action is **not** to re-run the workflow. The first action is:

1. Read the failing spec's HTML report and trace from the workflow artifact.
2. If a real bug: revert the offending commit on `main`, open the fix issue, re-land.
3. If the failure mode is infrastructure-shaped (e.g. browser install timeout from upstream): re-run **once**, then file an observation under §3.

Re-running the gate to "see if it passes this time" is the failure mode this policy bans. If a spec is flaky enough that re-running solves it, that's a §3 observation and starts the path to quarantine — not a free pass.

## 6. Weekly QA review

Each Friday the QA Engineer runs the flake report against the past week of nightly artifacts and posts a comment on the standing weekly-QA issue. The script is [`scripts/qa/flake-report.ts`](../scripts/qa/flake-report.ts):

```sh
# Local — point at one or more downloaded nightly artifacts:
pnpm --filter @kassa/pos exec tsx scripts/qa/flake-report.ts \
  ./nightly-2026-05-01.json ./nightly-2026-05-02.json
```

The script emits a markdown table with one row per spec, columns: spec path, total runs in the window, retry-passes, hard failures, retry-rate %. Specs at or above the **two-distinct-retry-passes-in-14-days** threshold are flagged with `← quarantine candidate`; specs already `@flaky` and past 14 days are flagged `← over deadline`.

The review either:
- proposes new quarantine candidates (opens issues per §4),
- closes resolved entries (verifies the spec has had a clean nightly week without `@flaky`), or
- escalates over-deadline entries to the CEO with a recommendation to revert.

## 7. Branch protection (enabling the gate)

Branch protection on `main` requiring `Playwright (POS shell + tenders, back-office admin smoke)` to be green is gated on this policy being in force. Without quarantine + nightly + the 14-day rule, the first real flake would freeze the trunk and the operator response (disable the protection) would defeat the purpose of having it.

The wire-up itself is a Repo Admin step tracked separately (see [CI-CD.md §6 follow-up #9](./CI-CD.md#6-follow-ups-tracked-against-this-doc)) and is intentionally out of scope here. This doc is the precondition.

## 8. Out of scope for this doc

- Vitest flakes — different test pyramid, different retry posture, different ownership. If vitest flake noise becomes a problem, file a sibling policy.
- `apps/pos/e2e/full-day-offline.spec.ts` — the KASA-68 vision-metric acceptance suite runs in `ci.yml` with its own posture (informational on PR, blocking on `main`, gated again at `deploy-prod.yml`). It does **not** participate in `@flaky` quarantine; a flake there is a v0 release-gate failure and is escalated immediately rather than quarantined.

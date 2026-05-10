#!/usr/bin/env -S tsx
/*
 * scripts/qa/flake-report.ts — weekly QA flake report.
 *
 * Reads one or more Playwright JSON outcome files (typically downloaded from
 * the `nightly-results-<run-id>` artifacts produced by .github/workflows/e2e.yml)
 * and emits a markdown table summarising spec health for the weekly QA review.
 *
 * The policy that defines the table's quarantine-candidate threshold lives in
 * docs/E2E-FLAKE-POLICY.md §3 and §6.
 *
 * Usage
 * -----
 *   pnpm --filter @kassa/pos exec tsx scripts/qa/flake-report.ts \
 *     ./nightly-2026-05-01.json ./nightly-2026-05-02.json ...
 *
 * Or against a directory:
 *   pnpm --filter @kassa/pos exec tsx scripts/qa/flake-report.ts ./artifacts/
 *
 * Output goes to stdout; redirect into the QA review issue.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Playwright JSON shape (subset we rely on). Keep this conservative — the
// reporter has more fields than we use, and it has changed between Playwright
// minor versions, so we only depend on the fields that have been stable since
// 1.30.
// ---------------------------------------------------------------------------

interface PwResult {
  status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
  retry: number;
}

interface PwTest {
  results: PwResult[];
  // `expected` = passed first try, `flaky` = passed on retry,
  // `unexpected` = ultimately failed, `skipped` = not run.
  status?: "expected" | "unexpected" | "flaky" | "skipped";
}

interface PwSpec {
  title: string;
  file?: string;
  tags?: string[];
  tests: PwTest[];
  ok: boolean;
}

interface PwSuite {
  title: string;
  file?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}

interface PwReport {
  suites: PwSuite[];
  stats?: { startTime?: string };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface SpecAggregate {
  specPath: string; // file::title
  file: string;
  title: string;
  totalRuns: number; // number of input files where this spec ran
  retryPasses: number; // runs where the test eventually passed after at least one retry
  hardFailures: number; // runs where the test ended in failed/timedOut/interrupted
  cleanPasses: number; // runs where the test passed first try
  tagged: boolean; // already carries @flaky tag
}

const QUARANTINE_TAG = "@flaky";
// Threshold per docs/E2E-FLAKE-POLICY.md §3. A spec earns quarantine when
// it has retry-passed in two distinct runs within the report window.
const QUARANTINE_CANDIDATE_THRESHOLD = 2;

function expandPaths(args: string[]): string[] {
  const files: string[] = [];
  for (const arg of args) {
    const stat = statSync(arg);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(arg)) {
        if (entry.endsWith(".json")) files.push(join(arg, entry));
      }
    } else {
      files.push(arg);
    }
  }
  return files;
}

function isFlakyTagged(spec: PwSpec): boolean {
  if (spec.tags?.some((t) => t === QUARANTINE_TAG)) return true;
  // Pre-1.42 Playwright didn't populate `tags`; the title-suffix form
  // (`test("foo @flaky", …)`) is still the supported convention, so fall
  // back to a substring check on the title.
  return spec.title.includes(QUARANTINE_TAG);
}

function classifyTest(test: PwTest): "clean" | "retry-pass" | "hard-fail" | "skipped" {
  if (test.status === "skipped") return "skipped";
  if (test.status === "flaky") return "retry-pass";
  if (test.status === "unexpected") return "hard-fail";
  if (test.status === "expected") return "clean";
  // Fall back to inspecting results when status isn't populated — older
  // reporter output.
  const last = test.results.at(-1);
  if (!last) return "skipped";
  if (last.status === "passed") {
    const hadFailure = test.results.some((r) => r.status === "failed" || r.status === "timedOut");
    return hadFailure ? "retry-pass" : "clean";
  }
  if (last.status === "skipped") return "skipped";
  return "hard-fail";
}

function walkSuite(
  suite: PwSuite,
  parentFile: string | undefined,
  visit: (spec: PwSpec, file: string) => void,
): void {
  const file = suite.file ?? parentFile ?? "<unknown>";
  for (const spec of suite.specs ?? []) {
    visit(spec, spec.file ?? file);
  }
  for (const child of suite.suites ?? []) walkSuite(child, file, visit);
}

function aggregate(files: string[]): SpecAggregate[] {
  const byKey = new Map<string, SpecAggregate>();

  for (const path of files) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      console.error(`[flake-report] skipping ${path}: ${(err as Error).message}`);
      continue;
    }
    let report: PwReport;
    try {
      report = JSON.parse(raw) as PwReport;
    } catch (err) {
      console.error(`[flake-report] skipping ${path}: not valid JSON (${(err as Error).message})`);
      continue;
    }

    // Track which spec keys we've already counted in THIS run so a spec
    // that appears in multiple projects (chromium-laptop, etc.) only
    // contributes one observation per run — runs are the unit, not
    // project-runs.
    const seenInRun = new Set<string>();

    for (const suite of report.suites ?? []) {
      walkSuite(suite, undefined, (spec, file) => {
        const key = `${file}::${spec.title}`;
        if (seenInRun.has(key)) {
          // Promote per-run classification: if any project saw a
          // hard-fail or retry-pass, that's the run's classification
          // for this spec. Already counted, so just upgrade.
          return;
        }
        let cls: "clean" | "retry-pass" | "hard-fail" | "skipped" = "skipped";
        for (const t of spec.tests) {
          const c = classifyTest(t);
          if (c === "hard-fail") {
            cls = "hard-fail";
            break;
          }
          if (c === "retry-pass") cls = "retry-pass";
          else if (c === "clean" && cls === "skipped") cls = "clean";
        }
        if (cls === "skipped") return;
        seenInRun.add(key);

        let agg = byKey.get(key);
        if (!agg) {
          agg = {
            specPath: key,
            file,
            title: spec.title,
            totalRuns: 0,
            retryPasses: 0,
            hardFailures: 0,
            cleanPasses: 0,
            tagged: isFlakyTagged(spec),
          };
          byKey.set(key, agg);
        } else if (isFlakyTagged(spec)) {
          agg.tagged = true;
        }

        agg.totalRuns += 1;
        if (cls === "retry-pass") agg.retryPasses += 1;
        else if (cls === "hard-fail") agg.hardFailures += 1;
        else agg.cleanPasses += 1;
      });
    }
  }

  return [...byKey.values()].sort((a, b) => {
    // Most retry-noise first, then hard failures, then file path.
    if (b.retryPasses !== a.retryPasses) return b.retryPasses - a.retryPasses;
    if (b.hardFailures !== a.hardFailures) return b.hardFailures - a.hardFailures;
    return a.specPath.localeCompare(b.specPath);
  });
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderMarkdown(rows: SpecAggregate[], runCount: number): string {
  const lines: string[] = [];
  lines.push(`# E2E flake report`);
  lines.push("");
  lines.push(
    `Aggregated across **${runCount}** Playwright outcome file${runCount === 1 ? "" : "s"}. Policy: [docs/E2E-FLAKE-POLICY.md](../docs/E2E-FLAKE-POLICY.md).`,
  );
  lines.push("");

  if (rows.length === 0) {
    lines.push("_No specs ran in the supplied outcome files._");
    return `${lines.join("\n")}\n`;
  }

  const candidates = rows.filter(
    (r) => !r.tagged && r.retryPasses >= QUARANTINE_CANDIDATE_THRESHOLD,
  );
  const tagged = rows.filter((r) => r.tagged);

  lines.push(`- Total specs observed: **${rows.length}**`);
  lines.push(`- Already quarantined (\`@flaky\`): **${tagged.length}**`);
  lines.push(
    `- New quarantine candidates (≥ ${QUARANTINE_CANDIDATE_THRESHOLD} retry-passes in window): **${candidates.length}**`,
  );
  lines.push("");
  lines.push("| Spec | Runs | Clean | Retry-pass | Hard-fail | Retry rate | Status |");
  lines.push("|:-----|-----:|------:|-----------:|----------:|-----------:|:-------|");

  for (const r of rows) {
    const rate = r.totalRuns > 0 ? ((r.retryPasses / r.totalRuns) * 100).toFixed(0) : "—";
    const status: string[] = [];
    if (r.tagged) status.push("`@flaky` quarantined — verify against issue deadline");
    else if (r.retryPasses >= QUARANTINE_CANDIDATE_THRESHOLD) status.push("← quarantine candidate");
    if (r.hardFailures > 0 && !r.tagged) status.push("← hard failure on `gate` lane");
    const statusCell = status.length ? status.join("; ") : "";
    lines.push(
      `| \`${escapePipes(r.specPath)}\` | ${r.totalRuns} | ${r.cleanPasses} | ${r.retryPasses} | ${r.hardFailures} | ${rate}% | ${statusCell} |`,
    );
  }

  lines.push("");
  lines.push("## Next actions");
  lines.push("");
  if (candidates.length > 0) {
    lines.push(
      `- Open a quarantine issue per candidate (see [E2E-FLAKE-POLICY.md §4](../docs/E2E-FLAKE-POLICY.md#4-quarantine-lifecycle)).`,
    );
  }
  if (tagged.length > 0) {
    lines.push(
      `- Cross-reference each \`@flaky\` row with its tracking issue. Anything past the 14-day deadline either ships a fix this week or is reverted (policy §4).`,
    );
  }
  if (candidates.length === 0 && tagged.length === 0) {
    lines.push("- No flake-budget action this week. Carry the row count forward.");
  }
  return `${lines.join("\n")}\n`;
}

function escapePipes(s: string): string {
  return s.replace(/\|/g, "\\|");
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

function main(): number {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: tsx scripts/qa/flake-report.ts <playwright-outcome.json|dir> [...more]");
    return 2;
  }
  const files = expandPaths(args);
  if (files.length === 0) {
    console.error("[flake-report] no JSON files found in supplied paths");
    return 2;
  }
  const rows = aggregate(files);
  process.stdout.write(renderMarkdown(rows, files.length));
  return 0;
}

process.exit(main());

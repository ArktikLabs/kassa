import * as Sentry from "@sentry/react";
import { onCLS, onINP, onLCP, type Metric } from "web-vitals";

/*
 * Real-user Web Vitals collection for the POS PWA (KASA-282).
 *
 * We sample the three Core Web Vitals that map to the merchant-visible SLO
 * stated in docs/TECH-STACK.md §11 and the Lighthouse contract in
 * apps/pos/lighthouserc.json:
 *
 *   - LCP — cold-start tile-grid paint on slow-4G is the headline metric.
 *   - INP — replaces FID; surfaces tap-latency regressions on the catalog
 *     grid and tender keypads.
 *   - CLS — receipts and price tiles must not jump after first paint.
 *
 * Each metric is emitted as a Sentry breadcrumb so any subsequent error
 * event carries the page-load perf context, and as a Sentry message at
 * info level so it can be aggregated on the dashboards a separate
 * observability ticket will wire up.
 *
 * Both side effects are no-ops when VITE_SENTRY_DSN is unset (Sentry init
 * bails early in that case), which keeps dev, CI, and unconfigured
 * deployments quiet. This module is lazy-imported from main.tsx after
 * first paint so the web-vitals package is never on the LCP-critical
 * chunk.
 */

type VitalName = "LCP" | "INP" | "CLS";

function reportMetric(metric: Metric): void {
  const name = metric.name as VitalName;
  const data = {
    value: metric.value,
    rating: metric.rating,
    delta: metric.delta,
    id: metric.id,
    navigationType: metric.navigationType,
  };

  Sentry.addBreadcrumb({
    category: "web-vitals",
    type: "info",
    level: "info",
    message: name,
    data,
  });

  Sentry.captureMessage(`web-vitals.${name}`, {
    level: "info",
    tags: { "web-vitals.metric": name, "web-vitals.rating": metric.rating },
    extra: data,
  });
}

let started = false;

export function startWebVitals(): void {
  if (started) return;
  if (typeof window === "undefined") return;
  started = true;
  onLCP(reportMetric);
  onINP(reportMetric);
  onCLS(reportMetric);
}

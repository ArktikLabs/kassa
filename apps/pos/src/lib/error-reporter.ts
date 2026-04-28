/*
 * Lazy facade over `lib/sentry.ts`. Modules that need to capture exceptions
 * (sync provider, background workers) call `reportException` from here so the
 * Sentry SDK (~110 kB gzip) stays out of the LCP-critical chunk and only
 * downloads after `main.tsx` schedules the deferred import. Errors are
 * extremely rare on cold load — queueing them behind the lazy import is the
 * right tradeoff for the mobile Performance/LCP budget (KASA-157).
 */

type ReportContext = {
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
};

let cached: Promise<typeof import("./sentry")> | null = null;
function loadSentryModule(): Promise<typeof import("./sentry")> {
  if (!cached) cached = import("./sentry");
  return cached;
}

export function reportException(err: unknown, ctx?: ReportContext): void {
  void loadSentryModule()
    .then((m) => m.reportException(err, ctx))
    .catch((loadErr) => {
      // The Sentry chunk can fail to load if the device is offline and the
      // chunk has not yet been precached. Don't crash the app over a failed
      // error report — log to the console as a last resort.
      console.error("[reportException] sentry chunk load failed", err, loadErr);
    });
}

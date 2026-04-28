import * as Sentry from "@sentry/node";

/*
 * Sentry runtime init for the API tier (KASA-143). Mirrors the contract in
 * apps/{pos,back-office}/src/lib/sentry.ts so events from the server side
 * land in the same shape as the browser SDKs. ADR-010 ("No PII in Sentry
 * events", ARCHITECTURE.md): merchant phone, Indonesian-style address,
 * and 12+ digit runs (card / bank-account shaped) are scrubbed before
 * leaving the process. Receipts and tender amounts are not scrubbed —
 * not PII under PDPA and we need them to triage charge bugs.
 *
 *  - sendDefaultPii=false so the SDK never auto-attaches IPs, cookies,
 *    or query strings.
 *  - beforeSend / beforeBreadcrumb run the same scrubber the PWAs use.
 *  - No Performance / Profiling integrations: out of scope for KASA-143
 *    (KASA-71 owns alert wiring, future tickets own sampling tuning).
 *
 * Init is gated on SENTRY_DSN. Dev / CI / staging without a DSN run silent
 * — buildApp() and the worker entrypoint must boot the same whether Sentry
 * is configured or not.
 *
 * The Sentry release name (`kassa-api@<sha12>`) is derived from
 * KASSA_API_VERSION (`prod-<sha12>` / `staging-<sha12>` /
 * `preview-pr-<N>-<sha12>`) so events tag against the same release the
 * source-map upload created in CD (docs/CI-CD.md §3.5b). Local dev leaves
 * KASSA_API_VERSION unset; events from a developer machine are not
 * falsely attributed to a CI release.
 */

// Same scrubber regexes as apps/pos/src/lib/sentry.ts. Kept in sync by hand
// rather than extracting to @kassa/schemas: the scrubber is a security
// surface, and the tests in apps/{pos,api} pin the contract independently
// so an accidental loosening on one side is caught by the other's suite.
const PHONE_RE = /(?<![.\d])(?:\+62|62|0)[\s-]?\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,5}(?![.\d])/g;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const ADDRESS_STREET_RE =
  /\b(?:jl\.?|jalan|gg\.?|gang)\s+\S+(?:\s+\S+){0,8}?\s+(?:no\.?|rt\.?|rw\.?)\s*\d+\b/gi;
const ADDRESS_NUMBER_RE = /\b(?:no\.?|rt\.?|rw\.?)\s*\d+\b/gi;
const LONG_DIGIT_RUN = /\b\d{12,}\b/g;

function scrubString(input: string): string {
  return input
    .replace(EMAIL_RE, "[email]")
    .replace(PHONE_RE, "[phone]")
    .replace(ADDRESS_STREET_RE, "[address]")
    .replace(ADDRESS_NUMBER_RE, "[address]")
    .replace(LONG_DIGIT_RUN, "[digits]");
}

function scrub<T>(value: T): T {
  if (typeof value === "string") return scrubString(value) as T;
  if (Array.isArray(value)) return value.map(scrub) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrub(v);
    }
    return out as T;
  }
  return value;
}

// KASSA_API_VERSION is shaped `<tier>-<sha12>` (or `preview-pr-<N>-<sha12>`).
// The Sentry release name is `kassa-api@<sha12>` so the runtime tag matches
// the source-map upload — see docs/CI-CD.md §3.5b for why prefixes diverge.
function deriveRelease(version: string | undefined): string | undefined {
  const v = version?.trim();
  if (!v) return undefined;
  const match = v.match(/([0-9a-f]{12})$/);
  return match ? `kassa-api@${match[1]}` : `kassa-api@${v}`;
}

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) return;

  // SENTRY_ENVIRONMENT separates prod from staging/preview events
  // (apps/api/fly.toml pre-stages this var). NODE_ENV stays `production`
  // on every Fly tier because Fastify, pino, and the pg client gate
  // prod-only behaviour on it; the Sentry environment must come from a
  // dedicated var so cross-tier filtering still works.
  const environment =
    process.env.SENTRY_ENVIRONMENT?.trim() || process.env.NODE_ENV || "development";
  const release = deriveRelease(process.env.KASSA_API_VERSION);

  Sentry.init({
    dsn,
    environment,
    ...(release !== undefined ? { release } : {}),
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.request) {
        delete event.request.cookies;
        delete event.request.headers;
        if (event.request.query_string) {
          event.request.query_string = scrub(event.request.query_string);
        }
        if (event.request.data !== undefined) {
          event.request.data = scrub(event.request.data);
        }
      }
      if (event.user) {
        delete event.user.email;
        delete event.user.ip_address;
        delete event.user.username;
      }
      if (event.message) event.message = scrubString(event.message);
      if (event.exception?.values) {
        for (const ex of event.exception.values) {
          if (ex.value) ex.value = scrubString(ex.value);
        }
      }
      if (event.extra) event.extra = scrub(event.extra);
      if (event.contexts) event.contexts = scrub(event.contexts);
      return event;
    },
    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.message) {
        breadcrumb.message = scrubString(breadcrumb.message);
      }
      if (breadcrumb.data) breadcrumb.data = scrub(breadcrumb.data);
      return breadcrumb;
    },
  });
}

export { Sentry };
export const _scrubStringForTest = scrubString;
export const _deriveReleaseForTest = deriveRelease;

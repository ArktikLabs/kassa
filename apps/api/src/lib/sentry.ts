import * as Sentry from "@sentry/node";
import type { ErrorEvent, EventHint } from "@sentry/node";

/*
 * Sentry runtime init for the API tier (KASA-143 / KASA-196). Mirrors the
 * contract in apps/{pos,back-office}/src/lib/sentry.ts so events from the
 * server side land in the same shape as the browser SDKs. ADR-010 ("No PII
 * in Sentry events", ARCHITECTURE.md): merchant phone, Indonesian-style
 * address, and 12+ digit runs (card / bank-account shaped) are scrubbed
 * before leaving the process. Receipts and tender amounts are not scrubbed —
 * not PII under PDPA and we need them to triage charge bugs.
 *
 *  - sendDefaultPii=false so the SDK never auto-attaches IPs, cookies,
 *    or query strings.
 *  - beforeSend / beforeBreadcrumb run the same scrubber the PWAs use.
 *  - Routes that handle PII (`POST /v1/sales`, `POST /v1/payments/*`,
 *    `POST /v1/auth/session/*`) have their request body dropped wholesale
 *    by `beforeSend` — even with regex-level masking the body is too rich
 *    to ship under ADR-010. The complementary allowlist of routes that
 *    keep their (scrubbed) body lives in `BODY_KEEP_ROUTES`; everything
 *    else falls back to the regex masker as a defence in depth.
 *  - `tracesSampleRate` reads from `SENTRY_TRACES_SAMPLE_RATE` so ops can
 *    bump traces without a redeploy. Defaults to 0 (no transactions) so
 *    a missing var never silently turns on the paid-tier transaction quota.
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

// PII routes whose request body must be dropped before the event leaves the
// process (ADR-010, KASA-196 AC). Match is method + path-prefix on the URL
// captured by Sentry's Fastify integration. Stored as plain prefixes so
// future routes are appended in one place — kept in lockstep with the README
// "Route map" (apps/api/README.md) and the issue body.
const PII_BODY_DROP_ROUTES: ReadonlyArray<{
  method: "POST";
  prefix: string;
}> = [
  { method: "POST", prefix: "/v1/sales" },
  { method: "POST", prefix: "/v1/payments/" },
  { method: "POST", prefix: "/v1/auth/session/" },
];

// Routes that keep their (regex-scrubbed) body. Anything matched here is left
// with its body intact except for the regex pass; anything else is also
// regex-scrubbed today, but listing the safe routes explicitly makes the AC
// "path allowlist for what gets to keep its body" auditable rather than
// implicit. New PII routes default to the drop list; the allowlist must be
// updated deliberately.
export const BODY_KEEP_ROUTES: ReadonlyArray<{
  method: "POST" | "GET";
  prefix: string;
}> = [
  { method: "POST", prefix: "/v1/auth/enrolment-codes" },
  { method: "POST", prefix: "/v1/auth/enroll" },
  { method: "POST", prefix: "/v1/payments/webhooks/" },
  { method: "POST", prefix: "/v1/eod/" },
  { method: "POST", prefix: "/v1/admin/" },
  { method: "POST", prefix: "/v1/catalog/" },
  { method: "POST", prefix: "/v1/outlets" },
];

function eventPathname(rawUrl: unknown): string {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return "";
  // Sentry's Fastify integration may set `event.request.url` to either a
  // bare path (`/v1/sales`) or a full URL (`http://host/v1/sales?x=y`).
  // Extract just the pathname so the prefix match is stable across both.
  const qIndex = rawUrl.indexOf("?");
  const noQuery = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
  if (noQuery.startsWith("/")) return noQuery;
  try {
    return new URL(noQuery).pathname;
  } catch {
    return "";
  }
}

function shouldDropBody(method: unknown, rawUrl: unknown): boolean {
  if (typeof method !== "string") return false;
  const upper = method.toUpperCase();
  const path = eventPathname(rawUrl);
  if (!path) return false;
  return PII_BODY_DROP_ROUTES.some((rule) => {
    if (rule.method !== upper) return false;
    // Prefixes ending in `/` are sub-tree matchers (`/v1/payments/` covers
    // `/v1/payments/qris` but not the literal `/v1/payments`). Bare prefixes
    // match the exact path or a `/`-bounded sub-path so `/v1/sales` covers
    // `/v1/sales` and `/v1/sales/<id>/refund` without grabbing
    // `/v1/salesperson`.
    if (rule.prefix.endsWith("/")) return path.startsWith(rule.prefix);
    return path === rule.prefix || path.startsWith(`${rule.prefix}/`);
  });
}

/**
 * Sentry `beforeSend` hook. Exported so the integration tests can pin its
 * behaviour against synthetic events without spinning up the full SDK.
 *
 * Order matters:
 *  1. PII-route gate: if the request URL matches a deny-listed route, drop
 *     the request body and query string entirely. This protects us even if
 *     the regex masker misses a buyer-name shape we have not seen.
 *  2. Default scrub: regex-mask phones / emails / addresses / 12+ digit
 *     runs in whatever fields remain (request.data, message, exception,
 *     extra, contexts).
 */
export function beforeSend(event: ErrorEvent, _hint?: EventHint): ErrorEvent {
  if (event.request) {
    delete event.request.cookies;
    delete event.request.headers;
    if (shouldDropBody(event.request.method, event.request.url)) {
      delete event.request.data;
      delete event.request.query_string;
    } else {
      if (event.request.query_string) {
        event.request.query_string = scrub(event.request.query_string);
      }
      if (event.request.data !== undefined) {
        event.request.data = scrub(event.request.data);
      }
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
}

// Reads SENTRY_TRACES_SAMPLE_RATE and clamps to [0, 1]. Default 0 — the API
// tier opts in to transactions deliberately because tracing inflates the
// paid-tier event quota and the alert routing in KASA-71 has not yet
// modelled trace volume.
function deriveTracesSampleRate(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 0;
  const value = Number.parseFloat(trimmed);
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
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
  const tracesSampleRate = deriveTracesSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE);

  Sentry.init({
    dsn,
    environment,
    ...(release !== undefined ? { release } : {}),
    sendDefaultPii: false,
    tracesSampleRate,
    beforeSend,
    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.message) {
        breadcrumb.message = scrubString(breadcrumb.message);
      }
      if (breadcrumb.data) breadcrumb.data = scrub(breadcrumb.data);
      return breadcrumb;
    },
  });
}

/**
 * Tags the current Sentry isolation scope with device-auth principal fields.
 * No-op when no Sentry client is initialised (DSN unset) and when the
 * principal is missing — the tags must never leak across requests so the
 * caller is expected to invoke this only when the principal is freshly set
 * for the request, AND `Sentry.setupFastifyErrorHandler` has wired the
 * per-request isolation scope so `setTags` is request-local.
 *
 * The contract is "no PII" (ADR-010): merchantId / outletId / deviceId are
 * opaque ULIDs without identifying information about a buyer or a staff
 * member. They make it possible to slice "noisy device" / "outlet outage"
 * alerts in KASA-71 without joining back to a customer record.
 */
export function applyDeviceTags(principal: {
  merchantId: string;
  outletId: string;
  deviceId: string;
}): void {
  if (!Sentry.getClient()) return;
  Sentry.getIsolationScope().setTags({
    merchant_id: principal.merchantId,
    outlet_id: principal.outletId,
    device_id: principal.deviceId,
  });
}

export { Sentry };
export const _scrubStringForTest = scrubString;
export const _deriveReleaseForTest = deriveRelease;
export const _deriveTracesSampleRateForTest = deriveTracesSampleRate;
export const _shouldDropBodyForTest = shouldDropBody;

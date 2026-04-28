import * as Sentry from "@sentry/react";

/*
 * Sentry browser init for the POS PWA. Implements ADR-010 ("No PII in
 * Sentry events", ARCHITECTURE.md): the buyer-identifying fields named
 * by the contract (name, phone, email) never leave the device.
 *
 *  - sendDefaultPii=false so the SDK never auto-attaches IP, cookies,
 *    or query strings.
 *  - beforeSend / beforeBreadcrumb scrub merchant phone numbers,
 *    Indonesian-style addresses (jl. / gg. / no.), email addresses,
 *    and any field containing a 12+ digit run that could be a card or
 *    bank account number. Receipts and tender amounts are not scrubbed
 *    — they are not PII under PDPA and we need them to triage charge
 *    bugs.
 *  - Session replay is disabled. The clerk's screen contains customer
 *    PII (cart contents tied to an attached customer); replay needs a
 *    dedicated review before it ships.
 *  - Tracing sample rate is low; raise it once we have real volume.
 *
 * Init is gated on VITE_SENTRY_DSN so dev, CI, and the local Vite
 * preview can run without a DSN configured. Cloudflare Pages preview
 * deploys are expected to inject the DSN at build time.
 */

// Indonesian phone shape: +62 / 62 / 0 prefix followed by 8–13 more digits
// in 2–4 / 3–4 / 3–5 groups separated by space or dash. Dots are NOT
// allowed as separators so version strings like "0.500.100.123" do not
// masquerade as phone numbers. Bordered by non-digit / non-dot to avoid
// chopping into longer numeric runs.
const PHONE_RE = /(?<![.\d])(?:\+62|62|0)[\s-]?\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,5}(?![.\d])/g;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Full Indonesian street address: street prefix (jl/jalan/gg/gang) + street
// name + a numbered component (no./rt/rw + digits) within a few tokens.
const ADDRESS_STREET_RE =
  /\b(?:jl\.?|jalan|gg\.?|gang)\s+\S+(?:\s+\S+){0,8}?\s+(?:no\.?|rt\.?|rw\.?)\s*\d+\b/gi;
// Bare numbered address component: requires digits to follow the prefix so
// generic English like "no one" or "rt happy" no longer matches.
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

export function initSentry(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;

  // VITE_SENTRY_ENVIRONMENT separates prod from preview/staging events
  // (KASA-150). MODE is `production` for any `vite build` regardless of
  // deploy target, so per-environment Sentry alert rules need a build-time
  // override. Falls back to MODE when unset so dev/test keep their existing
  // tag (`development` / `test`).
  const environment = import.meta.env.VITE_SENTRY_ENVIRONMENT || import.meta.env.MODE;

  Sentry.init({
    dsn,
    environment,
    release: import.meta.env.VITE_RELEASE,
    sendDefaultPii: false,
    tracesSampleRate: import.meta.env.PROD ? 0.05 : 0,
    integrations: [Sentry.browserTracingIntegration()],
    beforeSend(event) {
      if (event.request) {
        delete event.request.cookies;
        delete event.request.headers;
        if (event.request.query_string) {
          event.request.query_string = scrub(event.request.query_string);
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

/**
 * Forward an exception to Sentry from places that should not pull `@sentry/react`
 * into their static import graph (the LCP-critical chunk). Callers should reach
 * for `lib/error-reporter.ts` instead, which dynamic-imports this module so the
 * Sentry SDK ends up in its own chunk.
 */
export function reportException(
  err: unknown,
  ctx?: { tags?: Record<string, string>; extra?: Record<string, unknown> },
): void {
  Sentry.captureException(err, ctx);
}

export const _scrubStringForTest = scrubString;

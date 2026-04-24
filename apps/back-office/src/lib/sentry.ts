import * as Sentry from "@sentry/react";

/*
 * Sentry browser init for the back-office.
 *
 * Mirrors the PII posture of the POS PWA (ARCHITECTURE.md ADR-010):
 *  - sendDefaultPii: false, cookies/headers stripped.
 *  - beforeSend / beforeBreadcrumb scrub Indonesian phone numbers,
 *    email addresses, Indonesian-style street addresses (Jl./Gg./No.),
 *    and any 12+ digit run that could be a card/bank-account number.
 *  - Replay is disabled. The back-office shows staff details, customer
 *    summaries, and bank payout info — replay needs a dedicated review
 *    before it can ship.
 *  - Init is gated on VITE_SENTRY_DSN so dev/CI run silent.
 */

const PHONE_RE = /(\+?62|0)[\s.-]?\d{2,4}[\s.-]?\d{3,4}[\s.-]?\d{3,5}/g;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const ADDRESS_RE = /\b(jl\.?|jalan|gg\.?|gang|no\.?|rt\.?|rw\.?)\s*\S+/gi;
const LONG_DIGIT_RUN = /\b\d{12,}\b/g;

function scrubString(input: string): string {
  return input
    .replace(EMAIL_RE, "[email]")
    .replace(PHONE_RE, "[phone]")
    .replace(ADDRESS_RE, "[address]")
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

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
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

export { Sentry };
export const _scrubStringForTest = scrubString;

import { z } from "zod";

// A trimmed empty string for an optional env var is "unset", not "invalid".
// `.env.example` tells devs to leave `MIDTRANS_SERVER_KEY=` blank locally,
// so preserve that ergonomics instead of crashing boot with a Zod error.
const optionalTrimmedString = z.preprocess((v) => {
  const s = typeof v === "string" ? v.trim() : v;
  return s === "" ? undefined : s;
}, z.string().min(1).optional());

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    STAFF_BOOTSTRAP_TOKEN: z.string().min(16).optional(),
    ENROLMENT_CODE_TTL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(10 * 60 * 1000),
    MIDTRANS_SERVER_KEY: optionalTrimmedString,
    MIDTRANS_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
    // `postgres://…` URL. Optional in dev/test so the enrolment in-memory repo
    // path keeps working without a running Postgres; required in production —
    // see the refinement below.
    DATABASE_URL: optionalTrimmedString,
    // TLS toggle for the Postgres connection. Neon + Fly Postgres need `true`;
    // a local loopback test db can opt out with `DATABASE_SSL=false`.
    DATABASE_SSL: z
      .preprocess(
        (v) => (typeof v === "string" ? v.trim().toLowerCase() : v),
        z.enum(["true", "false"]).default("true"),
      )
      .transform((v) => v === "true"),
    // `redis://…` (or `rediss://…` for TLS) — BullMQ broker for the worker
    // process group. Optional today (KASA-111 ships only a placeholder queue;
    // the worker logs and idles when REDIS_URL is unset). The first PR that
    // wires a real consumer (KASA-120: nightly reconciliation) is expected to
    // tighten this to required-in-production via the refinement block below,
    // alongside the Fly secret being landed on `kassa-api-staging` and the
    // production `kassa-api` app. See docs/CI-CD.md §3.4 for provisioning.
    //
    // Staging and production must point at separate Redis instances — no
    // shared queue state across tiers.
    REDIS_URL: optionalTrimmedString,
    // HMAC secret for the staff session cookie. Optional everywhere — the
    // `superRefine` block intentionally does NOT promote it to required-in-
    // production. Rationale (KASA-201 / KASA-203, ADR-011): the only route
    // that uses this secret is `POST /v1/auth/session/login`, which already
    // returns 503 `not_configured` when the secret is absent. Crashing the
    // whole API on boot for a missing back-office login secret turns a
    // localized degradation into a full outage (sales, sync, /health all go
    // down). Instead the missing-secret state surfaces as a startup warning
    // logged by `index.ts`, captured as a Sentry breadcrumb, and exposed via
    // `/health`'s `warnings[]` field so monitoring and ops both see the
    // degradation without paging on-call. Min length stays 32 chars when the
    // secret IS set, so no weak-secret regression.
    SESSION_COOKIE_SECRET: z.string().min(32).optional(),
    // Comma-separated allow-list of origins that may make cross-origin
    // requests against the API with `credentials: include`. Each entry is a
    // literal origin (`https://kassa-back-office.pages.dev`); the Cloudflare
    // Pages preview pattern `https://pr-N.kassa-back-office.pages.dev` is
    // matched separately via `BACK_OFFICE_PREVIEW_ORIGIN_PATTERN` below.
    CORS_ALLOWED_ORIGINS: optionalTrimmedString,
    // Optional regex (one entry, anchored automatically) that matches preview
    // origins. Defaults to the Cloudflare-Pages preview pattern; set to a
    // blank string to disable previews.
    CORS_PREVIEW_ORIGIN_PATTERN: optionalTrimmedString,
  })
  .superRefine((env, ctx) => {
    // DATABASE_URL stays a hard fail in production: no /v1 route can serve
    // without it, so booting up just to 500 every request is worse than
    // crashing on `flyctl deploy` and surfacing the misconfiguration loudly.
    // Per ADR-011, that is the only "loud fail on boot" gate kept around.
    if (env.NODE_ENV === "production" && !env.DATABASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DATABASE_URL"],
        message: "DATABASE_URL is required when NODE_ENV=production.",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${details}`);
  }
  return parsed.data;
}

/**
 * Stable identifiers for the structured startup warnings surfaced via
 * `/health` and Sentry breadcrumbs. New entries should be added here so
 * monitoring queries can match a finite, documented set of codes.
 */
export type StartupWarningCode = "missing_session_cookie_secret";

export interface StartupWarning {
  code: StartupWarningCode;
  message: string;
}

/**
 * Inspect a parsed env and return the list of "degraded but up" warnings
 * the API should surface at boot (instead of crashing). Today this is just
 * `SESSION_COOKIE_SECRET` in production — see ADR-011 for the policy and
 * KASA-201 for the incident that motivated softening the gate.
 */
export function collectStartupWarnings(env: Env): StartupWarning[] {
  const warnings: StartupWarning[] = [];
  if (env.NODE_ENV === "production" && !env.SESSION_COOKIE_SECRET) {
    warnings.push({
      code: "missing_session_cookie_secret",
      message:
        "SESSION_COOKIE_SECRET is unset in production; POST /v1/auth/session/login will respond 503 not_configured.",
    });
  }
  return warnings;
}

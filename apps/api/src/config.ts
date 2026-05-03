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
    // HMAC secret for the staff session cookie. Required in production —
    // see the refinement below — because without it `POST /v1/auth/session/login`
    // returns 503 and the back-office cannot sign anyone in. Local dev is
    // free to skip it; the route surfaces 503 `not_configured` cleanly.
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
    if (env.NODE_ENV === "production" && !env.DATABASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DATABASE_URL"],
        message: "DATABASE_URL is required when NODE_ENV=production.",
      });
    }
    if (env.NODE_ENV === "production" && !env.SESSION_COOKIE_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SESSION_COOKIE_SECRET"],
        message: "SESSION_COOKIE_SECRET is required when NODE_ENV=production.",
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

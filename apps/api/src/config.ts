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
  })
  .superRefine((env, ctx) => {
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

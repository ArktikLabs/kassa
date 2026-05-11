import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { StartupWarning } from "../config.js";

const healthResponseSchema = z
  .object({
    status: z.literal("ok"),
    service: z.literal("kassa-api"),
    version: z.string(),
    uptimeSeconds: z.number().int().nonnegative(),
    timestamp: z.string().datetime({ offset: true }),
    // Stable codes from `collectStartupWarnings()` describing degraded-but-up
    // configuration gaps (ADR-011 / KASA-203). Empty array on a clean deploy.
    // Liveness is unchanged: monitoring stays green when the array is non-empty;
    // ops should grep for the codes here to spot a missing config.
    warnings: z.array(z.string()),
  })
  .strict()
  .describe(
    "Liveness payload for uptime monitors. Intentionally unversioned so " +
      "monitors do not need to track API versions.",
  );

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export function healthRoutes(startupWarnings: ReadonlyArray<StartupWarning>) {
  return async function register(app: FastifyInstance): Promise<void> {
    // KASSA_API_VERSION is injected at deploy time (commit SHA). Falls back to
    // the workspace package version when running outside a deploy (local dev,
    // CI tests). The smoke-test job in .github/workflows/cd.yml asserts that
    // this field matches the deployed commit before calling a release green.
    const version = process.env.KASSA_API_VERSION ?? process.env.npm_package_version ?? "0.0.0";
    const warningCodes = startupWarnings.map((w) => w.code);

    app.get(
      "/health",
      {
        schema: {
          tags: ["health"],
          summary: "Liveness probe",
          description:
            "Always returns 200 when the process can serve requests. Mounted at " +
            "the root (not under `/v1`) so external monitors do not have to " +
            "track API versions. The `warnings[]` array exposes structured " +
            "codes for degraded-but-up boots (e.g. `missing_session_cookie_secret`); " +
            "see ADR-011 for the policy.",
          response: { 200: healthResponseSchema },
        },
      },
      async (): Promise<HealthResponse> => {
        return {
          status: "ok",
          service: "kassa-api",
          version,
          uptimeSeconds: Math.floor(process.uptime()),
          timestamp: new Date().toISOString(),
          warnings: [...warningCodes],
        };
      },
    );
  };
}

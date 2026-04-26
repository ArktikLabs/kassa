import type { FastifyInstance } from "fastify";
import { z } from "zod";

const healthResponseSchema = z
  .object({
    status: z.literal("ok"),
    service: z.literal("kassa-api"),
    version: z.string(),
    uptimeSeconds: z.number().int().nonnegative(),
    timestamp: z.string().datetime({ offset: true }),
  })
  .strict()
  .describe(
    "Liveness payload for uptime monitors. Intentionally unversioned so " +
      "monitors do not need to track API versions.",
  );

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // KASSA_API_VERSION is injected at deploy time (commit SHA). Falls back to
  // the workspace package version when running outside a deploy (local dev,
  // CI tests). The smoke-test job in .github/workflows/cd.yml asserts that
  // this field matches the deployed commit before calling a release green.
  const version = process.env.KASSA_API_VERSION ?? process.env.npm_package_version ?? "0.0.0";

  app.get(
    "/health",
    {
      schema: {
        tags: ["health"],
        summary: "Liveness probe",
        description:
          "Always returns 200 when the process can serve requests. Mounted at " +
          "the root (not under `/v1`) so external monitors do not have to " +
          "track API versions.",
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
      };
    },
  );
}

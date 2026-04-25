import type { FastifyInstance } from "fastify";

export interface HealthResponse {
  status: "ok";
  service: "kassa-api";
  version: string;
  uptimeSeconds: number;
  timestamp: string;
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // KASSA_API_VERSION is injected at deploy time (commit SHA). Falls back to
  // the workspace package version when running outside a deploy (local dev,
  // CI tests). The smoke-test job in .github/workflows/cd.yml asserts that
  // this field matches the deployed commit before calling a release green.
  const version = process.env.KASSA_API_VERSION ?? process.env.npm_package_version ?? "0.0.0";

  app.get("/health", async (): Promise<HealthResponse> => {
    return {
      status: "ok",
      service: "kassa-api",
      version,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  });
}

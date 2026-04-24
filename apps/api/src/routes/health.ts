import type { FastifyInstance } from "fastify";

export interface HealthResponse {
  status: "ok";
  service: "kassa-api";
  version: string;
  uptimeSeconds: number;
  timestamp: string;
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  const version = process.env.npm_package_version ?? "0.0.0";

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

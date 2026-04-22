import type { FastifyInstance } from "fastify";
import { notImplemented } from "../lib/errors.js";

export async function salesRoutes(app: FastifyInstance): Promise<void> {
  app.post("/", async (_req, reply) =>
    notImplemented(reply, "POST /v1/sales"),
  );

  app.get("/:saleId", async (_req, reply) =>
    notImplemented(reply, "GET /v1/sales/:saleId"),
  );

  app.post("/:saleId/void", async (_req, reply) =>
    notImplemented(reply, "POST /v1/sales/:saleId/void"),
  );

  app.post("/:saleId/refund", async (_req, reply) =>
    notImplemented(reply, "POST /v1/sales/:saleId/refund"),
  );

  app.post("/sync", async (_req, reply) =>
    notImplemented(reply, "POST /v1/sales/sync"),
  );
}

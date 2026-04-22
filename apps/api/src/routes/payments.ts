import type { FastifyInstance } from "fastify";
import { notImplemented } from "../lib/errors.js";

export async function paymentsRoutes(app: FastifyInstance): Promise<void> {
  app.post("/qris", async (_req, reply) =>
    notImplemented(reply, "POST /v1/payments/qris"),
  );

  app.get("/qris/:orderId/status", async (_req, reply) =>
    notImplemented(reply, "GET /v1/payments/qris/:orderId/status"),
  );

  app.post("/webhooks/midtrans", async (_req, reply) =>
    notImplemented(reply, "POST /v1/payments/webhooks/midtrans"),
  );
}

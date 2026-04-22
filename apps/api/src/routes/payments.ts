import type { FastifyInstance } from "fastify";
import { notImplemented } from "../lib/errors.js";

export async function paymentsRoutes(app: FastifyInstance): Promise<void> {
  app.post("/qris", async (req, reply) => notImplemented(req, reply));
  app.get("/qris/:orderId/status", async (req, reply) => notImplemented(req, reply));
  app.post("/webhooks/midtrans", async (req, reply) => notImplemented(req, reply));
}

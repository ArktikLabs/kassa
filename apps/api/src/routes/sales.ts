import type { FastifyInstance } from "fastify";
import { notImplemented } from "../lib/errors.js";

export async function salesRoutes(app: FastifyInstance): Promise<void> {
  app.post("/", async (req, reply) => notImplemented(req, reply));
  app.get("/:saleId", async (req, reply) => notImplemented(req, reply));
  app.post("/:saleId/void", async (req, reply) => notImplemented(req, reply));
  app.post("/:saleId/refund", async (req, reply) => notImplemented(req, reply));
  app.post("/sync", async (req, reply) => notImplemented(req, reply));
}

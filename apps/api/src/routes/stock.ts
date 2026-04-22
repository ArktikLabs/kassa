import type { FastifyInstance } from "fastify";
import { notImplemented } from "../lib/errors.js";

export async function stockRoutes(app: FastifyInstance): Promise<void> {
  app.get("/snapshot", async (req, reply) => notImplemented(req, reply));
  app.get("/ledger", async (req, reply) => notImplemented(req, reply));
}

import type { FastifyInstance } from "fastify";
import { notImplemented } from "../lib/errors.js";

export async function outletsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (req, reply) => notImplemented(req, reply));
  app.get("/:outletId", async (req, reply) => notImplemented(req, reply));
}

import type { FastifyInstance } from "fastify";
import { notImplemented } from "../lib/errors.js";

export async function eodRoutes(app: FastifyInstance): Promise<void> {
  app.post("/close", async (req, reply) => notImplemented(req, reply));
  app.get("/report", async (req, reply) => notImplemented(req, reply));
  app.get("/:eodId", async (req, reply) => notImplemented(req, reply));
}

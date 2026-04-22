import type { FastifyInstance } from "fastify";
import { notImplemented } from "../lib/errors.js";

export async function outletsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (_req, reply) =>
    notImplemented(reply, "GET /v1/outlets"),
  );

  app.get("/:outletId", async (_req, reply) =>
    notImplemented(reply, "GET /v1/outlets/:outletId"),
  );
}

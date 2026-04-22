import type { FastifyInstance } from "fastify";
import { notImplemented } from "../lib/errors.js";

export async function stockRoutes(app: FastifyInstance): Promise<void> {
  app.get("/snapshot", async (_req, reply) =>
    notImplemented(reply, "GET /v1/stock/snapshot"),
  );

  app.get("/ledger", async (_req, reply) =>
    notImplemented(reply, "GET /v1/stock/ledger"),
  );
}

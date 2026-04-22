import type { FastifyInstance } from "fastify";
import { notImplemented } from "../lib/errors.js";

export async function eodRoutes(app: FastifyInstance): Promise<void> {
  app.post("/close", async (_req, reply) =>
    notImplemented(reply, "POST /v1/eod/close"),
  );

  app.get("/report", async (_req, reply) =>
    notImplemented(reply, "GET /v1/eod/report"),
  );

  app.get("/:eodId", async (_req, reply) =>
    notImplemented(reply, "GET /v1/eod/:eodId"),
  );
}

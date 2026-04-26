import type { FastifyInstance } from "fastify";
import { notImplemented } from "../lib/errors.js";
import { notImplementedResponses } from "../lib/openapi.js";

export async function stockRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/snapshot",
    {
      schema: {
        tags: ["stock"],
        summary: "Per-outlet stock snapshot (not implemented)",
        description: "Will return on-hand quantities per outlet. Lands with KASA-23.",
        response: notImplementedResponses,
      },
    },
    async (req, reply) => notImplemented(req, reply),
  );
  app.get(
    "/ledger",
    {
      schema: {
        tags: ["stock"],
        summary: "Stock movement ledger (not implemented)",
        description: "Will return the stock movement ledger. Lands with KASA-23.",
        response: notImplementedResponses,
      },
    },
    async (req, reply) => notImplemented(req, reply),
  );
}

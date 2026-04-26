import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notImplemented } from "../lib/errors.js";
import { notImplementedResponses } from "../lib/openapi.js";

const saleIdParam = z.object({ saleId: z.string().uuid() }).strict();

export async function salesRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/",
    {
      schema: {
        tags: ["sales"],
        summary: "Create a sale (not implemented)",
        description: "Will create a new sale on the server. Lands with KASA-23.",
        response: notImplementedResponses,
      },
    },
    async (req, reply) => notImplemented(req, reply),
  );
  app.get(
    "/:saleId",
    {
      schema: {
        tags: ["sales"],
        summary: "Fetch a sale (not implemented)",
        description: "Will return a single sale by id. Lands with KASA-23.",
        params: saleIdParam,
        response: notImplementedResponses,
      },
    },
    async (req, reply) => notImplemented(req, reply),
  );
  app.post(
    "/:saleId/void",
    {
      schema: {
        tags: ["sales"],
        summary: "Void a sale (not implemented)",
        description: "Will void a sale that has not yet been settled. Lands with KASA-23.",
        params: saleIdParam,
        response: notImplementedResponses,
      },
    },
    async (req, reply) => notImplemented(req, reply),
  );
  app.post(
    "/:saleId/refund",
    {
      schema: {
        tags: ["sales"],
        summary: "Refund a sale (not implemented)",
        description: "Will refund a settled sale. Lands with KASA-23.",
        params: saleIdParam,
        response: notImplementedResponses,
      },
    },
    async (req, reply) => notImplemented(req, reply),
  );
  app.post(
    "/sync",
    {
      schema: {
        tags: ["sales"],
        summary: "Sync queued offline sales (not implemented)",
        description:
          "Will accept the POS's queued sales batch from the offline outbox " +
          "and reconcile them server-side. Lands with KASA-23.",
        response: notImplementedResponses,
      },
    },
    async (req, reply) => notImplemented(req, reply),
  );
}

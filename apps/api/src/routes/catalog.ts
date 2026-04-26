import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notImplemented } from "../lib/errors.js";
import { notImplementedResponses } from "../lib/openapi.js";

const itemIdParam = z.object({ itemId: z.string().uuid() }).strict();

export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/items",
    {
      schema: {
        tags: ["catalog"],
        summary: "List catalog items (not implemented)",
        description: "Will return the merchant's catalog items. Lands with KASA-23.",
        response: notImplementedResponses,
      },
    },
    async (req, reply) => notImplemented(req, reply),
  );
  app.get(
    "/items/:itemId",
    {
      schema: {
        tags: ["catalog"],
        summary: "Fetch a catalog item (not implemented)",
        description: "Will return a single catalog item by id. Lands with KASA-23.",
        params: itemIdParam,
        response: notImplementedResponses,
      },
    },
    async (req, reply) => notImplemented(req, reply),
  );
  app.get(
    "/boms",
    {
      schema: {
        tags: ["catalog"],
        summary: "List BOMs (not implemented)",
        description: "Will return bill-of-materials definitions. Lands with KASA-23.",
        response: notImplementedResponses,
      },
    },
    async (req, reply) => notImplemented(req, reply),
  );
  app.get(
    "/uoms",
    {
      schema: {
        tags: ["catalog"],
        summary: "List units of measure (not implemented)",
        description: "Will return units of measure used by the catalog. Lands with KASA-23.",
        response: notImplementedResponses,
      },
    },
    async (req, reply) => notImplemented(req, reply),
  );
  app.get(
    "/modifiers",
    {
      schema: {
        tags: ["catalog"],
        summary: "List item modifiers (not implemented)",
        description: "Will return item modifier groups. Lands with KASA-23.",
        response: notImplementedResponses,
      },
    },
    async (req, reply) => notImplemented(req, reply),
  );
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notImplemented } from "../lib/errors.js";
import { notImplementedResponses } from "../lib/openapi.js";

const outletIdParam = z.object({ outletId: z.string().uuid() }).strict();

export async function outletsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/",
    {
      schema: {
        tags: ["outlets"],
        summary: "List outlets (not implemented)",
        description: "Will return outlets configured under the merchant. Lands with KASA-23.",
        response: notImplementedResponses,
      },
    },
    async (req, reply) => notImplemented(req, reply),
  );
  app.get(
    "/:outletId",
    {
      schema: {
        tags: ["outlets"],
        summary: "Fetch an outlet (not implemented)",
        description: "Will return a single outlet by id. Lands with KASA-23.",
        params: outletIdParam,
        response: notImplementedResponses,
      },
    },
    async (req, reply) => notImplemented(req, reply),
  );
}

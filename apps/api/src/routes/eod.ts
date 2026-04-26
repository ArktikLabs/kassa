import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notImplemented } from "../lib/errors.js";
import { notImplementedResponses } from "../lib/openapi.js";

const eodIdParam = z.object({ eodId: z.string().uuid() }).strict();

export async function eodRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/close",
    {
      schema: {
        tags: ["eod"],
        summary: "Close end-of-day (not implemented)",
        description:
          "Will close out the current shift, reconcile cash and QRIS tenders, " +
          "and snapshot stock movement for the outlet. Lands with KASA-23.",
        response: notImplementedResponses,
      },
    },
    async (req, reply) => notImplemented(req, reply),
  );
  app.get(
    "/report",
    {
      schema: {
        tags: ["eod"],
        summary: "End-of-day report (not implemented)",
        description: "Will return the latest end-of-day report. Lands with KASA-23.",
        response: notImplementedResponses,
      },
    },
    async (req, reply) => notImplemented(req, reply),
  );
  app.get(
    "/:eodId",
    {
      schema: {
        tags: ["eod"],
        summary: "Fetch a historical end-of-day record (not implemented)",
        description: "Will return a single end-of-day record by id. Lands with KASA-23.",
        params: eodIdParam,
        response: notImplementedResponses,
      },
    },
    async (req, reply) => notImplemented(req, reply),
  );
}

import type { FastifyInstance } from "fastify";
import { notImplemented } from "../lib/errors.js";

export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  app.get("/items", async (_req, reply) =>
    notImplemented(reply, "GET /v1/catalog/items"),
  );

  app.get("/items/:itemId", async (_req, reply) =>
    notImplemented(reply, "GET /v1/catalog/items/:itemId"),
  );

  app.get("/boms", async (_req, reply) =>
    notImplemented(reply, "GET /v1/catalog/boms"),
  );

  app.get("/uoms", async (_req, reply) =>
    notImplemented(reply, "GET /v1/catalog/uoms"),
  );

  app.get("/modifiers", async (_req, reply) =>
    notImplemented(reply, "GET /v1/catalog/modifiers"),
  );
}

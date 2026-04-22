import type { FastifyInstance } from "fastify";
import { notImplemented } from "../lib/errors.js";

export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  app.get("/items", async (req, reply) => notImplemented(req, reply));
  app.get("/items/:itemId", async (req, reply) => notImplemented(req, reply));
  app.get("/boms", async (req, reply) => notImplemented(req, reply));
  app.get("/uoms", async (req, reply) => notImplemented(req, reply));
  app.get("/modifiers", async (req, reply) => notImplemented(req, reply));
}

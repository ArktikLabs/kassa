import type { FastifyInstance } from "fastify";
import { notImplemented } from "../lib/errors.js";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/enroll", async (req, reply) => notImplemented(req, reply));
  app.post("/heartbeat", async (req, reply) => notImplemented(req, reply));
  app.post("/pin/verify", async (req, reply) => notImplemented(req, reply));
  app.post("/session/login", async (req, reply) => notImplemented(req, reply));
  app.post("/session/logout", async (req, reply) => notImplemented(req, reply));
}

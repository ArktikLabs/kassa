import type { FastifyInstance } from "fastify";
import { notImplemented } from "../lib/errors.js";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/enroll", async (_req, reply) =>
    notImplemented(reply, "POST /v1/auth/enroll"),
  );

  app.post("/heartbeat", async (_req, reply) =>
    notImplemented(reply, "POST /v1/auth/heartbeat"),
  );

  app.post("/pin/verify", async (_req, reply) =>
    notImplemented(reply, "POST /v1/auth/pin/verify"),
  );

  app.post("/session/login", async (_req, reply) =>
    notImplemented(reply, "POST /v1/auth/session/login"),
  );

  app.post("/session/logout", async (_req, reply) =>
    notImplemented(reply, "POST /v1/auth/session/logout"),
  );
}

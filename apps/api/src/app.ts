import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import type { PaymentProvider } from "@kassa/payments";
import { healthRoutes } from "./routes/health.js";
import { registerV1Routes } from "./routes/index.js";
import { sendError } from "./lib/errors.js";
import {
  createDomainEventBus,
  type DomainEventBus,
} from "./lib/events.js";
import {
  createInMemoryDedupeStore,
  type WebhookDedupeStore,
} from "./lib/webhook-dedupe.js";

export interface BuildAppOptions {
  logger?: FastifyServerOptions["logger"];
  midtransProvider?: PaymentProvider | undefined;
  events?: DomainEventBus;
  webhookDedupe?: WebhookDedupeStore;
}

declare module "fastify" {
  interface FastifyInstance {
    events: DomainEventBus;
    webhookDedupe: WebhookDedupeStore;
    midtransProvider: PaymentProvider | null;
  }
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    disableRequestLogging: false,
    trustProxy: true,
  });

  app.decorate("events", options.events ?? createDomainEventBus());
  app.decorate(
    "webhookDedupe",
    options.webhookDedupe ?? createInMemoryDedupeStore(),
  );
  app.decorate("midtransProvider", options.midtransProvider ?? null);

  app.setNotFoundHandler((req, reply) => {
    sendError(reply, 404, "not_found", `No route for ${req.method} ${req.url}.`);
  });

  app.setErrorHandler((err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    req.log.error({ err }, "request failed");
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    const code = status >= 500 ? "internal_error" : (err.code ?? "bad_request").toLowerCase();
    const message = status >= 500 ? "Internal server error." : err.message;
    sendError(reply, status, code, message);
  });

  await app.register(healthRoutes);
  await app.register(registerV1Routes, { prefix: "/v1" });

  return app;
}

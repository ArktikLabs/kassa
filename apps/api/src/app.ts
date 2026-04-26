import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type { PaymentProvider } from "@kassa/payments";
import { healthRoutes } from "./routes/health.js";
import { registerV1Routes, type V1RouteDeps } from "./routes/index.js";
import { sendError } from "./lib/errors.js";
import { createDomainEventBus, type DomainEventBus } from "./lib/events.js";
import { registerOpenapi } from "./lib/openapi.js";
import { createInMemoryDedupeStore, type WebhookDedupeStore } from "./lib/webhook-dedupe.js";
import { EnrolmentService, InMemoryEnrolmentRepository } from "./services/enrolment/index.js";

export interface BuildAppOptions {
  logger?: FastifyServerOptions["logger"];
  midtransProvider?: PaymentProvider | undefined;
  events?: DomainEventBus;
  webhookDedupe?: WebhookDedupeStore;
  enrolment?: {
    service: EnrolmentService;
    staffBootstrapToken?: string;
    enrollRateLimitPerMinute?: number;
  };
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
  app.decorate("webhookDedupe", options.webhookDedupe ?? createInMemoryDedupeStore());
  app.decorate("midtransProvider", options.midtransProvider ?? null);

  // Wire fastify-type-provider-zod so route schemas authored as Zod are
  // both runtime-validated AND emitted to OpenAPI from the same definition.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setNotFoundHandler((req, reply) => {
    sendError(reply, 404, "not_found", `No route for ${req.method} ${req.url}.`);
  });

  app.setErrorHandler((err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    // Map Zod schema-validation failures to the existing `bad_request`
    // contract so clients keep getting `{ error: { code, message, details } }`
    // rather than Fastify's default validation envelope.
    if (hasZodFastifySchemaValidationErrors(err)) {
      sendError(reply, 400, "bad_request", "Invalid request.", err.validation);
      return;
    }
    req.log.error({ err }, "request failed");
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    const code = status >= 500 ? "internal_error" : (err.code ?? "bad_request").toLowerCase();
    const message = status >= 500 ? "Internal server error." : err.message;
    sendError(reply, status, code, message);
  });

  const enrolment = options.enrolment ?? {
    service: new EnrolmentService({ repository: new InMemoryEnrolmentRepository() }),
  };

  const v1Deps: V1RouteDeps = {
    auth: {
      enrolment: enrolment.service,
      ...(enrolment.staffBootstrapToken !== undefined
        ? { staffBootstrapToken: enrolment.staffBootstrapToken }
        : {}),
      ...(enrolment.enrollRateLimitPerMinute !== undefined
        ? { enrollRateLimitPerMinute: enrolment.enrollRateLimitPerMinute }
        : {}),
    },
  };

  // Swagger MUST be registered before routes so it can capture them.
  await registerOpenapi(app);

  await app.register(healthRoutes);
  await app.register(async (instance) => registerV1Routes(instance, v1Deps), { prefix: "/v1" });

  return app;
}

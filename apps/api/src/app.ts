import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import type { PaymentProvider } from "@kassa/payments";
import { healthRoutes } from "./routes/health.js";
import { registerV1Routes, type V1RouteDeps } from "./routes/index.js";
import { sendError } from "./lib/errors.js";
import { createDomainEventBus, type DomainEventBus } from "./lib/events.js";
import { createInMemoryDedupeStore, type WebhookDedupeStore } from "./lib/webhook-dedupe.js";
import { EnrolmentService, InMemoryEnrolmentRepository } from "./services/enrolment/index.js";
import { InMemoryItemsRepository, ItemsService } from "./services/catalog/index.js";
import {
  EodService,
  InMemoryEodRepository,
  SalesRepositorySalesReader,
} from "./services/eod/index.js";
import {
  InMemorySalesRepository,
  SalesService,
  type SalesRepository,
} from "./services/sales/index.js";

const BOOTSTRAP_MERCHANT_ID = "01890abc-1234-7def-8000-00000000a001";

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
  eod?: {
    service: EodService;
    resolveMerchantId?: () => string;
  };
  catalog?: {
    items: ItemsService;
    staffBootstrapToken?: string;
  };
  sales?: {
    service: SalesService;
    repository: SalesRepository;
  };
  /**
   * Resolves the merchantId for incoming requests. Defaults to reading the
   * `x-kassa-merchant-id` header so test fixtures and the POS client can
   * send a merchant context without waiting for KASA-25 JWT auth.
   */
  resolveMerchantId?: (req: { headers: Record<string, unknown> }) => string | null;
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

  const enrolment = options.enrolment ?? {
    service: new EnrolmentService({ repository: new InMemoryEnrolmentRepository() }),
  };

  const catalog = options.catalog ?? {
    items: new ItemsService({ repository: new InMemoryItemsRepository() }),
  };

  const salesRepository = options.sales?.repository ?? new InMemorySalesRepository();
  const salesService = options.sales?.service ?? new SalesService({ repository: salesRepository });
  const resolveRequestMerchantId = options.resolveMerchantId ?? defaultMerchantResolver;

  const eod = options.eod ?? {
    service: new EodService({
      salesReader: new SalesRepositorySalesReader(salesRepository),
      eodRepository: new InMemoryEodRepository(),
    }),
  };
  const resolveEodMerchantId = eod.resolveMerchantId ?? (() => BOOTSTRAP_MERCHANT_ID);

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
    catalog: {
      items: catalog.items,
      ...(catalog.staffBootstrapToken !== undefined
        ? { staffBootstrapToken: catalog.staffBootstrapToken }
        : {}),
    },
    sales: {
      service: salesService,
      resolveMerchantId: resolveRequestMerchantId,
    },
    stock: {
      repository: salesRepository,
      resolveMerchantId: resolveRequestMerchantId,
    },
    eod: { service: eod.service, resolveMerchantId: resolveEodMerchantId },
  };

  await app.register(healthRoutes);
  await app.register(async (instance) => registerV1Routes(instance, v1Deps), { prefix: "/v1" });

  return app;
}

// TODO(KASA-25): replace with a JWT-derived merchant resolver before this
// endpoint is reachable from anything other than the trusted PWA on a private
// network. The header-only resolver lets any caller claim any merchantId.
function defaultMerchantResolver(req: { headers: Record<string, unknown> }): string | null {
  const header = req.headers["x-kassa-merchant-id"];
  if (typeof header === "string" && header.length > 0) return header;
  if (Array.isArray(header) && typeof header[0] === "string" && header[0].length > 0) {
    return header[0];
  }
  return null;
}

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
import { makeDeviceAuthPreHandler, type DeviceAuthRepository } from "./auth/device-auth.js";
import { healthRoutes } from "./routes/health.js";
import { registerV1Routes, type V1RouteDeps } from "./routes/index.js";
import { sendError } from "./lib/errors.js";
import { createDomainEventBus, type DomainEventBus } from "./lib/events.js";
import { registerOpenapi } from "./lib/openapi.js";
import { createInMemoryDedupeStore, type WebhookDedupeStore } from "./lib/webhook-dedupe.js";
import { EnrolmentService, InMemoryEnrolmentRepository } from "./services/enrolment/index.js";
import {
  BomsService,
  InMemoryBomsRepository,
  InMemoryItemsRepository,
  InMemoryUomsRepository,
  ItemsService,
  UomsService,
} from "./services/catalog/index.js";
import {
  EodService,
  InMemoryEodRepository,
  SalesRepositorySalesReader,
} from "./services/eod/index.js";
import { InMemoryOutletsRepository, OutletsService } from "./services/outlets/index.js";
import {
  InMemoryReconciliationRepository,
  ReconciliationService,
} from "./services/reconciliation/index.js";
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
    boms?: BomsService;
    uoms?: UomsService;
    staffBootstrapToken?: string;
  };
  outlets?: {
    service: OutletsService;
    staffBootstrapToken?: string;
  };
  reconciliation?: {
    service: ReconciliationService;
    staffBootstrapToken?: string;
  };
  sales?: {
    service: SalesService;
    repository: SalesRepository;
  };
  /**
   * Device-authentication repository. Defaults to the same in-memory store
   * the EnrolmentService is wired against, so a `buildApp()` with no options
   * boots into a coherent state where a device enrolled via
   * `POST /v1/auth/enroll` can immediately authenticate against routes
   * gated by `requireDevice`.
   */
  deviceAuth?: {
    repository: DeviceAuthRepository;
    now?: () => Date;
  };
  /**
   * Resolves the merchantId for incoming requests. Defaults to preferring
   * `req.devicePrincipal.merchantId` (set by the device-auth middleware) and
   * falling back to the `x-kassa-merchant-id` header so test fixtures and
   * un-gated routes still work during the bootstrap window.
   */
  resolveMerchantId?: (req: FastifyRequest) => string | null;
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

  // Build a single in-memory repository when no overrides are provided so the
  // EnrolmentService and the device-auth lookups share the same store. With
  // separate stores, an enrolled device would never authenticate.
  const fallbackEnrolmentRepository =
    options.enrolment && options.deviceAuth ? null : new InMemoryEnrolmentRepository();

  const enrolment = options.enrolment ?? {
    service: new EnrolmentService({ repository: fallbackEnrolmentRepository! }),
  };

  const deviceAuthRepository = options.deviceAuth?.repository ?? fallbackEnrolmentRepository;
  if (!deviceAuthRepository) {
    throw new Error(
      "buildApp: device-auth repository missing — pass `deviceAuth.repository` when supplying a custom `enrolment.service`.",
    );
  }
  const requireDevice = makeDeviceAuthPreHandler({
    repository: deviceAuthRepository,
    ...(options.deviceAuth?.now ? { now: options.deviceAuth.now } : {}),
  });

  const catalog = options.catalog ?? {
    items: new ItemsService({ repository: new InMemoryItemsRepository() }),
  };
  const catalogBoms = catalog.boms ?? new BomsService({ repository: new InMemoryBomsRepository() });
  const catalogUoms = catalog.uoms ?? new UomsService({ repository: new InMemoryUomsRepository() });

  const outletsCfg = options.outlets ?? {
    service: new OutletsService({ repository: new InMemoryOutletsRepository() }),
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

  // Reconciliation needs a PaymentProvider for settlement fetches; fall back
  // to a no-rows stub when one is not configured so the admin routes still
  // register and the manual-match path stays usable.
  const reconciliation = options.reconciliation ?? {
    service: new ReconciliationService({
      repository: new InMemoryReconciliationRepository(),
      provider: options.midtransProvider ?? makeNoSettlementProvider(),
    }),
  };

  const v1Deps: V1RouteDeps = {
    requireDevice,
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
      boms: catalogBoms,
      uoms: catalogUoms,
      ...(catalog.staffBootstrapToken !== undefined
        ? { staffBootstrapToken: catalog.staffBootstrapToken }
        : {}),
    },
    outlets: {
      outlets: outletsCfg.service,
      ...(outletsCfg.staffBootstrapToken !== undefined
        ? { staffBootstrapToken: outletsCfg.staffBootstrapToken }
        : {}),
    },
    sales: {
      service: salesService,
      resolveMerchantId: resolveRequestMerchantId,
    },
    stock: {
      repository: salesRepository,
      service: salesService,
      resolveMerchantId: resolveRequestMerchantId,
    },
    eod: { service: eod.service, resolveMerchantId: resolveEodMerchantId },
    reconciliation: {
      service: reconciliation.service,
      ...(reconciliation.staffBootstrapToken !== undefined
        ? { staffBootstrapToken: reconciliation.staffBootstrapToken }
        : {}),
    },
  };

  // Swagger MUST be registered before routes so it can capture them.
  await registerOpenapi(app);

  await app.register(healthRoutes);
  await app.register(async (instance) => registerV1Routes(instance, v1Deps), { prefix: "/v1" });

  return app;
}

// Prefers the merchantId derived from a verified device session
// (`req.devicePrincipal`, populated by the device-auth preHandler). Falls
// back to the `x-kassa-merchant-id` header so routes that have not yet
// adopted the device-auth gate continue to work during the rollout.
//
// Once every device-facing route has the gate applied, the header path
// can be retired with KASA-26 (RBAC).
function defaultMerchantResolver(req: FastifyRequest): string | null {
  if (req.devicePrincipal?.merchantId) return req.devicePrincipal.merchantId;
  const header = req.headers["x-kassa-merchant-id"];
  if (typeof header === "string" && header.length > 0) return header;
  if (Array.isArray(header) && typeof header[0] === "string" && header[0].length > 0) {
    return header[0];
  }
  return null;
}

// Stub provider used when no Midtrans provider is configured. Returns zero
// settlements for every fetch so the reconciliation pass runs cleanly (zero
// matches) instead of crashing — matters for the manual-match route which
// the operator can still use independently of automated settlement fetches.
function makeNoSettlementProvider(): PaymentProvider {
  return {
    name: "no-settlement-stub",
    async createQris() {
      throw new Error("payments provider not configured");
    },
    async getQrisStatus() {
      throw new Error("payments provider not configured");
    },
    verifyWebhookSignature() {
      throw new Error("payments provider not configured");
    },
    async fetchQrisSettlements() {
      return [];
    },
  };
}

// OTEL boot must precede the Fastify import so any future auto-instrumentation
// shim sees Fastify load through its hook. Today the SDK runs without
// auto-instrumentations (KASA-284 only ships manual spans on `sale.submit`
// and `eod.close`), but the side-effect-import ordering is the contract that
// keeps the door open for adding `@opentelemetry/auto-instrumentations-node`
// in a follow-up without re-shuffling the entrypoint.
import "./lib/otel-bootstrap.js";
import { shutdownOtel } from "./lib/otel.js";

import { createMidtransProvider, type PaymentProvider } from "@kassa/payments";
import { buildApp } from "./app.js";
import { collectStartupWarnings, loadEnv } from "./config.js";
import { createDatabase, type DatabaseHandle } from "./db/client.js";
import { initSentry, Sentry } from "./lib/sentry.js";
import { EnrolmentService, InMemoryEnrolmentRepository } from "./services/enrolment/index.js";
import { InMemoryStaffRepository, type StaffRepository } from "./services/staff/index.js";
import {
  InMemoryItemsRepository,
  ItemsService,
  PgItemsRepository,
  type ItemsRepository,
} from "./services/catalog/index.js";
import {
  DashboardService,
  InMemoryDashboardRepository,
  PgDashboardRepository,
  type DashboardRepository,
} from "./services/dashboard/index.js";
import {
  InMemoryMerchantsRepository,
  MerchantsService,
  PgMerchantsRepository,
  type MerchantsRepository,
} from "./services/merchants/index.js";

async function main(): Promise<void> {
  // Sentry runs before buildApp() so the Fastify error handler picks up the
  // initialised client. No-op when SENTRY_DSN is unset (dev / CI).
  initSentry();

  const env = loadEnv();
  const startupWarnings = collectStartupWarnings(env);

  // Repository binding lands in KASA-21 (Postgres + Drizzle migrations); until
  // then dev/staging boot with an in-memory store. Outlets must be seeded by
  // calling code (or via a future admin endpoint) before enrolment will work.
  const repository = new InMemoryEnrolmentRepository();
  const enrolmentService = new EnrolmentService({
    repository,
    codeTtlMs: env.ENROLMENT_CODE_TTL_MS,
  });

  // Catalog (KASA-23), merchant settings (KASA-221), and admin reports
  // (KASA-237) are merchant-scoped; bind to Postgres when DATABASE_URL is
  // set, otherwise fall back to the in-memory repos (dev convenience —
  // data is lost on restart).
  let database: DatabaseHandle | null = null;
  let itemsRepository: ItemsRepository;
  let merchantsRepository: MerchantsRepository;
  let dashboardRepository: DashboardRepository;
  if (env.DATABASE_URL) {
    database = createDatabase({ url: env.DATABASE_URL, ssl: env.DATABASE_SSL });
    itemsRepository = new PgItemsRepository(database.db);
    merchantsRepository = new PgMerchantsRepository(database.db);
    dashboardRepository = new PgDashboardRepository(database.db);
  } else {
    itemsRepository = new InMemoryItemsRepository();
    merchantsRepository = new InMemoryMerchantsRepository();
    dashboardRepository = new InMemoryDashboardRepository();
  }
  const itemsService = new ItemsService({ repository: itemsRepository });
  const merchantsService = new MerchantsService({ repository: merchantsRepository });
  const dashboardService = new DashboardService({ repository: dashboardRepository });

  let midtransProvider: PaymentProvider | undefined;
  if (env.MIDTRANS_SERVER_KEY) {
    midtransProvider = createMidtransProvider({
      serverKey: env.MIDTRANS_SERVER_KEY,
      environment: env.MIDTRANS_ENVIRONMENT,
    });
  }

  // Staff session login (KASA-183). The Postgres-backed staff repo
  // lands with seat management; until then, the in-memory repo keeps
  // production deploys booting cleanly — the route returns 401
  // `invalid_credentials` on every attempt because the repo is empty,
  // which surfaces as a normal "wrong password" toast in the UI.
  const staffRepository: StaffRepository = new InMemoryStaffRepository();

  const corsAllowedOrigins: Array<string | RegExp> = [];
  if (env.CORS_ALLOWED_ORIGINS) {
    for (const raw of env.CORS_ALLOWED_ORIGINS.split(",")) {
      const trimmed = raw.trim();
      if (trimmed.length > 0) corsAllowedOrigins.push(trimmed);
    }
  }
  // Default preview pattern matches Cloudflare Pages preview deploys
  // (`https://pr-123.kassa-back-office.pages.dev`); ops can override
  // via `CORS_PREVIEW_ORIGIN_PATTERN` (set to "" to disable).
  const previewPattern =
    env.CORS_PREVIEW_ORIGIN_PATTERN === undefined
      ? "^https://pr-\\d+\\.kassa-back-office\\.pages\\.dev$"
      : env.CORS_PREVIEW_ORIGIN_PATTERN;
  if (previewPattern.length > 0) {
    corsAllowedOrigins.push(new RegExp(previewPattern));
  }

  const app = await buildApp({
    logger: {
      level: env.LOG_LEVEL,
      ...(env.NODE_ENV === "development"
        ? { transport: { target: "pino-pretty", options: { colorize: true } } }
        : {}),
    },
    enrolment: {
      service: enrolmentService,
      ...(env.STAFF_BOOTSTRAP_TOKEN !== undefined
        ? { staffBootstrapToken: env.STAFF_BOOTSTRAP_TOKEN }
        : {}),
    },
    deviceAuth: { repository },
    catalog: {
      items: itemsService,
      ...(env.STAFF_BOOTSTRAP_TOKEN !== undefined
        ? { staffBootstrapToken: env.STAFF_BOOTSTRAP_TOKEN }
        : {}),
    },
    merchant: {
      service: merchantsService,
      ...(env.STAFF_BOOTSTRAP_TOKEN !== undefined
        ? { staffBootstrapToken: env.STAFF_BOOTSTRAP_TOKEN }
        : {}),
    },
    reports: {
      service: dashboardService,
      ...(env.STAFF_BOOTSTRAP_TOKEN !== undefined
        ? { staffBootstrapToken: env.STAFF_BOOTSTRAP_TOKEN }
        : {}),
    },
    ...(env.SESSION_COOKIE_SECRET !== undefined
      ? {
          staffSession: {
            repository: staffRepository,
            cookieSecret: env.SESSION_COOKIE_SECRET,
          },
        }
      : {}),
    ...(corsAllowedOrigins.length > 0 ? { cors: { allowedOrigins: corsAllowedOrigins } } : {}),
    ...(midtransProvider !== undefined ? { midtransProvider } : {}),
    ...(startupWarnings.length > 0 ? { startupWarnings } : {}),
  });

  if (env.STAFF_BOOTSTRAP_TOKEN === undefined) {
    app.log.warn(
      "STAFF_BOOTSTRAP_TOKEN is not set; POST /v1/auth/enrolment-codes will reject all requests with 503.",
    );
  }
  // Structured startup warnings (KASA-203 / ADR-011): pino-warn each entry
  // AND drop a Sentry breadcrumb so the degradation is visible from the
  // dashboard without grepping Fly logs. Sentry calls are no-ops when
  // SENTRY_DSN is unset (initSentry returned without instantiating a client).
  for (const warning of startupWarnings) {
    app.log.warn({ event: "startup.warning", code: warning.code }, warning.message);
    Sentry.addBreadcrumb({
      category: "startup",
      level: "warning",
      message: warning.message,
      data: { code: warning.code },
    });
    Sentry.captureMessage(warning.message, {
      level: "warning",
      tags: { component: "startup", code: warning.code },
    });
  }
  if (corsAllowedOrigins.length === 0) {
    app.log.warn(
      "No CORS allow-list configured; the back-office will be blocked by the browser when calling the API cross-origin.",
    );
  }
  if (!midtransProvider) {
    app.log.warn(
      "MIDTRANS_SERVER_KEY not set; /v1/payments/webhooks/midtrans will respond 503 until configured",
    );
  }
  app.log.warn("Enrolment store is in-memory; persistent Postgres binding lands in KASA-21.");
  if (!env.DATABASE_URL) {
    app.log.warn(
      "DATABASE_URL not set; catalog CRUD is using an in-memory items repo (data is lost on restart).",
    );
  }

  try {
    await app.listen({ host: env.HOST, port: env.PORT });
  } catch (err) {
    app.log.error({ err }, "failed to start");
    process.exit(1);
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, async () => {
      app.log.info({ signal }, "shutting down");
      try {
        await app.close();
        if (database) await database.close();
        // Flush in-flight spans before exit. Safe to call when the SDK
        // never started — `shutdownOtel` is a no-op in that case.
        await shutdownOtel();
        process.exit(0);
      } catch (err) {
        app.log.error({ err }, "shutdown failed");
        process.exit(1);
      }
    });
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("fatal", err);
  process.exit(1);
});

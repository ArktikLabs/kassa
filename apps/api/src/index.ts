import { createMidtransProvider, type PaymentProvider } from "@kassa/payments";
import { buildApp } from "./app.js";
import { loadEnv } from "./config.js";
import { createDatabase, type DatabaseHandle } from "./db/client.js";
import { EnrolmentService, InMemoryEnrolmentRepository } from "./services/enrolment/index.js";
import {
  InMemoryItemsRepository,
  ItemsService,
  PgItemsRepository,
  type ItemsRepository,
} from "./services/catalog/index.js";

async function main(): Promise<void> {
  const env = loadEnv();

  // Repository binding lands in KASA-21 (Postgres + Drizzle migrations); until
  // then dev/staging boot with an in-memory store. Outlets must be seeded by
  // calling code (or via a future admin endpoint) before enrolment will work.
  const repository = new InMemoryEnrolmentRepository();
  const enrolmentService = new EnrolmentService({
    repository,
    codeTtlMs: env.ENROLMENT_CODE_TTL_MS,
  });

  // Catalog (KASA-23) is merchant-scoped; bind to Postgres when DATABASE_URL
  // is set, otherwise fall back to the in-memory repo (dev convenience).
  let database: DatabaseHandle | null = null;
  let itemsRepository: ItemsRepository;
  if (env.DATABASE_URL) {
    database = createDatabase({ url: env.DATABASE_URL, ssl: env.DATABASE_SSL });
    itemsRepository = new PgItemsRepository(database.db);
  } else {
    itemsRepository = new InMemoryItemsRepository();
  }
  const itemsService = new ItemsService({ repository: itemsRepository });

  let midtransProvider: PaymentProvider | undefined;
  if (env.MIDTRANS_SERVER_KEY) {
    midtransProvider = createMidtransProvider({
      serverKey: env.MIDTRANS_SERVER_KEY,
      environment: env.MIDTRANS_ENVIRONMENT,
    });
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
    catalog: {
      items: itemsService,
      ...(env.STAFF_BOOTSTRAP_TOKEN !== undefined
        ? { staffBootstrapToken: env.STAFF_BOOTSTRAP_TOKEN }
        : {}),
    },
    ...(midtransProvider !== undefined ? { midtransProvider } : {}),
  });

  if (env.STAFF_BOOTSTRAP_TOKEN === undefined) {
    app.log.warn(
      "STAFF_BOOTSTRAP_TOKEN is not set; POST /v1/auth/enrolment-codes will reject all requests with 503.",
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

import { buildApp } from "./app.js";
import { loadEnv } from "./config.js";
import { EnrolmentService, InMemoryEnrolmentRepository } from "./services/enrolment/index.js";

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
  });

  if (env.STAFF_BOOTSTRAP_TOKEN === undefined) {
    app.log.warn(
      "STAFF_BOOTSTRAP_TOKEN is not set; POST /v1/auth/enrolment-codes will reject all requests with 503.",
    );
  }
  app.log.warn(
    "Enrolment store is in-memory; persistent Postgres binding lands in KASA-21.",
  );

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

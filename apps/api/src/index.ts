import { createMidtransProvider, type PaymentProvider } from "@kassa/payments";
import { buildApp } from "./app.js";
import { loadEnv } from "./config.js";

async function main(): Promise<void> {
  const env = loadEnv();

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
    midtransProvider,
  });

  if (!midtransProvider) {
    app.log.warn(
      "MIDTRANS_SERVER_KEY not set; /v1/payments/* will respond 503 until configured",
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

import { loadEnv } from "../config.js";

// Placeholder worker entrypoint.
//
// TECH-STACK.md §5.2 specifies a two-process model (web + worker) on a single
// image. Redis / BullMQ provisioning is not yet in place, so this process
// idles until a real queue consumer lands. It responds to SIGTERM so Fly
// machines auto_stop cleanly.

function emit(
  level: "info" | "debug" | "error",
  msg: string,
  extra: Record<string, unknown> = {},
): void {
  // biome-ignore lint/suspicious/noConsole: stdout is the worker's log channel; pino lands with the real queue consumer.
  console.log(JSON.stringify({ level, msg, pid: process.pid, ...extra }));
}

async function main(): Promise<void> {
  const env = loadEnv();
  emit("info", "kassa-worker up (idle; no queue broker configured)", {
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
  });

  const heartbeat = setInterval(() => {
    emit("debug", "worker heartbeat");
  }, 60_000);

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeat);
    emit("info", "worker shutdown", { signal });
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await new Promise<void>(() => {});
}

main().catch((err) => {
  emit("error", "worker fatal", { err: String(err) });
  process.exit(1);
});

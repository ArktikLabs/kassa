import { Queue, Worker, type Processor } from "bullmq";
import { Redis, type RedisOptions } from "ioredis";

import { loadEnv } from "../config.js";

// BullMQ worker entrypoint for the `worker` Fly process group (TECH-STACK.md
// §5.2 + §7). One image, two process commands; this one runs no HTTP and
// consumes jobs off Redis.
//
// KASA-111 lands the broker + bootstrap. The actual job code (nightly
// reconciliation, EOD rollups, sync replays, …) lands per-feature in the
// follow-up issues that mention this one. Until then, the bootstrap registers
// a single `kassa.system.heartbeat` queue with a no-op processor so the BullMQ
// connection lifecycle, error reporting, and graceful-shutdown hooks are
// exercised end-to-end on every staging deploy.
//
// Behaviour matrix:
//
//   REDIS_URL set     → connect to Redis, register the heartbeat consumer,
//                       block on SIGTERM/SIGINT, drain in-flight jobs cleanly.
//   REDIS_URL unset   → idle loop only. Logs a warning so the operator knows
//                       no broker is bound; intended for the dev/test path
//                       and for the brief window after this PR ships and
//                       before ops finishes setting the Fly secret. Once
//                       KASA-120 (or any real consumer) lands, the gate in
//                       config.ts should flip to required-in-production and
//                       this branch becomes a startup error in prod.

const PLACEHOLDER_QUEUE = "kassa.system.heartbeat";

type LogLevel = "debug" | "info" | "warn" | "error";

function emit(level: LogLevel, msg: string, extra: Record<string, unknown> = {}): void {
  // biome-ignore lint/suspicious/noConsole: stdout is the worker's log channel until pino lands here.
  console.log(JSON.stringify({ level, msg, pid: process.pid, ...extra }));
}

// Connection options BullMQ needs for a long-running worker. `maxRetriesPerRequest:
// null` is BullMQ's required setting — without it, ioredis aborts blocking
// commands (BRPOPLPUSH, the core BullMQ primitive) after N retries and the
// worker silently stops consuming. `enableReadyCheck: false` keeps the worker
// from crashing on transient `INFO` failures while Redis is restarting.
const REDIS_CONNECTION_OPTIONS: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

const heartbeatProcessor: Processor = async (job) => {
  emit("debug", "heartbeat job processed", { jobId: job.id, name: job.name });
};

interface RunningWorker {
  shutdown: (signal: NodeJS.Signals) => Promise<void>;
}

async function startBullMqWorker(redisUrl: string): Promise<RunningWorker> {
  const connection = new Redis(redisUrl, REDIS_CONNECTION_OPTIONS);

  connection.on("error", (err: Error) => {
    emit("error", "redis connection error", { err: String(err) });
  });

  // Holding a `Queue` reference (not just the `Worker`) keeps the producer-side
  // surface available to the rest of the process — future enqueues from the
  // web tier will reach for queues that mirror this shape. Closing both on
  // shutdown is what releases the underlying ioredis sockets.
  const queue = new Queue(PLACEHOLDER_QUEUE, { connection });

  const worker = new Worker(PLACEHOLDER_QUEUE, heartbeatProcessor, {
    connection,
    // Concurrency 1 is fine for a placeholder; KASA-120's processor will set
    // its own number based on the job's I/O profile.
    concurrency: 1,
  });

  worker.on("ready", () => {
    emit("info", "bullmq worker ready", { queue: PLACEHOLDER_QUEUE });
  });
  worker.on("error", (err) => {
    emit("error", "bullmq worker error", { err: String(err) });
  });
  worker.on("failed", (job, err) => {
    emit("error", "bullmq job failed", {
      jobId: job?.id,
      name: job?.name,
      err: String(err),
    });
  });

  return {
    shutdown: async (signal) => {
      emit("info", "worker shutdown begin", { signal });
      // Worker.close() waits for in-flight jobs to finish (default token
      // timeout 30s) before resolving. Queue.close() then quits the producer
      // connection. Order matters: drain consumers first.
      try {
        await worker.close();
      } catch (err) {
        emit("error", "worker close failed", { err: String(err) });
      }
      try {
        await queue.close();
      } catch (err) {
        emit("error", "queue close failed", { err: String(err) });
      }
      try {
        await connection.quit();
      } catch (err) {
        emit("error", "redis quit failed", { err: String(err) });
      }
      emit("info", "worker shutdown complete", { signal });
    },
  };
}

function startIdleStub(): RunningWorker {
  emit("warn", "kassa-worker idle: REDIS_URL not configured", {
    note: "set REDIS_URL on the Fly app to bind the BullMQ broker (see docs/CI-CD.md §3.4)",
  });
  const heartbeat = setInterval(() => {
    emit("debug", "worker heartbeat (idle stub)");
  }, 60_000);
  return {
    shutdown: async (signal) => {
      clearInterval(heartbeat);
      emit("info", "idle worker shutdown", { signal });
    },
  };
}

async function main(): Promise<void> {
  const env = loadEnv();

  const running = env.REDIS_URL ? await startBullMqWorker(env.REDIS_URL) : startIdleStub();

  emit("info", "kassa-worker up", {
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    broker: env.REDIS_URL ? "bullmq" : "idle",
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    running
      .shutdown(signal)
      .then(() => process.exit(0))
      .catch((err) => {
        emit("error", "shutdown handler threw", { err: String(err) });
        process.exit(1);
      });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await new Promise<void>(() => {});
}

main().catch((err) => {
  emit("error", "worker fatal", { err: String(err) });
  process.exit(1);
});

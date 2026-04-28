import type { PaymentProvider, SettlementReportFilter } from "@kassa/payments";
import { Redis, type RedisOptions } from "ioredis";

import { loadEnv } from "../config.js";
import { initSentry, Sentry } from "../lib/sentry.js";
import {
  InMemoryReconciliationRepository,
  ReconciliationService,
} from "../services/reconciliation/index.js";
import {
  bootReconciliationQueue,
  type LogHook,
  type RunningReconciliationQueue,
} from "./reconciliation-job.js";

/*
 * BullMQ worker entrypoint for the `worker` Fly process group (TECH-STACK.md
 * §5.2 + §7). One image, two process commands; this one runs no HTTP and
 * consumes jobs off Redis.
 *
 * Behaviour matrix:
 *
 *   REDIS_URL set     → connect to Redis, register the nightly reconciliation
 *                       queue + cron scheduler (KASA-120), block on
 *                       SIGTERM/SIGINT, drain in-flight jobs cleanly.
 *   REDIS_URL unset   → idle loop only. Logs a warning so the operator knows
 *                       no broker is bound; intended for the dev/test path
 *                       and for the brief window after this PR ships and
 *                       before ops sets the Fly secret. Once the production
 *                       Redis is wired permanently, the gate in config.ts
 *                       should flip to required-in-production and this branch
 *                       becomes a startup error in prod.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

function emit(level: LogLevel, msg: string, extra: Record<string, unknown> = {}): void {
  // biome-ignore lint/suspicious/noConsole: stdout is the worker's log channel until pino lands here.
  console.log(JSON.stringify({ level, msg, pid: process.pid, ...extra }));
}

const reconciliationLog: LogHook = (level, message, fields) => {
  emit(level, message, { component: "reconciliation", ...(fields ?? {}) });
};

// Connection options BullMQ needs for a long-running worker. `maxRetriesPerRequest:
// null` is BullMQ's required setting — without it, ioredis aborts blocking
// commands (BRPOPLPUSH, the core BullMQ primitive) after N retries and the
// worker silently stops consuming. `enableReadyCheck: false` keeps the worker
// from crashing on transient `INFO` failures while Redis is restarting.
const REDIS_CONNECTION_OPTIONS: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

interface RunningWorker {
  shutdown: (signal: NodeJS.Signals) => Promise<void>;
}

/**
 * Stub PaymentProvider used until the worker process is wired to the real
 * Midtrans server key (the API process owns that wiring today). Returns an
 * empty settlement set so the reconciliation pass exits cleanly with zero
 * matches; the production secrets land before the outlet enumerator does, so
 * by the time real outlets are enumerated this stub will have been replaced.
 */
function makeNoSettlementProvider(): PaymentProvider {
  return {
    name: "no-settlement-stub",
    async createQris() {
      throw new Error("payments provider not configured in worker");
    },
    async getQrisStatus() {
      throw new Error("payments provider not configured in worker");
    },
    verifyWebhookSignature() {
      throw new Error("payments provider not configured in worker");
    },
    async fetchQrisSettlements(_filter: SettlementReportFilter) {
      return [];
    },
  };
}

async function startBullMqWorker(redisUrl: string): Promise<RunningWorker> {
  const connection = new Redis(redisUrl, REDIS_CONNECTION_OPTIONS);

  connection.on("error", (err: Error) => {
    emit("error", "redis connection error", { err: String(err) });
  });

  // The reconciliation service in the worker uses the same in-memory
  // repository the API uses today (KASA-64 wiring). When the Postgres-backed
  // repository lands, swap both sites in the same PR so they continue to
  // share state.
  const reconciliation = new ReconciliationService({
    repository: new InMemoryReconciliationRepository(),
    provider: makeNoSettlementProvider(),
  });

  const queue: RunningReconciliationQueue = await bootReconciliationQueue({
    connection,
    service: reconciliation,
    log: reconciliationLog,
  });

  queue.worker.on("ready", () => {
    emit("info", "bullmq worker ready", { queue: queue.queue.name });
  });
  queue.worker.on("error", (err) => {
    emit("error", "bullmq worker error", { err: String(err) });
    // Tag every captured event with the queue so Sentry can group worker
    // errors by source even when the worker process group expands beyond
    // reconciliation. captureException is a no-op when Sentry is not
    // initialised (no DSN), so the worker still runs cleanly in dev / CI.
    Sentry.captureException(err, {
      tags: { component: "bullmq", queue: queue.queue.name, kind: "worker_error" },
    });
  });
  queue.worker.on("failed", (job, err) => {
    emit("error", "bullmq job failed", {
      jobId: job?.id,
      name: job?.name,
      err: String(err),
    });
    Sentry.captureException(err, {
      tags: {
        component: "bullmq",
        queue: queue.queue.name,
        kind: "job_failed",
        ...(job?.name ? { jobName: job.name } : {}),
      },
      ...(job?.id ? { extra: { jobId: job.id } } : {}),
    });
  });

  return {
    shutdown: async (signal) => {
      emit("info", "worker shutdown begin", { signal });
      // Worker.close() waits for in-flight jobs to finish (default token
      // timeout 30s) before resolving. Queue.close() then quits the producer
      // connection. Order matters: drain consumers first.
      try {
        await queue.shutdown();
      } catch (err) {
        emit("error", "queue shutdown failed", { err: String(err) });
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
  // Init Sentry before loadEnv() so a config-validation throw is captured.
  // No-op when SENTRY_DSN is unset.
  initSentry();

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
  Sentry.captureException(err, { tags: { component: "worker", kind: "fatal" } });
  process.exit(1);
});

import type {
  ConnectionOptions,
  Job,
  JobsOptions,
  Processor,
  Queue,
  Worker,
  WorkerOptions,
} from "bullmq";
import type { ReconcilePassReport } from "../services/reconciliation/index.js";

/*
 * BullMQ nightly reconciliation schedule (KASA-120, ARCHITECTURE.md §3.1
 * Flow C fallback / ADR-008).
 *
 * One repeating cron job ("schedule-tick") fans out per-(merchant, outlet)
 * jobs ("reconcile-outlet"); each per-outlet job calls
 * `ReconciliationService.reconcileBusinessDate` for `businessDate = yesterday
 * in outlet timezone`. The schedule fires at 00:30 Asia/Jakarta every day,
 * which is comfortably after the buyer's bank typically settles the previous
 * day's QRIS transfers but before the back-office team comes in.
 *
 * Why two job names on one queue:
 *   - keeps retry policy per-outlet (one Surabaya failure does not block the
 *     Jakarta-Selatan pass)
 *   - keeps the cron registration (BullMQ JobScheduler) attached to a single
 *     queue so ops only have one queue to monitor
 *
 * The processor is split into pure helpers so the unit suite can drive the
 * scheduler and the per-outlet path against in-memory fakes — no Redis
 * required for tests.
 */

export const RECONCILIATION_QUEUE_NAME = "kassa.reconciliation.nightly";

/** Cron pattern: 00:30 every day, evaluated in {@link RECONCILIATION_TIMEZONE}. */
export const RECONCILIATION_CRON = "30 0 * * *";
export const RECONCILIATION_TIMEZONE = "Asia/Jakarta";
export const RECONCILIATION_SCHEDULER_ID = "kassa.reconciliation.nightly.scheduler";

/** Cron-bound fan-out job. No payload; each tick reads the current outlet list. */
export const SCHEDULE_TICK_JOB = "schedule-tick";
/** Per-(merchant, outlet, businessDate) reconciliation pass. */
export const RECONCILE_OUTLET_JOB = "reconcile-outlet";

export interface ReconcileOutletJobData {
  merchantId: string;
  outletId: string;
  /** YYYY-MM-DD; the local calendar day in the outlet's timezone. */
  businessDate: string;
}

// AC: 3 attempts, exponential backoff, 1 hour cap. 5-minute base × 2^(n-1)
// gives 5min → 10min before the cap kicks in; the cap is enforced for safety
// against future tuning that might push the base higher.
const RETRY_DELAY_BASE_MS = 5 * 60 * 1000;
const RETRY_DELAY_MAX_MS = 60 * 60 * 1000;
const RECONCILE_BACKOFF_NAME = "kassa-reconcile-exponential";

export const RECONCILE_OUTLET_RETRY: Pick<JobsOptions, "attempts" | "backoff"> = {
  attempts: 3,
  backoff: { type: RECONCILE_BACKOFF_NAME },
};

/**
 * Persistent job log (AC: "so a missed night can be replayed"). 365 entries
 * is one year of nightly history per outlet — enough to retrigger a missed
 * pass by hand from the BullMQ history without growing the broker without
 * bound.
 */
export const RECONCILIATION_JOB_RETENTION: Pick<JobsOptions, "removeOnComplete" | "removeOnFail"> =
  {
    removeOnComplete: { count: 365 },
    removeOnFail: { count: 365 },
  };

/** Worker settings that supply the named exponential-with-cap backoff strategy. */
export const RECONCILIATION_WORKER_SETTINGS: NonNullable<WorkerOptions["settings"]> = {
  backoffStrategy: (attemptsMade: number): number => {
    const exp = RETRY_DELAY_BASE_MS * 2 ** Math.max(0, attemptsMade - 1);
    return Math.min(exp, RETRY_DELAY_MAX_MS);
  },
};

export interface OutletInfo {
  merchantId: string;
  outletId: string;
  /** IANA timezone, e.g. `Asia/Jakarta`. */
  timezone: string;
}

export interface OutletEnumerator {
  /** Active outlets eligible for nightly reconciliation. */
  listActiveOutlets(): Promise<readonly OutletInfo[]>;
}

/**
 * Bootstrap default — returns no outlets. The worker still boots the cron
 * and the queue topology, but each tick is a no-op until a Postgres-backed
 * enumerator lands (follow-up issue under KASA-21). This keeps the merge of
 * KASA-120 atomic: the schedule + retry policy + breadcrumbs are all live;
 * the only thing that flips when the DB enumerator lands is the input to
 * `planReconcileTick`.
 */
export const emptyOutletEnumerator: OutletEnumerator = {
  async listActiveOutlets() {
    return [];
  },
};

export type LogHook = (
  level: "info" | "warn" | "error",
  message: string,
  fields?: Record<string, unknown>,
) => void;

/**
 * Sentry-style breadcrumb seam. Production wiring (when @sentry/node lands
 * in the API process) registers a hook that calls `Sentry.addBreadcrumb`;
 * tests assert the calls directly. The default no-op makes the worker safe
 * to boot without a Sentry DSN configured.
 */
export type BreadcrumbHook = (b: {
  category: string;
  message: string;
  data?: Record<string, unknown>;
}) => void;

export interface JobEnqueuer {
  add(name: string, data: unknown, opts?: JobsOptions): Promise<unknown>;
}

export interface ReconcileService {
  reconcileBusinessDate(input: ReconcileOutletJobData): Promise<ReconcilePassReport>;
}

const noopLog: LogHook = () => {};
const noopBreadcrumb: BreadcrumbHook = () => {};

/** Compute yesterday's businessDate (YYYY-MM-DD) in the given IANA timezone. */
export function yesterdayInTimezone(now: Date, timezone: string): string {
  return shiftYmdByDays(formatYmdInTimezone(now, timezone), -1);
}

function formatYmdInTimezone(at: Date, timezone: string): string {
  // `en-CA` formats numeric date as `YYYY-MM-DD`; the timezone parameter
  // selects the local calendar day for that wall clock.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

function shiftYmdByDays(ymd: string, deltaDays: number): string {
  const [yStr, mStr, dStr] = ymd.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

export interface PlanReconcileTickInput {
  outlets: readonly OutletInfo[];
  now: Date;
}

/** Pure planner: outlet list + wall clock → per-outlet job payloads. */
export function planReconcileTick(
  input: PlanReconcileTickInput,
): readonly ReconcileOutletJobData[] {
  return input.outlets.map((o) => ({
    merchantId: o.merchantId,
    outletId: o.outletId,
    businessDate: yesterdayInTimezone(input.now, o.timezone),
  }));
}

export interface ReconciliationProcessorDeps {
  service: ReconcileService;
  outlets: OutletEnumerator;
  queue: JobEnqueuer;
  log?: LogHook;
  breadcrumb?: BreadcrumbHook;
  now?: () => Date;
}

export function makeReconciliationProcessor(deps: ReconciliationProcessorDeps): Processor {
  const log = deps.log ?? noopLog;
  const breadcrumb = deps.breadcrumb ?? noopBreadcrumb;
  const now = deps.now ?? (() => new Date());

  return async function reconciliationProcessor(job: Job): Promise<unknown> {
    if (job.name === SCHEDULE_TICK_JOB) {
      return runScheduleTick({
        outlets: deps.outlets,
        queue: deps.queue,
        log,
        breadcrumb,
        now,
      });
    }
    if (job.name === RECONCILE_OUTLET_JOB) {
      return runReconcileOutlet({
        service: deps.service,
        log,
        breadcrumb,
        data: job.data as ReconcileOutletJobData,
      });
    }
    log("warn", "unknown reconciliation job name", { jobId: job.id, name: job.name });
    return undefined;
  };
}

interface ScheduleTickResult {
  outletCount: number;
  enqueued: number;
}

async function runScheduleTick(deps: {
  outlets: OutletEnumerator;
  queue: JobEnqueuer;
  log: LogHook;
  breadcrumb: BreadcrumbHook;
  now: () => Date;
}): Promise<ScheduleTickResult> {
  const at = deps.now();
  const outlets = await deps.outlets.listActiveOutlets();
  const plan = planReconcileTick({ outlets, now: at });
  for (const data of plan) {
    await deps.queue.add(RECONCILE_OUTLET_JOB, data, {
      ...RECONCILE_OUTLET_RETRY,
      ...RECONCILIATION_JOB_RETENTION,
      // Idempotent jobId: a duplicate scheduler tick (two workers racing on
      // the same minute) collapses to a single per-outlet pass. To replay a
      // missed night by hand, enqueue with a different jobId or remove the
      // historical record first.
      jobId: `reconcile:${data.merchantId}:${data.outletId}:${data.businessDate}`,
    });
  }
  deps.breadcrumb({
    category: "reconciliation",
    message: "schedule-tick fan-out",
    data: { outletCount: outlets.length, enqueued: plan.length },
  });
  deps.log("info", "reconciliation schedule-tick fan-out", {
    outletCount: outlets.length,
    enqueued: plan.length,
  });
  return { outletCount: outlets.length, enqueued: plan.length };
}

interface ReconcileOutletResult {
  matchedCount: number;
  consideredTenderCount: number;
  settlementRowCount: number;
}

async function runReconcileOutlet(deps: {
  service: ReconcileService;
  log: LogHook;
  breadcrumb: BreadcrumbHook;
  data: ReconcileOutletJobData;
}): Promise<ReconcileOutletResult> {
  const start = Date.now();
  deps.breadcrumb({
    category: "reconciliation",
    message: "reconcile-outlet pass start",
    data: { ...deps.data },
  });
  const report = await deps.service.reconcileBusinessDate(deps.data);
  const summary = {
    ...deps.data,
    matchedCount: report.matchedCount,
    consideredTenderCount: report.consideredTenderCount,
    settlementRowCount: report.settlementRowCount,
  };
  deps.breadcrumb({
    category: "reconciliation",
    message: "reconcile-outlet pass complete",
    data: summary,
  });
  deps.log("info", "reconcile-outlet pass complete", {
    ...summary,
    unmatchedTenderCount: report.unmatchedTenderIds.length,
    unmatchedSettlementCount: report.unmatchedSettlementIds.length,
    durationMs: Date.now() - start,
  });
  return {
    matchedCount: report.matchedCount,
    consideredTenderCount: report.consideredTenderCount,
    settlementRowCount: report.settlementRowCount,
  };
}

// =============================================================================
// Production bootstrap. `workers/index.ts` calls this when REDIS_URL is set.
// =============================================================================

export interface BootReconciliationDeps {
  connection: ConnectionOptions;
  service: ReconcileService;
  outlets?: OutletEnumerator;
  log?: LogHook;
  breadcrumb?: BreadcrumbHook;
}

export interface RunningReconciliationQueue {
  queue: Queue;
  worker: Worker;
  shutdown: () => Promise<void>;
}

/**
 * Starts the reconciliation queue + worker + cron registration. Idempotent:
 * the cron registration uses `upsertJobScheduler`, so re-deploying the worker
 * does not duplicate the schedule. Closing the returned handle drains
 * in-flight jobs before quitting the broker connection.
 */
export async function bootReconciliationQueue(
  deps: BootReconciliationDeps,
): Promise<RunningReconciliationQueue> {
  const { Queue, Worker } = await import("bullmq");

  const queue = new Queue(RECONCILIATION_QUEUE_NAME, { connection: deps.connection });
  const enqueuer: JobEnqueuer = {
    async add(name, data, opts) {
      return queue.add(name, data as Record<string, unknown>, opts);
    },
  };

  const processor = makeReconciliationProcessor({
    service: deps.service,
    outlets: deps.outlets ?? emptyOutletEnumerator,
    queue: enqueuer,
    ...(deps.log !== undefined ? { log: deps.log } : {}),
    ...(deps.breadcrumb !== undefined ? { breadcrumb: deps.breadcrumb } : {}),
  });

  const worker = new Worker(RECONCILIATION_QUEUE_NAME, processor, {
    connection: deps.connection,
    settings: RECONCILIATION_WORKER_SETTINGS,
  });

  await queue.upsertJobScheduler(
    RECONCILIATION_SCHEDULER_ID,
    {
      pattern: RECONCILIATION_CRON,
      tz: RECONCILIATION_TIMEZONE,
    },
    {
      name: SCHEDULE_TICK_JOB,
      data: {},
      opts: { ...RECONCILIATION_JOB_RETENTION },
    },
  );

  return {
    queue,
    worker,
    async shutdown() {
      await worker.close();
      await queue.close();
    },
  };
}

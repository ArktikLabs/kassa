import type { Job, JobsOptions } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import {
  RECONCILE_OUTLET_JOB,
  RECONCILE_OUTLET_RETRY,
  RECONCILIATION_CRON,
  RECONCILIATION_JOB_RETENTION,
  RECONCILIATION_TIMEZONE,
  RECONCILIATION_WORKER_SETTINGS,
  SCHEDULE_TICK_JOB,
  emptyOutletEnumerator,
  makeReconciliationProcessor,
  planReconcileTick,
  yesterdayInTimezone,
  type BreadcrumbHook,
  type JobEnqueuer,
  type LogHook,
  type OutletEnumerator,
  type OutletInfo,
  type ReconcileOutletJobData,
  type ReconcileService,
} from "../src/workers/reconciliation-job.js";
import type { ReconcilePassReport } from "../src/services/reconciliation/index.js";

/*
 * In-memory BullMQ test harness for the nightly reconciliation queue
 * (KASA-120 AC). Drives the schedule-tick fan-out and the per-outlet
 * processor against fakes so neither Redis nor the real BullMQ runtime is
 * required to assert the AC: the processor calls
 * `ReconciliationService.reconcileBusinessDate` with the right
 * (merchantId, outletId, businessDate) tuple per outlet.
 */

interface RecordedAdd {
  name: string;
  data: unknown;
  opts: JobsOptions | undefined;
}

class RecordingEnqueuer implements JobEnqueuer {
  readonly calls: RecordedAdd[] = [];
  async add(name: string, data: unknown, opts?: JobsOptions): Promise<{ id: string }> {
    this.calls.push({ name, data, opts });
    return { id: `q-${this.calls.length}` };
  }
}

function fakeOutletEnumerator(outlets: readonly OutletInfo[]): OutletEnumerator {
  return {
    async listActiveOutlets() {
      return outlets;
    },
  };
}

function fakeJob(name: string, data: unknown, id = "job-1"): Job {
  return { id, name, data } as unknown as Job;
}

function emptyReport(): ReconcilePassReport {
  return {
    matchedCount: 0,
    consideredTenderCount: 0,
    settlementRowCount: 0,
    matches: [],
    unmatchedTenderIds: [],
    unmatchedSettlementIds: [],
  };
}

describe("yesterdayInTimezone", () => {
  it("returns the previous calendar day in the outlet's local timezone", () => {
    // 2026-04-25 00:30 Asia/Jakarta = 2026-04-24 17:30 UTC.
    const at = new Date(Date.UTC(2026, 3, 24, 17, 30, 0));
    expect(yesterdayInTimezone(at, "Asia/Jakarta")).toBe("2026-04-24");
  });

  it("respects DST-style tz drift: outlets in different timezones can disagree on yesterday", () => {
    // 2026-04-25 16:00 UTC.
    //   Asia/Jakarta (UTC+7): 2026-04-25 23:00 → yesterday = 2026-04-24
    //   UTC                 : 2026-04-25 16:00 → yesterday = 2026-04-24
    //   Asia/Tokyo  (UTC+9):  2026-04-26 01:00 → yesterday = 2026-04-25
    const at = new Date(Date.UTC(2026, 3, 25, 16, 0, 0));
    expect(yesterdayInTimezone(at, "Asia/Jakarta")).toBe("2026-04-24");
    expect(yesterdayInTimezone(at, "UTC")).toBe("2026-04-24");
    expect(yesterdayInTimezone(at, "Asia/Tokyo")).toBe("2026-04-25");
  });
});

describe("planReconcileTick", () => {
  it("emits one job payload per outlet, scoped to that outlet's local yesterday", () => {
    // 2026-04-25 00:30 Asia/Jakarta = 17:30 UTC (2026-04-24).
    const at = new Date(Date.UTC(2026, 3, 24, 17, 30, 0));
    const plan = planReconcileTick({
      now: at,
      outlets: [
        { merchantId: "m-1", outletId: "out-jaksel", timezone: "Asia/Jakarta" },
        { merchantId: "m-1", outletId: "out-makassar", timezone: "Asia/Makassar" },
        { merchantId: "m-2", outletId: "out-utc", timezone: "UTC" },
      ],
    });
    expect(plan).toEqual([
      { merchantId: "m-1", outletId: "out-jaksel", businessDate: "2026-04-24" },
      { merchantId: "m-1", outletId: "out-makassar", businessDate: "2026-04-24" },
      { merchantId: "m-2", outletId: "out-utc", businessDate: "2026-04-23" },
    ]);
  });
});

describe("schedule-tick processor", () => {
  it("enqueues one reconcile-outlet job per active outlet with retry + retention opts", async () => {
    // Fire at 2026-04-25 00:30 Asia/Jakarta — what the cron will fire at in
    // production. yesterday(WIB) = 2026-04-24.
    const at = new Date(Date.UTC(2026, 3, 24, 17, 30, 0));
    const outlets = fakeOutletEnumerator([
      { merchantId: "m-1", outletId: "out-jaksel", timezone: "Asia/Jakarta" },
      { merchantId: "m-1", outletId: "out-surabaya", timezone: "Asia/Jakarta" },
      { merchantId: "m-2", outletId: "out-makassar", timezone: "Asia/Makassar" },
    ]);
    const queue = new RecordingEnqueuer();
    const log = vi.fn<LogHook>();
    const breadcrumb = vi.fn<BreadcrumbHook>();
    const service: ReconcileService = {
      async reconcileBusinessDate() {
        throw new Error("schedule-tick must not call the service directly");
      },
    };

    const processor = makeReconciliationProcessor({
      service,
      outlets,
      queue,
      log,
      breadcrumb,
      now: () => at,
    });

    const result = await processor(fakeJob(SCHEDULE_TICK_JOB, {}, "tick-1"), "token");

    expect(result).toEqual({ outletCount: 3, enqueued: 3 });
    expect(queue.calls).toHaveLength(3);

    expect(queue.calls.map((c) => c.data)).toEqual([
      { merchantId: "m-1", outletId: "out-jaksel", businessDate: "2026-04-24" },
      { merchantId: "m-1", outletId: "out-surabaya", businessDate: "2026-04-24" },
      { merchantId: "m-2", outletId: "out-makassar", businessDate: "2026-04-24" },
    ]);
    for (const call of queue.calls) {
      expect(call.name).toBe(RECONCILE_OUTLET_JOB);
      expect(call.opts?.attempts).toBe(RECONCILE_OUTLET_RETRY.attempts);
      expect(call.opts?.backoff).toEqual(RECONCILE_OUTLET_RETRY.backoff);
      expect(call.opts?.removeOnComplete).toEqual(RECONCILIATION_JOB_RETENTION.removeOnComplete);
      expect(call.opts?.removeOnFail).toEqual(RECONCILIATION_JOB_RETENTION.removeOnFail);
      const data = call.data as ReconcileOutletJobData;
      expect(call.opts?.jobId).toBe(
        `reconcile:${data.merchantId}:${data.outletId}:${data.businessDate}`,
      );
    }

    expect(breadcrumb).toHaveBeenCalledWith({
      category: "reconciliation",
      message: "schedule-tick fan-out",
      data: { outletCount: 3, enqueued: 3 },
    });
    expect(log).toHaveBeenCalledWith(
      "info",
      "reconciliation schedule-tick fan-out",
      expect.objectContaining({ outletCount: 3, enqueued: 3 }),
    );
  });

  it("is a no-op when the outlet enumerator returns nothing (bootstrap default)", async () => {
    const queue = new RecordingEnqueuer();
    const processor = makeReconciliationProcessor({
      service: {
        async reconcileBusinessDate() {
          throw new Error("not reached");
        },
      },
      outlets: emptyOutletEnumerator,
      queue,
      now: () => new Date(Date.UTC(2026, 3, 24, 17, 30, 0)),
    });

    const result = await processor(fakeJob(SCHEDULE_TICK_JOB, {}), "token");

    expect(result).toEqual({ outletCount: 0, enqueued: 0 });
    expect(queue.calls).toHaveLength(0);
  });
});

describe("reconcile-outlet processor", () => {
  it("calls ReconciliationService.reconcileBusinessDate with the job's tuple", async () => {
    const reconcile = vi.fn(async () => ({
      ...emptyReport(),
      matchedCount: 1,
      consideredTenderCount: 2,
      settlementRowCount: 3,
    }));
    const log = vi.fn<LogHook>();
    const breadcrumb = vi.fn<BreadcrumbHook>();

    const processor = makeReconciliationProcessor({
      service: { reconcileBusinessDate: reconcile },
      outlets: emptyOutletEnumerator,
      queue: new RecordingEnqueuer(),
      log,
      breadcrumb,
    });

    const data: ReconcileOutletJobData = {
      merchantId: "m-1",
      outletId: "out-jaksel",
      businessDate: "2026-04-24",
    };

    const result = await processor(fakeJob(RECONCILE_OUTLET_JOB, data, "j-1"), "token");

    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith(data);
    expect(result).toEqual({ matchedCount: 1, consideredTenderCount: 2, settlementRowCount: 3 });

    // Sentry breadcrumb on each pass (AC).
    expect(breadcrumb).toHaveBeenCalledWith({
      category: "reconciliation",
      message: "reconcile-outlet pass start",
      data,
    });
    expect(breadcrumb).toHaveBeenCalledWith({
      category: "reconciliation",
      message: "reconcile-outlet pass complete",
      data: expect.objectContaining({ ...data, matchedCount: 1 }),
    });

    // Structured log line for the report counts (AC).
    expect(log).toHaveBeenCalledWith(
      "info",
      "reconcile-outlet pass complete",
      expect.objectContaining({
        merchantId: "m-1",
        outletId: "out-jaksel",
        businessDate: "2026-04-24",
        matchedCount: 1,
        consideredTenderCount: 2,
        settlementRowCount: 3,
      }),
    );
  });

  it("propagates service errors so BullMQ's retry policy can take over", async () => {
    const boom = new Error("midtrans_timeout");
    const processor = makeReconciliationProcessor({
      service: {
        async reconcileBusinessDate() {
          throw boom;
        },
      },
      outlets: emptyOutletEnumerator,
      queue: new RecordingEnqueuer(),
    });

    await expect(
      processor(
        fakeJob(RECONCILE_OUTLET_JOB, {
          merchantId: "m-1",
          outletId: "out-1",
          businessDate: "2026-04-24",
        }),
        "token",
      ),
    ).rejects.toBe(boom);
  });
});

describe("reconciliation queue topology", () => {
  it("uses the cron + tz from the AC", () => {
    // Sanity: the AC pins the cron to 00:30 every day in Asia/Jakarta.
    expect(RECONCILIATION_CRON).toBe("30 0 * * *");
    expect(RECONCILIATION_TIMEZONE).toBe("Asia/Jakarta");
  });

  it("retry policy is exponential and capped at 1 hour", () => {
    expect(RECONCILE_OUTLET_RETRY.attempts).toBe(3);

    const strategy = RECONCILIATION_WORKER_SETTINGS.backoffStrategy;
    expect(typeof strategy).toBe("function");
    if (typeof strategy !== "function") return;

    const oneHourMs = 60 * 60 * 1000;
    const callStrategy = (n: number): number =>
      strategy(n, "custom", new Error(), {} as Job) as number;
    // Grows exponentially.
    expect(callStrategy(1)).toBeLessThan(callStrategy(2));
    expect(callStrategy(2)).toBeLessThan(callStrategy(3));
    // Capped at 1 hour even far past the AC's attempt budget.
    expect(callStrategy(20)).toBe(oneHourMs);
  });
});

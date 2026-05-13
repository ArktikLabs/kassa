import type { Database } from "../db/index.ts";
import type { PendingShiftEvent } from "../db/types.ts";
import { pullAll, type PullAllResult } from "./pull.ts";
import { pushOutbox, type PushOptions, type PushResult } from "./push.ts";
import { pushCatalogMutations, type PushCatalogOptions } from "./push-catalog.ts";
import {
  pushShiftEvents,
  type PushShiftOptions,
  type PushShiftResult,
  type ShiftSyncResponse,
} from "./push-shifts.ts";
import { SyncHttpError, SyncNetworkError, SyncOfflineError, SyncParseError } from "./errors.ts";
import type { SyncStatusStore } from "./status.ts";

export const DEFAULT_SYNC_INTERVAL_MS = 60_000;

export interface OnlineSource {
  isOnline: () => boolean;
  subscribe: (listener: (online: boolean) => void) => () => void;
}

export function browserOnlineSource(): OnlineSource {
  const isOnline = () => (typeof navigator === "undefined" ? true : navigator.onLine !== false);
  const subscribe = (listener: (online: boolean) => void) => {
    if (typeof window === "undefined") return () => {};
    const onOnline = () => listener(true);
    const onOffline = () => listener(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  };
  return { isOnline, subscribe };
}

export interface RunnerCycleResult {
  pull: PullAllResult | null;
  push: PushResult | null;
}

export interface RunnerOptions {
  database: Database;
  baseUrl: string;
  status: SyncStatusStore;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  onSentryError?: (err: SyncParseError) => void;
  onlineSource?: OnlineSource;
  clock?: () => Date;
  auth?: () => Promise<{ apiKey: string; apiSecret: string } | null>;
  outletId?: () => Promise<string | null>;
  /** Injected so tests can assert what the runner drives push.ts with. */
  pushImpl?: (database: Database, opts: PushOptions) => Promise<PushResult>;
  /** Injected so tests can assert what the runner drives push-shifts.ts with. */
  pushShiftsImpl?: (database: Database, opts: PushShiftOptions) => Promise<PushShiftResult>;
  /** Injected so tests can assert what the runner drives push-catalog.ts with. */
  pushCatalogImpl?: (database: Database, opts: PushCatalogOptions) => Promise<PushResult>;
}

export interface SyncRunner {
  start: () => void;
  stop: () => void;
  trigger: () => Promise<RunnerCycleResult | null>;
  /** Drain the outbox only — no pull. Used by the /admin requeue action. */
  triggerPush: () => Promise<PushResult | null>;
  isRunning: () => boolean;
}

export function createSyncRunner(opts: RunnerOptions): SyncRunner {
  const interval = opts.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
  const onlineSource = opts.onlineSource ?? browserOnlineSource();
  const pushImpl = opts.pushImpl ?? pushOutbox;
  const pushShiftsImpl = opts.pushShiftsImpl ?? pushShiftEvents;
  const pushCatalogImpl = opts.pushCatalogImpl ?? pushCatalogMutations;
  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubOnline: (() => void) | null = null;
  let running = false;
  let inFlight: Promise<RunnerCycleResult | null> | null = null;

  const setOffline = () => {
    opts.status.update((s) => ({ ...s, phase: { kind: "offline" } }));
  };

  const refreshNeedsAttention = async (): Promise<number> => {
    const rows = await opts.database.repos.pendingSales.listNeedsAttention();
    opts.status.update((s) => ({ ...s, needsAttentionCount: rows.length }));
    return rows.length;
  };

  const buildPushOptions = async (): Promise<PushOptions> => {
    const auth = opts.auth ? await opts.auth() : null;
    const pushOpts: PushOptions = {
      baseUrl: opts.baseUrl,
      status: opts.status,
      isOnline: onlineSource.isOnline,
      auth,
    };
    if (opts.fetchImpl) pushOpts.fetchImpl = opts.fetchImpl;
    if (opts.clock) pushOpts.clock = opts.clock;
    return pushOpts;
  };

  const runPush = async (): Promise<PushResult | null> => {
    if (!onlineSource.isOnline()) {
      setOffline();
      return null;
    }
    try {
      // KASA-235 — drain shift events before sales so an offline-queued
      // open lands before any sale that rolled in after it. The server
      // already accepts sales without a server-side shift, but draining
      // in this order keeps the local sync-state coherent for the boot
      // guard and the EOD float lookup.
      await pushShiftsImpl(opts.database, await buildShiftPushOptions());
      // KASA-248 — drain catalog tile availability toggles before sales
      // so a "Tandai sebagai habis" tap lands on the server before the
      // next reference-pull window. Failures here are best-effort: the
      // local row already reflects the toggle, and the next pull will
      // reconcile against the server's canonical value.
      await pushCatalogImpl(opts.database, await buildCatalogPushOptions());
      const result = await pushImpl(opts.database, await buildPushOptions());
      await refreshNeedsAttention();
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      opts.status.update((s) => ({
        ...s,
        phase: { kind: "error", message, table: "pending_sales" },
      }));
      await refreshNeedsAttention();
      throw err;
    }
  };

  const buildShiftPushOptions = async (): Promise<PushShiftOptions> => {
    const auth = opts.auth ? await opts.auth() : null;
    const handleSynced = async (
      event: PendingShiftEvent,
      response: ShiftSyncResponse | null,
    ): Promise<void> => {
      const repo = opts.database.repos.shiftState;
      if (event.kind === "open") {
        if (response?.shiftId) await repo.recordServerShiftId(response.shiftId);
      } else if (event.kind === "close") {
        // Close acknowledged: drop the local singleton so the boot guard
        // routes the cashier back to /shift/open on the next session.
        await repo.clear();
      }
    };
    const shiftPushOpts: PushShiftOptions = {
      baseUrl: opts.baseUrl,
      isOnline: onlineSource.isOnline,
      auth,
      onEventSynced: handleSynced,
    };
    if (opts.fetchImpl) shiftPushOpts.fetchImpl = opts.fetchImpl;
    if (opts.clock) shiftPushOpts.clock = opts.clock;
    return shiftPushOpts;
  };

  const buildCatalogPushOptions = async (): Promise<PushCatalogOptions> => {
    const auth = opts.auth ? await opts.auth() : null;
    const catalogPushOpts: PushCatalogOptions = {
      baseUrl: opts.baseUrl,
      isOnline: onlineSource.isOnline,
      auth,
    };
    if (opts.fetchImpl) catalogPushOpts.fetchImpl = opts.fetchImpl;
    if (opts.clock) catalogPushOpts.clock = opts.clock;
    return catalogPushOpts;
  };

  const runOnce = (): Promise<RunnerCycleResult | null> => {
    if (inFlight) return inFlight;
    if (!onlineSource.isOnline()) {
      setOffline();
      return Promise.resolve(null);
    }
    const promise = (async () => {
      let pullResult: PullAllResult | null = null;
      let pushResult: PushResult | null = null;
      try {
        const auth = opts.auth ? await opts.auth() : null;
        const outletId = opts.outletId ? await opts.outletId() : null;
        pullResult = await pullAll(opts.database, {
          baseUrl: opts.baseUrl,
          outletId,
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
          status: opts.status,
          isOnline: onlineSource.isOnline,
          ...(opts.clock ? { clock: opts.clock } : {}),
          auth,
          ...(opts.onSentryError ? { onSentryError: opts.onSentryError } : {}),
        });
        pushResult = await runPush();
        return { pull: pullResult, push: pushResult };
      } catch (err) {
        if (err instanceof SyncOfflineError) {
          setOffline();
          return { pull: pullResult, push: pushResult };
        }
        const message = errorMessage(err);
        const table = errorTable(err);
        opts.status.update((s) => ({
          ...s,
          phase: { kind: "error", message, table },
        }));
        throw err;
      } finally {
        inFlight = null;
      }
    })();
    inFlight = promise;
    return promise;
  };

  const runner: SyncRunner = {
    start() {
      if (running) return;
      running = true;
      unsubOnline = onlineSource.subscribe((online) => {
        if (online) {
          void runner.trigger().catch(() => {});
        } else {
          setOffline();
        }
      });
      timer = setInterval(() => {
        void runner.trigger().catch(() => {});
      }, interval);
      void runner.trigger().catch(() => {});
    },
    stop() {
      running = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (unsubOnline) {
        unsubOnline();
        unsubOnline = null;
      }
    },
    trigger: runOnce,
    async triggerPush() {
      return runPush();
    },
    isRunning: () => running,
  };

  return runner;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function errorTable(err: unknown) {
  if (
    err instanceof SyncParseError ||
    err instanceof SyncHttpError ||
    err instanceof SyncNetworkError
  ) {
    return err.table;
  }
  return null;
}

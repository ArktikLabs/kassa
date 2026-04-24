import type { Database } from "../db/index.ts";
import { pullAll, type PullAllResult } from "./pull.ts";
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
}

export interface SyncRunner {
  start: () => void;
  stop: () => void;
  trigger: () => Promise<PullAllResult | null>;
  isRunning: () => boolean;
}

export function createSyncRunner(opts: RunnerOptions): SyncRunner {
  const interval = opts.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
  const onlineSource = opts.onlineSource ?? browserOnlineSource();
  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubOnline: (() => void) | null = null;
  let running = false;
  let inFlight: Promise<PullAllResult | null> | null = null;

  const setOfflinePhase = () => {
    if (!onlineSource.isOnline()) {
      opts.status.set({ phase: { kind: "offline" } });
    }
  };

  const runOnce = (): Promise<PullAllResult | null> => {
    if (inFlight) return inFlight;
    if (!onlineSource.isOnline()) {
      setOfflinePhase();
      return Promise.resolve(null);
    }
    const promise = (async () => {
      try {
        const auth = opts.auth ? await opts.auth() : null;
        const outletId = opts.outletId ? await opts.outletId() : null;
        return await pullAll(opts.database, {
          baseUrl: opts.baseUrl,
          outletId,
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
          status: opts.status,
          isOnline: onlineSource.isOnline,
          ...(opts.clock ? { clock: opts.clock } : {}),
          auth,
          ...(opts.onSentryError ? { onSentryError: opts.onSentryError } : {}),
        });
      } catch (err) {
        if (err instanceof SyncOfflineError) {
          opts.status.set({ phase: { kind: "offline" } });
          return null;
        }
        const message = errorMessage(err);
        const table = errorTable(err);
        opts.status.set({
          phase: { kind: "error", message, table },
        });
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
          opts.status.set({ phase: { kind: "offline" } });
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

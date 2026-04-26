import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { getDatabase, type Database } from "../data/db/index.ts";
import {
  createSyncRunner,
  createSyncStatusStore,
  type SyncRunner,
  type SyncStatus,
  type SyncStatusStore,
} from "../data/sync/index.ts";
import type { SyncParseError } from "../data/sync/errors.ts";
import { Sentry } from "./sentry.ts";

interface SyncContextValue {
  store: SyncStatusStore;
  runner: SyncRunner | null;
  triggerRefresh: () => Promise<void>;
  triggerPush: () => Promise<void>;
}

const SyncContext = createContext<SyncContextValue | null>(null);

function readBaseUrl(): string {
  const envUrl = import.meta.env.VITE_API_BASE_URL;
  if (typeof envUrl === "string" && envUrl.length > 0) return envUrl;
  if (typeof window !== "undefined") return window.location.origin;
  return "http://localhost:3000";
}

function reportParseError(err: SyncParseError): void {
  Sentry.captureException(err, {
    tags: { sync_table: err.table },
    extra: {
      issueSummary: err.issueSummary,
      receivedKeys: err.receivedKeys,
    },
  });
}

export function SyncProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<SyncStatusStore | null>(null);
  if (!storeRef.current) storeRef.current = createSyncStatusStore();
  const store = storeRef.current;
  const runnerRef = useRef<SyncRunner | null>(null);
  const databaseRef = useRef<Database | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    (async () => {
      try {
        const database = await getDatabase();
        if (cancelled) return;
        databaseRef.current = database;
        // Seed the needs-attention counter so the pill can render "Sync
        // gagal" before the first drain completes.
        const parked = await database.repos.pendingSales.listNeedsAttention();
        store.update((s) => ({ ...s, needsAttentionCount: parked.length }));
        const runner = createSyncRunner({
          database,
          baseUrl: readBaseUrl(),
          status: store,
          onSentryError: reportParseError,
          auth: async () => {
            const secret = await database.repos.deviceSecret.get();
            if (!secret) return null;
            return { apiKey: secret.apiKey, apiSecret: secret.apiSecret };
          },
          outletId: async () => {
            const secret = await database.repos.deviceSecret.get();
            return secret?.outletId ?? null;
          },
        });
        runnerRef.current = runner;
        const secret = await database.repos.deviceSecret.get();
        if (secret) runner.start();
      } catch (err) {
        Sentry.captureException(err);
      }
    })();
    return () => {
      cancelled = true;
      runnerRef.current?.stop();
      runnerRef.current = null;
    };
  }, [store]);

  const triggerRefresh = useCallback(async () => {
    await runnerRef.current?.trigger();
  }, []);

  const triggerPush = useCallback(async () => {
    await runnerRef.current?.triggerPush();
  }, []);

  const value = useMemo<SyncContextValue>(
    () => ({
      store,
      runner: runnerRef.current,
      triggerRefresh,
      triggerPush,
    }),
    [store, triggerRefresh, triggerPush],
  );
  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

const DEFAULT_STATUS: SyncStatus = {
  phase: { kind: "idle", lastSuccessAt: null, lastError: null },
  needsAttentionCount: 0,
};

export function useSyncStatus(): SyncStatus {
  const ctx = useContext(SyncContext);
  const store = ctx?.store ?? null;
  return useSyncExternalStore(
    (listener) => (store ? store.subscribe(listener) : () => {}),
    () => (store ? store.get() : DEFAULT_STATUS),
    () => DEFAULT_STATUS,
  );
}

export function useSyncActions(): {
  triggerRefresh: () => Promise<void>;
  triggerPush: () => Promise<void>;
} {
  const ctx = useContext(SyncContext);
  return {
    triggerRefresh: ctx?.triggerRefresh ?? (async () => {}),
    triggerPush: ctx?.triggerPush ?? (async () => {}),
  };
}

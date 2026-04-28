import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { getDatabase, type Database } from "../data/db/index.ts";
import {
  createSyncRunner,
  createSyncStatusStore,
  type SyncRunner,
  type SyncStatusStore,
} from "../data/sync/index.ts";
import type { SyncParseError } from "../data/sync/errors.ts";
import { reportException } from "./error-reporter.ts";
import { SyncContext, type SyncContextValue } from "./sync-context.tsx";

// Hooks (`useSyncStatus`, `useSyncActions`) and the React context now live in
// `./sync-context.tsx` so RootLayout / admin / eod can pull them statically
// without dragging Dexie + sync runner into the initial chunk. This file
// (the heavy provider) is dynamic-imported from `main.tsx` after first paint
// (KASA-157).

function readBaseUrl(): string {
  const envUrl = import.meta.env.VITE_API_BASE_URL;
  if (typeof envUrl === "string" && envUrl.length > 0) return envUrl;
  if (typeof window !== "undefined") return window.location.origin;
  return "http://localhost:3000";
}

function reportParseError(err: SyncParseError): void {
  reportException(err, {
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
        reportException(err);
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

import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { getDatabase, type Database } from "../../data/db/index.ts";
import type { EodClosure, Outlet, PendingSale } from "../../data/db/types.ts";

/*
 * Hook that resolves the current outlet + today's outbox rows + an existing
 * closure marker. The three are co-located so the `/eod` screen can render
 * either the open-variance form or the closed-day summary without further
 * plumbing.
 *
 * Business date is the outlet's local calendar date — same rule
 * `features/sale.finalize.ts` uses when stamping `pending_sales.businessDate`.
 * The hook expects the device to be enrolled; it returns `ready=false` until
 * the outlet row is hydrated.
 */

function outletLocalDate(now: Date, timezone: string | undefined): string {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone ?? "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return fmt.format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export interface EodDataSnapshot {
  ready: boolean;
  outlet: Outlet | null;
  businessDate: string | null;
  sales: readonly PendingSale[];
  existingClosure: EodClosure | null;
  /** Outbox rows the sale-push drain still owes the server. */
  outstandingCount: number;
}

export function useEodData(now: Date = new Date()): EodDataSnapshot {
  const [db, setDb] = useState<Database | null>(null);
  const [outlet, setOutlet] = useState<Outlet | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    (async () => {
      try {
        const database = await getDatabase();
        if (cancelled) return;
        setDb(database);
        const secret = await database.repos.deviceSecret.get();
        if (!secret) return;
        const row = await database.repos.outlets.getById(secret.outletId);
        if (!cancelled) setOutlet(row ?? null);
      } catch {
        // Swallow — the enrol guard owns the redirect when Dexie is broken.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const businessDate = outlet ? outletLocalDate(now, outlet.timezone) : null;

  const sales = useLiveQuery<readonly PendingSale[] | undefined>(async () => {
    if (!db || !outlet) return undefined;
    return db.repos.pendingSales.listAll();
  }, [db, outlet?.id]);

  const outstandingCount = useLiveQuery<number | undefined>(
    async () => (db ? db.repos.pendingSales.countOutstanding() : undefined),
    [db],
  );

  const existingClosure = useLiveQuery<EodClosure | null | undefined>(async () => {
    if (!db || !outlet || !businessDate) return undefined;
    return (await db.repos.eodClosures.get(outlet.id, businessDate)) ?? null;
  }, [db, outlet?.id, businessDate]);

  return {
    ready: Boolean(db && outlet && businessDate),
    outlet: outlet ?? null,
    businessDate,
    sales: sales ?? [],
    existingClosure: existingClosure ?? null,
    outstandingCount: outstandingCount ?? 0,
  };
}

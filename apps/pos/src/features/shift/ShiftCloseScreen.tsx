import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useLiveQuery } from "dexie-react-hooks";
import { NumericKeypad, applyKeypadKey } from "../../shared/components/NumericKeypad.tsx";
import { formatIdr, toRupiah, zeroRupiah, type Rupiah } from "../../shared/money/index.ts";
import { apiBaseUrl } from "../../data/api/config.ts";
import { getDatabase, type Database } from "../../data/db/index.ts";
import { getSnapshot } from "../../lib/enrolment.ts";
import { useSyncActions } from "../../lib/sync-context.tsx";
import type { PendingSale, ShiftState } from "../../data/db/types.ts";
import { closeShift } from "./api.ts";
import { enqueueCloseShift, getCurrentShift } from "./repository.ts";

/*
 * `/shift/close` — cashier counts the drawer at end of shift.
 *
 * The expected-cash math here mirrors the server's:
 *   `expectedCash = openingFloatIdr + sum(cashTendersForOutletAndDate)`.
 *
 * The screen surfaces variance (counted − expected) so the cashier sees
 * the same number the server will record. The server is still the source
 * of truth — we render the local number for fast feedback and then
 * enqueue the close event into the outbox.
 */

const MAX_COUNTED_CASH = 999_999_999;

function sumCashTenders(rows: readonly PendingSale[]): number {
  let total = 0;
  for (const row of rows) {
    if (row.status === "needs_attention") continue; // unsynced, drop
    for (const tender of row.tenders) {
      if (tender.method === "cash") total += tender.amountIdr as number;
    }
  }
  return total;
}

export function ShiftCloseScreen() {
  const navigate = useNavigate();
  const { triggerPush } = useSyncActions();
  const [db, setDb] = useState<Database | null>(null);
  const [shift, setShift] = useState<ShiftState | null>(null);
  const [counted, setCounted] = useState<Rupiah>(zeroRupiah);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const database = await getDatabase();
        if (cancelled) return;
        setDb(database);
        const current = await getCurrentShift();
        if (!cancelled) setShift(current);
      } catch {
        // boot guard owns the redirect on Dexie failure
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const sales = useLiveQuery<readonly PendingSale[] | undefined>(async () => {
    if (!db || !shift) return undefined;
    const all = await db.repos.pendingSales.listAll();
    return all.filter(
      (s) => s.outletId === shift.outletId && s.businessDate === shift.businessDate,
    );
  }, [db, shift?.outletId, shift?.businessDate]);

  const handleKey = useCallback((key: Parameters<typeof applyKeypadKey>[1]) => {
    setCounted((current) => {
      const next = applyKeypadKey(current as number, key);
      const clamped = Math.min(Math.max(0, next), MAX_COUNTED_CASH);
      return toRupiah(clamped);
    });
  }, []);

  const openShiftId = shift?.openShiftId ?? null;
  const handleSubmit = useCallback(async () => {
    if (submitting || !openShiftId) return;
    const snap = getSnapshot();
    if (snap.state !== "enrolled") {
      setError("Perangkat belum terdaftar.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await enqueueCloseShift({
        countedCashIdr: counted as number,
      });
      if (result.kind === "no_open_shift") {
        setError("Shift sudah ditutup.");
        setSubmitting(false);
        return;
      }
      try {
        await closeShift(
          {
            closeShiftId: result.event.closeShiftId as string,
            openShiftId,
            closedAt: result.event.occurredAt,
            countedCashIdr: counted as number,
          },
          {
            baseUrl: apiBaseUrl() || window.location.origin,
            auth: { apiKey: snap.device.apiKey, apiSecret: snap.device.apiSecret },
          },
        );
      } catch {
        // outbox owns durability
      }
      void triggerPush().catch(() => {});
      await navigate({ to: "/eod" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Gagal menutup shift.";
      setError(message);
      setSubmitting(false);
    }
  }, [counted, navigate, openShiftId, submitting, triggerPush]);

  if (!shift) {
    return (
      <section className="space-y-3" data-testid="shift-close-no-open">
        <p className="text-sm text-neutral-600">Tidak ada shift terbuka.</p>
        <button
          type="button"
          onClick={() => navigate({ to: "/shift/open" })}
          className="rounded-lg bg-neutral-900 px-4 py-3 text-base font-semibold text-white"
        >
          Buka shift baru
        </button>
      </section>
    );
  }

  const cashSales = sumCashTenders(sales ?? []);
  const expectedCash = (shift.openingFloatIdr as number) + cashSales;
  const variance = (counted as number) - expectedCash;

  return (
    <section
      className="flex h-full flex-col gap-4"
      aria-label="Tutup shift"
      data-testid="shift-close-screen"
    >
      <header className="space-y-1">
        <h1 className="text-lg font-bold text-neutral-900">Tutup shift</h1>
        <p className="text-sm text-neutral-600">
          Hitung uang fisik di laci, lalu masukkan totalnya.
        </p>
      </header>

      <dl className="rounded-lg border border-neutral-200 bg-white p-4 space-y-2 text-sm">
        <div className="flex items-center justify-between">
          <dt className="text-neutral-600">Modal awal</dt>
          <dd className="font-medium tabular-nums" data-testid="shift-close-float">
            {formatIdr(toRupiah(shift.openingFloatIdr as number))}
          </dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-neutral-600">Penjualan tunai</dt>
          <dd className="font-medium tabular-nums" data-testid="shift-close-cash-sales">
            {formatIdr(toRupiah(cashSales))}
          </dd>
        </div>
        <div className="flex items-center justify-between border-t border-neutral-200 pt-2">
          <dt className="text-neutral-700 font-medium">Seharusnya</dt>
          <dd className="text-lg font-semibold tabular-nums" data-testid="shift-close-expected">
            {formatIdr(toRupiah(expectedCash))}
          </dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-neutral-600">Dihitung</dt>
          <dd
            className="text-2xl font-bold tabular-nums text-neutral-900"
            data-testid="shift-close-counted"
          >
            {formatIdr(counted)}
          </dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-neutral-600">Selisih</dt>
          <dd
            className={
              variance === 0
                ? "font-medium tabular-nums text-emerald-700"
                : "font-medium tabular-nums text-red-700"
            }
            data-testid="shift-close-variance"
          >
            {variance >= 0 ? "+" : "−"}
            {formatIdr(toRupiah(Math.abs(variance)))}
          </dd>
        </div>
      </dl>

      <NumericKeypad
        onKey={handleKey}
        disabled={submitting}
        aria-label="Keypad nominal tunai dihitung"
      />

      {error ? (
        <p
          role="alert"
          className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </p>
      ) : null}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={submitting}
        data-testid="shift-close-submit"
        className="rounded-lg bg-neutral-900 px-4 py-3 text-base font-semibold text-white disabled:opacity-50"
      >
        {submitting ? "Menutup…" : "Tutup shift"}
      </button>
    </section>
  );
}

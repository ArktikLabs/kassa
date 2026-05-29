import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useLiveQuery } from "dexie-react-hooks";
import { NumericKeypad, applyKeypadKey } from "../../shared/components/NumericKeypad.tsx";
import { formatIdr, toRupiah, zeroRupiah, type Rupiah } from "../../shared/money/index.ts";
import { apiBaseUrl } from "../../data/api/config.ts";
import { getDatabase, type Database } from "../../data/db/index.ts";
import { getSnapshot } from "../../lib/enrolment.ts";
import { useSyncActions } from "../../lib/sync-context.tsx";
import type { ParkedSale, PendingSale, ShiftState } from "../../data/db/types.ts";
import { clearParkedForCurrentShift } from "../parked-sales/repository.ts";
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
  const [confirmingParked, setConfirmingParked] = useState(false);

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

  const parkedRows = useLiveQuery<readonly ParkedSale[] | undefined>(async () => {
    if (!db || !shift) return undefined;
    return db.repos.parkedSales.listForShift(shift.outletId, shift.localShiftId);
  }, [db, shift?.outletId, shift?.localShiftId]);
  const parkedCount = parkedRows?.length ?? 0;

  const handleKey = useCallback((key: Parameters<typeof applyKeypadKey>[1]) => {
    setCounted((current) => {
      const next = applyKeypadKey(current as number, key);
      const clamped = Math.min(Math.max(0, next), MAX_COUNTED_CASH);
      return toRupiah(clamped);
    });
  }, []);

  const openShiftId = shift?.openShiftId ?? null;
  const finalizeClose = useCallback(async () => {
    if (submitting || !openShiftId) return;
    const snap = getSnapshot();
    if (snap.state !== "enrolled") {
      setError("Perangkat belum terdaftar.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // KASA-366 — clear the parked tray atomically with the shift close
      // so a parked cart from a closed shift cannot resurface in the next
      // one. Failure here is non-fatal: stranded rows are still scoped to
      // a now-closed `localShiftId` and won't show up in the live query.
      try {
        await clearParkedForCurrentShift();
      } catch {
        // best-effort
      }
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

  const handleSubmit = useCallback(async () => {
    if (parkedCount > 0 && !confirmingParked) {
      setConfirmingParked(true);
      return;
    }
    await finalizeClose();
  }, [confirmingParked, finalizeClose, parkedCount]);

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

      {parkedCount > 0 ? (
        <p
          role="status"
          className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
          data-testid="shift-close-parked-warning"
          data-parked-count={parkedCount}
        >
          {parkedCount === 1
            ? "Ada 1 keranjang yang masih diparkir. Menutup shift akan membuangnya."
            : `Ada ${parkedCount} keranjang yang masih diparkir. Menutup shift akan membuangnya.`}
        </p>
      ) : null}

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

      {confirmingParked ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="shift-close-parked-confirm-title"
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
          data-testid="shift-close-parked-confirm"
        >
          <div className="w-full max-w-md rounded-t-2xl bg-white p-4 shadow-xl sm:rounded-2xl">
            <h2
              id="shift-close-parked-confirm-title"
              className="text-lg font-bold text-neutral-900"
            >
              Tutup shift &amp; buang keranjang diparkir?
            </h2>
            <p className="mt-1 text-sm text-neutral-600">
              {parkedCount === 1
                ? "1 keranjang masih ada di parkiran. Lanjutkan akan menghapusnya secara permanen."
                : `${parkedCount} keranjang masih ada di parkiran. Lanjutkan akan menghapus semuanya secara permanen.`}
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmingParked(false)}
                disabled={submitting}
                data-testid="shift-close-parked-cancel"
                className="h-11 flex-1 rounded-md border border-neutral-300 bg-white font-semibold text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={() => {
                  void finalizeClose();
                }}
                disabled={submitting}
                data-testid="shift-close-parked-confirm-button"
                className="h-11 flex-1 rounded-md bg-red-700 font-semibold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:bg-red-300"
              >
                Buang &amp; tutup
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

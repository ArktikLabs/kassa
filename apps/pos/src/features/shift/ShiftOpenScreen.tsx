import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { NumericKeypad, applyKeypadKey } from "../../shared/components/NumericKeypad.tsx";
import { formatIdr, toRupiah, zeroRupiah, type Rupiah } from "../../shared/money/index.ts";
import { apiBaseUrl } from "../../data/api/config.ts";
import { getDatabase } from "../../data/db/index.ts";
import { getSnapshot } from "../../lib/enrolment.ts";
import { useSyncActions } from "../../lib/sync-context.tsx";
import { enqueueOpenShift } from "./repository.ts";
import { openShift } from "./api.ts";

/*
 * `/shift/open` — cashier signs on by entering the starting cash float.
 *
 * Flow (KASA-235):
 *   1. Cashier types the working float into the numeric keypad.
 *   2. Tap "Buka shift" → enqueue an `open` event in the shift outbox
 *      and stamp the local `shift_state` singleton in one go.
 *   3. Best-effort online POST to `/v1/shifts/open`. Online success
 *      promotes the local row's `serverShiftId`; offline / failure
 *      leaves the row queued for the sync runner to drain.
 *   4. Navigate to `/catalog` so the cashier can start ringing sales.
 */

const MAX_FLOAT_IDR = 99_999_999;

function outletLocalDate(now: Date, timezone: string | undefined): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone ?? "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function ShiftOpenScreen() {
  const navigate = useNavigate();
  const { triggerPush } = useSyncActions();
  const [openingFloat, setOpeningFloat] = useState<Rupiah>(zeroRupiah);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outletTimezone, setOutletTimezone] = useState<string>("Asia/Jakarta");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const snap = getSnapshot();
      if (snap.state !== "enrolled") return;
      try {
        const database = await getDatabase();
        const outlet = await database.repos.outlets.getById(snap.device.outlet.id);
        if (!cancelled && outlet?.timezone) setOutletTimezone(outlet.timezone);
      } catch {
        // The boot guard owns the redirect when Dexie fails — fall back to the default tz.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleKey = useCallback((key: Parameters<typeof applyKeypadKey>[1]) => {
    setOpeningFloat((current) => {
      const next = applyKeypadKey(current as number, key);
      const clamped = Math.min(Math.max(0, next), MAX_FLOAT_IDR);
      return toRupiah(clamped);
    });
  }, []);

  const handleSubmit = useCallback(async () => {
    if (submitting) return;
    const snap = getSnapshot();
    if (snap.state !== "enrolled") {
      setError("Perangkat belum terdaftar.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const businessDate = outletLocalDate(new Date(), outletTimezone);
      const result = await enqueueOpenShift({
        outletId: snap.device.outlet.id,
        // v0 single-cashier-per-outlet — use deviceId as the cashier
        // identity until the staff-session shift handoff lands (out of
        // scope per KASA-235 description).
        cashierStaffId: snap.device.deviceId,
        businessDate,
        openingFloatIdr: openingFloat as number,
      });

      // Best-effort online open. Failure is silent: the outbox row is
      // already queued and the sync runner will drain it on the next
      // online cycle.
      try {
        await openShift(
          {
            openShiftId: result.event.openShiftId as string,
            outletId: snap.device.outlet.id,
            cashierStaffId: snap.device.deviceId,
            businessDate,
            openedAt: result.event.occurredAt,
            openingFloatIdr: openingFloat as number,
          },
          {
            baseUrl: apiBaseUrl() || window.location.origin,
            auth: { apiKey: snap.device.apiKey, apiSecret: snap.device.apiSecret },
          },
        );
      } catch {
        // ignore — outbox owns durability
      }
      void triggerPush().catch(() => {});

      await navigate({ to: "/catalog" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Gagal membuka shift.";
      setError(message);
      setSubmitting(false);
    }
  }, [navigate, openingFloat, outletTimezone, submitting, triggerPush]);

  return (
    <section
      className="flex h-full flex-col gap-4"
      aria-label="Buka shift"
      data-testid="shift-open-screen"
    >
      <header className="space-y-1">
        <h1 className="text-lg font-bold text-neutral-900">Buka shift</h1>
        <p className="text-sm text-neutral-600">
          Masukkan jumlah uang awal di laci sebelum mulai transaksi.
        </p>
      </header>

      <dl className="rounded-lg border border-neutral-200 bg-white p-4 space-y-2 text-sm">
        <div className="flex items-center justify-between">
          <dt className="text-neutral-600">Modal awal</dt>
          <dd
            data-testid="shift-open-float"
            className="text-2xl font-bold tabular-nums text-neutral-900"
          >
            {formatIdr(openingFloat)}
          </dd>
        </div>
      </dl>

      <NumericKeypad
        onKey={handleKey}
        disabled={submitting}
        aria-label="Keypad nominal modal awal"
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
        data-testid="shift-open-submit"
        className="rounded-lg bg-neutral-900 px-4 py-3 text-base font-semibold text-white disabled:opacity-50"
      >
        {submitting ? "Membuka…" : "Buka shift"}
      </button>
    </section>
  );
}

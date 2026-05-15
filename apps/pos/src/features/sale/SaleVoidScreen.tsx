/*
 * KASA-236-B — POS manager-PIN void flow.
 *
 * Reached via /sale/$id/void from either:
 *   - the post-sale receipt screen (`/receipt/$id`)
 *   - the sales history list (`/sales/history` → row "Batalkan")
 *
 * Eligibility (UI-side):
 *   1. The sale must exist locally.
 *   2. The sale must not already be voided.
 *   3. The sale's `businessDate` must equal the currently-open shift's.
 *      Sales from a prior shift route through the back-office
 *      reconciliation flow (server returns `void_outside_open_shift`).
 *
 * The screen collects:
 *   - manager staff id (v0 free-text UUID; a proper staff sync is out of
 *     scope per the parent issue scope note)
 *   - 4–8 digit manager PIN
 *   - optional reason
 *
 * Submit flow:
 *   1. Enqueue a `pending_voids` outbox row + optimistically flip the
 *      local sale to voided (offline-safe).
 *   2. Best-effort online POST. On `synced` go straight to the receipt
 *      and surface a success toast. On a terminal 4xx (manager-PIN /
 *      outside-shift) roll the optimistic mark back and surface the
 *      mapped error.
 *   3. On `offline`/network error leave the row queued and route back to
 *      the receipt with the "Pembatalan akan diproses saat online" toast.
 */

import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams, Link } from "@tanstack/react-router";
import { FormattedMessage, useIntl } from "react-intl";
import { showToast } from "../../components/Toast.tsx";
import { apiBaseUrl } from "../../data/api/config.ts";
import { getDatabase, type Database } from "../../data/db/index.ts";
import type { PendingSale, ShiftState } from "../../data/db/types.ts";
import { getSnapshot } from "../../lib/enrolment.ts";
import { useSyncActions } from "../../lib/sync-context.tsx";
import { enqueueVoid } from "./voidRepository.ts";
import { voidSale, type VoidSaleApiResult } from "./voidApi.ts";

type Phase = "idle" | "submitting";

interface LoadedSale {
  sale: PendingSale;
  shift: ShiftState | null;
}

async function loadSale(database: Database, localSaleId: string): Promise<LoadedSale | null> {
  const sale = await database.repos.pendingSales.getById(localSaleId);
  if (!sale) return null;
  const shift = await database.repos.shiftState.get();
  return {
    sale,
    shift: shift && shift.closedAt === null ? shift : null,
  };
}

export function SaleVoidScreen() {
  const intl = useIntl();
  const navigate = useNavigate();
  const { id: localSaleId } = useParams({ from: "/sale/$id/void" });
  const { triggerPush } = useSyncActions();

  const [db, setDb] = useState<Database | null>(null);
  const [loaded, setLoaded] = useState<LoadedSale | null | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>("idle");
  const [managerStaffId, setManagerStaffId] = useState("");
  const [managerPin, setManagerPin] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    getDatabase()
      .then((next) => {
        if (cancelled) return;
        setDb(next);
        return loadSale(next, localSaleId).then((row) => {
          if (!cancelled) setLoaded(row);
        });
      })
      .catch(() => {
        if (!cancelled) setLoaded(null);
      });
    return () => {
      cancelled = true;
    };
  }, [localSaleId]);

  const pinValid = /^\d{4,8}$/.test(managerPin);
  const managerIdValid = managerStaffId.trim().length > 0;
  const canSubmit = phase === "idle" && pinValid && managerIdValid && Boolean(loaded?.sale);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || !db || !loaded) return;
    const { sale, shift } = loaded;

    // UI-side gate — keeps the request off the wire when we can already
    // see it will 422. The server still re-checks; this is just a faster
    // failure path for the common case.
    if (!shift || shift.businessDate !== sale.businessDate) {
      setError(intl.formatMessage({ id: "void.error.outside_shift" }));
      return;
    }
    if (sale.voidedAt) {
      setError(intl.formatMessage({ id: "void.error.already_voided" }));
      return;
    }
    if (!sale.serverSaleId) {
      // Pre-sync: the sale hasn't landed on the server yet, so we can't
      // call its void route. Tell the cashier to retry once the sync
      // indicator shows green.
      setError(intl.formatMessage({ id: "void.error.unsynced" }));
      return;
    }

    setPhase("submitting");
    setError(null);

    const snap = getSnapshot();
    const auth =
      snap.state === "enrolled"
        ? { apiKey: snap.device.apiKey, apiSecret: snap.device.apiSecret }
        : null;

    let enqueued: Awaited<ReturnType<typeof enqueueVoid>>;
    try {
      enqueued = await enqueueVoid({
        saleId: sale.serverSaleId,
        localSaleId: sale.localSaleId,
        outletId: sale.outletId,
        managerStaffId: managerStaffId.trim(),
        managerPin,
        voidBusinessDate: shift.businessDate,
        reason: reason.trim() || null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("idle");
      return;
    }

    // Best-effort online call. The outbox row is the durable layer; we
    // try the network anyway so a connected device gets an immediate
    // success/failure verdict without waiting for the next runner tick.
    let result: VoidSaleApiResult;
    if (auth) {
      result = await voidSale(
        {
          saleId: sale.serverSaleId,
          localVoidId: enqueued.row.localVoidId,
          managerStaffId: managerStaffId.trim(),
          managerPin,
          voidedAt: enqueued.row.voidedAt,
          voidBusinessDate: enqueued.row.voidBusinessDate,
          reason: enqueued.row.reason,
        },
        {
          baseUrl: apiBaseUrl() || window.location.origin,
          auth,
        },
      );
    } else {
      result = { kind: "offline", reason: "unenrolled" };
    }

    switch (result.kind) {
      case "synced": {
        // Mark the outbox row synced so the drain doesn't replay it. The
        // optimistic markVoided we did in enqueueVoid is already correct.
        await db.repos.pendingVoids.markSynced(enqueued.row.localVoidId, new Date().toISOString());
        void triggerPush().catch(() => {});
        showToast(intl.formatMessage({ id: "void.toast.success" }), "success");
        await navigate({ to: "/receipt/$id", params: { id: localSaleId } });
        return;
      }
      case "manager_pin_required": {
        // Roll back the optimistic mark — the void didn't happen.
        await rollbackOptimisticVoid(db, sale.localSaleId, enqueued.row.localVoidId);
        await db.repos.pendingVoids.markNeedsAttention(
          enqueued.row.localVoidId,
          result.message,
          new Date().toISOString(),
        );
        setError(intl.formatMessage({ id: "void.error.manager_pin_required" }));
        showToast(intl.formatMessage({ id: "void.toast.manager_pin_required" }), "error");
        setPhase("idle");
        return;
      }
      case "outside_open_shift": {
        await rollbackOptimisticVoid(db, sale.localSaleId, enqueued.row.localVoidId);
        await db.repos.pendingVoids.markNeedsAttention(
          enqueued.row.localVoidId,
          result.message,
          new Date().toISOString(),
        );
        setError(intl.formatMessage({ id: "void.error.outside_shift" }));
        showToast(intl.formatMessage({ id: "void.toast.outside_shift" }), "error");
        setPhase("idle");
        return;
      }
      case "rejected": {
        await rollbackOptimisticVoid(db, sale.localSaleId, enqueued.row.localVoidId);
        await db.repos.pendingVoids.markNeedsAttention(
          enqueued.row.localVoidId,
          result.message,
          new Date().toISOString(),
        );
        setError(result.message);
        showToast(result.message, "error");
        setPhase("idle");
        return;
      }
      case "retriable":
      case "offline": {
        // Leave the row queued; the runner drains it. The optimistic mark
        // stays so the PEMBATALAN banner appears immediately.
        void triggerPush().catch(() => {});
        showToast(intl.formatMessage({ id: "void.toast.queued" }), "info");
        await navigate({ to: "/receipt/$id", params: { id: localSaleId } });
        return;
      }
    }
  }, [
    canSubmit,
    db,
    intl,
    loaded,
    localSaleId,
    managerPin,
    managerStaffId,
    navigate,
    reason,
    triggerPush,
  ]);

  if (loaded === undefined) {
    return (
      <section className="space-y-3" aria-busy data-testid="sale-void-loading">
        <p className="text-sm text-neutral-500">
          <FormattedMessage id="void.loading" />
        </p>
      </section>
    );
  }

  if (loaded === null) {
    return (
      <section
        className="space-y-2 rounded-md border border-danger-border bg-danger-surface p-4"
        role="alert"
        data-testid="sale-void-missing"
      >
        <h1 className="text-lg font-bold text-danger-fg">
          <FormattedMessage id="receipt.missing.heading" />
        </h1>
        <p className="text-sm text-danger-fg">
          <FormattedMessage id="receipt.missing.body" />
        </p>
      </section>
    );
  }

  const { sale, shift } = loaded;
  const eligibility = computeEligibility(sale, shift);

  return (
    <section
      className="space-y-4"
      aria-label={intl.formatMessage({ id: "void.aria" })}
      data-testid="sale-void-screen"
    >
      <header className="space-y-1">
        <Link
          to="/receipt/$id"
          params={{ id: sale.localSaleId }}
          className="text-sm font-semibold text-primary-700 hover:text-primary-800"
          data-testid="sale-void-back"
        >
          <FormattedMessage id="void.back" />
        </Link>
        <h1 className="text-lg font-bold text-neutral-900">
          <FormattedMessage id="void.heading" />
        </h1>
        <p className="text-sm text-neutral-600">
          <FormattedMessage id="void.notice" />
        </p>
      </header>

      {eligibility.kind !== "ok" ? (
        <p
          role="alert"
          data-testid="sale-void-ineligible"
          className="rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-sm text-warning-fg"
        >
          <FormattedMessage id={eligibility.messageId} />
        </p>
      ) : (
        <form
          className="space-y-3"
          data-testid="sale-void-form"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          <label className="block space-y-1">
            <span className="text-sm font-semibold text-neutral-900">
              <FormattedMessage id="void.field.managerStaffId" />
            </span>
            <input
              type="text"
              value={managerStaffId}
              onChange={(event) => setManagerStaffId(event.currentTarget.value)}
              autoComplete="off"
              spellCheck={false}
              data-testid="sale-void-manager-staff-id"
              className="w-full rounded-md border border-neutral-300 px-3 py-2 text-base font-mono tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"
              placeholder={intl.formatMessage({ id: "void.field.managerStaffId.placeholder" })}
              disabled={phase === "submitting"}
            />
            <span className="text-xs text-neutral-600">
              <FormattedMessage id="void.field.managerStaffId.hint" />
            </span>
          </label>

          <label className="block space-y-1">
            <span className="text-sm font-semibold text-neutral-900">
              <FormattedMessage id="void.field.managerPin" />
            </span>
            <input
              type="password"
              inputMode="numeric"
              pattern="\d{4,8}"
              minLength={4}
              maxLength={8}
              value={managerPin}
              onChange={(event) =>
                setManagerPin(event.currentTarget.value.replace(/\D/g, "").slice(0, 8))
              }
              autoComplete="off"
              data-testid="sale-void-manager-pin"
              className="w-full rounded-md border border-neutral-300 px-3 py-2 text-base font-mono tracking-[0.5em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"
              placeholder="••••"
              disabled={phase === "submitting"}
            />
            <span className="text-xs text-neutral-600">
              <FormattedMessage id="void.field.managerPin.hint" />
            </span>
          </label>

          <label className="block space-y-1">
            <span className="text-sm font-semibold text-neutral-900">
              <FormattedMessage id="void.field.reason" />
            </span>
            <input
              type="text"
              value={reason}
              onChange={(event) => setReason(event.currentTarget.value.slice(0, 256))}
              autoComplete="off"
              data-testid="sale-void-reason"
              className="w-full rounded-md border border-neutral-300 px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"
              placeholder={intl.formatMessage({ id: "void.field.reason.placeholder" })}
              disabled={phase === "submitting"}
            />
          </label>

          {error ? (
            <p
              role="alert"
              data-testid="sale-void-error"
              className="rounded-md border border-danger-border bg-danger-surface px-3 py-2 text-sm text-danger-fg"
            >
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={!canSubmit}
            data-testid="sale-void-submit"
            className={[
              "w-full h-14 rounded-md text-base font-semibold",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 focus-visible:ring-offset-white",
              canSubmit
                ? "bg-red-700 text-white active:bg-red-800"
                : "bg-neutral-200 text-neutral-500",
            ].join(" ")}
          >
            {phase === "submitting" ? (
              <FormattedMessage id="void.cta.submitting" />
            ) : (
              <FormattedMessage id="void.cta" />
            )}
          </button>
        </form>
      )}
    </section>
  );
}

type Eligibility = { kind: "ok" } | { kind: "blocked"; messageId: string };

function computeEligibility(sale: PendingSale, shift: ShiftState | null): Eligibility {
  if (sale.voidedAt) return { kind: "blocked", messageId: "void.error.already_voided" };
  if (!shift) return { kind: "blocked", messageId: "void.error.no_open_shift" };
  if (shift.businessDate !== sale.businessDate) {
    return { kind: "blocked", messageId: "void.error.outside_shift" };
  }
  if (!sale.serverSaleId) return { kind: "blocked", messageId: "void.error.unsynced" };
  return { kind: "ok" };
}

/**
 * Returns true when a sale can be voided from the POS right now: it
 * belongs to the currently-open shift, is not already voided, and is
 * known to the server (we have its serverSaleId). The entry-point
 * components (receipt screen, history list) call this to decide whether
 * to surface the Batalkan affordance.
 */
export function canVoidSale(sale: PendingSale, shift: ShiftState | null): boolean {
  return computeEligibility(sale, shift).kind === "ok";
}

async function rollbackOptimisticVoid(
  database: Database,
  localSaleId: string,
  expectedVoidLocalId: string,
): Promise<void> {
  await database.repos.pendingSales.clearOptimisticVoid(localSaleId, expectedVoidLocalId);
}

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { FormattedMessage, useIntl } from "react-intl";
import {
  createQrisOrder,
  QrisApiError,
  type CreateQrisOrderResponse,
  type QrisOrderStatusName,
} from "../../data/api/qris";
import { getDatabase } from "../../data/db/index.ts";
import { formatIdr } from "../../shared/money/index.ts";
import { uuidv7 } from "../../lib/uuidv7.ts";
import { useCartStore } from "../cart/store.ts";
import { finalizeQrisSale, SaleFinalizeError } from "../sale/finalize.ts";
import { QrSvg } from "./QrSvg.tsx";
import { useQrisPoll } from "./useQrisPoll.ts";

type LifecycleStep = "idle" | "creating" | "waiting" | "finalizing" | "error";

interface CreatedOrder extends CreateQrisOrderResponse {
  localSaleId: string;
}

/*
 * KASA-63 dynamic QRIS tender.
 *
 * The clerk taps "Buat QR" → we mint a UUIDv7 on the client and call
 * `POST /v1/payments/qris`. The resulting EMV payload is rendered inline
 * and the panel starts polling status every 3 s. On `paid` we enqueue the
 * sale to the outbox (same path cash uses) with `tender.reference` set to
 * the Midtrans order id, then route to the receipt. On `expired` or
 * `cancelled` we surface a retry + switch-to-cash choice. If the create-QR
 * call fails at the network layer we hide the QR and show the "Offline —
 * gunakan QRIS statis" fallback link (KASA-64 owns the static route).
 */
export function TenderQrisPanel() {
  const intl = useIntl();
  const navigate = useNavigate();
  const lines = useCartStore((s) => s.lines);
  const totalsFn = useCartStore((s) => s.totals);
  const clear = useCartStore((s) => s.clear);
  const t = totalsFn();

  const [step, setStep] = useState<LifecycleStep>("idle");
  const [order, setOrder] = useState<CreatedOrder | null>(null);
  const [createError, setCreateError] = useState<QrisApiError | null>(null);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  // Synchronously guard "Buat QR" so a double-tap (the two clicks arrive
  // before React commits the `creating` state) cannot mint two Midtrans
  // orders. React state alone is not enough here because setState is async.
  const creatingRef = useRef(false);
  // Track the order id the panel has already finalised so a late polling tick
  // (e.g. `capture` followed by `settlement`) cannot double-enqueue the sale.
  const finalizedOrderRef = useRef<string | null>(null);

  const empty = lines.length === 0;
  const poll = useQrisPoll(step === "waiting" && order ? order.qrisOrderId : null);
  const pollStatus: QrisOrderStatusName | null = poll.status;

  const handleCreate = useCallback(async () => {
    if (empty) return;
    if (creatingRef.current) return;
    if (step === "creating" || step === "waiting" || step === "finalizing") return;
    creatingRef.current = true;
    setStep("creating");
    setCreateError(null);
    setFinalizeError(null);
    const localSaleId = uuidv7();
    try {
      const database = await getDatabase();
      const deviceSecret = await database.repos.deviceSecret.get();
      if (!deviceSecret) throw new QrisApiError("bad_request", "device is not enrolled");
      const response = await createQrisOrder({
        amount: t.totalIdr as number,
        localSaleId,
        outletId: deviceSecret.outletId,
      });
      setOrder({ ...response, localSaleId });
      setStep("waiting");
    } catch (err) {
      const e = err instanceof QrisApiError ? err : new QrisApiError("unknown", String(err));
      setCreateError(e);
      setOrder(null);
      setStep("error");
    } finally {
      creatingRef.current = false;
    }
  }, [empty, step, t.totalIdr]);

  const handleReset = useCallback(() => {
    finalizedOrderRef.current = null;
    creatingRef.current = false;
    setOrder(null);
    setCreateError(null);
    setFinalizeError(null);
    setStep("idle");
  }, []);

  const finalize = useCallback(
    async (current: CreatedOrder) => {
      if (finalizedOrderRef.current === current.qrisOrderId) return;
      finalizedOrderRef.current = current.qrisOrderId;
      setStep("finalizing");
      setFinalizeError(null);
      try {
        const database = await getDatabase();
        const result = await finalizeQrisSale(
          {
            lines,
            totals: t,
            localSaleId: current.localSaleId,
            qrisOrderId: current.qrisOrderId,
          },
          { database },
        );
        clear();
        await navigate({
          to: "/receipt/$id",
          params: { id: result.localSaleId },
        });
      } catch (err) {
        const message =
          err instanceof SaleFinalizeError
            ? err.message
            : intl.formatMessage({ id: "tender.qris.error.finalize" });
        setFinalizeError(message);
        finalizedOrderRef.current = null;
        setStep("waiting");
      }
    },
    [clear, intl, lines, navigate, t],
  );

  useEffect(() => {
    if (step !== "waiting" || !order) return;
    if (pollStatus === "paid") {
      void finalize(order);
    }
  }, [finalize, order, pollStatus, step]);

  return (
    <section
      aria-label={intl.formatMessage({ id: "tender.qris.aria" })}
      className="flex h-full flex-col gap-4"
      data-testid="tender-qris"
    >
      <header className="space-y-1">
        <h1 className="text-lg font-bold text-neutral-900">
          <FormattedMessage id="tender.qris.heading" />
        </h1>
        <dl className="rounded-lg bg-white border border-neutral-200 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <dt className="text-sm text-neutral-600">
              <FormattedMessage id="tender.qris.total" />
            </dt>
            <dd
              data-testid="tender-qris-total"
              className="text-[32px] leading-10 font-bold tabular-nums tracking-tight text-neutral-900"
              style={{ letterSpacing: "-0.01em" }}
              data-tabular="true"
            >
              {formatIdr(t.totalIdr)}
            </dd>
          </div>
        </dl>
      </header>

      {empty ? (
        <p
          role="status"
          data-testid="tender-qris-cart-empty"
          className="rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-sm text-warning-fg"
        >
          <FormattedMessage id="tender.qris.cart.empty" />
        </p>
      ) : null}

      {step === "idle" || step === "creating" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <p className="max-w-xs text-center text-sm text-neutral-600">
            <FormattedMessage id="tender.qris.intro" />
          </p>
          <button
            type="button"
            disabled={empty || step === "creating"}
            onClick={() => void handleCreate()}
            data-testid="tender-qris-create"
            className={[
              "min-w-[200px] h-14 rounded-md text-base font-semibold",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 focus-visible:ring-offset-white",
              empty || step === "creating"
                ? "bg-neutral-200 text-neutral-500 cursor-not-allowed"
                : "bg-primary-600 text-white active:bg-primary-700",
            ].join(" ")}
          >
            {step === "creating" ? (
              <FormattedMessage id="tender.qris.create.loading" />
            ) : (
              <FormattedMessage id="tender.qris.create.cta" />
            )}
          </button>
        </div>
      ) : null}

      {(step === "waiting" || step === "finalizing") && order ? (
        <div
          data-testid="tender-qris-display"
          data-qris-order-id={order.qrisOrderId}
          className="flex flex-1 flex-col items-center gap-4"
        >
          <div className="text-center">
            <p className="text-sm font-semibold text-neutral-700">
              <FormattedMessage
                id="tender.qris.instructions"
                values={{ total: formatIdr(t.totalIdr) }}
              />
            </p>
          </div>
          <QrSvg value={order.qrString} size={288} testId="tender-qris-qr" />
          <p
            role="status"
            data-testid="tender-qris-status"
            data-status={pollStatus ?? "polling"}
            className="text-sm tabular-nums text-neutral-600"
          >
            {pollStatus === "paid" || step === "finalizing" ? (
              <FormattedMessage id="tender.qris.status.paid" />
            ) : pollStatus === "expired" ? (
              <FormattedMessage id="tender.qris.status.expired" />
            ) : pollStatus === "cancelled" ? (
              <FormattedMessage id="tender.qris.status.cancelled" />
            ) : pollStatus === "failed" ? (
              <FormattedMessage id="tender.qris.status.failed" />
            ) : (
              <FormattedMessage id="tender.qris.status.polling" />
            )}
          </p>
          {finalizeError ? (
            <p
              role="alert"
              data-testid="tender-qris-finalize-error"
              className="rounded-md border border-danger-border bg-danger-surface px-3 py-2 text-sm text-danger-fg"
            >
              {finalizeError}
            </p>
          ) : null}
          {pollStatus === "expired" || pollStatus === "cancelled" || pollStatus === "failed" ? (
            <div className="flex w-full max-w-xs flex-col gap-2">
              <button
                type="button"
                onClick={handleReset}
                data-testid="tender-qris-retry"
                className="h-12 rounded-md bg-primary-600 text-base font-semibold text-white active:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
              >
                <FormattedMessage id="tender.qris.retry" />
              </button>
              <button
                type="button"
                onClick={() => {
                  void navigate({ to: "/tender/cash" });
                }}
                data-testid="tender-qris-switch-cash"
                className="h-12 rounded-md border border-neutral-300 text-base font-semibold text-neutral-800 active:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
              >
                <FormattedMessage id="tender.qris.switch.cash" />
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {step === "error" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <p
            role="alert"
            data-testid="tender-qris-create-error"
            data-error-code={createError?.code ?? "unknown"}
            className="rounded-md border border-danger-border bg-danger-surface px-3 py-2 text-sm text-danger-fg text-center"
          >
            {createError?.code === "network_error" ? (
              <FormattedMessage id="tender.qris.error.offline" />
            ) : createError?.code === "payments_unavailable" ? (
              <FormattedMessage id="tender.qris.error.unavailable" />
            ) : (
              <FormattedMessage id="tender.qris.error.create" />
            )}
          </p>
          <div className="flex w-full max-w-xs flex-col gap-2">
            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={empty}
              data-testid="tender-qris-retry-create"
              className="h-12 rounded-md bg-primary-600 text-base font-semibold text-white active:bg-primary-700 disabled:bg-neutral-200 disabled:text-neutral-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
            >
              <FormattedMessage id="tender.qris.create.retry" />
            </button>
            <button
              type="button"
              onClick={() => {
                void navigate({ to: "/tender/cash" });
              }}
              data-testid="tender-qris-switch-cash"
              className="h-12 rounded-md border border-neutral-300 text-base font-semibold text-neutral-800 active:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
            >
              <FormattedMessage id="tender.qris.switch.cash" />
            </button>
          </div>
        </div>
      ) : null}

      {createError?.code === "network_error" ? (
        <footer className="mt-auto pt-2">
          <a
            href="/tender/qris/static"
            data-testid="tender-qris-static-fallback"
            className="block w-full rounded-md border border-dashed border-neutral-300 px-3 py-2 text-center text-sm text-neutral-700 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"
          >
            <FormattedMessage id="tender.qris.static.fallback" />
          </a>
        </footer>
      ) : null}
    </section>
  );
}

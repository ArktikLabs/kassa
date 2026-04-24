import { useEffect, useState } from "react";
import {
  getQrisOrderStatus,
  QrisApiError,
  type QrisOrderStatusName,
  type QrisOrderStatusResponseBody,
} from "../../data/api/qris";

export interface QrisPollState {
  status: QrisOrderStatusName | null;
  paidAt: string | null;
  /** Last poll failure; null once a poll succeeds again. */
  error: QrisApiError | null;
}

const TERMINAL: ReadonlyArray<QrisOrderStatusName> = ["paid", "expired", "cancelled", "failed"];

/**
 * Poll `GET /v1/payments/qris/:orderId/status` every `intervalMs` until a
 * terminal state is observed or the caller unmounts. The first poll runs
 * immediately — we do not wait `intervalMs` before the first fetch because
 * the customer may pay between "Buat QR" and the first tick. Polling stops
 * as soon as we see `paid | expired | cancelled | failed`; the consumer
 * drives the next step (finalise, retry, or cancel) off the returned state.
 */
export function useQrisPoll(
  qrisOrderId: string | null,
  options: { intervalMs?: number; fetchImpl?: typeof fetch } = {},
): QrisPollState {
  const intervalMs = options.intervalMs ?? 3_000;
  const [state, setState] = useState<QrisPollState>({
    status: null,
    paidAt: null,
    error: null,
  });

  useEffect(() => {
    if (!qrisOrderId) {
      setState({ status: null, paidAt: null, error: null });
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (): Promise<void> => {
      try {
        const fetchOpts: { signal: AbortSignal; fetchImpl?: typeof fetch } = {
          signal: controller.signal,
        };
        if (options.fetchImpl) fetchOpts.fetchImpl = options.fetchImpl;
        const body: QrisOrderStatusResponseBody = await getQrisOrderStatus(qrisOrderId, fetchOpts);
        if (cancelled) return;
        setState({ status: body.status, paidAt: body.paidAt, error: null });
        if (TERMINAL.includes(body.status)) return;
      } catch (err) {
        if (cancelled) return;
        const e = err instanceof QrisApiError ? err : new QrisApiError("unknown", String(err));
        setState((prev) => ({ ...prev, error: e }));
        // Network errors: keep polling so a transient drop self-heals once
        // the tablet is back online. Terminal HTTP 4xx (bad_request) would
        // never self-heal, but the caller disables the panel on error from
        // `createQrisOrder` before we ever reach here, so this branch only
        // fires on transient network or upstream failures.
      }
      if (!cancelled) {
        timer = setTimeout(() => {
          void tick();
        }, intervalMs);
      }
    };

    void tick();

    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [qrisOrderId, intervalMs, options.fetchImpl]);

  return state;
}

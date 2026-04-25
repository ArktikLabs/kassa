import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { FormattedMessage, useIntl } from "react-intl";
import { getDatabase } from "../../data/db/index.ts";
import { fetchPrintedQris, PrintedQrisApiError } from "../../data/api/printed-qris.ts";
import type { PrintedQris } from "../../data/db/types.ts";
import { formatIdr } from "../../shared/money/index.ts";
import { useCartStore } from "../cart/store.ts";
import { finalizeQrisStaticSale, SaleFinalizeError } from "../sale/finalize.ts";

/*
 * KASA-118 static-QRIS tender (ADR-008 fallback).
 *
 * The clerk lands here when the device is offline or when dynamic QRIS
 * fails. The panel renders the merchant's printed-QR image (cached per
 * outlet in Dexie), the amount in large tabular numerals, and a 4-digit
 * input for the last 4 digits of the buyer's reference. On "Selesai" we
 * write a PendingSale with `tender.method: "qris_static"`, `verified: false`,
 * and `buyerRefLast4`. Server-side reconciliation (KASA-64 / PR #34) flips
 * the row to `verified: true` after matching against the Midtrans EOD
 * settlement report.
 */

/**
 * Refresh the printed-QR cache when the local row is older than 24h. The
 * threshold is generous on purpose: the merchant's printed QR is a static
 * EMV string, refreshing it more often only burns network on a value that
 * almost never changes.
 */
const PRINTED_QR_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

type ImageState =
  | { kind: "loading" }
  | { kind: "ready"; image: string; mimeType: string; fetchedAt: string }
  | { kind: "missing"; reason: PrintedQrisApiError["code"] | "unenrolled" };

type FinalizeState = "idle" | "submitting" | "error";

interface TenderQrisStaticPanelDeps {
  fetchPrintedQris?: typeof fetchPrintedQris;
  now?: () => Date;
}

interface TenderQrisStaticPanelProps {
  /**
   * Optional override so tests can inject a deterministic clock and a
   * stubbed `fetchPrintedQris`. Production wires this from `useDeps()`-style
   * defaults; we keep it explicit because the panel has no other DI seam.
   */
  deps?: TenderQrisStaticPanelDeps | undefined;
}

function isFresh(row: PrintedQris, now: Date): boolean {
  const fetchedAt = Date.parse(row.fetchedAt);
  if (!Number.isFinite(fetchedAt)) return false;
  return now.getTime() - fetchedAt < PRINTED_QR_STALE_AFTER_MS;
}

export function TenderQrisStaticPanel({ deps }: TenderQrisStaticPanelProps = {}) {
  const intl = useIntl();
  const navigate = useNavigate();
  const lines = useCartStore((s) => s.lines);
  const totalsFn = useCartStore((s) => s.totals);
  const clear = useCartStore((s) => s.clear);
  const t = totalsFn();

  const [last4, setLast4] = useState("");
  const [image, setImage] = useState<ImageState>({ kind: "loading" });
  const [finalize, setFinalize] = useState<FinalizeState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const empty = lines.length === 0;
  const last4Valid = /^\d{4}$/.test(last4);
  const canSubmit = !empty && last4Valid && finalize !== "submitting";

  // Hydrate the cached printed-QR image on mount and (when stale) refetch
  // from the server in the background. The cache fallback means an offline
  // tablet with a previously-fetched QR still renders it to the buyer.
  useEffect(() => {
    let cancelled = false;
    const fetcher = deps?.fetchPrintedQris ?? fetchPrintedQris;
    const now = deps?.now ?? (() => new Date());

    async function hydrate() {
      try {
        const database = await getDatabase();
        const deviceSecret = await database.repos.deviceSecret.get();
        if (!deviceSecret) {
          if (!cancelled) setImage({ kind: "missing", reason: "unenrolled" });
          return;
        }
        const cached = await database.repos.printedQris.get(deviceSecret.outletId);
        if (cached) {
          if (cancelled) return;
          setImage({
            kind: "ready",
            image: cached.image,
            mimeType: cached.mimeType,
            fetchedAt: cached.fetchedAt,
          });
        }
        const fresh = cached && isFresh(cached, now());
        if (fresh) return;

        try {
          const fetched = await fetcher(deviceSecret.outletId);
          if (cancelled) return;
          const row: PrintedQris = {
            outletId: fetched.outletId,
            image: fetched.image,
            mimeType: fetched.mimeType,
            fetchedAt: now().toISOString(),
          };
          await database.repos.printedQris.put(row);
          setImage({
            kind: "ready",
            image: row.image,
            mimeType: row.mimeType,
            fetchedAt: row.fetchedAt,
          });
        } catch (err) {
          if (cancelled) return;
          // Cache fallback: if we already painted the cached row, leave it
          // visible — the clerk can still hand the QR to the buyer offline.
          if (cached) return;
          const code = err instanceof PrintedQrisApiError ? err.code : "unknown";
          setImage({ kind: "missing", reason: code });
        }
      } catch {
        if (cancelled) return;
        setImage({ kind: "missing", reason: "unknown" });
      }
    }

    void hydrate();
    return () => {
      cancelled = true;
    };
  }, [deps]);

  const handleLast4Change = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const digitsOnly = event.target.value.replace(/\D/g, "").slice(0, 4);
    setLast4(digitsOnly);
    setErrorMessage(null);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setFinalize("submitting");
    setErrorMessage(null);
    try {
      const database = await getDatabase();
      const result = await finalizeQrisStaticSale(
        {
          lines,
          totals: t,
          buyerRefLast4: last4,
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
          : intl.formatMessage({ id: "tender.qris.static.error.finalize" });
      setErrorMessage(message);
      setFinalize("error");
    }
  }, [canSubmit, clear, intl, last4, lines, navigate, t]);

  return (
    <section
      aria-label={intl.formatMessage({ id: "tender.qris.static.aria" })}
      className="flex h-full flex-col gap-4"
      data-testid="tender-qris-static"
    >
      <header className="space-y-1">
        <h1 className="text-lg font-bold text-neutral-900">
          <FormattedMessage id="tender.qris.static.heading" />
        </h1>
        <dl className="rounded-lg bg-white border border-neutral-200 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <dt className="text-sm text-neutral-600">
              <FormattedMessage id="tender.qris.static.total" />
            </dt>
            <dd
              data-testid="tender-qris-static-total"
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
          data-testid="tender-qris-static-cart-empty"
          className="rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-sm text-warning-fg"
        >
          <FormattedMessage id="tender.qris.static.cart.empty" />
        </p>
      ) : null}

      <div
        data-testid="tender-qris-static-image"
        data-image-state={image.kind}
        className="flex flex-col items-center gap-2 rounded-lg border border-neutral-200 bg-white p-4"
      >
        {image.kind === "ready" ? (
          <img
            src={image.image}
            alt={intl.formatMessage({ id: "tender.qris.static.image.alt" })}
            data-testid="tender-qris-static-image-img"
            className="h-64 w-64 object-contain"
          />
        ) : image.kind === "loading" ? (
          <p
            role="status"
            data-testid="tender-qris-static-image-loading"
            className="text-sm text-neutral-600"
          >
            <FormattedMessage id="tender.qris.static.image.loading" />
          </p>
        ) : (
          <p
            role="status"
            data-testid="tender-qris-static-image-missing"
            data-missing-reason={image.reason}
            className="rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-center text-sm text-warning-fg"
          >
            <FormattedMessage id="tender.qris.static.image.missing" />
          </p>
        )}
        <p className="text-center text-sm text-neutral-700">
          <FormattedMessage id="tender.qris.static.instructions" />
        </p>
      </div>

      <div className="space-y-2">
        <label
          htmlFor="tender-qris-static-last4"
          className="block text-sm font-semibold text-neutral-700"
        >
          <FormattedMessage id="tender.qris.static.last4.label" />
        </label>
        <input
          id="tender-qris-static-last4"
          data-testid="tender-qris-static-last4"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          maxLength={4}
          pattern="\d{4}"
          value={last4}
          onChange={handleLast4Change}
          aria-invalid={last4.length > 0 && !last4Valid}
          aria-describedby="tender-qris-static-last4-hint"
          className="block h-14 w-full rounded-md border border-neutral-300 bg-white px-3 text-center text-2xl font-bold tabular-nums tracking-[0.4em] text-neutral-900 focus-visible:border-primary-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"
          disabled={empty}
        />
        <p
          id="tender-qris-static-last4-hint"
          className="text-xs text-neutral-600"
          data-testid="tender-qris-static-last4-hint"
        >
          <FormattedMessage id="tender.qris.static.last4.hint" />
        </p>
      </div>

      {errorMessage ? (
        <p
          role="alert"
          data-testid="tender-qris-static-error"
          className="rounded-md border border-danger-border bg-danger-surface px-3 py-2 text-sm text-danger-fg"
        >
          {errorMessage}
        </p>
      ) : null}

      <div className="mt-auto space-y-2">
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => void handleSubmit()}
          data-testid="tender-qris-static-submit"
          className={[
            "w-full h-14 rounded-md text-base font-semibold tabular-nums",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 focus-visible:ring-offset-white",
            !canSubmit
              ? "bg-neutral-200 text-neutral-500 cursor-not-allowed"
              : "bg-primary-600 text-white active:bg-primary-700",
          ].join(" ")}
        >
          {finalize === "submitting" ? (
            <FormattedMessage id="tender.qris.static.submit.submitting" />
          ) : (
            <FormattedMessage id="tender.qris.static.submit.done" />
          )}
        </button>
        <button
          type="button"
          disabled={finalize === "submitting"}
          onClick={() => {
            if (finalize === "submitting") return;
            void navigate({ to: "/tender/cash" });
          }}
          data-testid="tender-qris-static-switch-cash"
          className={[
            "w-full h-12 rounded-md border text-base font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 focus-visible:ring-offset-white",
            finalize === "submitting"
              ? "border-neutral-200 text-neutral-400 cursor-not-allowed"
              : "border-neutral-300 text-neutral-800 active:bg-neutral-100",
          ].join(" ")}
        >
          <FormattedMessage id="tender.qris.static.switch.cash" />
        </button>
      </div>
    </section>
  );
}

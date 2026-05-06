/*
 * Reprint detail (KASA-220).
 *
 * Read-only view of a past sale with a single action: print a SALINAN copy of
 * the receipt. The route is a sibling of `/receipt/$id` (the post-sale flow)
 * rather than a flag on it because:
 *   - The post-sale screen reaches the printer once and is then discarded;
 *     the reprint flow lives behind a list and can be re-entered any time.
 *   - The button label, status copy, and SALINAN banner all differ; sharing
 *     the same screen with a `mode` toggle would mean every render is a
 *     `kind === "reprint" ? … : …` ladder.
 *
 * Both screens converge at `usePrintReceipt()` so the ESC/POS payload, the
 * Bluetooth handshake, and the `window.print()` fallback are identical. The
 * only difference at the byte layer is the SALINAN banner the encoder emits
 * when `salinan: true` is set.
 *
 * IMPORTANT: this path is read-only. We never write to `pending_sales`,
 * `sync_state`, or `eod_closures`, and we never POST to the API. A reprint
 * must not show up in EOD totals or in the outbox drain.
 */

import { useParams, Link } from "@tanstack/react-router";
import { FormattedMessage, useIntl } from "react-intl";
import { ReceiptPreview } from "./ReceiptPreview.tsx";
import { usePaperWidthStore } from "./paperWidth.ts";
import { usePendingSale } from "./usePendingSale.ts";
import { usePrintReceipt } from "./printing.ts";

export function SaleReprintScreen() {
  const intl = useIntl();
  const { id: localSaleId } = useParams({ from: "/sales/$id" });
  const { sale, outlet, ready } = usePendingSale(localSaleId);
  const paperWidth = usePaperWidthStore((s) => s.width);
  const { state: print, print: handlePrint } = usePrintReceipt();

  if (!ready) {
    return (
      <section className="space-y-3" aria-busy>
        <p className="text-sm text-neutral-500">
          <FormattedMessage id="receipt.loading" />
        </p>
      </section>
    );
  }

  if (!sale) {
    return (
      <section
        className="space-y-2 rounded-md border border-danger-border bg-danger-surface p-4"
        role="alert"
        data-testid="reprint-missing"
      >
        <h1 className="text-lg font-bold text-danger-fg">
          <FormattedMessage id="receipt.missing.heading" />
        </h1>
        <p className="text-sm text-danger-fg">
          <FormattedMessage id="receipt.missing.body" />
        </p>
        <Link
          to="/sales/history"
          className="inline-block text-sm font-semibold text-danger-fg underline"
        >
          <FormattedMessage id="reprint.back" />
        </Link>
      </section>
    );
  }

  return (
    <section className="space-y-4" aria-label={intl.formatMessage({ id: "reprint.aria" })}>
      <header className="space-y-1">
        <Link
          to="/sales/history"
          className="text-sm font-semibold text-primary-700 hover:text-primary-800"
          data-testid="reprint-back"
        >
          <FormattedMessage id="reprint.back" />
        </Link>
        <h1 className="text-lg font-bold text-neutral-900">
          <FormattedMessage id="reprint.heading" />
        </h1>
        <p className="text-sm text-neutral-600">
          <FormattedMessage id="reprint.notice" />
        </p>
      </header>

      <ReceiptPreview sale={sale} outlet={outlet} paperWidth={paperWidth} salinan />

      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => void handlePrint({ sale, outlet, paperWidth, salinan: true })}
          disabled={print.kind === "printing"}
          data-testid="reprint-cta"
          className={[
            "w-full h-14 rounded-md text-base font-semibold",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 focus-visible:ring-offset-white",
            print.kind === "printing"
              ? "bg-neutral-200 text-neutral-500"
              : "bg-primary-600 text-white active:bg-primary-700",
          ].join(" ")}
        >
          {print.kind === "printing"
            ? intl.formatMessage({ id: "reprint.cta.spooling" })
            : intl.formatMessage({ id: "reprint.cta" })}
        </button>
        {print.kind === "done" ? (
          <p
            role="status"
            data-testid="reprint-status"
            className="rounded-md border border-success-border bg-success-surface px-3 py-2 text-sm text-success-fg"
          >
            <FormattedMessage id="receipt.print.done" />
          </p>
        ) : null}
        {print.kind === "fallback" ? (
          <p
            role="alert"
            data-testid="reprint-fallback"
            className="rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-sm text-warning-fg"
          >
            {print.message}
          </p>
        ) : null}
      </div>
    </section>
  );
}

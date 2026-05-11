import { useIntl } from "react-intl";
import type { Outlet, PendingSale } from "../../data/db/types.ts";
import type { ReceiptMerchant } from "./ReceiptPreview.tsx";
import { buildWhatsAppReceiptBody, buildWhatsAppShareUrl } from "./whatsappShare.ts";

/*
 * "Kirim WhatsApp" CTA below the Cetak block (KASA-252).
 *
 * Enabled only when the sale has a server-acknowledged identifier
 * (`serverSaleName`) — sharing a queued sale would risk the customer
 * keeping a receipt for a transaction the server later rejects.
 */

interface ShareWhatsAppButtonProps {
  sale: PendingSale;
  outlet: Outlet | undefined;
  merchant?: ReceiptMerchant | null;
}

const BUTTON_BASE =
  "w-full h-14 rounded-md text-base font-semibold inline-flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 focus-visible:ring-offset-white";

export function ShareWhatsAppButton({ sale, outlet, merchant }: ShareWhatsAppButtonProps) {
  const intl = useIntl();
  const label = intl.formatMessage({ id: "receipt.share.whatsapp.cta" });
  const aria = intl.formatMessage({ id: "receipt.share.whatsapp.aria" });
  const pendingTooltip = intl.formatMessage({ id: "receipt.share.whatsapp.pendingTooltip" });
  const isConfirmed = sale.serverSaleName !== null;

  if (!isConfirmed) {
    return (
      <div className="flex flex-col gap-1">
        <button
          type="button"
          disabled
          aria-disabled="true"
          title={pendingTooltip}
          aria-describedby="receipt-share-pending-hint"
          data-testid="receipt-share-whatsapp"
          className={`${BUTTON_BASE} bg-neutral-200 text-neutral-500`}
        >
          {label}
        </button>
        <p
          id="receipt-share-pending-hint"
          data-testid="receipt-share-whatsapp-pending"
          className="text-xs text-neutral-600"
        >
          {pendingTooltip}
        </p>
      </div>
    );
  }

  const body = buildWhatsAppReceiptBody({
    sale,
    outlet,
    merchant,
    formatMessage: (descriptor, values) => intl.formatMessage(descriptor, values),
  });
  const href = buildWhatsAppShareUrl(body);

  function handleClick(): void {
    // Sentry breadcrumb only — fire-and-forget through the lazy facade so the
    // SDK chunk stays out of the LCP-critical bundle.
    void import("../../lib/error-reporter.ts").then((m) =>
      m.addBreadcrumb({
        category: "receipt.share.whatsapp",
        level: "info",
        data: { saleId: sale.localSaleId, outletId: sale.outletId },
      }),
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={aria}
      data-testid="receipt-share-whatsapp"
      onClick={handleClick}
      className={`${BUTTON_BASE} bg-success-fg text-white active:opacity-90`}
    >
      {label}
    </a>
  );
}

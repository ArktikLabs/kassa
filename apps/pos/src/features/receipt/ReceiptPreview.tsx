import { useIntl } from "react-intl";
import { formatIdr, type Rupiah } from "../../shared/money/index.ts";
import type { Outlet, PendingSale } from "../../data/db/types.ts";
import { PAPER_WIDTH_PX, type PaperWidth } from "./paperWidth.ts";

/**
 * Merchant-wide receipt branding (KASA-219). Optional — falls back to
 * outlet name + i18n thanks footer when absent.
 */
export interface ReceiptMerchant {
  displayName: string;
  addressLine: string | null;
  phone: string | null;
  npwp: string | null;
  receiptFooterText: string | null;
}

interface ReceiptPreviewProps {
  sale: PendingSale;
  outlet: Outlet | undefined;
  paperWidth: PaperWidth;
  merchant?: ReceiptMerchant | null;
}

function formatDateTime(iso: string, timezone: string | undefined): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat("id-ID", {
      timeZone: timezone ?? "UTC",
      day: "2-digit",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

export function ReceiptPreview({ sale, outlet, paperWidth, merchant }: ReceiptPreviewProps) {
  const intl = useIntl();
  const widthPx = PAPER_WIDTH_PX[paperWidth];
  const totalTendered = sale.tenders.reduce<number>(
    (acc, t) => acc + (t.amountIdr as number),
    0,
  ) as Rupiah;
  const change = Math.max(0, (totalTendered as number) - (sale.totalIdr as number)) as Rupiah;
  const npwpLabel = intl.formatMessage({ id: "receipt.merchant.npwp" });
  const fallbackFooter = intl.formatMessage({ id: "receipt.footer.thanks" });
  const footerText = merchant?.receiptFooterText?.trim() || fallbackFooter;

  return (
    <article
      data-testid="receipt-preview"
      data-paper-width={paperWidth}
      className="mx-auto rounded-none border border-dashed border-neutral-300 bg-white px-3 py-4 font-mono text-[14px] leading-[20px] text-neutral-900"
      style={{ width: `${widthPx}px` }}
    >
      <header className="text-center" data-testid="receipt-header">
        {merchant ? (
          <div data-testid="receipt-merchant">
            <p className="font-bold uppercase" data-testid="receipt-merchant-name">
              {merchant.displayName}
            </p>
            {merchant.addressLine ? (
              <p className="text-[12px] text-neutral-700" data-testid="receipt-merchant-address">
                {merchant.addressLine}
              </p>
            ) : null}
            {merchant.phone ? (
              <p className="text-[12px] text-neutral-700" data-testid="receipt-merchant-phone">
                {merchant.phone}
              </p>
            ) : null}
            {merchant.npwp ? (
              <p className="text-[12px] text-neutral-700" data-testid="receipt-merchant-npwp">
                {npwpLabel} {merchant.npwp}
              </p>
            ) : null}
            <p className="text-[12px] text-neutral-700" data-testid="receipt-outlet-name">
              {outlet?.name ?? intl.formatMessage({ id: "receipt.outlet.unknown" })}
            </p>
          </div>
        ) : (
          <p className="font-bold uppercase" data-testid="receipt-outlet-name">
            {outlet?.name ?? intl.formatMessage({ id: "receipt.outlet.unknown" })}
          </p>
        )}
        <p className="text-[12px] text-neutral-700">
          {formatDateTime(sale.createdAt, outlet?.timezone)}
        </p>
        <p className="text-[11px] text-neutral-600">ID {sale.localSaleId.slice(0, 8)}</p>
      </header>
      <hr className="my-2 border-dashed border-neutral-400" />
      <ul data-testid="receipt-lines" className="space-y-1">
        {sale.items.map((item) => (
          <li
            key={item.itemId}
            className="flex items-baseline justify-between gap-2 tabular-nums"
            data-tabular="true"
          >
            <span className="truncate">
              {item.quantity}× {item.itemId.slice(0, 8)}
            </span>
            <span>{formatIdr(item.lineTotalIdr)}</span>
          </li>
        ))}
      </ul>
      <hr className="my-2 border-dashed border-neutral-400" />
      <dl className="space-y-1 tabular-nums" data-tabular="true">
        <Row
          label={intl.formatMessage({ id: "receipt.subtotal" })}
          value={formatIdr(sale.subtotalIdr)}
        />
        {(sale.discountIdr as number) > 0 ? (
          <Row
            label={intl.formatMessage({ id: "receipt.discount" })}
            value={`-${formatIdr(sale.discountIdr)}`}
          />
        ) : null}
        <Row
          label={intl.formatMessage({ id: "receipt.total" })}
          value={formatIdr(sale.totalIdr)}
          strong
        />
        <Row
          label={intl.formatMessage({ id: "receipt.tendered" })}
          value={formatIdr(totalTendered)}
        />
        <Row label={intl.formatMessage({ id: "receipt.change" })} value={formatIdr(change)} />
      </dl>
      <hr className="my-2 border-dashed border-neutral-400" />
      <footer className="text-center text-[12px]" data-testid="receipt-footer">
        {footerText}
      </footer>
    </article>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div
      className={["flex items-baseline justify-between gap-2", strong ? "font-bold" : ""].join(" ")}
    >
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

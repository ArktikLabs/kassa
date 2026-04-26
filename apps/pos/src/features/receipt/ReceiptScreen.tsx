import { useCallback, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useIntl } from "react-intl";
import { formatIdr, toRupiah } from "../../shared/money/index.ts";
import {
  BluetoothPrintError,
  BluetoothUnsupportedError,
  isWebBluetoothSupported,
  webBluetoothPrinter,
} from "./bluetooth.ts";
import { encodeReceipt, type ReceiptLine } from "./escpos.ts";
import { ReceiptPreview } from "./ReceiptPreview.tsx";
import { PAPER_WIDTH_CHAR_COLUMNS, usePaperWidthStore, type PaperWidth } from "./paperWidth.ts";
import { usePendingSale } from "./usePendingSale.ts";

type PrintState =
  | { kind: "idle" }
  | { kind: "printing" }
  | { kind: "done" }
  | { kind: "fallback"; reason: "unsupported" | "failed"; message: string };

export function ReceiptScreen() {
  const intl = useIntl();
  const { id: localSaleId } = useParams({ from: "/receipt/$id" });
  const { sale, outlet, ready } = usePendingSale(localSaleId);
  const paperWidth = usePaperWidthStore((s) => s.width);
  const setWidth = usePaperWidthStore((s) => s.setWidth);
  const [print, setPrint] = useState<PrintState>({ kind: "idle" });

  const bluetoothSupported = isWebBluetoothSupported();

  const handlePrint = useCallback(async () => {
    if (!sale) return;
    if (!bluetoothSupported) {
      setPrint({
        kind: "fallback",
        reason: "unsupported",
        message: intl.formatMessage({ id: "receipt.print.unsupported" }),
      });
      window.print();
      return;
    }
    setPrint({ kind: "printing" });
    try {
      const lines: ReceiptLine[] = sale.items.map((item) => ({
        left: `${item.quantity}x ${item.itemId.slice(0, 8)}`,
        right: formatIdr(item.lineTotalIdr),
      }));
      const tendered = sale.tenders.reduce((acc, t) => acc + (t.amountIdr as number), 0);
      const change = Math.max(0, tendered - (sale.totalIdr as number));
      const bytes = encodeReceipt({
        outletName: outlet?.name ?? intl.formatMessage({ id: "receipt.outlet.unknown" }),
        outletTimezone: outlet?.timezone ?? null,
        address: null,
        createdAtIso: sale.createdAt,
        localSaleId: sale.localSaleId,
        items: lines,
        subtotal: formatIdr(sale.subtotalIdr),
        discount: formatIdr(sale.discountIdr),
        total: formatIdr(sale.totalIdr),
        tenderedLabel: intl.formatMessage({ id: "receipt.tendered" }),
        tendered: formatIdr(toRupiah(tendered)),
        changeLabel: intl.formatMessage({ id: "receipt.change" }),
        change: formatIdr(toRupiah(change)),
        footerThanks: intl.formatMessage({ id: "receipt.footer.thanks" }),
        width: PAPER_WIDTH_CHAR_COLUMNS[paperWidth],
      });
      await webBluetoothPrinter.printReceipt(bytes);
      setPrint({ kind: "done" });
    } catch (err) {
      if (err instanceof BluetoothUnsupportedError) {
        setPrint({
          kind: "fallback",
          reason: "unsupported",
          message: intl.formatMessage({ id: "receipt.print.unsupported" }),
        });
        window.print();
        return;
      }
      const message =
        err instanceof BluetoothPrintError
          ? err.message
          : intl.formatMessage({ id: "receipt.print.failed" });
      setPrint({ kind: "fallback", reason: "failed", message });
    }
  }, [bluetoothSupported, intl, outlet, paperWidth, sale]);

  if (!ready) {
    return (
      <section className="space-y-3" aria-busy>
        <p className="text-sm text-neutral-500">{intl.formatMessage({ id: "receipt.loading" })}</p>
      </section>
    );
  }

  if (!sale) {
    return (
      <section
        className="space-y-2 rounded-md border border-danger-border bg-danger-surface p-4"
        role="alert"
        data-testid="receipt-missing"
      >
        <h1 className="text-lg font-bold text-danger-fg">
          {intl.formatMessage({ id: "receipt.missing.heading" })}
        </h1>
        <p className="text-sm text-danger-fg">
          {intl.formatMessage({ id: "receipt.missing.body" })}
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-4" aria-label={intl.formatMessage({ id: "receipt.aria" })}>
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-neutral-900">
          {intl.formatMessage({ id: "receipt.heading" })}
        </h1>
        <PaperWidthToggle width={paperWidth} onSelect={setWidth} />
      </header>

      <ReceiptPreview sale={sale} outlet={outlet} paperWidth={paperWidth} />

      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => void handlePrint()}
          disabled={print.kind === "printing"}
          data-testid="receipt-print"
          className={[
            "w-full h-14 rounded-md text-base font-semibold",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 focus-visible:ring-offset-white",
            print.kind === "printing"
              ? "bg-neutral-200 text-neutral-500"
              : "bg-primary-600 text-white active:bg-primary-700",
          ].join(" ")}
        >
          {print.kind === "printing"
            ? intl.formatMessage({ id: "receipt.print.spooling" })
            : intl.formatMessage({ id: "receipt.print.cetak" })}
        </button>
        {print.kind === "done" ? (
          <p
            role="status"
            data-testid="receipt-print-status"
            className="rounded-md border border-success-border bg-success-surface px-3 py-2 text-sm text-success-fg"
          >
            {intl.formatMessage({ id: "receipt.print.done" })}
          </p>
        ) : null}
        {print.kind === "fallback" ? (
          <p
            role="alert"
            data-testid="receipt-print-fallback"
            className="rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-sm text-warning-fg"
          >
            {print.message}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function PaperWidthToggle({
  width,
  onSelect,
}: {
  width: PaperWidth;
  onSelect(value: PaperWidth): void;
}) {
  const intl = useIntl();
  return (
    <div
      role="group"
      aria-label={intl.formatMessage({ id: "receipt.paperWidth.aria" })}
      className="inline-flex rounded-full border border-neutral-300 p-[2px] text-xs font-semibold"
      data-testid="receipt-paper-width"
    >
      {(["58mm", "80mm"] as const).map((value) => {
        const active = value === width;
        return (
          <button
            key={value}
            type="button"
            onClick={() => onSelect(value)}
            aria-pressed={active}
            data-testid={`receipt-paper-${value}`}
            className={[
              "rounded-full px-3 py-1 transition-colors",
              active ? "bg-primary-600 text-white" : "text-neutral-700 hover:bg-neutral-100",
            ].join(" ")}
          >
            {value}
          </button>
        );
      })}
    </div>
  );
}

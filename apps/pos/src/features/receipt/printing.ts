/*
 * Shared print orchestration for the receipt screen and the reprint screen.
 *
 * Both flows speak ESC/POS over Web Bluetooth with a `window.print()` fallback
 * for browsers that don't expose `navigator.bluetooth` (KASA-220 reprint
 * follows the same path as KASA-56 first-print so a clerk's muscle memory
 * does not change). Extracting the state machine here keeps the reprint
 * screen from re-implementing a subtly different copy of the original.
 */

import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import { formatIdr, toRupiah } from "../../shared/money/index.ts";
import type { Outlet, PendingSale } from "../../data/db/types.ts";
import {
  BluetoothPrintError,
  BluetoothUnsupportedError,
  isWebBluetoothSupported,
  webBluetoothPrinter,
} from "./bluetooth.ts";
import { encodeReceipt, type ReceiptLine } from "./escpos.ts";
import { PAPER_WIDTH_CHAR_COLUMNS, type PaperWidth } from "./paperWidth.ts";

export type PrintState =
  | { kind: "idle" }
  | { kind: "printing" }
  | { kind: "done" }
  | { kind: "fallback"; reason: "unsupported" | "failed"; message: string };

export interface PrintRequest {
  sale: PendingSale;
  outlet: Outlet | undefined;
  paperWidth: PaperWidth;
  /**
   * Mark the printed copy as a SALINAN (reprint) — adds a banner to the top
   * of the ESC/POS payload so the receipt is unambiguously a duplicate.
   */
  salinan?: boolean;
}

export interface UsePrintReceipt {
  state: PrintState;
  print(request: PrintRequest): Promise<void>;
}

export function usePrintReceipt(): UsePrintReceipt {
  const intl = useIntl();
  const [state, setState] = useState<PrintState>({ kind: "idle" });

  const print = useCallback(
    async ({ sale, outlet, paperWidth, salinan }: PrintRequest): Promise<void> => {
      if (!isWebBluetoothSupported()) {
        setState({
          kind: "fallback",
          reason: "unsupported",
          message: intl.formatMessage({ id: "receipt.print.unsupported" }),
        });
        if (typeof window !== "undefined") window.print();
        return;
      }
      setState({ kind: "printing" });
      try {
        const lines: ReceiptLine[] = sale.items.map((item) => ({
          left: `${item.quantity}x ${item.itemId.slice(0, 8)}`,
          right: formatIdr(item.lineTotalIdr),
        }));
        const tendered = sale.tenders.reduce((acc, t) => acc + (t.amountIdr as number), 0);
        const change = Math.max(0, tendered - (sale.totalIdr as number));
        const taxIdr = sale.taxIdr;
        const payload = {
          outletName: outlet?.name ?? intl.formatMessage({ id: "receipt.outlet.unknown" }),
          outletTimezone: outlet?.timezone ?? null,
          address: null,
          createdAtIso: sale.createdAt,
          localSaleId: sale.localSaleId,
          items: lines,
          subtotal: formatIdr(sale.subtotalIdr),
          discount: formatIdr(sale.discountIdr),
          ...(taxIdr !== undefined && (taxIdr as number) > 0
            ? {
                taxLabel: intl.formatMessage({ id: "receipt.tax" }, { rate: 11 }),
                tax: formatIdr(taxIdr),
              }
            : {}),
          total: formatIdr(sale.totalIdr),
          tenderedLabel: intl.formatMessage({ id: "receipt.tendered" }),
          tendered: formatIdr(toRupiah(tendered)),
          changeLabel: intl.formatMessage({ id: "receipt.change" }),
          change: formatIdr(toRupiah(change)),
          footerThanks: intl.formatMessage({ id: "receipt.footer.thanks" }),
          width: PAPER_WIDTH_CHAR_COLUMNS[paperWidth],
          // exactOptionalPropertyTypes: only attach the flag when reprinting so
          // the type stays `boolean` instead of `boolean | undefined`.
          ...(salinan ? { salinan: true as const } : {}),
        };
        const bytes = encodeReceipt(payload);
        await webBluetoothPrinter.printReceipt(bytes);
        setState({ kind: "done" });
      } catch (err) {
        if (err instanceof BluetoothUnsupportedError) {
          setState({
            kind: "fallback",
            reason: "unsupported",
            message: intl.formatMessage({ id: "receipt.print.unsupported" }),
          });
          if (typeof window !== "undefined") window.print();
          return;
        }
        const message =
          err instanceof BluetoothPrintError
            ? err.message
            : intl.formatMessage({ id: "receipt.print.failed" });
        setState({ kind: "fallback", reason: "failed", message });
      }
    },
    [intl],
  );

  return { state, print };
}

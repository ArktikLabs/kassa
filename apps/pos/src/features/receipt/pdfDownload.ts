/*
 * React-side glue for the PDF receipt fallback (KASA-309).
 *
 * Wraps the pure `encodePdfReceipt` byte builder, generates the localised
 * payload from the current sale, and triggers an anchor-based download.
 * Kept in its own module so the heavy emitter (and the PDF byte builder
 * it pulls in) can be lazy-imported off the `/receipt` route — see
 * `code-splitting` note in the issue acceptance criteria.
 */

import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import type { Outlet, PendingSale } from "../../data/db/types.ts";
import type { ReceiptMerchant } from "./ReceiptPreview.tsx";
import { buildPdfReceiptInput, encodePdfReceipt, pdfReceiptFilename } from "./pdf.ts";
import type { PaperWidth } from "./paperWidth.ts";

export type PdfDownloadState =
  | { kind: "idle" }
  | { kind: "generating" }
  | { kind: "done" }
  | { kind: "failed"; message: string };

export interface PdfDownloadRequest {
  sale: PendingSale;
  outlet: Outlet | undefined;
  paperWidth: PaperWidth;
  merchant?: ReceiptMerchant | null;
  salinan?: boolean;
}

export interface UsePdfDownload {
  state: PdfDownloadState;
  download(request: PdfDownloadRequest): Promise<void>;
}

/**
 * Default DOM download driver. Tests can swap this with a stub that
 * captures the Blob / filename without actually mutating the document.
 */
export interface DownloadDriver {
  trigger(blob: Blob, filename: string): void;
}

const browserDownloadDriver: DownloadDriver = {
  trigger(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Defer revoke so iOS Safari has time to start the download — the
    // anchor click is synchronous but the navigation that opens the
    // share sheet on iPad is not.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },
};

export function usePdfReceipt(driver: DownloadDriver = browserDownloadDriver): UsePdfDownload {
  const intl = useIntl();
  const [state, setState] = useState<PdfDownloadState>({ kind: "idle" });

  const download = useCallback(
    async ({ sale, outlet, paperWidth, merchant, salinan }: PdfDownloadRequest) => {
      setState({ kind: "generating" });
      try {
        const input = buildPdfReceiptInput({
          sale,
          outlet,
          paperWidth,
          merchant: merchant ?? null,
          ...(salinan ? { salinan: true as const } : {}),
          i18n: {
            outletUnknown: intl.formatMessage({ id: "receipt.outlet.unknown" }),
            npwpLabel: intl.formatMessage({ id: "receipt.merchant.npwp" }),
            subtotalLabel: intl.formatMessage({ id: "receipt.subtotal" }),
            discountLabel: intl.formatMessage({ id: "receipt.discount" }),
            taxLabelTemplate: (rate) => intl.formatMessage({ id: "receipt.tax" }, { rate }),
            totalLabel: intl.formatMessage({ id: "receipt.total" }),
            tenderedLabel: intl.formatMessage({ id: "receipt.tendered" }),
            changeLabel: intl.formatMessage({ id: "receipt.change" }),
            footerThanks: intl.formatMessage({ id: "receipt.footer.thanks" }),
            salinanBanner: intl.formatMessage({ id: "receipt.salinan.banner" }),
            pembatalanBanner: intl.formatMessage({ id: "receipt.pembatalan.banner" }),
            pembatalanReference: intl.formatMessage({ id: "receipt.pembatalan.reference" }),
            pembatalanQrisRefund: intl.formatMessage({ id: "receipt.pembatalan.qrisRefund" }),
          },
        });
        const bytes = encodePdfReceipt(input);
        // Copy through an ArrayBuffer slice so the Blob constructor's
        // strict typings accept the payload — DOM lib annotates BlobPart
        // as Uint8Array<ArrayBuffer> (not Uint8Array<ArrayBufferLike>).
        const blob = new Blob([new Uint8Array(bytes).buffer], { type: "application/pdf" });
        driver.trigger(blob, pdfReceiptFilename(sale));
        setState({ kind: "done" });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : intl.formatMessage({ id: "receipt.pdf.failed" });
        setState({ kind: "failed", message });
      }
    },
    [driver, intl],
  );

  return { state, download };
}

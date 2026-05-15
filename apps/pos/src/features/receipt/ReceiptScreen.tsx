import { Link, useParams } from "@tanstack/react-router";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { useIntl } from "react-intl";
import type { Database, ShiftState } from "../../data/db/index.ts";
import { getDatabase } from "../../data/db/index.ts";
import { canVoidSale } from "../sale/SaleVoidScreen.tsx";
import { ReceiptPreview } from "./ReceiptPreview.tsx";
import { usePaperWidthStore, type PaperWidth } from "./paperWidth.ts";
import { usePendingSale } from "./usePendingSale.ts";
import { usePrintReceipt } from "./printing.ts";

function useOpenShift(): ShiftState | null | undefined {
  const [db, setDb] = useState<Database | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    getDatabase()
      .then((next) => {
        if (!cancelled) setDb(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return useLiveQuery(async () => {
    if (!db) return undefined;
    const row = await db.repos.shiftState.get();
    return row && row.closedAt === null ? row : null;
  }, [db]);
}

export function ReceiptScreen() {
  const intl = useIntl();
  const { id: localSaleId } = useParams({ from: "/receipt/$id" });
  const { sale, outlet, ready } = usePendingSale(localSaleId);
  const shift = useOpenShift();
  const paperWidth = usePaperWidthStore((s) => s.width);
  const setWidth = usePaperWidthStore((s) => s.setWidth);
  const { state: print, print: handlePrint } = usePrintReceipt();

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

      {canVoidSale(sale, shift ?? null) ? (
        <Link
          to="/sale/$id/void"
          params={{ id: sale.localSaleId }}
          data-testid="receipt-void-cta"
          className="block w-full rounded-md border border-red-700 px-4 py-3 text-center text-base font-semibold text-red-700 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
        >
          {intl.formatMessage({ id: "receipt.void.cta" })}
        </Link>
      ) : null}

      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => void handlePrint({ sale, outlet, paperWidth })}
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

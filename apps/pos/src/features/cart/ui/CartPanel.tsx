import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useLiveQuery } from "dexie-react-hooks";
import { FormattedMessage, useIntl } from "react-intl";
import { useCartStore } from "../store.ts";
import type { CartLine } from "../types.ts";
import { CartLineRow } from "./CartLineRow.tsx";
import { CartEditSheet } from "./CartEditSheet.tsx";
import { ChargeButton } from "./ChargeButton.tsx";
import { formatIdr } from "../../../shared/money/index.ts";
import { getDatabase, type Database } from "../../../data/db/index.ts";
import type { ParkedSale } from "../../../data/db/types.ts";
import { showToast } from "../../../components/Toast.tsx";
import {
  discardParkedCart,
  parkActiveCart,
  resumeParkedCart,
} from "../../parked-sales/repository.ts";
import { DiscardParkedSheet } from "../../parked-sales/ui/DiscardParkedSheet.tsx";
import { ParkCartSheet } from "../../parked-sales/ui/ParkCartSheet.tsx";
import { ParkedTraySheet } from "../../parked-sales/ui/ParkedTraySheet.tsx";

type PendingResume = { kind: "needs_confirm"; row: ParkedSale } | null;

export function CartPanel() {
  const intl = useIntl();
  const navigate = useNavigate();
  const lines = useCartStore((s) => s.lines);
  const discountIdr = useCartStore((s) => s.discountIdr);
  const totalsFn = useCartStore((s) => s.totals);
  const setLineQuantity = useCartStore((s) => s.setLineQuantity);
  const removeLine = useCartStore((s) => s.removeLine);
  const replaceCart = useCartStore((s) => s.replace);
  const clearCart = useCartStore((s) => s.clear);
  const t = totalsFn();
  const [editing, setEditing] = useState<CartLine | null>(null);
  const [parkSheetOpen, setParkSheetOpen] = useState(false);
  const [parkError, setParkError] = useState<string | null>(null);
  const [traySheetOpen, setTraySheetOpen] = useState(false);
  const [discarding, setDiscarding] = useState<ParkedSale | null>(null);
  const [pendingResume, setPendingResume] = useState<PendingResume>(null);

  const [db, setDb] = useState<Database | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    getDatabase()
      .then((d) => {
        if (!cancelled) setDb(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const shift = useLiveQuery(async () => (db ? db.repos.shiftState.get() : undefined), [db]);
  const activeShift = shift && shift.closedAt === null ? shift : null;

  const parkedRows = useLiveQuery(
    async (): Promise<ParkedSale[]> => {
      if (!db || !activeShift) return [];
      return db.repos.parkedSales.listForShift(activeShift.outletId, activeShift.localShiftId);
    },
    [db, activeShift?.outletId, activeShift?.localShiftId],
    [] as ParkedSale[],
  );

  const parkedCount = parkedRows.length;

  const handlePark = async (label: string): Promise<void> => {
    const res = await parkActiveCart({
      label,
      cart: { lines, discountIdr },
    });
    if (res.kind === "ok") {
      clearCart();
      setParkSheetOpen(false);
      setParkError(null);
      showToast(
        intl.formatMessage({ id: "cart.park.toast.success" }, { label: res.row.label }),
        "success",
      );
      return;
    }
    if (res.kind === "blank_label") {
      setParkError(intl.formatMessage({ id: "cart.park.error.blank" }));
      return;
    }
    if (res.kind === "empty_cart") {
      setParkError(intl.formatMessage({ id: "cart.park.error.empty" }));
      return;
    }
    if (res.kind === "no_open_shift") {
      setParkError(intl.formatMessage({ id: "cart.park.error.no_shift" }));
      return;
    }
    setParkError(intl.formatMessage({ id: "cart.park.error.unknown" }));
  };

  const runResume = async (row: ParkedSale): Promise<void> => {
    const res = await resumeParkedCart({ id: row.id });
    if (res.kind === "ok") {
      replaceCart(res.cart);
      setTraySheetOpen(false);
      setPendingResume(null);
      showToast(
        intl.formatMessage({ id: "cart.parked.resume.toast.success" }, { label: row.label }),
        "success",
      );
      return;
    }
    showToast(intl.formatMessage({ id: "cart.parked.discard.error.notFound" }), "error");
  };

  const handleResume = (row: ParkedSale): void => {
    if (lines.length > 0) {
      setPendingResume({ kind: "needs_confirm", row });
      return;
    }
    void runResume(row);
  };

  const handleDiscard = async (row: ParkedSale): Promise<void> => {
    const res = await discardParkedCart({ id: row.id });
    setDiscarding(null);
    if (res.kind === "ok") {
      showToast(
        intl.formatMessage({ id: "cart.parked.discard.toast.success" }, { label: row.label }),
        "success",
      );
      return;
    }
    showToast(intl.formatMessage({ id: "cart.parked.discard.error.notFound" }), "error");
  };

  return (
    <section aria-label={intl.formatMessage({ id: "cart.aria" })} className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-neutral-200 px-4 py-3">
        <h1 className="text-lg font-bold text-neutral-900">
          {intl.formatMessage({ id: "cart.heading" })}
        </h1>
        <div className="flex items-center gap-3">
          {parkedCount > 0 ? (
            <button
              type="button"
              onClick={() => setTraySheetOpen(true)}
              aria-label={intl.formatMessage({ id: "cart.parked.tray.ariaCta" })}
              data-testid="cart-parked-tray-cta"
              className="rounded-full border border-neutral-300 bg-neutral-100 px-3 py-1.5 text-sm font-semibold text-neutral-800 hover:bg-neutral-200"
            >
              <FormattedMessage id="cart.parked.tray.cta" values={{ count: parkedCount }} />
            </button>
          ) : null}
          {/*
           * KASA-369 — counter-side entry point for the find-sale lookup.
           * A customer who returns 20-40 minutes later asks the cashier at
           * the same counter that's about to ring up the next sale; the
           * cart screen is where that conversation happens.
           */}
          <Link
            to="/find-sale"
            className="text-sm font-semibold text-primary-700 hover:text-primary-800"
            data-testid="cart-find-sale-link"
          >
            <FormattedMessage id="nav.findSale" />
          </Link>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto">
        {lines.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center"
            data-testid="cart-empty"
          >
            <p className="text-base font-semibold text-neutral-700">
              {intl.formatMessage({ id: "cart.empty.heading" })}
            </p>
            <p className="text-sm text-neutral-500">
              {intl.formatMessage({ id: "cart.empty.body" })}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-neutral-200" data-testid="cart-lines">
            {lines.map((line) => (
              <li key={line.itemId}>
                <CartLineRow
                  line={line}
                  onOpenEdit={setEditing}
                  onRemove={(l) => removeLine(l.itemId)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      <footer className="border-t border-neutral-200 bg-white px-4 py-3 space-y-2">
        <dl className="flex items-center justify-between text-sm text-neutral-600">
          <dt>{intl.formatMessage({ id: "cart.totals.subtotal" })}</dt>
          <dd className="tabular-nums" data-tabular="true">
            {formatIdr(t.subtotalIdr)}
          </dd>
        </dl>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              setParkError(null);
              setParkSheetOpen(true);
            }}
            disabled={lines.length === 0}
            aria-label={intl.formatMessage({ id: "cart.park.ariaCta" })}
            data-testid="cart-park-cta"
            className="h-12 flex-1 rounded-lg border border-neutral-300 bg-white text-base font-semibold text-neutral-800 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <FormattedMessage id="cart.park.cta" />
          </button>
          <div className="flex-[2]">
            <ChargeButton
              totalIdr={t.totalIdr}
              disabled={lines.length === 0}
              onClick={() => {
                void navigate({ to: "/tender/cash" });
              }}
            />
          </div>
        </div>
      </footer>
      <CartEditSheet
        line={editing}
        onClose={() => setEditing(null)}
        onApply={(quantity) => {
          if (editing) setLineQuantity(editing.itemId, quantity);
          setEditing(null);
        }}
        onRemove={() => {
          if (editing) removeLine(editing.itemId);
          setEditing(null);
        }}
      />
      <ParkCartSheet
        open={parkSheetOpen}
        onClose={() => {
          setParkSheetOpen(false);
          setParkError(null);
        }}
        onSubmit={handlePark}
        error={parkError}
      />
      <ParkedTraySheet
        open={traySheetOpen}
        rows={parkedRows}
        onClose={() => setTraySheetOpen(false)}
        onResume={handleResume}
        onDiscard={setDiscarding}
      />
      <DiscardParkedSheet
        row={discarding}
        onClose={() => setDiscarding(null)}
        onConfirm={handleDiscard}
      />
      {pendingResume ? (
        <ResumeReplaceSheet
          row={pendingResume.row}
          onCancel={() => setPendingResume(null)}
          onConfirm={() => {
            const row = pendingResume.row;
            setPendingResume(null);
            void runResume(row);
          }}
        />
      ) : null}
    </section>
  );
}

function ResumeReplaceSheet({
  row,
  onCancel,
  onConfirm,
}: {
  row: ParkedSale;
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
      data-testid="resume-replace-sheet"
    >
      <div className="w-full max-w-md rounded-t-2xl bg-white p-4 shadow-xl sm:rounded-2xl">
        <h2 className="text-lg font-bold text-neutral-900">
          <FormattedMessage id="cart.parked.resume.replace.title" />
        </h2>
        <p className="mt-1 text-sm text-neutral-600">
          <FormattedMessage id="cart.parked.resume.replace.body" values={{ label: row.label }} />
        </p>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            data-testid="resume-replace-cancel"
            className="h-11 flex-1 rounded-md border border-neutral-300 bg-white font-semibold text-neutral-700 hover:bg-neutral-100"
          >
            <FormattedMessage id="cart.parked.resume.replace.cancel" />
          </button>
          <button
            type="button"
            onClick={onConfirm}
            data-testid="resume-replace-confirm"
            className="h-11 flex-1 rounded-md bg-neutral-900 font-semibold text-white hover:bg-neutral-800"
          >
            <FormattedMessage id="cart.parked.resume.replace.confirm" />
          </button>
        </div>
      </div>
    </div>
  );
}

import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { FormattedMessage, useIntl } from "react-intl";
import { useCartStore } from "../store.ts";
import type { CartLine } from "../types.ts";
import { CartLineRow } from "./CartLineRow.tsx";
import { CartEditSheet } from "./CartEditSheet.tsx";
import { ChargeButton } from "./ChargeButton.tsx";
import { formatIdr } from "../../../shared/money/index.ts";

export function CartPanel() {
  const intl = useIntl();
  const navigate = useNavigate();
  const lines = useCartStore((s) => s.lines);
  const totalsFn = useCartStore((s) => s.totals);
  const setLineQuantity = useCartStore((s) => s.setLineQuantity);
  const removeLine = useCartStore((s) => s.removeLine);
  const t = totalsFn();
  const [editing, setEditing] = useState<CartLine | null>(null);

  return (
    <section aria-label={intl.formatMessage({ id: "cart.aria" })} className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-neutral-200 px-4 py-3">
        <h1 className="text-lg font-bold text-neutral-900">
          {intl.formatMessage({ id: "cart.heading" })}
        </h1>
        {/*
         * KASA-369 — counter-side entry point for the find-sale lookup.
         * A customer who returns 20-40 minutes later asks the cashier at
         * the same counter that's about to ring up the next sale; the
         * cart screen is where that conversation happens, so the link
         * lives in the cart header rather than in the bottom nav (which
         * is already full at five tabs).
         */}
        <Link
          to="/find-sale"
          className="text-sm font-semibold text-primary-700 hover:text-primary-800"
          data-testid="cart-find-sale-link"
        >
          <FormattedMessage id="nav.findSale" />
        </Link>
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
        <ChargeButton
          totalIdr={t.totalIdr}
          disabled={lines.length === 0}
          onClick={() => {
            void navigate({ to: "/tender/cash" });
          }}
        />
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
    </section>
  );
}

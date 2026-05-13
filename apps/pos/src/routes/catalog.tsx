import { useState } from "react";
import { useIntl } from "react-intl";
import { CatalogGrid } from "../features/catalog/CatalogGrid";
import { useSoldOutToggle } from "../features/catalog/useSoldOutToggle";
import { CartPanel } from "../features/cart/ui/CartPanel";
import { BottomSheet } from "../shared/components/BottomSheet";
import type { Item } from "../data/db/types";

/*
 * POS tablet landscape splits catalog (left) and cart (right) per
 * DESIGN-SYSTEM §8. Portrait and phone stack, and the bottom nav
 * keeps a dedicated /cart route for deep linking.
 */
export function CatalogScreen() {
  const intl = useIntl();
  const [longPressItem, setLongPressItem] = useState<Item | null>(null);
  const { setAvailability } = useSoldOutToggle();

  const handleToggle = async () => {
    if (!longPressItem) return;
    const next = longPressItem.availability === "sold_out" ? "available" : "sold_out";
    setLongPressItem(null);
    await setAvailability(longPressItem, next);
  };

  const sheetTitle = longPressItem
    ? intl.formatMessage(
        {
          id:
            longPressItem.availability === "sold_out"
              ? "catalog.soldOut.titleReenable"
              : "catalog.soldOut.title",
        },
        { name: longPressItem.name },
      )
    : "";

  return (
    <div className="grid h-full gap-4 tablet:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <section aria-label={intl.formatMessage({ id: "catalog.aria" })}>
        <h1 className="mb-3 text-lg font-bold text-neutral-900">
          {intl.formatMessage({ id: "catalog.heading" })}
        </h1>
        <CatalogGrid onLongPress={setLongPressItem} />
      </section>
      <aside
        aria-label={intl.formatMessage({ id: "cart.aria" })}
        className="hidden min-h-[480px] rounded-lg border border-neutral-200 bg-white tablet:flex tablet:flex-col"
      >
        <CartPanel />
      </aside>
      <BottomSheet
        open={longPressItem !== null}
        onClose={() => setLongPressItem(null)}
        title={sheetTitle}
        labelledById="catalog-sold-out-title"
      >
        <p className="text-sm text-neutral-600">
          {intl.formatMessage({
            id:
              longPressItem?.availability === "sold_out"
                ? "catalog.soldOut.bodyReenable"
                : "catalog.soldOut.body",
          })}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="h-12 rounded-md border border-neutral-300 px-4 text-sm font-semibold text-neutral-700 active:bg-neutral-50"
            onClick={() => setLongPressItem(null)}
          >
            {intl.formatMessage({ id: "catalog.soldOut.cancel" })}
          </button>
          <button
            type="button"
            data-testid="catalog-sold-out-confirm"
            className="h-12 rounded-md bg-primary-600 px-5 text-sm font-semibold text-white active:bg-primary-700"
            onClick={handleToggle}
          >
            {intl.formatMessage({
              id:
                longPressItem?.availability === "sold_out"
                  ? "catalog.soldOut.confirmReenable"
                  : "catalog.soldOut.confirm",
            })}
          </button>
        </div>
      </BottomSheet>
    </div>
  );
}

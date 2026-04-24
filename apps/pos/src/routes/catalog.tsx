import { useState } from "react";
import { useIntl } from "react-intl";
import { CatalogGrid } from "../features/catalog/CatalogGrid";
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
  const [variantItem, setVariantItem] = useState<Item | null>(null);

  return (
    <div className="grid h-full gap-4 tablet:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <section aria-label={intl.formatMessage({ id: "catalog.aria" })}>
        <h1 className="mb-3 text-lg font-bold text-neutral-900">
          {intl.formatMessage({ id: "catalog.heading" })}
        </h1>
        <CatalogGrid onLongPress={setVariantItem} />
      </section>
      <aside
        aria-label={intl.formatMessage({ id: "cart.aria" })}
        className="hidden min-h-[480px] rounded-lg border border-neutral-200 bg-white tablet:flex tablet:flex-col"
      >
        <CartPanel />
      </aside>
      <BottomSheet
        open={variantItem !== null}
        onClose={() => setVariantItem(null)}
        title={intl.formatMessage(
          { id: "catalog.variant.title" },
          { name: variantItem?.name ?? "" },
        )}
        labelledById="catalog-variant-title"
      >
        <p className="text-sm text-neutral-600">
          {intl.formatMessage({ id: "catalog.variant.placeholder" })}
        </p>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            className="h-12 rounded-md bg-primary-600 px-5 text-sm font-semibold text-white active:bg-primary-700"
            onClick={() => setVariantItem(null)}
          >
            {intl.formatMessage({ id: "catalog.variant.close" })}
          </button>
        </div>
      </BottomSheet>
    </div>
  );
}

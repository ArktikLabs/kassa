import { useIntl } from "react-intl";
import { useCatalog } from "./useCatalog.ts";
import { CatalogTile } from "./CatalogTile.tsx";
import { useCartStore } from "../cart/index.ts";
import type { Item } from "../../data/db/types.ts";

export function CatalogGrid({
  onLongPress,
}: {
  onLongPress?: (item: Item) => void;
}) {
  const { tiles, ready } = useCatalog();
  const intl = useIntl();
  const addLine = useCartStore((s) => s.addLine);

  function handleAdd(item: Item) {
    addLine({
      itemId: item.id,
      name: item.name,
      unitPriceIdr: item.priceIdr,
    });
  }

  if (!ready) {
    return (
      <p className="text-neutral-500" role="status">
        {intl.formatMessage({ id: "catalog.loading" })}
      </p>
    );
  }

  if (tiles.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-8 text-center"
        data-testid="catalog-empty"
      >
        <p className="text-base font-semibold text-neutral-700">
          {intl.formatMessage({ id: "catalog.empty.heading" })}
        </p>
        <p className="text-sm text-neutral-500">
          {intl.formatMessage({ id: "catalog.empty.body" })}
        </p>
      </div>
    );
  }

  return (
    <div
      role="grid"
      aria-label={intl.formatMessage({ id: "catalog.grid.aria" })}
      className="grid grid-cols-2 gap-3 tablet:grid-cols-4 landscape:tablet:grid-cols-6"
      data-testid="catalog-grid"
    >
      {tiles.map(({ item, outOfStock }) => {
        const tileProps = {
          item,
          outOfStock,
          onAdd: handleAdd,
          ...(onLongPress ? { onLongPress } : {}),
        };
        return <CatalogTile key={item.id} {...tileProps} />;
      })}
    </div>
  );
}

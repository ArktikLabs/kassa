import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IntlProvider } from "react-intl";
import { CatalogTile } from "./CatalogTile.tsx";
import { toRupiah } from "../../shared/money/index.ts";
import type { Item } from "../../data/db/types.ts";
import { messagesFor } from "../../i18n/messages.ts";

const baseItem: Item = {
  id: "item-1",
  code: "SKU-1",
  name: "Kopi Susu",
  priceIdr: toRupiah(18000),
  uomId: "uom-1",
  bomId: null,
  isStockTracked: true,
  taxRate: 11,
  availability: "available",
  isActive: true,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function renderTile(props: Parameters<typeof CatalogTile>[0]) {
  return render(
    <IntlProvider locale="id-ID" messages={messagesFor("id-ID")}>
      <CatalogTile {...props} />
    </IntlProvider>,
  );
}

describe("<CatalogTile />", () => {
  it("renders name, price, and an accessible label", () => {
    const onAdd = vi.fn();
    renderTile({ item: baseItem, outOfStock: false, onAdd });
    expect(screen.getByText("Kopi Susu")).toBeInTheDocument();
    const tile = screen.getByRole("button", {
      name: /Kopi Susu.*Ketuk untuk menambah/i,
    });
    expect(tile).toBeInTheDocument();
  });

  it("calls onAdd with the item when tapped", async () => {
    const onAdd = vi.fn();
    renderTile({ item: baseItem, outOfStock: false, onAdd });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Kopi Susu/i }));
    expect(onAdd).toHaveBeenCalledWith(baseItem);
  });

  it("shows the `Habis` overlay and does not add when out of stock", async () => {
    const onAdd = vi.fn();
    renderTile({ item: baseItem, outOfStock: true, onAdd });
    expect(screen.getByText("Habis")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /habis/i }));
    expect(onAdd).not.toHaveBeenCalled();
  });
});

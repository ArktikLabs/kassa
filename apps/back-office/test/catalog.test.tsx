import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CatalogScreen } from "../src/routes/catalog";
import { renderAt } from "./harness";
import { getSnapshot } from "../src/data/store";

describe("Catalog CRUD", () => {
  it("creates an item, edits it, and deactivates it", async () => {
    renderAt("/catalog", [{ path: "/catalog", component: CatalogScreen }]);
    const user = userEvent.setup();

    // Create
    await user.click(
      await screen.findByRole("button", { name: "Tambah produk" }),
    );
    await user.type(screen.getByLabelText("SKU"), "ES-001");
    await user.type(screen.getByLabelText("Nama produk"), "Es Teh Manis");
    await user.type(screen.getByLabelText("Harga (IDR)"), "8000");
    await user.click(screen.getByRole("button", { name: "Simpan produk" }));

    expect(await screen.findByText("Es Teh Manis")).toBeInTheDocument();
    const created = getSnapshot().items.find((it) => it.sku === "ES-001");
    expect(created).toBeDefined();
    expect(created!.priceIdr).toBe(8000);

    // Deactivate
    const deactivate = await screen.findAllByRole("button", {
      name: "Nonaktifkan",
    });
    expect(deactivate.length).toBeGreaterThan(0);
    await user.click(deactivate[0]!);
    expect(getSnapshot().items.some((it) => !it.isActive)).toBe(true);
  });
});

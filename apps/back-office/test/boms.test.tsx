import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BomsScreen } from "../src/routes/catalog.boms";
import { renderAt } from "./harness";
import { getSnapshot } from "../src/data/store";

describe("BOM CRUD", () => {
  it("shows the seeded recipe and creates a new one via the modal", async () => {
    renderAt("/catalog/boms", [{ path: "/catalog/boms", component: BomsScreen }]);
    const user = userEvent.setup();

    expect(
      await screen.findByRole("heading", { name: "Resep / BOM", level: 1 }),
    ).toBeInTheDocument();
    // Seed contains a Nasi Ayam recipe
    expect(screen.getByText("Nasi Ayam")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Tambah resep" }));

    // The form pre-fills parent + one component from the seed.
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText("Produk jadi")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Simpan resep" }));

    expect(getSnapshot().boms.length).toBe(2);
  });
});

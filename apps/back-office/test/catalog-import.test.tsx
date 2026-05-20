import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CatalogImportScreen } from "../src/routes/admin.catalog.import";
import { renderAt } from "./harness";
import { getSnapshot } from "../src/data/store";
import { CSV_HEADER } from "../src/lib/catalog-import";

function csvFile(name: string, body: string): File {
  return new File([body], name, { type: "text/csv" });
}

describe("/admin/catalog/import (KASA-311)", () => {
  it("uploads a valid CSV, shows the diff, and applies the import to the store", async () => {
    renderAt("/admin/catalog/import", [
      { path: "/admin/catalog/import", component: CatalogImportScreen },
    ]);
    const user = userEvent.setup();

    const csv = [
      CSV_HEADER.join(","),
      "NEW-001,Es Jeruk,8000,pcs,false,true",
      "NSI-001,Nasi Ayam,25000,porsi,false,true",
    ].join("\n");

    const fileInput = (await screen.findByLabelText(/Pilih file CSV/i)) as HTMLInputElement;
    await user.upload(fileInput, csvFile("menu.csv", csv));

    expect(await screen.findByTestId("summary-create")).toHaveTextContent("1");
    expect(screen.getByTestId("summary-unchanged")).toHaveTextContent("1");
    expect(screen.getByTestId("summary-skip")).toHaveTextContent("0");

    const confirm = await screen.findByRole("button", { name: "Konfirmasi impor" });
    expect(confirm).not.toBeDisabled();
    await user.click(confirm);

    expect(await screen.findByTestId("import-result")).toBeInTheDocument();
    const items = getSnapshot().items;
    expect(items.some((it) => it.sku === "NEW-001" && it.name === "Es Jeruk")).toBe(true);
  });

  it("disables import when a row has validation errors", async () => {
    renderAt("/admin/catalog/import", [
      { path: "/admin/catalog/import", component: CatalogImportScreen },
    ]);
    const user = userEvent.setup();

    const csv = [
      CSV_HEADER.join(","),
      ",Missing sku,5000,pcs,false,true",
      "OK-001,Valid,6000,pcs,false,true",
    ].join("\n");

    const fileInput = (await screen.findByLabelText(/Pilih file CSV/i)) as HTMLInputElement;
    await user.upload(fileInput, csvFile("bad.csv", csv));

    expect(await screen.findByTestId("summary-skip")).toHaveTextContent("1");
    const confirm = await screen.findByRole("button", { name: "Konfirmasi impor" });
    expect(confirm).toBeDisabled();

    // The seeded store should still hold its original rows — no row leaked in.
    expect(getSnapshot().items.some((it) => it.sku === "OK-001")).toBe(false);
  });

  it("re-importing the same CSV is idempotent (no duplicate rows)", async () => {
    renderAt("/admin/catalog/import", [
      { path: "/admin/catalog/import", component: CatalogImportScreen },
    ]);
    const user = userEvent.setup();

    const csv = [CSV_HEADER.join(","), "RPT-001,Repeat,4000,pcs,false,true"].join("\n");

    const fileInput = (await screen.findByLabelText(/Pilih file CSV/i)) as HTMLInputElement;
    await user.upload(fileInput, csvFile("once.csv", csv));
    await user.click(await screen.findByRole("button", { name: "Konfirmasi impor" }));

    // Round 2: same file, same SKU. After the first import the row exists so
    // diff bucket flips from create→unchanged. The store must not duplicate.
    await user.click(await screen.findByRole("button", { name: "Batal" }));
    await user.upload(fileInput, csvFile("twice.csv", csv));
    expect(await screen.findByTestId("summary-unchanged")).toHaveTextContent("1");
    expect(screen.getByTestId("summary-create")).toHaveTextContent("0");

    const count = getSnapshot().items.filter((it) => it.sku === "RPT-001").length;
    expect(count).toBe(1);
  });
});

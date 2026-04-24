import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IntlProvider } from "../src/i18n/IntlProvider";
import { DataTable, type DataTableColumn } from "../src/components/DataTable";

type Row = { id: string; name: string; qty: number };

function mkRow(i: number): Row {
  return { id: `r-${i}`, name: `Item ${i}`, qty: i };
}

const COLUMNS: DataTableColumn<Row>[] = [
  { key: "name", header: "Nama", render: (r) => r.name },
  { key: "qty", header: "Jumlah", numeric: true, render: (r) => r.qty },
];

describe("DataTable primitive", () => {
  it("paginates rows with prev/next and shows the range", async () => {
    const rows = Array.from({ length: 52 }, (_, i) => mkRow(i + 1));
    render(
      <IntlProvider locale="id-ID">
        <DataTable columns={COLUMNS} rows={rows} getRowId={(r) => r.id} pageSize={25} />
      </IntlProvider>,
    );

    expect(screen.getByTestId("data-table-range")).toHaveTextContent("1–25 dari 52");
    expect(screen.getAllByTestId("data-table-row")).toHaveLength(25);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Berikutnya" }));
    expect(screen.getByTestId("data-table-range")).toHaveTextContent("26–50 dari 52");
    await user.click(screen.getByRole("button", { name: "Berikutnya" }));
    expect(screen.getByTestId("data-table-range")).toHaveTextContent("51–52 dari 52");
  });

  it("renders the empty state when rows is empty", () => {
    render(
      <IntlProvider locale="id-ID">
        <DataTable
          columns={COLUMNS}
          rows={[]}
          getRowId={(r) => r.id}
          emptyState={<span>Tidak ada data</span>}
        />
      </IntlProvider>,
    );
    expect(screen.getByText("Tidak ada data")).toBeInTheDocument();
  });

  it("applies numeric alignment to numeric columns", () => {
    render(
      <IntlProvider locale="id-ID">
        <DataTable columns={COLUMNS} rows={[mkRow(1)]} getRowId={(r) => r.id} />
      </IntlProvider>,
    );
    const row = screen.getByTestId("data-table-row");
    const qtyCell = within(row).getByText("1").closest("td");
    expect(qtyCell?.className).toMatch(/text-right/);
    expect(qtyCell?.className).toMatch(/tabular-nums/);
  });
});

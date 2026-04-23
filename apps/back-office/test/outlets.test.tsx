import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OutletsScreen } from "../src/routes/outlets";
import { renderAt } from "./harness";
import { getSnapshot } from "../src/data/store";

describe("Outlets CRUD", () => {
  it("lists seeded outlets and creates a new one via the modal form", async () => {
    renderAt("/outlets", [{ path: "/outlets", component: OutletsScreen }]);
    expect(
      await screen.findByRole("heading", { name: "Outlet", level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText("Warung Pusat")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Tambah outlet" }));

    await user.type(screen.getByLabelText("Nama outlet"), "Cabang Bekasi");
    await user.type(
      screen.getByLabelText("Header struk"),
      "Cabang Bekasi · Jl. Ahmad Yani",
    );
    await user.type(screen.getByLabelText("Alamat"), "Jl. Ahmad Yani No.42");
    await user.click(screen.getByRole("button", { name: "Simpan outlet" }));

    expect(getSnapshot().outlets.map((o) => o.name)).toContain(
      "Cabang Bekasi",
    );
    expect(await screen.findByText("Cabang Bekasi")).toBeInTheDocument();
  });

  it("issues an enrolment code for an outlet", async () => {
    renderAt("/outlets", [{ path: "/outlets", component: OutletsScreen }]);
    const user = userEvent.setup();

    const issueBtn = await screen.findAllByRole("button", {
      name: "Buat kode enrolment",
    });
    await user.click(issueBtn[0]!);

    // Banner text wraps the code in a <code> tag, so the rendered text
    // is split across elements. Match via the aria-live region instead.
    const banner = await screen.findByRole("status");
    expect(banner).toHaveTextContent(/Kode [A-HJ-NP-Z2-9]{8} dibuat/);
    expect(getSnapshot().enrolmentCodes).toHaveLength(1);
    expect(getSnapshot().enrolmentCodes[0]!.code).toMatch(
      /^[A-HJ-NP-Z2-9]{8}$/,
    );
  });
});

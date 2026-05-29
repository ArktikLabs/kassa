import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OutletsScreen } from "../src/routes/outlets";
import { renderAt } from "./harness";
import { getSnapshot } from "../src/data/store";

describe("Outlets CRUD", () => {
  it("lists seeded outlets and creates a new one via the modal form", async () => {
    renderAt("/outlets", [{ path: "/outlets", component: OutletsScreen }]);
    expect(await screen.findByRole("heading", { name: "Outlet", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("Warung Pusat")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Tambah outlet" }));

    await user.type(screen.getByLabelText("Nama outlet"), "Cabang Bekasi");
    await user.type(screen.getByLabelText("Header struk"), "Cabang Bekasi · Jl. Ahmad Yani");
    await user.type(screen.getByLabelText("Alamat"), "Jl. Ahmad Yani No.42");
    await user.click(screen.getByRole("button", { name: "Simpan outlet" }));

    expect(getSnapshot().outlets.map((o) => o.name)).toContain("Cabang Bekasi");
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
    expect(getSnapshot().enrolmentCodes[0]!.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  });

  // KASA-367 — per-outlet receipt branding overrides.
  it("persists displayName, NPWP, address lines, and footer lines on save", async () => {
    renderAt("/outlets", [{ path: "/outlets", component: OutletsScreen }]);
    const user = userEvent.setup();

    await user.click((await screen.findAllByRole("button", { name: "Ubah outlet" }))[0]!);

    await user.type(screen.getByLabelText("Nama tampil di struk"), "Warung Pusat");
    await user.type(screen.getByLabelText("Alamat baris 1"), "Jl. Sudirman No.1");
    // Type with the canonical NPWP mask — punctuation should be stripped.
    await user.type(screen.getByLabelText("NPWP"), "01.234.567.8-901.000");
    await user.type(screen.getByLabelText("Baris penutup 1"), "Terima kasih atas kunjungan Anda");
    await user.click(screen.getByRole("button", { name: "Simpan outlet" }));

    const persisted = getSnapshot().outlets[0]!;
    expect(persisted.displayName).toBe("Warung Pusat");
    expect(persisted.addressLine1).toBe("Jl. Sudirman No.1");
    expect(persisted.taxId).toBe("012345678901000");
    expect(persisted.receiptFooterLine1).toBe("Terima kasih atas kunjungan Anda");
  });

  it("blocks save and shows a clear error when the NPWP is too short", async () => {
    renderAt("/outlets", [{ path: "/outlets", component: OutletsScreen }]);
    const user = userEvent.setup();

    await user.click((await screen.findAllByRole("button", { name: "Ubah outlet" }))[0]!);
    await user.type(screen.getByLabelText("NPWP"), "12345");
    await user.click(screen.getByRole("button", { name: "Simpan outlet" }));

    expect(await screen.findByText("NPWP harus 15 atau 16 digit.")).toBeInTheDocument();
    // The form modal stays open and the snapshot is unchanged.
    expect(getSnapshot().outlets[0]!.taxId).toBe("");
  });

  it("caps footer-line input length at 32 characters", async () => {
    renderAt("/outlets", [{ path: "/outlets", component: OutletsScreen }]);
    const user = userEvent.setup();

    await user.click((await screen.findAllByRole("button", { name: "Ubah outlet" }))[0]!);
    const footer = screen.getByLabelText(/Baris penutup 1/);
    expect(footer).toHaveAttribute("maxLength", "32");
  });
});

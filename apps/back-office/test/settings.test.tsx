import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsScreen } from "../src/routes/settings";
import { renderAt } from "./harness";
import { getSnapshot } from "../src/data/store";

describe("Merchant settings (KASA-219)", () => {
  it("seeds the form with the current merchant identity and saves an edit", async () => {
    renderAt("/settings", [{ path: "/settings", component: SettingsScreen }]);
    const user = userEvent.setup();

    expect(
      await screen.findByRole("heading", { name: "Pengaturan merchant", level: 1 }),
    ).toBeInTheDocument();

    const display = screen.getByLabelText("Nama tampilan di struk") as HTMLInputElement;
    expect(display.value).toBe("Warung Pusat");

    const footer = screen.getByLabelText("Teks penutup struk") as HTMLInputElement;
    await user.clear(footer);
    await user.type(footer, "Sampai jumpa lagi!");
    await user.click(screen.getByRole("button", { name: "Simpan pengaturan" }));

    expect(getSnapshot().merchant.receiptFooterText).toBe("Sampai jumpa lagi!");
    expect(await screen.findByTestId("settings-saved")).toBeInTheDocument();
  });

  it("rejects an NPWP that is not exactly 16 digits", async () => {
    renderAt("/settings", [{ path: "/settings", component: SettingsScreen }]);
    const user = userEvent.setup();

    const npwp = await screen.findByLabelText("NPWP");
    await user.type(npwp, "12345");
    await user.click(screen.getByRole("button", { name: "Simpan pengaturan" }));

    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((el) => /NPWP/.test(el.textContent ?? ""))).toBe(true);
    // Persisted state untouched (the seed leaves npwp null).
    expect(getSnapshot().merchant.npwp).toBeNull();
  });

  it("rejects letters in the phone field", async () => {
    renderAt("/settings", [{ path: "/settings", component: SettingsScreen }]);
    const user = userEvent.setup();

    const phone = await screen.findByLabelText("Telepon");
    await user.clear(phone);
    await user.type(phone, "call us");
    await user.click(screen.getByRole("button", { name: "Simpan pengaturan" }));

    expect((await screen.findAllByRole("alert")).length).toBeGreaterThan(0);
    // The seed phone wins; the bad value is not committed.
    expect(getSnapshot().merchant.phone).toBe("+62 21 555 0100");
  });

  it("clears an optional field by submitting it blank", async () => {
    renderAt("/settings", [{ path: "/settings", component: SettingsScreen }]);
    const user = userEvent.setup();

    const address = await screen.findByLabelText("Alamat");
    await user.clear(address);
    await user.click(screen.getByRole("button", { name: "Simpan pengaturan" }));

    expect(getSnapshot().merchant.addressLine).toBeNull();
  });
});

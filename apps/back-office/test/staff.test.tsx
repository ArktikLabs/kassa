import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StaffScreen } from "../src/routes/staff";
import { renderAt } from "./harness";
import { getSnapshot } from "../src/data/store";

describe("Staff CRUD", () => {
  it("creates a staff member with a role and PIN", async () => {
    renderAt("/staff", [{ path: "/staff", component: StaffScreen }]);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Tambah staf" }));
    await user.type(screen.getByLabelText("Nama tampilan"), "Budi Santoso");
    await user.type(screen.getByLabelText("Email"), "budi@warungpusat.id");
    await user.selectOptions(screen.getByLabelText("Peran"), "cashier");
    await user.type(screen.getByLabelText("PIN 4 digit"), "4321");
    await user.click(screen.getByRole("button", { name: "Simpan staf" }));

    const created = getSnapshot().staff.find((s) => s.email === "budi@warungpusat.id");
    expect(created).toBeDefined();
    expect(created!.role).toBe("cashier");
    expect(created!.pin).toBe("4321");
  });

  it("resets a staff PIN", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    renderAt("/staff", [{ path: "/staff", component: StaffScreen }]);
    const user = userEvent.setup();

    await user.click((await screen.findAllByRole("button", { name: "Atur ulang PIN" }))[0]!);

    const seeded = getSnapshot().staff[0]!;
    expect(seeded.pin).toMatch(/^\d{4}$/);
    expect(alertSpy).toHaveBeenCalled();
    alertSpy.mockRestore();
  });
});

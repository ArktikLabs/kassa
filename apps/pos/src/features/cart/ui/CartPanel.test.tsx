import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dexie from "dexie";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { IntlProvider } from "../../../i18n/IntlProvider.tsx";
import { routeTree } from "../../../router.tsx";
import { _resetForTest } from "../../../lib/enrolment.ts";
import { _resetDatabaseSingletonForTest, DB_NAME, getDatabase } from "../../../data/db/index.ts";
import { toRupiah } from "../../../shared/money/index.ts";
import { useCartStore, _resetCartStoreForTest } from "../store.ts";

/*
 * Component test for the KASA-366 cart park/resume affordances. Drives
 * the real Dexie singleton via `fake-indexeddb` plus the live cart
 * store; the router renders the actual `/cart` route so the integration
 * with the shift guard is exercised.
 */

async function seedDeviceAndShift(): Promise<void> {
  const { repos } = await getDatabase();
  await repos.deviceSecret.set({
    deviceId: "11111111-1111-1111-1111-111111111111",
    apiKey: "pk_live_test",
    apiSecret: "sk_live_test",
    outletId: "outlet-1",
    outletName: "Warung Maju",
    merchantId: "merchant-1",
    merchantName: "Toko Maju",
    enrolledAt: "2026-05-29T03:00:00.000Z",
  });
  await repos.shiftState.put({
    localShiftId: "shift-A",
    outletId: "outlet-1",
    cashierStaffId: "staff-1",
    businessDate: "2026-05-29",
    openShiftId: "open-1",
    openedAt: "2026-05-29T03:00:00.000Z",
    openingFloatIdr: 100_000,
    serverShiftId: null,
    closedAt: null,
  });
}

function renderCart(): void {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/cart"] }),
  });
  render(
    <IntlProvider locale="id-ID">
      <RouterProvider router={router} />
    </IntlProvider>,
  );
}

function seedKopiInCart(): void {
  act(() => {
    useCartStore.getState().addLine({
      itemId: "item-kopi",
      name: "Kopi Susu",
      unitPriceIdr: toRupiah(18_000),
      quantity: 2,
    });
  });
}

describe("<CartPanel /> — park / resume", () => {
  beforeEach(async () => {
    _resetForTest();
    _resetDatabaseSingletonForTest();
    _resetCartStoreForTest();
    await Dexie.delete(DB_NAME);
    await seedDeviceAndShift();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("park button is disabled when the cart is empty", async () => {
    renderCart();
    // Wait for the cart screen to settle past the shift guard before
    // reaching for the park button; otherwise we can race the router
    // mid-redirect on a fresh Dexie fixture and find an empty body.
    await screen.findByRole("heading", { name: "Keranjang" });
    const cta = await screen.findByTestId("cart-park-cta");
    expect(cta).toBeDisabled();
  });

  it("parks the active cart, clears it, and exposes a tray affordance", async () => {
    seedKopiInCart();
    renderCart();

    const user = userEvent.setup();
    const parkBtn = await screen.findByTestId("cart-park-cta");
    await waitFor(() => expect(parkBtn).not.toBeDisabled());
    await user.click(parkBtn);

    const sheet = await screen.findByTestId("park-cart-sheet");
    await user.type(sheet.querySelector("input")!, "Meja 3");
    await user.click(screen.getByTestId("park-cart-confirm"));

    await waitFor(() => {
      expect(screen.queryByTestId("park-cart-sheet")).toBeNull();
    });
    // Active cart resets to empty.
    expect(await screen.findByTestId("cart-empty")).toBeInTheDocument();
    // Tray affordance appears with count 1.
    const tray = await screen.findByTestId("cart-parked-tray-cta");
    expect(tray.textContent).toMatch(/1/);

    // Persisted in Dexie.
    const { repos } = await getDatabase();
    const rows = await repos.parkedSales.listForShift("outlet-1", "shift-A");
    expect(rows.map((r) => r.label)).toEqual(["Meja 3"]);
    expect(rows[0]?.lines[0]?.quantity).toBe(2);
  });

  it("resume from an empty cart restores the parked lines and removes the row", async () => {
    // Seed a parked row directly so we don't depend on the park flow above.
    const { repos } = await getDatabase();
    await repos.parkedSales.put({
      id: "parked-1",
      outletId: "outlet-1",
      localShiftId: "shift-A",
      cashierStaffId: "staff-1",
      label: "Bapak Ali",
      lines: [
        {
          itemId: "item-roti",
          name: "Roti Bakar",
          unitPriceIdr: toRupiah(12_500),
          quantity: 3,
          lineTotalIdr: toRupiah(37_500),
        },
      ],
      discountIdr: toRupiah(0),
      parkedAt: "2026-05-29T04:00:00.000Z",
    });

    renderCart();
    const user = userEvent.setup();
    const trayBtn = await screen.findByTestId("cart-parked-tray-cta");
    await user.click(trayBtn);

    await screen.findByTestId("parked-tray-sheet");
    const resumeBtn = await screen.findByTestId("parked-tray-row-resume");
    await user.click(resumeBtn);

    // Cart lines render the resumed line; the row is gone from Dexie.
    await waitFor(() => {
      expect(screen.getByTestId("cart-lines")).toBeInTheDocument();
    });
    expect(useCartStore.getState().lines).toHaveLength(1);
    expect(useCartStore.getState().lines[0]?.itemId).toBe("item-roti");
    await waitFor(async () => {
      const after = await repos.parkedSales.getById("parked-1");
      expect(after).toBeUndefined();
    });
  });

  it("blocks discard until the manager PIN is entered", async () => {
    const { repos } = await getDatabase();
    await repos.parkedSales.put({
      id: "parked-2",
      outletId: "outlet-1",
      localShiftId: "shift-A",
      cashierStaffId: "staff-1",
      label: "Meja 7",
      lines: [
        {
          itemId: "item-roti",
          name: "Roti Bakar",
          unitPriceIdr: toRupiah(12_500),
          quantity: 1,
          lineTotalIdr: toRupiah(12_500),
        },
      ],
      discountIdr: toRupiah(0),
      parkedAt: "2026-05-29T04:00:00.000Z",
    });

    renderCart();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("cart-parked-tray-cta"));
    await user.click(await screen.findByTestId("parked-tray-row-discard"));

    const pinInput = await screen.findByTestId("discard-parked-pin-input");
    // Wrong PIN rejected.
    await user.type(pinInput, "0000");
    await user.click(screen.getByTestId("discard-parked-confirm"));
    await screen.findByTestId("discard-parked-error");
    // Row still present.
    expect(await repos.parkedSales.getById("parked-2")).toBeDefined();

    // Correct PIN — DEFAULT_MANAGER_PIN from idle-lock is "9999".
    await user.clear(pinInput);
    await user.type(pinInput, "9999");
    await user.click(screen.getByTestId("discard-parked-confirm"));

    await waitFor(async () => {
      expect(await repos.parkedSales.getById("parked-2")).toBeUndefined();
    });
  });
});

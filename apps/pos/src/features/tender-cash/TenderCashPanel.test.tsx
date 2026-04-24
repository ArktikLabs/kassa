import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IntlProvider } from "react-intl";
import { DEFAULT_LOCALE, messagesFor } from "../../i18n/messages.ts";
import { toRupiah } from "../../shared/money/index.ts";
import { _resetCartStoreForTest, useCartStore } from "../cart/store.ts";
import {
  _resetDatabaseSingletonForTest,
  getDatabase,
} from "../../data/db/index.ts";
import Dexie from "dexie";
import { DB_NAME } from "../../data/db/schema.ts";
import { TenderCashPanel } from "./TenderCashPanel.tsx";

const locale = DEFAULT_LOCALE;
const messages = messagesFor(locale);

const navigate = vi.fn();
vi.mock("@tanstack/react-router", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    useNavigate: () => navigate,
  };
});

function renderPanel() {
  return render(
    <IntlProvider locale={locale} messages={messages} defaultLocale="en">
      <TenderCashPanel />
    </IntlProvider>,
  );
}

async function seedDb() {
  const database = await getDatabase();
  await database.repos.deviceSecret.set({
    deviceId: "11111111-1111-7111-8111-111111111111",
    outletId: "22222222-2222-7222-8222-222222222222",
    outletName: "Warung Maju",
    merchantId: "33333333-3333-7333-8333-333333333333",
    merchantName: "Toko Maju",
    apiKey: "pk",
    apiSecret: "sk",
    enrolledAt: "2026-04-23T00:00:00.000Z",
  });
  await database.repos.outlets.upsertMany([
    {
      id: "22222222-2222-7222-8222-222222222222",
      code: "MAIN",
      name: "Warung Maju",
      timezone: "Asia/Jakarta",
      updatedAt: "2026-04-23T00:00:00.000Z",
    },
  ]);
  await database.repos.items.upsertMany([
    {
      id: "44444444-4444-7444-8444-444444444444",
      code: "KP-001",
      name: "Kopi Susu",
      priceIdr: toRupiah(25_000),
      uomId: "55555555-5555-7555-8555-555555555555",
      bomId: null,
      isStockTracked: true,
      isActive: true,
      updatedAt: "2026-04-23T00:00:00.000Z",
    },
  ]);
  await database.repos.stockSnapshot.upsertMany([
    {
      key: "",
      outletId: "22222222-2222-7222-8222-222222222222",
      itemId: "44444444-4444-7444-8444-444444444444",
      onHand: 10,
      updatedAt: "2026-04-23T00:00:00.000Z",
    },
  ]);
  return database;
}

async function resetDb() {
  _resetDatabaseSingletonForTest();
  await Dexie.delete(DB_NAME);
}

describe("TenderCashPanel", () => {
  beforeEach(async () => {
    navigate.mockReset();
    _resetCartStoreForTest();
    await resetDb();
  });

  afterEach(async () => {
    await resetDb();
  });

  it("guards the empty cart — Selesai disabled, no finalize", async () => {
    renderPanel();
    const submit = screen.getByTestId("tender-submit");
    expect(submit).toBeDisabled();
    expect(screen.getByTestId("tender-cart-empty")).toBeInTheDocument();
  });

  it("shows change due when tendered covers total via a quick chip", async () => {
    const user = userEvent.setup();
    await seedDb();
    useCartStore.getState().addLine({
      itemId: "44444444-4444-7444-8444-444444444444",
      name: "Kopi Susu",
      unitPriceIdr: toRupiah(25_000),
      quantity: 2,
    });
    renderPanel();
    const chips = screen.getByTestId("quick-tender-chips");
    await user.click(
      within(chips).getByTestId("chip-tender.cash.chip.100k"),
    );
    expect(screen.getByTestId("tender-total")).toHaveTextContent("50.000");
    expect(screen.getByTestId("tender-amount")).toHaveTextContent("100.000");
    expect(screen.getByTestId("tender-change")).toHaveTextContent("50.000");
    expect(screen.getByTestId("tender-submit")).not.toBeDisabled();
  });

  it("finalizes, clears the cart, and navigates to /receipt/:id on Selesai", async () => {
    const user = userEvent.setup();
    await seedDb();
    useCartStore.getState().addLine({
      itemId: "44444444-4444-7444-8444-444444444444",
      name: "Kopi Susu",
      unitPriceIdr: toRupiah(25_000),
      quantity: 1,
    });
    renderPanel();
    const chips = screen.getByTestId("quick-tender-chips");
    await user.click(within(chips).getByTestId("chip-tender.cash.chip.pas"));
    await user.click(screen.getByTestId("tender-submit"));

    await vi.waitFor(() => {
      expect(navigate).toHaveBeenCalled();
    });
    const [args] = navigate.mock.calls[0] ?? [];
    expect((args as { to: string }).to).toBe("/receipt/$id");
    expect(useCartStore.getState().lines).toHaveLength(0);
  });

  it("keeps Selesai disabled while the tender amount is below the total", async () => {
    const user = userEvent.setup();
    await seedDb();
    useCartStore.getState().addLine({
      itemId: "44444444-4444-7444-8444-444444444444",
      name: "Kopi Susu",
      unitPriceIdr: toRupiah(25_000),
      quantity: 1,
    });
    renderPanel();
    await user.click(screen.getByTestId("keypad-1"));
    expect(screen.getByTestId("tender-coverage")).toBeInTheDocument();
    expect(screen.getByTestId("tender-submit")).toBeDisabled();
  });
});

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IntlProvider } from "react-intl";
import Dexie from "dexie";
import { DEFAULT_LOCALE, messagesFor } from "../../i18n/messages.ts";
import { toRupiah } from "../../shared/money/index.ts";
import { _resetCartStoreForTest, useCartStore } from "../cart/store.ts";
import { _resetDatabaseSingletonForTest, getDatabase } from "../../data/db/index.ts";
import { DB_NAME } from "../../data/db/schema.ts";
import { TenderSplitPanel } from "./TenderSplitPanel.tsx";

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

function renderPanel(initialMode: "auto" | "static" | "dynamic" = "static") {
  return render(
    <IntlProvider locale={locale} messages={messages} defaultLocale="en">
      <TenderSplitPanel
        initialMode={initialMode}
        generateLocalSaleId={() => "01929b2d-1ff0-7f00-80aa-000000000099"}
      />
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
      taxRate: 11,
      availability: "available",
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

function addKopiToCart(quantity: number) {
  useCartStore.getState().addLine({
    itemId: "44444444-4444-7444-8444-444444444444",
    name: "Kopi Susu",
    unitPriceIdr: toRupiah(25_000),
    quantity,
  });
}

describe("TenderSplitPanel", () => {
  beforeEach(async () => {
    navigate.mockReset();
    _resetCartStoreForTest();
    await resetDb();
  });

  afterEach(async () => {
    await resetDb();
  });

  it("renders the cart-empty guard and disables submit when the cart is empty", async () => {
    renderPanel("static");
    expect(screen.getByTestId("tender-split-cart-empty")).toBeInTheDocument();
    expect(screen.getByTestId("tender-split-submit-static")).toBeDisabled();
  });

  it("auto-fills the QRIS leg as total minus cash and refuses degenerate splits", async () => {
    const user = userEvent.setup();
    await seedDb();
    addKopiToCart(2); // 50k total
    renderPanel("static");

    // No cash yet → split invalid even with valid last4.
    const last4 = screen.getByTestId("tender-split-last4") as HTMLInputElement;
    expect(last4).toBeDisabled();

    // Type 20k via chip "Setengah" then bump using keypad.
    const halfChip = screen.getByTestId("tender-split-chip-setengah");
    await user.click(halfChip);

    // Half of 50k → 25k cash, 25k QRIS.
    expect(screen.getByTestId("tender-split-cash")).toHaveTextContent("25.000");
    expect(screen.getByTestId("tender-split-qris")).toHaveTextContent("25.000");
  });

  it("static-mode happy path: cash + qris_static with buyerRefLast4 finalises and navigates", async () => {
    const user = userEvent.setup();
    const database = await seedDb();
    addKopiToCart(2); // 50k total

    renderPanel("static");

    // Pick 20k via chip 20k.
    await user.click(screen.getByTestId("tender-split-chip-20k"));
    expect(screen.getByTestId("tender-split-cash")).toHaveTextContent("20.000");
    expect(screen.getByTestId("tender-split-qris")).toHaveTextContent("30.000");

    const last4 = screen.getByTestId("tender-split-last4") as HTMLInputElement;
    await user.type(last4, "1234");

    const submit = screen.getByTestId("tender-split-submit-static");
    expect(submit).not.toBeDisabled();
    await user.click(submit);

    // Wait for the navigation to fire — the panel writes the outbox row
    // and then navigates to /receipt/$id.
    await vi.waitFor(() => {
      expect(navigate).toHaveBeenCalledWith({
        to: "/receipt/$id",
        params: { id: "01929b2d-1ff0-7f00-80aa-000000000099" },
      });
    });

    const stored = await database.repos.pendingSales.getById(
      "01929b2d-1ff0-7f00-80aa-000000000099",
    );
    expect(stored?.tenders).toHaveLength(2);
    expect(stored?.tenders?.[0]).toMatchObject({
      method: "cash",
      amountIdr: 20_000,
    });
    expect(stored?.tenders?.[1]).toMatchObject({
      method: "qris_static",
      amountIdr: 30_000,
      verified: false,
      buyerRefLast4: "1234",
    });
    expect(stored?.totalIdr).toBe(50_000);
  });

  it("warns when the cash leg exceeds the total and disables submit", async () => {
    const user = userEvent.setup();
    await seedDb();
    addKopiToCart(1); // 25k total

    renderPanel("static");

    // 50k chip → cash 50k, but total is only 25k.
    await user.click(screen.getByTestId("tender-split-chip-50k"));

    // Chip clamps to total - 1 = 24_000, so the cash-over warning should
    // NOT trip from the chip path. Use the keypad to push past total.
    // First, clear via the "Setengah" route — actually easier: just type
    // digits directly.
    const keypadFive = screen.getByRole("button", { name: "5" });
    const keypadZero = screen.getByRole("button", { name: "0" });
    // Type "50000" → 50k via keypad (bypasses chip clamping).
    await user.click(keypadFive);
    await user.click(keypadZero);
    await user.click(keypadZero);
    await user.click(keypadZero);
    await user.click(keypadZero);

    // Now cash exceeds 25k.
    expect(screen.getByTestId("tender-split-cash-over")).toBeInTheDocument();
    expect(screen.getByTestId("tender-split-submit-static")).toBeDisabled();
  });
});

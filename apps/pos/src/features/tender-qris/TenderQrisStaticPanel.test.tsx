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
import { TenderQrisStaticPanel } from "./TenderQrisStaticPanel.tsx";

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

const SAMPLE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUAAAAFCAYAAACNbyblAAAAHElEQVQI12P4//8/w38GIAXDIBKE0DHxgljNBAAO9TXL0Y4OHwAAAABJRU5ErkJggg==";

function renderPanel(deps?: {
  fetchPrintedQris?: typeof import("../../data/api/printed-qris.ts").fetchPrintedQris;
  now?: () => Date;
}) {
  return render(
    <IntlProvider locale={locale} messages={messages} defaultLocale="en">
      <TenderQrisStaticPanel deps={deps} />
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

describe("TenderQrisStaticPanel", () => {
  beforeEach(async () => {
    navigate.mockReset();
    _resetCartStoreForTest();
    await resetDb();
  });

  afterEach(async () => {
    await resetDb();
  });

  it("renders the cart total and an empty-cart guard, Selesai disabled", async () => {
    renderPanel({
      fetchPrintedQris: vi.fn().mockResolvedValue({
        outletId: "22222222-2222-7222-8222-222222222222",
        image: SAMPLE_DATA_URL,
        mimeType: "image/png",
      }),
    });
    expect(screen.getByTestId("tender-qris-static-cart-empty")).toBeInTheDocument();
    expect(screen.getByTestId("tender-qris-static-submit")).toBeDisabled();
  });

  it("blocks Selesai until the last4 input is exactly 4 digits, even with a non-empty cart", async () => {
    const user = userEvent.setup();
    await seedDb();
    addKopiToCart(2);
    renderPanel({
      fetchPrintedQris: vi.fn().mockResolvedValue({
        outletId: "22222222-2222-7222-8222-222222222222",
        image: SAMPLE_DATA_URL,
        mimeType: "image/png",
      }),
    });

    const submit = screen.getByTestId("tender-qris-static-submit");
    expect(submit).toBeDisabled();

    const last4 = screen.getByTestId("tender-qris-static-last4") as HTMLInputElement;
    await user.type(last4, "12");
    expect(submit).toBeDisabled();

    await user.type(last4, "34");
    expect(last4.value).toBe("1234");
    expect(submit).not.toBeDisabled();
  });

  it("filters non-digit characters and clamps to 4 characters in the last4 input", async () => {
    const user = userEvent.setup();
    await seedDb();
    addKopiToCart(1);
    renderPanel({
      fetchPrintedQris: vi.fn().mockResolvedValue({
        outletId: "22222222-2222-7222-8222-222222222222",
        image: SAMPLE_DATA_URL,
        mimeType: "image/png",
      }),
    });

    const last4 = screen.getByTestId("tender-qris-static-last4") as HTMLInputElement;
    await user.type(last4, "ab12cd34ef99");
    expect(last4.value).toBe("1234");
  });

  it("fetches the printed QR and writes the cache row on first render", async () => {
    const user = userEvent.setup();
    const database = await seedDb();
    addKopiToCart(1);

    const fetchPrintedQris = vi.fn().mockResolvedValue({
      outletId: "22222222-2222-7222-8222-222222222222",
      image: SAMPLE_DATA_URL,
      mimeType: "image/png",
    });
    renderPanel({
      fetchPrintedQris,
      now: () => new Date("2026-04-23T03:00:00.000Z"),
    });

    await vi.waitFor(() => {
      expect(fetchPrintedQris).toHaveBeenCalledWith("22222222-2222-7222-8222-222222222222");
    });
    await vi.waitFor(() => {
      expect(screen.getByTestId("tender-qris-static-image-img")).toHaveAttribute(
        "src",
        SAMPLE_DATA_URL,
      );
    });

    const cached = await database.repos.printedQris.get("22222222-2222-7222-8222-222222222222");
    expect(cached?.image).toBe(SAMPLE_DATA_URL);
    expect(cached?.mimeType).toBe("image/png");

    // Smoke-check the rest of the flow: with a cached image and a valid
    // last4 the submit button finalises and routes to the receipt.
    const last4 = screen.getByTestId("tender-qris-static-last4");
    await user.type(last4, "1234");
    await user.click(screen.getByTestId("tender-qris-static-submit"));
    await vi.waitFor(() => {
      expect(navigate).toHaveBeenCalled();
    });
    const [args] = navigate.mock.calls[0] ?? [];
    expect((args as { to: string }).to).toBe("/receipt/$id");
    expect(useCartStore.getState().lines).toHaveLength(0);
  });

  it("falls back to the cached image when the fetch fails offline", async () => {
    const database = await seedDb();
    await database.repos.printedQris.put({
      outletId: "22222222-2222-7222-8222-222222222222",
      image: SAMPLE_DATA_URL,
      mimeType: "image/png",
      fetchedAt: "2026-04-23T00:00:00.000Z",
    });
    addKopiToCart(1);

    const { PrintedQrisApiError } = await import("../../data/api/printed-qris.ts");
    const fetchPrintedQris = vi
      .fn()
      .mockRejectedValue(new PrintedQrisApiError("network_error", "offline"));
    renderPanel({
      fetchPrintedQris,
      now: () => new Date("2026-04-25T00:00:00.000Z"),
    });

    await vi.waitFor(() => {
      expect(screen.getByTestId("tender-qris-static-image-img")).toHaveAttribute(
        "src",
        SAMPLE_DATA_URL,
      );
    });
  });

  it("on Selesai writes a queued qris_static PendingSale and routes to /receipt/:id", async () => {
    const user = userEvent.setup();
    const database = await seedDb();
    addKopiToCart(2);

    renderPanel({
      fetchPrintedQris: vi.fn().mockResolvedValue({
        outletId: "22222222-2222-7222-8222-222222222222",
        image: SAMPLE_DATA_URL,
        mimeType: "image/png",
      }),
    });

    const last4 = screen.getByTestId("tender-qris-static-last4");
    await user.type(last4, "5678");
    await user.click(screen.getByTestId("tender-qris-static-submit"));

    await vi.waitFor(() => {
      expect(navigate).toHaveBeenCalled();
    });

    const rows = await database.db.pending_sales.toArray();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.status).toBe("queued");
    expect(row?.tenders[0]?.method).toBe("qris_static");
    expect(row?.tenders[0]?.verified).toBe(false);
    expect(row?.tenders[0]?.buyerRefLast4).toBe("5678");
    expect(row?.tenders[0]?.amountIdr).toBe(50_000);
  });
});

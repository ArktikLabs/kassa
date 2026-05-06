import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import {
  EodService,
  InMemoryEodRepository,
  SalesRepositorySalesReader,
} from "../src/services/eod/index.js";
import {
  computeLineTaxIdr,
  InMemorySalesRepository,
  SalesService,
  type Item,
  type Merchant,
  type Outlet,
} from "../src/services/sales/index.js";

/*
 * KASA-218 — Indonesian PPN (VAT) end-to-end coverage.
 *
 *   1. Unit suite: per-line rounding for the documented edge cases. Locks the
 *      formula and the half-away-from-zero rule so a refactor that swaps
 *      `Math.round` for `Math.trunc`/banker's-rounding fails loud.
 *   2. Integration suite: posts an Rp 11,000 inclusive sale through the real
 *      `/v1/sales/submit` route and asserts `taxIdr === 1090` on both the
 *      submit response and the EOD breakdown — the literal acceptance from
 *      the KASA-218 ticket.
 */

describe("computeLineTaxIdr (KASA-218 unit)", () => {
  it("Rp 11,000 @ 11% inclusive → 1090 (acceptance number)", () => {
    expect(computeLineTaxIdr(11_000, 11, true)).toBe(1090);
  });

  it("Rp 10,000 @ 11% exclusive → 1100", () => {
    expect(computeLineTaxIdr(10_000, 11, false)).toBe(1100);
  });

  it("Rp 0 contributes 0 regardless of mode", () => {
    expect(computeLineTaxIdr(0, 11, true)).toBe(0);
    expect(computeLineTaxIdr(0, 11, false)).toBe(0);
  });

  it("0% rate contributes 0 regardless of mode", () => {
    expect(computeLineTaxIdr(11_000, 0, true)).toBe(0);
    expect(computeLineTaxIdr(11_000, 0, false)).toBe(0);
  });

  it("rounds half-away-from-zero for inclusive mode", () => {
    // Rp 100 @ 11% inclusive: 100 − 100/1.11 = 9.9099… → 10
    expect(computeLineTaxIdr(100, 11, true)).toBe(10);
    // Rp 5 @ 11% inclusive: 5 − 5/1.11 = 0.4955… → 0
    expect(computeLineTaxIdr(5, 11, true)).toBe(0);
    // Rp 50 @ 11% inclusive: 50 − 50/1.11 = 4.9549… → 5
    expect(computeLineTaxIdr(50, 11, true)).toBe(5);
  });

  it("rounds half-away-from-zero for exclusive mode", () => {
    // Rp 9 @ 11% exclusive: 0.99 → 1
    expect(computeLineTaxIdr(9, 11, false)).toBe(1);
    // Rp 4 @ 11% exclusive: 0.44 → 0
    expect(computeLineTaxIdr(4, 11, false)).toBe(0);
  });

  it("ignores negative rates / amounts (returns 0)", () => {
    expect(computeLineTaxIdr(-100, 11, true)).toBe(0);
    expect(computeLineTaxIdr(11_000, -5, true)).toBe(0);
  });
});

const MERCHANT = "11111111-1111-7111-8111-218000000001";
const OUTLET = "22222222-2222-7222-8222-218000000001";
const ITEM_KOPI = "44444444-4444-7444-8444-218000000001";
const UOM_PCS = "55555555-5555-7555-8555-218000000001";
const CLERK = "clerk-218";

function kopiPayload(localSaleId: string) {
  // Acceptance fixture: a single Rp 11,000 inclusive-PPN cup of coffee.
  return {
    localSaleId,
    outletId: OUTLET,
    clerkId: CLERK,
    businessDate: "2026-05-06",
    createdAt: "2026-05-06T03:00:00.000Z",
    subtotalIdr: 11_000,
    discountIdr: 0,
    totalIdr: 11_000,
    items: [
      {
        itemId: ITEM_KOPI,
        bomId: null,
        quantity: 1,
        uomId: UOM_PCS,
        unitPriceIdr: 11_000,
        lineTotalIdr: 11_000,
      },
    ],
    tenders: [{ method: "cash" as const, amountIdr: 11_000, reference: null }],
  };
}

interface Fixture {
  app: FastifyInstance;
  salesRepository: InMemorySalesRepository;
  eodService: EodService;
}

async function buildFixture(taxInclusive = true): Promise<Fixture> {
  const salesRepository = new InMemorySalesRepository();
  const items: Item[] = [
    {
      id: ITEM_KOPI,
      merchantId: MERCHANT,
      code: "KP-218",
      name: "Kopi PPN",
      priceIdr: 11_000,
      uomId: UOM_PCS,
      bomId: null,
      // Non-stock-tracked finished good — keeps the fixture tax-focused (no
      // BOM explosion or stock seeding required).
      isStockTracked: false,
      allowNegative: false,
      taxRate: 11,
      isActive: true,
    },
  ];
  const outlets: Outlet[] = [
    {
      id: OUTLET,
      merchantId: MERCHANT,
      code: "JKT-218",
      name: "Jakarta PPN",
      timezone: "Asia/Jakarta",
    },
  ];
  const merchants: Merchant[] = [{ id: MERCHANT, taxInclusive }];
  salesRepository.seedItems(items);
  salesRepository.seedOutlets(outlets);
  salesRepository.seedMerchants(merchants);

  let salesId = 0;
  const salesIdGen = () => {
    salesId += 1;
    return `01890218-1234-7def-8000-${salesId.toString(16).padStart(12, "0")}`;
  };
  const salesService = new SalesService({
    repository: salesRepository,
    generateId: salesIdGen,
    now: () => new Date("2026-05-06T03:00:01.000Z"),
    generateSaleName: (sale) =>
      `SALE-${sale.businessDate.replaceAll("-", "")}-${sale.id.slice(-4)}`,
  });

  const eodRepository = new InMemoryEodRepository();
  const salesReader = new SalesRepositorySalesReader(salesRepository);
  let eodId = 0;
  const eodService = new EodService({
    salesReader,
    eodRepository,
    now: () => new Date("2026-05-06T15:00:00.000Z"),
    generateEodId: () => {
      eodId += 1;
      return `01890218-1234-7def-8000-eee0000000${eodId.toString(16).padStart(2, "0")}`;
    },
  });

  const app = await buildApp({
    sales: { service: salesService, repository: salesRepository },
    eod: { service: eodService, resolveMerchantId: () => MERCHANT },
  });
  await app.ready();
  return { app, salesRepository, eodService };
}

describe("POST /v1/sales/submit — KASA-218 PPN integration", () => {
  it("records taxIdr=1090 for an inclusive Rp 11,000 sale at 11%", async () => {
    const fixture = await buildFixture(true);
    const res = await fixture.app.inject({
      method: "POST",
      url: "/v1/sales/submit",
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: kopiPayload("01929218-1e01-7f00-80aa-000000000001"),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { taxIdr: number; saleId: string };
    expect(body.taxIdr).toBe(1090);
    await fixture.app.close();
  });

  it("EOD breakdown sums sale taxIdr into the new `taxIdr` field", async () => {
    const fixture = await buildFixture(true);
    // Two cups → 2 × 1090 = 2180.
    for (let i = 1; i <= 2; i += 1) {
      const res = await fixture.app.inject({
        method: "POST",
        url: "/v1/sales/submit",
        headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
        payload: kopiPayload(`01929218-1e02-7f00-80aa-00000000000${i}`),
      });
      expect(res.statusCode).toBe(201);
    }

    const close = await fixture.eodService.close({
      merchantId: MERCHANT,
      outletId: OUTLET,
      businessDate: "2026-05-06",
      countedCashIdr: 22_000,
      varianceReason: null,
      clientSaleIds: [
        "01929218-1e02-7f00-80aa-000000000001",
        "01929218-1e02-7f00-80aa-000000000002",
      ],
    });
    expect(close.breakdown.taxIdr).toBe(2_180);
    expect(close.breakdown.netIdr).toBe(22_000);
    await fixture.app.close();
  });
});

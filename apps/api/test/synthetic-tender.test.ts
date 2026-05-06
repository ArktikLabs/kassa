import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import {
  EodService,
  InMemoryEodRepository,
  SalesRepositoryEodSyntheticReconciler,
  SalesRepositorySalesReader,
} from "../src/services/eod/index.js";
import {
  InMemorySalesRepository,
  SalesService,
  type Item,
  type Outlet,
} from "../src/services/sales/index.js";

/*
 * KASA-151 — `synthetic` tender method.
 *
 * The KASA-71 production probe POSTs a 1 IDR sale every 15 min. Three
 * invariants land here:
 *  1. Submit accepts `synthetic`, persists `sale.synthetic = true`, and
 *     writes the regular per-item ledger so the path is end-to-end
 *     identical to a real sale.
 *  2. EOD close excludes synthetic rows from the merchant breakdown /
 *     expected-cash / variance and writes balancing
 *     `synthetic_eod_reconcile` ledger entries so per-item stock nets to
 *     zero.
 *  3. Replays of the same `localSaleId` are idempotent — second submit is
 *     409 with the original envelope, no duplicate ledger writes.
 *  4. Merchant-facing read endpoints (`GET /v1/sales`, `GET /v1/sales/:id`)
 *     never surface synthetic rows even when querying the synthetic outlet.
 */

const MERCHANT = "11111111-1111-7111-8111-111111111151";
const OUTLET_SYNTH = "22222222-2222-7222-8222-222222222251";
const ITEM_PROBE = "44444444-4444-7444-8444-444444444451";
const UOM_PCS = "55555555-5555-7555-8555-555555555551";
const BUSINESS_DATE = "2026-04-28";
const CLOCK_NOW = new Date("2026-04-28T09:00:00.000Z");

interface Fixture {
  app: FastifyInstance;
  salesRepository: InMemorySalesRepository;
  eodService: EodService;
}

async function buildFixture(): Promise<Fixture> {
  const salesRepository = new InMemorySalesRepository();
  const items: Item[] = [
    {
      id: ITEM_PROBE,
      merchantId: MERCHANT,
      code: "SYNTH-1IDR",
      name: "Synthetic probe item",
      priceIdr: 1,
      uomId: UOM_PCS,
      bomId: null,
      isStockTracked: true,
      // Probe never tops up the synthetic outlet, so allow_negative keeps
      // the submit path unblocked even when on_hand goes negative.
      allowNegative: true,
      taxRate: 11,
      isActive: true,
    },
  ];
  const outlets: Outlet[] = [
    {
      id: OUTLET_SYNTH,
      merchantId: MERCHANT,
      code: "SYNTH-OUT",
      name: "Synthetic probe outlet",
      timezone: "Asia/Jakarta",
    },
  ];
  salesRepository.seedItems(items);
  salesRepository.seedOutlets(outlets);

  let salesIdCursor = 0;
  const salesIdGen = () => {
    salesIdCursor += 1;
    return `018f5151-0000-7000-8000-${salesIdCursor.toString(16).padStart(12, "0")}`;
  };
  const salesService = new SalesService({
    repository: salesRepository,
    generateId: salesIdGen,
    now: () => CLOCK_NOW,
    generateSaleName: (sale) =>
      `SALE-${sale.businessDate.replaceAll("-", "")}-${sale.id.slice(-4)}`,
  });

  let eodIdCursor = 0;
  const eodService = new EodService({
    salesReader: new SalesRepositorySalesReader(salesRepository),
    eodRepository: new InMemoryEodRepository(),
    syntheticReconciler: new SalesRepositoryEodSyntheticReconciler(salesRepository, () => {
      eodIdCursor += 1;
      return `018f5152-0000-7000-8000-${eodIdCursor.toString(16).padStart(12, "0")}`;
    }),
    now: () => CLOCK_NOW,
    generateEodId: () => "018f5153-0000-7000-8000-000000000001",
  });

  const app = await buildApp({
    sales: { service: salesService, repository: salesRepository },
    eod: { service: eodService, resolveMerchantId: () => MERCHANT },
  });
  await app.ready();
  return { app, salesRepository, eodService };
}

function syntheticPayload(localSaleId: string) {
  return {
    localSaleId,
    outletId: OUTLET_SYNTH,
    clerkId: "synthetic-probe",
    businessDate: BUSINESS_DATE,
    createdAt: "2026-04-28T08:30:00.000Z",
    subtotalIdr: 1,
    discountIdr: 0,
    totalIdr: 1,
    items: [
      {
        itemId: ITEM_PROBE,
        bomId: null,
        quantity: 1,
        uomId: UOM_PCS,
        unitPriceIdr: 1,
        lineTotalIdr: 1,
      },
    ],
    tenders: [{ method: "synthetic" as const, amountIdr: 1, reference: "kasa-71-probe" }],
  };
}

describe("KASA-151 synthetic tender", () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await buildFixture();
  });
  afterEach(async () => {
    await f.app.close();
  });

  // 1. Submit acceptance — synthetic sale persists with the flag and writes
  //    the regular ledger.

  it("accepts a synthetic submit, persists synthetic=true, and writes a ledger row", async () => {
    const localSaleId = "01929b51-0000-7000-8000-000000000001";
    const res = await f.app.inject({
      method: "POST",
      url: "/v1/sales/submit",
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: syntheticPayload(localSaleId),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { saleId: string; ledger: { delta: number; reason: string }[] };

    const stored = f.salesRepository._peekSales();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.synthetic).toBe(true);
    // Ledger explosion mirrors a normal sale — same reason, same shape.
    expect(body.ledger).toHaveLength(1);
    expect(body.ledger[0]).toMatchObject({ delta: -1, reason: "sale" });
  });

  it("rejects a payload that mixes synthetic with a real tender", async () => {
    const localSaleId = "01929b51-0000-7000-8000-000000000002";
    const payload = syntheticPayload(localSaleId);
    const mixed = {
      ...payload,
      // Break the integer-rupiah arithmetic invariant minimally so we don't
      // also trip pricing validation: split the 1 IDR across two tenders.
      totalIdr: 2,
      subtotalIdr: 2,
      items: [
        {
          ...payload.items[0]!,
          quantity: 2,
          lineTotalIdr: 2,
        },
      ],
      tenders: [
        { method: "synthetic" as const, amountIdr: 1, reference: "probe" },
        { method: "cash" as const, amountIdr: 1, reference: null },
      ],
    };
    const res = await f.app.inject({
      method: "POST",
      url: "/v1/sales/submit",
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: mixed,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: "synthetic_tender_mixed" } });
    expect(f.salesRepository._peekSales()).toHaveLength(0);
  });

  // 2. EOD reconciliation — synthetic rows are excluded from the breakdown
  //    and balanced via `synthetic_eod_reconcile` ledger entries.

  it("EOD close excludes synthetic from totals and writes balancing ledger entries", async () => {
    const synthA = "01929b51-0000-7000-8000-000000000010";
    const synthB = "01929b51-0000-7000-8000-000000000011";
    for (const localSaleId of [synthA, synthB]) {
      const submit = await f.app.inject({
        method: "POST",
        url: "/v1/sales/submit",
        headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
        payload: syntheticPayload(localSaleId),
      });
      expect(submit.statusCode).toBe(201);
    }

    // Two synthetic sales × 1 IDR = -2 on_hand for the probe item before close.
    expect(await f.salesRepository.onHandFor(OUTLET_SYNTH, ITEM_PROBE)).toBe(-2);

    const close = await f.app.inject({
      method: "POST",
      url: "/v1/eod/close",
      headers: { "content-type": "application/json" },
      payload: {
        outletId: OUTLET_SYNTH,
        businessDate: BUSINESS_DATE,
        countedCashIdr: 0,
        varianceReason: null,
        // The probe is not the merchant POS: it never adds its synthetic
        // localSaleIds to clientSaleIds. EOD must still reconcile them.
        clientSaleIds: [],
      },
    });
    expect(close.statusCode).toBe(201);
    const body = close.json() as {
      expectedCashIdr: number;
      varianceIdr: number;
      breakdown: { saleCount: number; cashIdr: number; netIdr: number };
    };
    // Synthetic excluded — merchant view says zero sales, zero cash, zero variance.
    expect(body.breakdown.saleCount).toBe(0);
    expect(body.breakdown.cashIdr).toBe(0);
    expect(body.breakdown.netIdr).toBe(0);
    expect(body.expectedCashIdr).toBe(0);
    expect(body.varianceIdr).toBe(0);

    // Balancing ledger: each synthetic sale gets +1 reconcile entry that
    // mirrors its -1 sale entry, netting per-item stock to zero.
    expect(await f.salesRepository.onHandFor(OUTLET_SYNTH, ITEM_PROBE)).toBe(0);
    const reconcileRows = f.salesRepository
      ._peekLedger()
      .filter((row) => row.reason === "synthetic_eod_reconcile");
    expect(reconcileRows).toHaveLength(2);
    for (const row of reconcileRows) {
      expect(row.delta).toBe(1);
      expect(row.refType).toBe("sale");
      expect(row.itemId).toBe(ITEM_PROBE);
      expect(row.outletId).toBe(OUTLET_SYNTH);
      expect(row.occurredAt).toBe(CLOCK_NOW.toISOString());
    }
  });

  // 3. Idempotency — replaying the same localSaleId is 409 with the original
  //    envelope and no duplicate ledger writes (matches non-synthetic
  //    behaviour from KASA-66).

  it("idempotent replay: a second synthetic submit returns 409 with the same saleId", async () => {
    const localSaleId = "01929b51-0000-7000-8000-000000000020";
    const payload = syntheticPayload(localSaleId);
    const first = await f.app.inject({
      method: "POST",
      url: "/v1/sales/submit",
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload,
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json() as { saleId: string; name: string };

    const second = await f.app.inject({
      method: "POST",
      url: "/v1/sales/submit",
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload,
    });
    expect(second.statusCode).toBe(409);
    const secondBody = second.json() as { saleId: string; name: string; ledger: unknown[] };
    expect(secondBody.saleId).toBe(firstBody.saleId);
    expect(secondBody.name).toBe(firstBody.name);
    expect(secondBody.ledger).toEqual([]);
    // No second ledger write.
    const saleRows = f.salesRepository._peekLedger().filter((row) => row.reason === "sale");
    expect(saleRows).toHaveLength(1);
  });

  // 4. Merchant-facing reads never surface synthetic rows.

  it("GET /v1/sales hides synthetic rows from the merchant view", async () => {
    const localSaleId = "01929b51-0000-7000-8000-000000000030";
    await f.app.inject({
      method: "POST",
      url: "/v1/sales/submit",
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: syntheticPayload(localSaleId),
    });
    const list = await f.app.inject({
      method: "GET",
      url: `/v1/sales/?outletId=${OUTLET_SYNTH}&businessDate=${BUSINESS_DATE}`,
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { records: unknown[] };
    expect(body.records).toEqual([]);
  });

  it("GET /v1/sales/:saleId 404s when the sale is synthetic", async () => {
    const localSaleId = "01929b51-0000-7000-8000-000000000031";
    const submit = await f.app.inject({
      method: "POST",
      url: "/v1/sales/submit",
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: syntheticPayload(localSaleId),
    });
    const submitBody = submit.json() as { saleId: string };
    const get = await f.app.inject({
      method: "GET",
      url: `/v1/sales/${submitBody.saleId}`,
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    expect(get.statusCode).toBe(404);
  });

  // Reconciler is idempotent on retry: a second close attempt should never
  // double-write balancing entries even though the EodRepository's lock is
  // what normally prevents it.

  it("reconciler is idempotent — calling reconcileSyntheticSales twice writes one set", async () => {
    const localSaleId = "01929b51-0000-7000-8000-000000000040";
    await f.app.inject({
      method: "POST",
      url: "/v1/sales/submit",
      headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
      payload: syntheticPayload(localSaleId),
    });
    const sale = f.salesRepository._peekSales()[0]!;
    const reconciler = new SalesRepositoryEodSyntheticReconciler(f.salesRepository, () => "x");
    await reconciler.reconcileSyntheticSales({
      saleIds: [sale.id],
      occurredAt: "2026-04-28T09:00:00.000Z",
    });
    await reconciler.reconcileSyntheticSales({
      saleIds: [sale.id],
      occurredAt: "2026-04-28T09:00:00.000Z",
    });
    const reconcileRows = f.salesRepository
      ._peekLedger()
      .filter((row) => row.reason === "synthetic_eod_reconcile");
    expect(reconcileRows).toHaveLength(1);
  });
});

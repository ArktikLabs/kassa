import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  InMemoryEodRepository,
  EodService,
  SalesRepositoryEodSyntheticReconciler,
  SalesRepositorySalesReader,
} from "../src/services/eod/index.js";
import {
  InMemorySalesRepository,
  SalesService,
  type Bom,
  type Item,
  type Outlet,
} from "../src/services/sales/index.js";

/*
 * KASA-284 — assert the manual `sale.submit` and `eod.close` spans (and the
 * named sub-spans called out in the issue) are recorded with the documented
 * attributes. We register an `InMemorySpanExporter` as the global tracer
 * provider before exercising the routes; in production
 * `OTEL_EXPORTER_OTLP_ENDPOINT` boots a real OTLP exporter instead, but the
 * span semantics are identical — `withSpan` reads `trace.getTracer(...)`
 * lazily so whichever provider is globally registered wins.
 */

const MERCHANT = "11111111-1111-7111-8111-111111111111";
const OUTLET = "22222222-2222-7222-8222-222222222222";
const UOM_PCS = "55555555-5555-7555-8555-555555555502";
const UOM_GR = "55555555-5555-7555-8555-555555555501";
const ITEM_COFFEE = "44444444-4444-7444-8444-444444444401";
const ITEM_BEANS = "44444444-4444-7444-8444-444444444402";
const BOM_COFFEE = "66666666-6666-7666-8666-666666666601";

const SPAN_PROCESSOR_FLUSH = 0;

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeAll(() => {
  // `AsyncLocalStorageContextManager` makes `startActiveSpan` propagate the
  // active span through async/await chains — without it, sub-spans created
  // inside `withSpan` would have no parent and the parent-child assertions
  // below would fail. In production `NodeSDK` installs this manager
  // automatically when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);

  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
});

beforeEach(() => {
  exporter.reset();
});

async function buildSalesFixture(): Promise<FastifyInstance> {
  const repository = new InMemorySalesRepository();
  const items: Item[] = [
    {
      id: ITEM_COFFEE,
      merchantId: MERCHANT,
      code: "KP-001",
      name: "Kopi Susu",
      priceIdr: 25_000,
      uomId: UOM_PCS,
      bomId: BOM_COFFEE,
      isStockTracked: false,
      allowNegative: false,
      taxRate: 11,
      isActive: true,
    },
    {
      id: ITEM_BEANS,
      merchantId: MERCHANT,
      code: "BN-001",
      name: "Biji Kopi",
      priceIdr: 0,
      uomId: UOM_GR,
      bomId: null,
      isStockTracked: true,
      allowNegative: false,
      taxRate: 11,
      isActive: true,
    },
  ];
  const boms: Bom[] = [
    {
      id: BOM_COFFEE,
      itemId: ITEM_COFFEE,
      version: "1",
      components: [{ componentItemId: ITEM_BEANS, quantity: 15, uomId: UOM_GR }],
    },
  ];
  const outlets: Outlet[] = [
    {
      id: OUTLET,
      merchantId: MERCHANT,
      code: "JKT-01",
      name: "Jakarta Pusat",
      timezone: "Asia/Jakarta",
    },
  ];
  repository.seedItems(items);
  repository.seedBoms(boms);
  repository.seedOutlets(outlets);
  let cursor = 0;
  const idGen = () => {
    cursor += 1;
    const hex = cursor.toString(16).padStart(12, "0");
    return `018f0000-0000-7000-8000-${hex}`;
  };
  repository.seedLedger(
    [
      {
        outletId: OUTLET,
        itemId: ITEM_BEANS,
        delta: 500,
        reason: "adjustment",
        refType: null,
        refId: null,
        occurredAt: "2026-04-23T00:00:00.000Z",
      },
    ],
    idGen,
  );

  let serviceCursor = 0;
  const serviceIdGen = () => {
    serviceCursor += 1;
    const hex = (serviceCursor + 0x1000).toString(16).padStart(12, "0");
    return `018f1111-1111-7111-8111-${hex}`;
  };
  const service = new SalesService({
    repository,
    generateId: serviceIdGen,
    now: () => new Date("2026-04-24T08:30:01.000Z"),
  });
  const app = await buildApp({ sales: { service, repository } });
  await app.ready();
  return app;
}

async function flushSpans(): Promise<ReadableSpan[]> {
  // SimpleSpanProcessor exports synchronously, but force-flushing is the
  // contract the exporter advertises so callers can rely on the snapshot
  // being complete.
  await provider.forceFlush();
  if (SPAN_PROCESSOR_FLUSH > 0) {
    await new Promise((resolve) => setTimeout(resolve, SPAN_PROCESSOR_FLUSH));
  }
  return exporter.getFinishedSpans();
}

describe("OTEL spans on the sale submit path", () => {
  it("records a `sale.submit` span with documented attributes plus the four sub-spans", async () => {
    const app = await buildSalesFixture();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/sales/submit",
        headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
        payload: {
          localSaleId: "01929b2d-1e02-7f00-80aa-000000000002",
          outletId: OUTLET,
          clerkId: "clerk-1",
          businessDate: "2026-04-24",
          createdAt: "2026-04-24T08:30:00+07:00",
          subtotalIdr: 25_000,
          discountIdr: 0,
          totalIdr: 25_000,
          items: [
            {
              itemId: ITEM_COFFEE,
              bomId: BOM_COFFEE,
              quantity: 1,
              uomId: UOM_PCS,
              unitPriceIdr: 25_000,
              lineTotalIdr: 25_000,
            },
          ],
          tenders: [{ method: "cash", amountIdr: 25_000, reference: null }],
        },
      });
      expect(res.statusCode).toBe(201);

      const spans = await flushSpans();
      const spanByName = (name: string) => spans.find((s) => s.name === name);

      const root = spanByName("sale.submit");
      expect(root, "expected a sale.submit span").toBeDefined();
      expect(root?.attributes.outlet_id).toBe(OUTLET);
      expect(root?.attributes.tender_count).toBe(1);
      expect(root?.attributes.idempotent_hit).toBe(false);
      expect(typeof root?.attributes.sale_id).toBe("string");

      expect(spanByName("sale.submit.idempotency")).toBeDefined();
      expect(spanByName("sale.submit.idempotency")?.attributes.hit).toBe(false);
      expect(spanByName("sale.submit.validation")).toBeDefined();
      expect(spanByName("sale.submit.validation")?.attributes.item_count).toBe(1);
      expect(spanByName("sale.submit.bom_explosion")).toBeDefined();
      expect(spanByName("sale.submit.bom_explosion")?.attributes.bom_count).toBe(1);
      expect(spanByName("sale.submit.bom_explosion")?.attributes.component_count).toBe(1);
      expect(spanByName("sale.submit.ledger_write")).toBeDefined();
      expect(spanByName("sale.submit.ledger_write")?.attributes.ledger_entry_count).toBe(1);

      // Sub-spans are children of `sale.submit` — they share its traceId
      // and point at it as the parent.
      const rootSpanId = root?.spanContext().spanId;
      for (const child of [
        "sale.submit.idempotency",
        "sale.submit.validation",
        "sale.submit.bom_explosion",
        "sale.submit.ledger_write",
      ] as const) {
        const span = spanByName(child);
        expect(span?.parentSpanContext?.spanId, `${child} should be a child of sale.submit`).toBe(
          rootSpanId,
        );
      }
    } finally {
      await app.close();
    }
  });

  it("flags an idempotent replay with idempotent_hit=true", async () => {
    const app = await buildSalesFixture();
    try {
      const payload = {
        localSaleId: "01929b2d-1e02-7f00-80aa-000000000777",
        outletId: OUTLET,
        clerkId: "clerk-1",
        businessDate: "2026-04-24",
        createdAt: "2026-04-24T08:30:00+07:00",
        subtotalIdr: 25_000,
        discountIdr: 0,
        totalIdr: 25_000,
        items: [
          {
            itemId: ITEM_COFFEE,
            bomId: BOM_COFFEE,
            quantity: 1,
            uomId: UOM_PCS,
            unitPriceIdr: 25_000,
            lineTotalIdr: 25_000,
          },
        ],
        tenders: [{ method: "cash" as const, amountIdr: 25_000, reference: null }],
      };
      const first = await app.inject({
        method: "POST",
        url: "/v1/sales/submit",
        headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
        payload,
      });
      expect(first.statusCode).toBe(201);
      exporter.reset();
      const replay = await app.inject({
        method: "POST",
        url: "/v1/sales/submit",
        headers: { "x-kassa-merchant-id": MERCHANT, "content-type": "application/json" },
        payload,
      });
      expect(replay.statusCode).toBe(409);

      const spans = await flushSpans();
      const root = spans.find((s) => s.name === "sale.submit");
      expect(root).toBeDefined();
      expect(root?.attributes.idempotent_hit).toBe(true);
      expect(typeof root?.attributes.sale_id).toBe("string");
    } finally {
      await app.close();
    }
  });
});

describe("OTEL spans on the EOD close path", () => {
  it("records an `eod.close` span with outlet_id, variance_idr, sales_count", async () => {
    const repository = new InMemorySalesRepository();
    const eodRepo = new InMemoryEodRepository();
    const salesReader = new SalesRepositorySalesReader(repository);
    const syntheticReconciler = new SalesRepositoryEodSyntheticReconciler(repository);
    repository.seedOutlets([
      {
        id: OUTLET,
        merchantId: MERCHANT,
        code: "JKT-01",
        name: "Jakarta Pusat",
        timezone: "Asia/Jakarta",
      },
    ]);
    const eodService = new EodService({
      salesReader,
      eodRepository: eodRepo,
      syntheticReconciler,
      now: () => new Date("2026-04-24T18:00:00.000Z"),
      generateEodId: () => "018f2222-2222-7222-8222-222222220001",
    });

    const record = await eodService.close({
      merchantId: MERCHANT,
      outletId: OUTLET,
      businessDate: "2026-04-24",
      countedCashIdr: 0,
      varianceReason: null,
      clientSaleIds: [],
    });
    expect(record.varianceIdr).toBe(0);

    const spans = await flushSpans();
    const span = spans.find((s) => s.name === "eod.close");
    expect(span, "expected an eod.close span").toBeDefined();
    expect(span?.attributes.outlet_id).toBe(OUTLET);
    expect(span?.attributes.business_date).toBe("2026-04-24");
    expect(span?.attributes.variance_idr).toBe(0);
    expect(span?.attributes.sales_count).toBe(0);
  });
});

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { InMemorySalesRepository, type Sale, SalesService } from "../src/services/sales/index.js";

/*
 * KASA-266 — cursor-paging contract for `GET /v1/sales?outletId=&businessDate=`.
 *
 * Two layers:
 *
 *   1. A direct in-memory repository test that walks a >100-sale bucket in
 *      small pages. The acceptance criterion explicitly calls out >100 sales,
 *      and standing 100+ HTTP submits up per run is wasteful, so this layer
 *      hits the repository's paged port directly.
 *   2. A Fastify HTTP test that exercises the wire shape end-to-end: limit
 *      query coercion, pageToken round-trip, deterministic ordering, and the
 *      `nextPageToken: null` terminator.
 */

const MERCHANT = "11111111-1111-7111-8111-111111111111";
const OUTLET_A = "22222222-2222-7222-8222-222222222222";
const OUTLET_B = "22222222-2222-7222-8222-222222222223";
const UOM_PCS = "55555555-5555-7555-8555-555555555502";
const ITEM_COFFEE = "44444444-4444-7444-8444-444444444401";
const BUSINESS_DATE = "2026-04-24";

function uuidV7(suffix: number, group = 0xa): string {
  // Synthetic UUIDv7-shaped strings for seeding. The regex in
  // `uuidV7Typed` checks `[0-9a-f]{8}-[0-9a-f]{4}-7…-[89ab]…-[0-9a-f]{12}`,
  // so the group nibble has to render as a single hex char (not "10" the
  // way String(0xa) would interpolate).
  const groupHex = group.toString(16);
  const hex = (suffix + 0x100000000).toString(16).padStart(12, "0").slice(-12);
  return `018f${groupHex}001-0000-7000-8000-${hex}`;
}

function buildSale(input: {
  id: string;
  localSaleId: string;
  outletId?: string;
  businessDate?: string;
  createdAt: string;
  synthetic?: boolean;
}): Sale {
  return {
    id: input.id,
    merchantId: MERCHANT,
    outletId: input.outletId ?? OUTLET_A,
    clerkId: "01890abc-0000-7000-8000-cccccccccccc",
    localSaleId: input.localSaleId,
    name: `SALE-${input.id.slice(-4)}`,
    businessDate: input.businessDate ?? BUSINESS_DATE,
    subtotalIdr: 25_000,
    discountIdr: 0,
    totalIdr: 25_000,
    taxIdr: 0,
    items: [
      {
        itemId: ITEM_COFFEE,
        bomId: null,
        quantity: 1,
        uomId: UOM_PCS,
        unitPriceIdr: 25_000,
        lineTotalIdr: 25_000,
      },
    ],
    tenders: [{ method: "cash", amountIdr: 25_000, reference: null }],
    createdAt: input.createdAt,
    voidedAt: null,
    voidBusinessDate: null,
    voidReason: null,
    localVoidId: null,
    voidedByStaffId: null,
    refunds: [],
    synthetic: input.synthetic ?? false,
  };
}

describe("InMemorySalesRepository.listSalesByBusinessDatePage", () => {
  it("walks >100 sales in fixed pages with no duplicates and no skipped rows", async () => {
    const repository = new InMemorySalesRepository();
    repository.seedOutlets([
      {
        id: OUTLET_A,
        merchantId: MERCHANT,
        code: "JKT-01",
        name: "Jakarta Pusat",
        timezone: "Asia/Jakarta",
      },
    ]);
    const TOTAL = 137;
    const sales: Sale[] = [];
    for (let i = 0; i < TOTAL; i += 1) {
      // Cluster timestamps so the (createdAt, id) tie-breaker is exercised:
      // every batch of 5 sales shares the same `createdAt`. Without the
      // tie-breaker in the cursor the walk would skip or duplicate rows
      // across batch boundaries.
      const hour = 8 + Math.floor(i / 30);
      const minute = (i % 30) * 2;
      const second = Math.floor(i / 5) % 60;
      const createdAt = `2026-04-24T${String(hour).padStart(2, "0")}:${String(minute).padStart(
        2,
        "0",
      )}:${String(second).padStart(2, "0")}+07:00`;
      sales.push(
        buildSale({
          id: uuidV7(i + 1),
          localSaleId: uuidV7(i + 1, 0xb),
          createdAt,
        }),
      );
    }
    repository.seedSales(sales);
    // A synthetic probe row inside the same bucket — must NEVER appear in
    // the paginated stream (merchant-facing list excludes synthetic rows).
    repository.seedSales([
      buildSale({
        id: uuidV7(9999),
        localSaleId: uuidV7(9999, 0xc),
        createdAt: "2026-04-24T12:00:00+07:00",
        synthetic: true,
      }),
    ]);
    // A sibling-outlet row + a different-day row — both must stay out of
    // the paged stream regardless of cursor state.
    repository.seedSales([
      buildSale({
        id: uuidV7(8888),
        localSaleId: uuidV7(8888, 0xd),
        outletId: OUTLET_B,
        createdAt: "2026-04-24T12:00:00+07:00",
      }),
      buildSale({
        id: uuidV7(7777),
        localSaleId: uuidV7(7777, 0xe),
        businessDate: "2026-04-23",
        createdAt: "2026-04-23T12:00:00+07:00",
      }),
    ]);

    const LIMIT = 10;
    const seen: string[] = [];
    let pageToken: string | null = null;
    let pages = 0;
    while (true) {
      pages += 1;
      const page: {
        records: readonly Sale[];
        nextPageToken: string | null;
      } = await repository.listSalesByBusinessDatePage({
        merchantId: MERCHANT,
        outletId: OUTLET_A,
        businessDate: BUSINESS_DATE,
        pageToken,
        limit: LIMIT,
      });
      for (const sale of page.records) seen.push(sale.id);
      if (page.nextPageToken === null) break;
      pageToken = page.nextPageToken;
      if (pages > 100) throw new Error("cursor walk did not terminate");
    }

    expect(seen).toHaveLength(TOTAL);
    // Deduplicate via a Set — same length means no row appeared twice.
    expect(new Set(seen).size).toBe(TOTAL);
    // Order matches the canonical (createdAt ASC, id ASC).
    const expected = [...sales]
      .sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
        return a.id < b.id ? -1 : 1;
      })
      .map((s) => s.id);
    expect(seen).toEqual(expected);
    // ceil(137 / 10) = 14 pages.
    expect(pages).toBe(Math.ceil(TOTAL / LIMIT));
  });

  it("returns nextPageToken=null when the bucket is empty or fits in one page", async () => {
    const repository = new InMemorySalesRepository();
    repository.seedOutlets([
      {
        id: OUTLET_A,
        merchantId: MERCHANT,
        code: "JKT-01",
        name: "Jakarta Pusat",
        timezone: "Asia/Jakarta",
      },
    ]);
    const emptyPage = await repository.listSalesByBusinessDatePage({
      merchantId: MERCHANT,
      outletId: OUTLET_A,
      businessDate: BUSINESS_DATE,
      pageToken: null,
      limit: 50,
    });
    expect(emptyPage.records).toEqual([]);
    expect(emptyPage.nextPageToken).toBeNull();

    repository.seedSales([
      buildSale({
        id: uuidV7(1),
        localSaleId: uuidV7(1, 0xb),
        createdAt: "2026-04-24T08:00:00+07:00",
      }),
      buildSale({
        id: uuidV7(2),
        localSaleId: uuidV7(2, 0xb),
        createdAt: "2026-04-24T08:01:00+07:00",
      }),
    ]);
    const onePage = await repository.listSalesByBusinessDatePage({
      merchantId: MERCHANT,
      outletId: OUTLET_A,
      businessDate: BUSINESS_DATE,
      pageToken: null,
      limit: 50,
    });
    expect(onePage.records).toHaveLength(2);
    expect(onePage.nextPageToken).toBeNull();
  });
});

describe("GET /v1/sales?pageToken=&limit=", () => {
  let app: FastifyInstance;
  let repository: InMemorySalesRepository;

  const TOTAL = 12;
  const seedSaleIds: string[] = [];

  beforeEach(async () => {
    repository = new InMemorySalesRepository();
    repository.seedOutlets([
      {
        id: OUTLET_A,
        merchantId: MERCHANT,
        code: "JKT-01",
        name: "Jakarta Pusat",
        timezone: "Asia/Jakarta",
      },
    ]);
    seedSaleIds.length = 0;
    const sales: Sale[] = [];
    for (let i = 0; i < TOTAL; i += 1) {
      const id = uuidV7(i + 1);
      seedSaleIds.push(id);
      sales.push(
        buildSale({
          id,
          localSaleId: uuidV7(i + 1, 0xb),
          createdAt: `2026-04-24T08:${String(i).padStart(2, "0")}:00+07:00`,
        }),
      );
    }
    repository.seedSales(sales);
    const service = new SalesService({ repository });
    app = await buildApp({ sales: { service, repository } });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns the first `limit` records and a non-null nextPageToken when more remain", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/sales?outletId=${OUTLET_A}&businessDate=${BUSINESS_DATE}&limit=5`,
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { records: { saleId: string }[]; nextPageToken: string | null };
    expect(body.records).toHaveLength(5);
    expect(body.nextPageToken).toBeTruthy();
    expect(body.records.map((r) => r.saleId)).toEqual(seedSaleIds.slice(0, 5));
  });

  it("round-trips the cursor through several pages with no duplicates and no skips", async () => {
    const seen: string[] = [];
    let pageToken: string | null = null;
    let pages = 0;
    while (true) {
      pages += 1;
      const url = `/v1/sales?outletId=${OUTLET_A}&businessDate=${BUSINESS_DATE}&limit=5${
        pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""
      }`;
      const res = await app.inject({
        method: "GET",
        url,
        headers: { "x-kassa-merchant-id": MERCHANT },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { records: { saleId: string }[]; nextPageToken: string | null };
      for (const r of body.records) seen.push(r.saleId);
      if (body.nextPageToken === null) break;
      pageToken = body.nextPageToken;
      if (pages > 10) throw new Error("HTTP cursor walk did not terminate");
    }
    expect(seen).toEqual(seedSaleIds);
    expect(new Set(seen).size).toBe(TOTAL);
    expect(pages).toBe(Math.ceil(TOTAL / 5));
  });

  it("omitting pageToken/limit returns the historic single-page shape (additive)", async () => {
    // No limit ⇒ server uses SALE_LIST_PAGE_LIMIT_DEFAULT (50); 12 seeded
    // sales fit in one page so nextPageToken is null.
    const res = await app.inject({
      method: "GET",
      url: `/v1/sales?outletId=${OUTLET_A}&businessDate=${BUSINESS_DATE}`,
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { records: { saleId: string }[]; nextPageToken: string | null };
    expect(body.records).toHaveLength(TOTAL);
    expect(body.nextPageToken).toBeNull();
  });

  it("rejects a malformed pageToken with 400 invalid_page_token", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/sales?outletId=${OUTLET_A}&businessDate=${BUSINESS_DATE}&limit=5&pageToken=not-a-valid-token`,
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "invalid_page_token" } });
  });

  it("rejects pageToken without businessDate at the validation layer", async () => {
    // pageToken-without-businessDate is a malformed request (validation),
    // not a tampered cursor (400). The schema's refine catches it as 422.
    const res = await app.inject({
      method: "GET",
      url: `/v1/sales?outletId=${OUTLET_A}&receiptCode=ABCDEF&pageToken=anyvalue`,
      headers: { "x-kassa-merchant-id": MERCHANT },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: "validation_error" } });
  });
});

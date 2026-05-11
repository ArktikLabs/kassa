import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  EodService,
  InMemoryEodRepository,
  SalesRepositorySalesReader,
} from "../src/services/eod/index.js";
import { InMemoryOutletsRepository, OutletsService } from "../src/services/outlets/index.js";
import { InMemorySalesRepository, SalesService } from "../src/services/sales/index.js";
import { InMemoryShiftsRepository } from "../src/services/shifts/index.js";
import { InMemoryStaffRepository } from "../src/services/staff/index.js";

/*
 * Wire-level coverage for `GET /v1/eod/:eodId/export.csv` (KASA-250).
 *
 * The pure CSV builder is exercised in `eod-csv.test.ts`; here we pin
 * the route surface: RBAC, headers, BOM in the wire bytes, 404 + 503
 * branches. Body shape is asserted via a sentinel byte (BOM) + a known
 * column header so we do not duplicate the field-level assertions in
 * the builder unit suite.
 */

const STAFF_TOKEN = "test-staff-token-csv-export-1234567";
const MERCHANT = "01890abc-1234-7def-8000-00000000aaa2";
const OUTLET = "01890abc-1234-7def-8000-000000000010";
const STAFF_USER = "01890abc-1234-7def-8000-000000000050";
const CASHIER = "01890abc-1234-7def-8000-000000000060";
const CLOCK_NOW = new Date("2026-04-23T18:30:00+07:00");

interface Harness {
  app: FastifyInstance;
  eodId: string;
}

async function setup(opts: { seedShift?: boolean; seedStaff?: boolean } = {}): Promise<Harness> {
  const salesRepository = new InMemorySalesRepository();
  const salesService = new SalesService({ repository: salesRepository });

  const outletsRepository = new InMemoryOutletsRepository();
  outletsRepository.seedOutlet({
    id: OUTLET,
    merchantId: MERCHANT,
    code: "JKT-01",
    name: "Warung Pusat",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  });
  const outletsService = new OutletsService({ repository: outletsRepository });

  const shiftsRepository = new InMemoryShiftsRepository();
  if (opts.seedShift) {
    await shiftsRepository.insertOpen({
      id: "01890abc-1234-7def-8000-0000000eee10",
      merchantId: MERCHANT,
      outletId: OUTLET,
      cashierStaffId: CASHIER,
      businessDate: "2026-04-23",
      status: "closed",
      openShiftId: "01890abc-1234-7def-8000-0000000eee11",
      openedAt: "2026-04-23T07:00:00+07:00",
      // Zero float so the seed close stays zero-variance — the CSV
      // builder unit suite exercises non-zero variance independently.
      openingFloatIdr: 0,
      closeShiftId: "01890abc-1234-7def-8000-0000000eee12",
      closedAt: "2026-04-23T18:25:00+07:00",
      countedCashIdr: 0,
      expectedCashIdr: 0,
      varianceIdr: 0,
    });
  }

  const staffRepository = new InMemoryStaffRepository();
  if (opts.seedStaff) {
    staffRepository.seedStaff({
      id: CASHIER,
      merchantId: MERCHANT,
      email: "budi@kassa.id",
      passwordHash: "argon2id$placeholder",
      displayName: "Budi Santoso",
      role: "cashier",
      pinHash: null,
    });
  }

  const eodService = new EodService({
    salesReader: new SalesRepositorySalesReader(salesRepository),
    eodRepository: new InMemoryEodRepository(),
    shiftReader: shiftsRepository,
    now: () => CLOCK_NOW,
    generateEodId: () => "01890abc-1234-7def-8000-0000000eee01",
  });

  const app = await buildApp({
    sales: { service: salesService, repository: salesRepository },
    outlets: { service: outletsService },
    shifts: { service: undefined as never, repository: shiftsRepository } as never,
    eod: {
      service: eodService,
      resolveMerchantId: () => MERCHANT,
      staffBootstrapToken: STAFF_TOKEN,
    },
    staffSession: {
      repository: staffRepository,
      cookieSecret: "test-cookie-secret-csv-export-suite-must-be-32+",
    },
  });
  await app.ready();

  // Close one EOD to give us a known id to hit. Empty sales day so we
  // do not have to seed the catalog.
  const close = await app.inject({
    method: "POST",
    url: "/v1/eod/close",
    headers: { "content-type": "application/json", "x-kassa-merchant-id": MERCHANT },
    payload: {
      outletId: OUTLET,
      businessDate: "2026-04-23",
      countedCashIdr: 0,
      varianceReason: null,
      clientSaleIds: [],
    },
  });
  if (close.statusCode !== 201) throw new Error(`seed close failed: ${close.statusCode}`);
  const body = close.json() as { eodId: string };
  return { app, eodId: body.eodId };
}

function staffHeaders(
  role: "owner" | "manager" | "cashier" | "read_only" = "owner",
): Record<string, string> {
  return {
    authorization: `Bearer ${STAFF_TOKEN}`,
    "x-staff-user-id": STAFF_USER,
    "x-staff-merchant-id": MERCHANT,
    "x-staff-role": role,
  };
}

describe("GET /v1/eod/:eodId/export.csv (KASA-250)", () => {
  let h: Harness;
  afterEach(async () => {
    if (h?.app) await h.app.close();
  });

  it("returns text/csv with a UTF-8 BOM and the documented filename for an owner", async () => {
    h = await setup({ seedShift: true, seedStaff: true });
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/eod/${h.eodId}/export.csv`,
      headers: staffHeaders("owner"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/csv; charset=utf-8/);
    expect(res.headers["content-disposition"]).toContain(
      'filename="kassa-eod-jkt-01-2026-04-23.csv"',
    );
    expect(res.headers["content-disposition"]).toContain(
      "filename*=UTF-8''kassa-eod-jkt-01-2026-04-23.csv",
    );
    // BOM is the first three bytes of the response — Buffer.from(string)
    // re-encodes through utf-8 so we get the byte sequence Excel-id sees.
    const buf = Buffer.from(res.rawPayload);
    expect(buf[0]).toBe(0xef);
    expect(buf[1]).toBe(0xbb);
    expect(buf[2]).toBe(0xbf);
    // Header row follows the BOM verbatim.
    expect(res.payload.slice(1)).toMatch(
      /^outlet;eod_date;shift_open_at;shift_close_at;cashier;expected_cash;/,
    );
    // Cashier display name is resolved from the staff record, not the UUID.
    expect(res.payload).toContain("Budi Santoso");
  });

  it("falls back to the staff id when no staff reader is configured", async () => {
    h = await setup({ seedShift: true, seedStaff: false });
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/eod/${h.eodId}/export.csv`,
      headers: staffHeaders("manager"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain(CASHIER);
  });

  it("renders empty shift columns when no shift was opened for the day", async () => {
    h = await setup({ seedShift: false, seedStaff: false });
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/eod/${h.eodId}/export.csv`,
      headers: staffHeaders("owner"),
    });
    expect(res.statusCode).toBe(200);
    // Data row: outlet;date;<empty>;<eod closedAt>;<empty>;...
    const dataRow = res.payload.split("\r\n")[1] ?? "";
    const cells = dataRow.split(";");
    expect(cells[0]).toBe("Warung Pusat");
    expect(cells[1]).toBe("2026-04-23");
    expect(cells[2]).toBe(""); // shift_open_at
    expect(cells[3]).toBe(CLOCK_NOW.toISOString()); // falls back to EOD close
    expect(cells[4]).toBe(""); // cashier
  });

  it("rejects cashier role with 403 forbidden", async () => {
    h = await setup();
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/eod/${h.eodId}/export.csv`,
      headers: staffHeaders("cashier"),
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("rejects read_only role with 403 forbidden", async () => {
    h = await setup();
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/eod/${h.eodId}/export.csv`,
      headers: staffHeaders("read_only"),
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects missing bearer with 401 unauthorized", async () => {
    h = await setup();
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/eod/${h.eodId}/export.csv`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 404 eod_not_found when the id is unknown", async () => {
    h = await setup();
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/eod/01890abc-1234-7def-8000-0000000eee99/export.csv",
      headers: staffHeaders("owner"),
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe("eod_not_found");
  });

  it("returns 503 staff_bootstrap_disabled when the token is not configured", async () => {
    const salesRepository = new InMemorySalesRepository();
    const eodService = new EodService({
      salesReader: new SalesRepositorySalesReader(salesRepository),
      eodRepository: new InMemoryEodRepository(),
    });
    const outletsRepository = new InMemoryOutletsRepository();
    const outletsService = new OutletsService({ repository: outletsRepository });
    const app = await buildApp({
      sales: {
        service: new SalesService({ repository: salesRepository }),
        repository: salesRepository,
      },
      outlets: { service: outletsService },
      eod: { service: eodService, resolveMerchantId: () => MERCHANT },
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/v1/eod/01890abc-1234-7def-8000-0000000eee01/export.csv",
      });
      expect(res.statusCode).toBe(503);
      const body = res.json() as { error: { code: string } };
      expect(body.error.code).toBe("staff_bootstrap_disabled");
    } finally {
      await app.close();
    }
  });
});

/*
 * KASA-241 — in-memory API harness for the void spec.
 *
 * Separate from `harness/server.ts` (KASA-68) because the void spec needs the
 * manager-PIN and open-shift gates that KASA-68 explicitly keeps off. The
 * harness wires:
 *   - `managerPinReader` from a seeded `InMemoryStaffRepository`
 *   - `openShiftReader` from the same `InMemoryShiftsRepository` `buildApp`
 *     uses to back `/v1/shifts/open`
 * so a void with a non-manager staffId 403s, and a void against a sale whose
 * `businessDate` differs from the open shift's 422s `void_outside_open_shift`.
 *
 * Endpoints exposed under `/__test__`:
 *   POST /__test__/seed → issues a fresh enrolment code and returns the
 *                         seeded merchant / outlet / staff / PIN context.
 *
 * The harness is not a production binary and must not ship with the API.
 */

import argon2 from "argon2";
import {
  BomsService,
  InMemoryBomsRepository,
  InMemoryItemsRepository,
  InMemoryUomsRepository,
  ItemsService,
  UomsService,
} from "@kassa/api/services/catalog/index.js";
import {
  EnrolmentService,
  InMemoryEnrolmentRepository,
  decodeApiKey,
} from "@kassa/api/services/enrolment/index.js";
import { InMemoryOutletsRepository, OutletsService } from "@kassa/api/services/outlets/index.js";
import {
  EodService,
  InMemoryEodRepository,
  SalesRepositorySalesReader,
} from "@kassa/api/services/eod/index.js";
import {
  InMemorySalesRepository,
  SalesService,
  type Bom as SalesBom,
  type Item as SalesItem,
  type Outlet as SalesOutlet,
} from "@kassa/api/services/sales/index.js";
import { InMemoryShiftsRepository, ShiftsService } from "@kassa/api/services/shifts/index.js";
import { InMemoryStaffRepository } from "@kassa/api/services/staff/index.js";
import { buildApp } from "@kassa/api/app.js";
import "@kassa/api/auth/staff-bootstrap.js";
import {
  BOM_ID,
  COMPONENT_ITEM_ID,
  HARNESS_BASE_URL,
  HARNESS_PORT,
  ITEM_ID,
  MANAGER_PIN,
  MANAGER_STAFF_ID,
  MERCHANT_ID,
  OPENING_STOCK,
  OUTLET_ID,
  OUTLET_NAME,
  OUTLET_TIMEZONE,
  STAFF_BOOTSTRAP_TOKEN,
  CASHIER_STAFF_ID,
  STAFF_USER_ID,
  UOM_GR_ID,
  UOM_PCS_ID,
} from "./void-fixtures.js";

interface SharedRepos {
  enrolment: InMemoryEnrolmentRepository;
  outlets: InMemoryOutletsRepository;
  items: InMemoryItemsRepository;
  boms: InMemoryBomsRepository;
  uoms: InMemoryUomsRepository;
  sales: InMemorySalesRepository;
  shifts: InMemoryShiftsRepository;
  staff: InMemoryStaffRepository;
}

function buildRepos(): SharedRepos {
  return {
    enrolment: new InMemoryEnrolmentRepository(),
    outlets: new InMemoryOutletsRepository(),
    items: new InMemoryItemsRepository(),
    boms: new InMemoryBomsRepository(),
    uoms: new InMemoryUomsRepository(),
    sales: new InMemorySalesRepository(),
    shifts: new InMemoryShiftsRepository(),
    staff: new InMemoryStaffRepository(),
  };
}

async function seedFixtures(repos: SharedRepos): Promise<void> {
  const merchantName = "Toko Maju";
  const seedAt = new Date("2026-04-23T00:00:00.000Z");

  repos.enrolment.seedOutlet({
    outlet: { id: OUTLET_ID, name: OUTLET_NAME },
    merchant: { id: MERCHANT_ID, name: merchantName },
  });
  repos.outlets.seedOutlet({
    id: OUTLET_ID,
    merchantId: MERCHANT_ID,
    code: "MAIN",
    name: OUTLET_NAME,
    timezone: OUTLET_TIMEZONE,
    createdAt: seedAt,
    updatedAt: seedAt,
  });

  const salesOutlets: SalesOutlet[] = [
    {
      id: OUTLET_ID,
      merchantId: MERCHANT_ID,
      code: "MAIN",
      name: OUTLET_NAME,
      timezone: OUTLET_TIMEZONE,
    },
  ];
  repos.sales.seedOutlets(salesOutlets);

  for (const uom of [
    { id: UOM_PCS_ID, code: "pcs", name: "Pieces" },
    { id: UOM_GR_ID, code: "gr", name: "Gram" },
  ]) {
    repos.uoms.seedUom({
      id: uom.id,
      merchantId: MERCHANT_ID,
      code: uom.code,
      name: uom.name,
      createdAt: seedAt,
      updatedAt: seedAt,
    });
    repos.items.seedUom(MERCHANT_ID, uom.id);
  }

  repos.boms.seedBom({
    id: BOM_ID,
    merchantId: MERCHANT_ID,
    itemId: ITEM_ID,
    components: [{ componentItemId: COMPONENT_ITEM_ID, quantity: 15, uomId: UOM_GR_ID }],
    updatedAt: seedAt,
  });
  repos.items.seedBom(MERCHANT_ID, BOM_ID);
  const salesBoms: SalesBom[] = [
    {
      id: BOM_ID,
      itemId: ITEM_ID,
      version: "1",
      components: [{ componentItemId: COMPONENT_ITEM_ID, quantity: 15, uomId: UOM_GR_ID }],
    },
  ];
  repos.sales.seedBoms(salesBoms);

  // BOM-parent (sold) — non-tracked. Sale price Rp 50,000 so the spec
  // matches the issue body (Rp 50,000 cash sale).
  await repos.items.createItem({
    id: ITEM_ID,
    merchantId: MERCHANT_ID,
    code: "KP-001",
    name: "Kopi Susu",
    priceIdr: 50_000,
    uomId: UOM_PCS_ID,
    bomId: BOM_ID,
    isStockTracked: false,
    isActive: true,
    now: seedAt,
  });
  // Component (raw, tracked) — deducted via BOM explosion.
  await repos.items.createItem({
    id: COMPONENT_ITEM_ID,
    merchantId: MERCHANT_ID,
    code: "BJ-001",
    name: "Biji Kopi",
    priceIdr: 0,
    uomId: UOM_GR_ID,
    bomId: null,
    isStockTracked: true,
    isActive: true,
    now: seedAt,
  });

  const salesItems: SalesItem[] = [
    {
      id: ITEM_ID,
      merchantId: MERCHANT_ID,
      code: "KP-001",
      name: "Kopi Susu",
      priceIdr: 50_000,
      uomId: UOM_PCS_ID,
      bomId: BOM_ID,
      isStockTracked: false,
      allowNegative: false,
      taxRate: 11,
      isActive: true,
    },
    {
      id: COMPONENT_ITEM_ID,
      merchantId: MERCHANT_ID,
      code: "BJ-001",
      name: "Biji Kopi",
      priceIdr: 0,
      uomId: UOM_GR_ID,
      bomId: null,
      isStockTracked: true,
      allowNegative: true,
      taxRate: 11,
      isActive: true,
    },
  ];
  repos.sales.seedItems(salesItems);

  // Opening stock — one "receipt" ledger row for the raw component.
  let stockId = 0;
  const openingId = (): string => {
    stockId += 1;
    return `01900000-0000-7000-8000-${(0xb000 + stockId).toString(16).padStart(12, "0")}`;
  };
  repos.sales.seedLedger(
    OPENING_STOCK.map((s) => ({
      outletId: s.outletId,
      itemId: s.itemId,
      delta: s.onHand,
      reason: "receipt" as const,
      refType: null,
      refId: null,
      // Opening stamped at midnight UTC so every sale's `occurredAt` is
      // strictly newer.
      occurredAt: "2026-04-23T00:00:00.000Z",
    })),
    openingId,
  );

  // Manager + cashier staff. Argon2-hash the PIN once at boot so the void
  // route's `argon2.verify` resolves deterministically. The cashier seat
  // exists purely so the "cashier rejection" test has a non-manager
  // staffId to send. We never actually run a cashier session here — the
  // staff bootstrap shim authenticates as the manager.
  const pinHash = await argon2.hash(MANAGER_PIN, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });
  // Cashier PIN is the same string; gate must still reject because the
  // role is `cashier`, not owner/manager.
  const cashierPinHash = await argon2.hash(MANAGER_PIN, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });
  repos.staff.seedStaff({
    id: MANAGER_STAFF_ID,
    merchantId: MERCHANT_ID,
    email: "manajer@example.com",
    passwordHash: pinHash,
    displayName: "Bu Manajer",
    role: "manager",
    pinHash,
  });
  repos.staff.seedStaff({
    id: CASHIER_STAFF_ID,
    merchantId: MERCHANT_ID,
    email: "kasir@example.com",
    passwordHash: cashierPinHash,
    displayName: "Pak Kasir",
    role: "cashier",
    pinHash: cashierPinHash,
  });
}

async function buildHarness(): Promise<{ url: string; close: () => Promise<void> }> {
  const repos = buildRepos();
  const enrolmentService = new EnrolmentService({ repository: repos.enrolment });
  const itemsService = new ItemsService({ repository: repos.items });
  const bomsService = new BomsService({ repository: repos.boms });
  const uomsService = new UomsService({ repository: repos.uoms });
  const outletsService = new OutletsService({ repository: repos.outlets });

  await seedFixtures(repos);

  // Build the SalesService explicitly so we can wire both gates against
  // the in-memory repositories the rest of the harness shares. Without
  // these readers the void route is a no-op gate — exactly the posture
  // KASA-68's harness needs but the opposite of what this spec verifies.
  const managerPinReader = {
    async findStaffById(input: { merchantId: string; staffId: string }) {
      const row = await repos.staff.findById({
        merchantId: input.merchantId,
        staffId: input.staffId,
      });
      if (!row) return null;
      return {
        id: row.id,
        merchantId: row.merchantId,
        role: row.role,
        pinHash: row.pinHash,
      };
    },
  };
  const salesService = new SalesService({
    repository: repos.sales,
    openShiftReader: repos.shifts,
    managerPinReader,
  });
  const shiftsService = new ShiftsService({
    repository: repos.shifts,
    salesReader: new SalesRepositorySalesReader(repos.sales),
  });
  const eodService = new EodService({
    salesReader: new SalesRepositorySalesReader(repos.sales),
    eodRepository: new InMemoryEodRepository(),
  });

  const app = await buildApp({
    logger: false,
    enrolment: { service: enrolmentService },
    deviceAuth: { repository: repos.enrolment },
    catalog: {
      items: itemsService,
      boms: bomsService,
      uoms: uomsService,
      staffBootstrapToken: STAFF_BOOTSTRAP_TOKEN,
    },
    outlets: { service: outletsService, staffBootstrapToken: STAFF_BOOTSTRAP_TOKEN },
    sales: { service: salesService, repository: repos.sales },
    shifts: { service: shiftsService, repository: repos.shifts },
    eod: { service: eodService, resolveMerchantId: () => MERCHANT_ID },
  });

  // CORS shim. The POS preview ships from `127.0.0.1:4175` and POSTs to the
  // harness on a different port, so Chromium sends a CORS preflight.
  // Mirrors the shim in `harness/server.ts`.
  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("access-control-allow-origin", req.headers.origin ?? "*");
    reply.header(
      "access-control-allow-headers",
      "content-type,x-kassa-api-key,x-kassa-api-secret,x-kassa-local-sale-id",
    );
    reply.header("access-control-allow-methods", "GET,POST,OPTIONS");
    return payload;
  });
  app.options("/*", async (_req, reply) => reply.code(204).send());

  // Test-only header translation: turn POS sync headers into a device
  // principal + staff bootstrap session.
  app.addHook("onRequest", async (req) => {
    const apiKey = pickHeader(req.headers["x-kassa-api-key"]);
    if (!apiKey) return;
    const deviceId = decodeApiKey(apiKey);
    if (!deviceId) return;
    const device = await repos.enrolment.findDevice(deviceId);
    if (!device) return;
    req.devicePrincipal = {
      deviceId: device.id,
      merchantId: device.merchantId,
      outletId: device.outletId,
    };
    req.staffPrincipal = { userId: STAFF_USER_ID, merchantId: device.merchantId };
    req.headers["x-kassa-merchant-id"] = device.merchantId;
    req.headers["x-staff-merchant-id"] = device.merchantId;
    req.headers["x-staff-user-id"] = STAFF_USER_ID;
    req.headers.authorization = `Bearer ${STAFF_BOOTSTRAP_TOKEN}`;
  });

  // Admin endpoint: issues a fresh enrolment code on every call so each
  // test gets its own device + browser context without colliding on a
  // single shared code.
  app.post("/__test__/seed", async () => {
    const issued = await enrolmentService.issueCode({
      outletId: OUTLET_ID,
      createdByUserId: STAFF_USER_ID,
    });
    return {
      code: issued.code,
      outletId: OUTLET_ID,
      merchantId: MERCHANT_ID,
      itemId: ITEM_ID,
      componentItemId: COMPONENT_ITEM_ID,
      managerStaffId: MANAGER_STAFF_ID,
      cashierStaffId: CASHIER_STAFF_ID,
      managerPin: MANAGER_PIN,
    };
  });

  const url = await app.listen({ host: "127.0.0.1", port: HARNESS_PORT });
  return {
    url,
    close: async () => {
      await app.close();
    },
  };
}

function pickHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

async function main(): Promise<void> {
  const harness = await buildHarness();
  process.stdout.write(`[void-harness] listening at ${harness.url}\n`);
  void HARNESS_BASE_URL; // referenced for parity with the other harness.
  const stop = async () => {
    await harness.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

void main().catch((err) => {
  process.stderr.write(
    `[void-harness] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});

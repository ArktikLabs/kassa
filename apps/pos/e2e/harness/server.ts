/*
 * In-memory API harness for the KASA-68 full-day offline acceptance suite.
 *
 * Boots the production `buildApp` with shared in-memory repositories, seeds
 * the fixture once on startup, and listens on a fixed port (`HARNESS_PORT`)
 * so the Vite preview can hit it via `VITE_API_BASE_URL`.
 *
 * Auth in v0 is a moving target (KASA-25). Production routes look at three
 * signals — `req.devicePrincipal` (set by the Basic-auth `requireDevice`
 * preHandler), `req.staffPrincipal` (set by the staff bootstrap pre-handler),
 * and the `x-kassa-merchant-id` header fallback. The POS sync runner sends
 * `x-kassa-api-key`/`x-kassa-api-secret` (custom headers, not Basic), so the
 * `onRequest` hook below translates those headers into the principal shapes
 * the real routes require. The suite still exercises the real Fastify
 * route → service → repo path; only the auth gate is bypassed for the
 * test-only header style. KASA-25 is the right place to retire this shim.
 *
 * Endpoints exposed under `/__test__`:
 *   POST /__test__/codes → returns the two enrolment codes (one per device).
 *
 * The harness is not a production binary and must not ship with the API.
 */

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
import {
  EodService,
  InMemoryEodRepository,
  SalesRepositorySalesReader,
} from "@kassa/api/services/eod/index.js";
import { InMemoryOutletsRepository, OutletsService } from "@kassa/api/services/outlets/index.js";
import {
  InMemorySalesRepository,
  SalesService,
  type Bom as SalesBom,
  type Item as SalesItem,
  type Outlet as SalesOutlet,
} from "@kassa/api/services/sales/index.js";
import { buildApp } from "@kassa/api/app.js";
// Side-effect import: brings the `req.staffPrincipal` module augmentation
// (declared in apps/api/src/auth/staff-bootstrap.ts) into TS scope here.
import "@kassa/api/auth/staff-bootstrap.js";
import {
  BOMS,
  FIXTURE_BUSINESS_DATE,
  HARNESS_PORT,
  ITEMS,
  MERCHANT_ID,
  OPENING_STOCK,
  OUTLETS,
  STAFF_BOOTSTRAP_TOKEN,
  STAFF_USER_ID,
  UOMS,
} from "./fixtures.js";

interface SharedRepos {
  enrolment: InMemoryEnrolmentRepository;
  outlets: InMemoryOutletsRepository;
  items: InMemoryItemsRepository;
  boms: InMemoryBomsRepository;
  uoms: InMemoryUomsRepository;
  sales: InMemorySalesRepository;
  eod: InMemoryEodRepository;
}

function buildRepos(): SharedRepos {
  return {
    enrolment: new InMemoryEnrolmentRepository(),
    outlets: new InMemoryOutletsRepository(),
    items: new InMemoryItemsRepository(),
    boms: new InMemoryBomsRepository(),
    uoms: new InMemoryUomsRepository(),
    sales: new InMemorySalesRepository(),
    eod: new InMemoryEodRepository(),
  };
}

async function seedFixtures(
  repos: SharedRepos,
  enrolmentService: EnrolmentService,
): Promise<{ outletId: string; code: string }[]> {
  const merchantName = "Toko Maju";
  const seedAt = new Date(`${FIXTURE_BUSINESS_DATE}T00:00:00.000Z`);
  const updatedAt = seedAt;

  for (const outlet of OUTLETS) {
    repos.enrolment.seedOutlet({
      outlet: { id: outlet.id, name: outlet.name },
      merchant: { id: MERCHANT_ID, name: merchantName },
    });
    repos.outlets.seedOutlet({
      id: outlet.id,
      merchantId: MERCHANT_ID,
      code: outlet.code,
      name: outlet.name,
      timezone: outlet.timezone,
      createdAt: seedAt,
      updatedAt,
    });
  }

  const salesOutlets: SalesOutlet[] = OUTLETS.map((o) => ({
    id: o.id,
    merchantId: MERCHANT_ID,
    code: o.code,
    name: o.name,
    timezone: o.timezone,
  }));
  repos.sales.seedOutlets(salesOutlets);

  for (const uom of UOMS) {
    repos.uoms.seedUom({
      id: uom.id,
      merchantId: MERCHANT_ID,
      code: uom.code,
      name: uom.name,
      createdAt: seedAt,
      updatedAt,
    });
    repos.items.seedUom(MERCHANT_ID, uom.id);
  }

  for (const bom of BOMS) {
    repos.boms.seedBom({
      id: bom.id,
      merchantId: MERCHANT_ID,
      itemId: bom.itemId,
      components: bom.components.map((c) => ({ ...c })),
      updatedAt,
    });
    repos.items.seedBom(MERCHANT_ID, bom.id);
  }
  const salesBoms: SalesBom[] = BOMS.map((b) => ({
    id: b.id,
    itemId: b.itemId,
    version: "1",
    components: b.components.map((c) => ({ ...c })),
  }));
  repos.sales.seedBoms(salesBoms);

  for (const item of ITEMS) {
    await repos.items.createItem({
      id: item.id,
      merchantId: MERCHANT_ID,
      code: item.code,
      name: item.name,
      priceIdr: item.priceIdr,
      uomId: item.uomId,
      bomId: item.bomId,
      isStockTracked: item.isStockTracked,
      isActive: true,
      now: seedAt,
    });
  }

  const salesItems: SalesItem[] = ITEMS.map((i) => ({
    id: i.id,
    merchantId: MERCHANT_ID,
    code: i.code,
    name: i.name,
    priceIdr: i.priceIdr,
    uomId: i.uomId,
    bomId: i.bomId,
    isStockTracked: i.isStockTracked,
    // BOM-parent items are non-tracked; raw components are tracked but
    // allowNegative so a stock undercount never blocks the suite.
    allowNegative: i.isStockTracked,
    taxRate: 11,
    isActive: true,
  }));
  repos.sales.seedItems(salesItems);

  // Opening stock — a "receipt" ledger row per (outlet, raw item). Stamped at
  // midnight UTC so every sale's `occurredAt` is strictly newer than opening.
  let stockId = 0;
  const openingId = (): string => {
    stockId += 1;
    return `01900000-0000-7000-8000-${(0xa000 + stockId).toString(16).padStart(12, "0")}`;
  };
  repos.sales.seedLedger(
    OPENING_STOCK.map((s) => ({
      outletId: s.outletId,
      itemId: s.itemId,
      delta: s.onHand,
      reason: "receipt" as const,
      refType: null,
      refId: null,
      occurredAt: `${FIXTURE_BUSINESS_DATE}T00:00:00.000Z`,
    })),
    openingId,
  );

  // Two enrolment codes — one for outlet A's device, one for outlet B's.
  // Outlet C deliberately gets no code (proves per-outlet isolation in the
  // EOD/ledger assertions).
  const a = await enrolmentService.issueCode({
    outletId: OUTLETS[0]!.id,
    createdByUserId: STAFF_USER_ID,
  });
  const b = await enrolmentService.issueCode({
    outletId: OUTLETS[1]!.id,
    createdByUserId: STAFF_USER_ID,
  });
  return [
    { outletId: a.outletId, code: a.code },
    { outletId: b.outletId, code: b.code },
  ];
}

async function buildHarness(): Promise<{ url: string; close: () => Promise<void> }> {
  const repos = buildRepos();
  const enrolmentService = new EnrolmentService({ repository: repos.enrolment });
  const salesService = new SalesService({ repository: repos.sales });
  const itemsService = new ItemsService({ repository: repos.items });
  const bomsService = new BomsService({ repository: repos.boms });
  const uomsService = new UomsService({ repository: repos.uoms });
  const outletsService = new OutletsService({ repository: repos.outlets });
  const eodService = new EodService({
    salesReader: new SalesRepositorySalesReader(repos.sales),
    eodRepository: repos.eod,
  });

  const codes = await seedFixtures(repos, enrolmentService);

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
    eod: { service: eodService, resolveMerchantId: () => MERCHANT_ID },
  });

  // Test-only CORS shim. The POS preview ships from `127.0.0.1:4174` and
  // POSTs to this harness on `127.0.0.1:4127` — different ports, so Chromium
  // sends a CORS preflight `OPTIONS`. Production keeps the API CORS-free
  // (same-origin reverse-proxy per ARCHITECTURE.md §4); this shim is scoped
  // to the harness only and retires with the harness binary.
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

  // Test-only header translation. See file docstring.
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

  // Admin route: returns the two enrolment codes the spec types into the UI.
  app.post("/__test__/codes", async () => ({ codes }));

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
  process.stdout.write(`[harness] listening at ${harness.url}\n`);
  const stop = async () => {
    await harness.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

void main().catch((err) => {
  process.stderr.write(`[harness] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

/*
 * Fixture data for the KASA-68 full-day offline acceptance suite.
 *
 * One merchant, three outlets (only A and B get devices), five catalog items
 * (two BOM-parents, three raw components), two BOMs, two UoMs. Outlet C exists
 * to prove the suite isolates per-outlet stock and EOD does not bleed across
 * outlets that did not transact.
 *
 * All UUIDs are RFC 9562 v7 shaped — version `7` and variant `8` nibbles in
 * the canonical positions — so `uuidV7` schemas accept them.
 */

export const FIXTURE_BUSINESS_DATE = "2026-04-24";

export const MERCHANT_ID = "01900000-0000-7000-8000-000000000001";

export const OUTLET_A_ID = "01900000-0000-7000-8000-0000000000a1";
export const OUTLET_B_ID = "01900000-0000-7000-8000-0000000000b1";
export const OUTLET_C_ID = "01900000-0000-7000-8000-0000000000c1";

export const OUTLET_A = {
  id: OUTLET_A_ID,
  code: "JKT-PUSAT",
  name: "Jakarta Pusat",
  timezone: "Asia/Jakarta",
} as const;

export const OUTLET_B = {
  id: OUTLET_B_ID,
  code: "JKT-SELATAN",
  name: "Jakarta Selatan",
  timezone: "Asia/Jakarta",
} as const;

export const OUTLET_C = {
  id: OUTLET_C_ID,
  code: "BDG",
  name: "Bandung Pasteur",
  timezone: "Asia/Jakarta",
} as const;

export const OUTLETS = [OUTLET_A, OUTLET_B, OUTLET_C] as const;

export const UOM_PCS_ID = "01900000-0000-7000-8000-0000000000f1";
export const UOM_GR_ID = "01900000-0000-7000-8000-0000000000f2";

export const UOMS = [
  { id: UOM_PCS_ID, code: "pcs", name: "Pieces" },
  { id: UOM_GR_ID, code: "gr", name: "Gram" },
] as const;

// BOM parents (sold to customers).
export const ITEM_KOPI_ID = "01900000-0000-7000-8000-000000000a01";
export const ITEM_TEH_ID = "01900000-0000-7000-8000-000000000a02";
// Raw components (deducted via BOM explosion).
export const ITEM_BIJI_ID = "01900000-0000-7000-8000-000000000a03";
export const ITEM_DAUN_ID = "01900000-0000-7000-8000-000000000a04";
// Stand-alone item without a BOM (also sold).
export const ITEM_AIR_ID = "01900000-0000-7000-8000-000000000a05";

export const BOM_KOPI_ID = "01900000-0000-7000-8000-000000000b01";
export const BOM_TEH_ID = "01900000-0000-7000-8000-000000000b02";

export interface FixtureItem {
  id: string;
  code: string;
  name: string;
  priceIdr: number;
  uomId: string;
  bomId: string | null;
  isStockTracked: boolean;
}

export const ITEMS: FixtureItem[] = [
  {
    id: ITEM_KOPI_ID,
    code: "KP-001",
    name: "Kopi Susu",
    priceIdr: 25_000,
    uomId: UOM_PCS_ID,
    bomId: BOM_KOPI_ID,
    isStockTracked: false,
  },
  {
    id: ITEM_TEH_ID,
    code: "TH-001",
    name: "Teh Manis",
    priceIdr: 18_000,
    uomId: UOM_PCS_ID,
    bomId: BOM_TEH_ID,
    isStockTracked: false,
  },
  {
    id: ITEM_BIJI_ID,
    code: "BJ-001",
    name: "Biji Kopi",
    priceIdr: 0,
    uomId: UOM_GR_ID,
    bomId: null,
    isStockTracked: true,
  },
  {
    id: ITEM_DAUN_ID,
    code: "DN-001",
    name: "Daun Teh",
    priceIdr: 0,
    uomId: UOM_GR_ID,
    bomId: null,
    isStockTracked: true,
  },
  {
    id: ITEM_AIR_ID,
    code: "AR-001",
    name: "Air Mineral",
    priceIdr: 8_000,
    uomId: UOM_PCS_ID,
    bomId: null,
    isStockTracked: true,
  },
];

export interface FixtureBomComponent {
  componentItemId: string;
  quantity: number;
  uomId: string;
}

export interface FixtureBom {
  id: string;
  itemId: string;
  components: FixtureBomComponent[];
}

export const BOMS: FixtureBom[] = [
  {
    id: BOM_KOPI_ID,
    itemId: ITEM_KOPI_ID,
    components: [{ componentItemId: ITEM_BIJI_ID, quantity: 15, uomId: UOM_GR_ID }],
  },
  {
    id: BOM_TEH_ID,
    itemId: ITEM_TEH_ID,
    components: [{ componentItemId: ITEM_DAUN_ID, quantity: 5, uomId: UOM_GR_ID }],
  },
];

// Opening stock per outlet (raw components + stand-alone item). Generous so
// 50 sales never trip insufficient_stock.
export interface FixtureOpeningStock {
  outletId: string;
  itemId: string;
  onHand: number;
}

export const OPENING_STOCK: FixtureOpeningStock[] = [
  { outletId: OUTLET_A_ID, itemId: ITEM_BIJI_ID, onHand: 10_000 },
  { outletId: OUTLET_A_ID, itemId: ITEM_DAUN_ID, onHand: 10_000 },
  { outletId: OUTLET_A_ID, itemId: ITEM_AIR_ID, onHand: 1_000 },
  { outletId: OUTLET_B_ID, itemId: ITEM_BIJI_ID, onHand: 10_000 },
  { outletId: OUTLET_B_ID, itemId: ITEM_DAUN_ID, onHand: 10_000 },
  { outletId: OUTLET_B_ID, itemId: ITEM_AIR_ID, onHand: 1_000 },
  { outletId: OUTLET_C_ID, itemId: ITEM_BIJI_ID, onHand: 10_000 },
  { outletId: OUTLET_C_ID, itemId: ITEM_DAUN_ID, onHand: 10_000 },
  { outletId: OUTLET_C_ID, itemId: ITEM_AIR_ID, onHand: 1_000 },
];

export const STAFF_BOOTSTRAP_TOKEN = "kasa-68-test-staff-token";
export const STAFF_USER_ID = "01900000-0000-7000-8000-00000000ffff";

export const HARNESS_PORT = 4127;
export const HARNESS_BASE_URL = `http://127.0.0.1:${HARNESS_PORT}`;

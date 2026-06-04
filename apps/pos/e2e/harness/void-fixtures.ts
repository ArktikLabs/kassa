/*
 * KASA-241 — fixtures for the void E2E harness.
 *
 * One merchant, one outlet, one BOM-parent item with one raw component, two
 * staff seats (manager + cashier). Distinct from `harness/fixtures.ts` so the
 * void spec can wire `managerPinReader` + `openShiftReader` without breaking
 * the KASA-68 full-day offline spec that explicitly keeps those gates off.
 *
 * All UUIDs are RFC 9562 v7 shaped — version `7` and variant `8` nibbles in
 * the canonical positions — so `uuidV7` schemas accept them.
 */

export const HARNESS_PORT = 4128;
export const HARNESS_BASE_URL = `http://127.0.0.1:${HARNESS_PORT}`;

export const MERCHANT_ID = "01900000-0000-7000-8000-0000000000d0";

export const OUTLET_ID = "01900000-0000-7000-8000-0000000000d1";
export const OUTLET_NAME = "Warung Manajer";
export const OUTLET_TIMEZONE = "Asia/Jakarta";

export const UOM_PCS_ID = "01900000-0000-7000-8000-0000000000d2";
export const UOM_GR_ID = "01900000-0000-7000-8000-0000000000d3";

export const ITEM_ID = "01900000-0000-7000-8000-0000000000d4";
export const COMPONENT_ITEM_ID = "01900000-0000-7000-8000-0000000000d5";
export const BOM_ID = "01900000-0000-7000-8000-0000000000d6";

export const MANAGER_STAFF_ID = "01900000-0000-7000-8000-0000000000d7";
export const CASHIER_STAFF_ID = "01900000-0000-7000-8000-0000000000d8";
export const MANAGER_PIN = "987654";

export interface FixtureOpeningStock {
  outletId: string;
  itemId: string;
  onHand: number;
}

export const OPENING_STOCK: FixtureOpeningStock[] = [
  { outletId: OUTLET_ID, itemId: COMPONENT_ITEM_ID, onHand: 10_000 },
];

export const STAFF_BOOTSTRAP_TOKEN = "kasa-241-test-staff-token";
export const STAFF_USER_ID = "01900000-0000-7000-8000-0000000000df";

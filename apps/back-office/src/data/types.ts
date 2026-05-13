/*
 * Domain types for the back-office scaffold.
 *
 * These mirror the entity list in ARCHITECTURE.md §4 (Outlet, Item,
 * BOM, BOM Item, Staff, Device). They are intentionally narrower than
 * the server-side row shapes — the UI only touches the fields a
 * manager edits in the scaffolded CRUD forms. Real Zod contracts for
 * each resource land in `@kassa/schemas` alongside the corresponding
 * API endpoints.
 */

import type { StaffRole } from "../lib/session";

export type UnitOfMeasure = "pcs" | "g" | "kg" | "ml" | "l" | "pack" | "porsi";

export const UNIT_OF_MEASURE_OPTIONS: readonly UnitOfMeasure[] = [
  "pcs",
  "g",
  "kg",
  "ml",
  "l",
  "pack",
  "porsi",
];

/**
 * KASA-248 — mid-shift availability flag. Mirrors the POS Dexie type
 * (`apps/pos/src/data/db/types.ts`) so the back-office can display the
 * same state the cashier sees once the catalog tile's long-press
 * toggle has synced. v0 back-office surfaces this as a read-only badge
 * only — single-tile flips happen on the POS.
 */
export type ItemAvailability = "available" | "sold_out";

export type CatalogItem = {
  id: string;
  sku: string;
  name: string;
  priceIdr: number;
  uom: UnitOfMeasure;
  imageUrl: string | null;
  isStockTracked: boolean;
  availability: ItemAvailability;
  isActive: boolean;
};

export type BomComponent = {
  componentItemId: string;
  qty: number;
  uom: UnitOfMeasure;
};

export type Bom = {
  id: string;
  parentItemId: string;
  components: BomComponent[];
  effectiveFrom: string;
  effectiveTo: string | null;
};

export type Outlet = {
  id: string;
  name: string;
  taxProfile: "none" | "ppn_11";
  receiptHeader: string;
  addressLine: string;
};

/* Merchant-wide receipt branding (KASA-219). Owner-editable; rendered
 * on every printed/PDF receipt via the POS sync runner.
 *
 * `name` is the legal merchant name (also returned by enrolment);
 * `displayName` is what the receipt prints — they often differ
 * (legal "PT Warung Pusat Indonesia" vs. printed "Warung Pusat"). All
 * fields except `displayName` accept `null` so a brand-new merchant
 * can ship the v0 layout with whatever subset they have on hand.
 */
export type MerchantSettings = {
  id: string;
  name: string;
  displayName: string;
  addressLine: string | null;
  phone: string | null;
  npwp: string | null;
  receiptFooterText: string | null;
};

export type Staff = {
  id: string;
  displayName: string;
  email: string;
  role: StaffRole;
  pin: string;
  isActive: boolean;
};

export type EnrolmentCode = {
  code: string;
  outletId: string;
  expiresAt: string;
  status: "active" | "used" | "revoked";
};

export type Device = {
  id: string;
  label: string;
  outletId: string;
  lastSeenAt: string | null;
  status: "active" | "revoked";
};

export type ReconciliationRow = {
  id: string;
  outletId: string;
  businessDate: string;
  staticQrisCounted: number;
  midtransSettled: number;
  variance: number;
  status: "zero_variance" | "variance" | "pending";
};

/* Unverified static-QRIS tender awaiting manual or settlement match.
 * Mirrors the slice of `payments_qris_static` rows the
 * /admin/reconciliation surface needs (KASA-64 §static-QRIS,
 * KASA-119). The full row lives server-side; we keep just what the
 * unmatched-list table renders. */
export type UnmatchedStaticTender = {
  id: string;
  outletId: string;
  businessDate: string;
  saleAt: string;
  amountIdr: number;
  last4: string;
};

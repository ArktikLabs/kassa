#!/usr/bin/env -S tsx
/*
 * scripts/seed-pilot.ts — staging seed for the v0 pilot test day (KASA-69).
 *
 * Loads a representative kopi-chain dataset modelled on the leading candidate
 * profile from KASA-50 (Yogyakarta–Solo corridor specialty kopi chain). The
 * specific named pilot merchant is still in outreach (KASA-52); this seed
 * gives the staging Neon branch a believable dataset so onboarding, BOM
 * deduction, multi-outlet stock, and EOD reconciliation can all be timed
 * end-to-end during the M4 pilot day.
 *
 * Idempotency
 * -----------
 * Every row uses a UUIDv5-style identifier derived from a stable seed
 * namespace + entity key (`derivedId(...)`), so reruns:
 *
 *   - merchant / outlets / uoms / items / boms      → upserted (content
 *     fields refreshed; the id and references stay stable)
 *   - staff                                         → insert-once
 *     (`onConflictDoNothing`) so we don't churn argon2 hashes — the salt
 *     re-randomises each run, which would invalidate any sessions
 *   - stock_snapshots                               → insert-once so we
 *     don't clobber sale-driven on_hand from a prior test day
 *
 * The script never deletes existing rows.
 *
 * Usage
 * -----
 *
 *   DATABASE_URL=postgres://… pnpm seed:pilot
 *
 * Env:
 *   DATABASE_URL  Postgres URL of the staging Neon branch. Required.
 *   DATABASE_SSL  "true" (default) or "false". Neon branches require TLS.
 *
 * The script does NOT run migrations — point it at a database that has
 * already had `pnpm --filter @kassa/api db:migrate` applied.
 */

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import argon2 from "argon2";
import { createDatabase, type Database } from "../apps/api/src/db/client.js";
import {
  bomComponents,
  boms,
  items,
  merchants,
  outlets,
  staff,
  stockSnapshots,
  uoms,
} from "../apps/api/src/db/schema/index.js";

// Stable v0 namespace UUID; never change it — the derived ids would shift
// and all previous rows would orphan. Generated once with
// `crypto.randomUUID()` and pinned here.
const SEED_NAMESPACE = "0d8b9e8d-0e1a-4c1b-9b40-1f4f4f6e4a91";

/**
 * Deterministic UUID for `(entity, key)`. Hashes
 * `${SEED_NAMESPACE}|${entity}|${key}` with SHA-1 and reformats the first
 * 16 bytes as a UUIDv5-shaped string. Same input → same uuid forever, so
 * upserts on the natural unique index land on the same row each rerun.
 */
function derivedId(entity: string, key: string): string {
  const digest = createHash("sha1").update(`${SEED_NAMESPACE}|${entity}|${key}`).digest();
  // Force version=5, variant=RFC4122 (high bits of bytes 6 and 8) so
  // Postgres' uuid type accepts it cleanly and the value visibly carries
  // the "derived" intent.
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

interface SeedSummary {
  merchants: number;
  outlets: number;
  uoms: number;
  items: number;
  boms: number;
  bomComponents: number;
  staff: number;
  stockSnapshots: number;
}

const MERCHANT_SLUG = "kopi-tugu-pilot";
const MERCHANT_ID = derivedId("merchant", MERCHANT_SLUG);

const OUTLET_DEFS = [
  { code: "JOG-01", name: "Kopi Tugu — Malioboro" },
  { code: "JOG-02", name: "Kopi Tugu — Kotagede" },
  { code: "KLT-01", name: "Kopi Tugu — Klaten" },
];

const UOM_DEFS = [
  { code: "pcs", name: "Pieces" },
  { code: "gram", name: "Gram" },
  { code: "ml", name: "Mililiter" },
];

interface RawMaterial {
  code: string;
  name: string;
  uom: "gram" | "ml" | "pcs";
  /** Initial on-hand per outlet, in the row's UOM. */
  initialStock: number;
  allowNegative: boolean;
}

const RAW_MATERIALS: RawMaterial[] = [
  {
    code: "RM-KOPI-BIJI",
    name: "Biji Kopi Arabika",
    uom: "gram",
    initialStock: 5_000,
    allowNegative: false,
  },
  {
    code: "RM-SUSU-FRESH",
    name: "Susu Fresh Full-cream",
    uom: "ml",
    initialStock: 8_000,
    allowNegative: false,
  },
  {
    code: "RM-GULA-PASIR",
    name: "Gula Pasir",
    uom: "gram",
    initialStock: 3_000,
    allowNegative: false,
  },
  {
    code: "RM-SIRUP-VAN",
    name: "Sirup Vanila",
    uom: "ml",
    initialStock: 2_000,
    allowNegative: false,
  },
  { code: "RM-AIR", name: "Air RO", uom: "ml", initialStock: 20_000, allowNegative: true },
  { code: "RM-ES-BATU", name: "Es Batu", uom: "gram", initialStock: 10_000, allowNegative: true },
];

interface MenuItem {
  code: string;
  name: string;
  priceIdr: number;
  /**
   * BOM components, expressed as `(rawMaterialCode, quantity)` in the raw
   * material's own UOM. Empty array = plain item, no BOM.
   */
  components: Array<{ rawCode: string; quantity: number }>;
  /** Initial on-hand per outlet for plain (non-BOM) items. */
  initialStock?: number;
}

const MENU: MenuItem[] = [
  {
    code: "ESP-001",
    name: "Espresso",
    priceIdr: 18_000,
    components: [
      { rawCode: "RM-KOPI-BIJI", quantity: 18 },
      { rawCode: "RM-AIR", quantity: 30 },
    ],
  },
  {
    code: "AME-001",
    name: "Americano",
    priceIdr: 22_000,
    components: [
      { rawCode: "RM-KOPI-BIJI", quantity: 18 },
      { rawCode: "RM-AIR", quantity: 180 },
    ],
  },
  {
    code: "CAP-001",
    name: "Cappuccino",
    priceIdr: 28_000,
    components: [
      { rawCode: "RM-KOPI-BIJI", quantity: 18 },
      { rawCode: "RM-SUSU-FRESH", quantity: 150 },
    ],
  },
  {
    code: "LAT-001",
    name: "Caffè Latte",
    priceIdr: 30_000,
    components: [
      { rawCode: "RM-KOPI-BIJI", quantity: 18 },
      { rawCode: "RM-SUSU-FRESH", quantity: 200 },
    ],
  },
  {
    code: "VAN-001",
    name: "Vanilla Latte",
    priceIdr: 32_000,
    components: [
      { rawCode: "RM-KOPI-BIJI", quantity: 18 },
      { rawCode: "RM-SUSU-FRESH", quantity: 200 },
      { rawCode: "RM-SIRUP-VAN", quantity: 15 },
    ],
  },
  {
    code: "EKS-001",
    name: "Es Kopi Susu",
    priceIdr: 25_000,
    components: [
      { rawCode: "RM-KOPI-BIJI", quantity: 18 },
      { rawCode: "RM-SUSU-FRESH", quantity: 120 },
      { rawCode: "RM-GULA-PASIR", quantity: 12 },
      { rawCode: "RM-ES-BATU", quantity: 80 },
    ],
  },
  {
    code: "AIR-001",
    name: "Air Mineral 600 ml",
    priceIdr: 8_000,
    components: [],
    initialStock: 24,
  },
];

interface StaffSeed {
  email: string;
  displayName: string;
  role: "owner" | "manager" | "cashier";
}

// Real merchant credentials get rotated on day one. These are deterministic
// stubs for staging only — the script still hashes them with Argon2id so
// the row matches the production-shape `password_hash`.
const STAFF: StaffSeed[] = [
  { email: "owner@kopi-tugu.test", displayName: "Bayu (Pemilik)", role: "owner" },
  { email: "manager@kopi-tugu.test", displayName: "Sari (Manager)", role: "manager" },
  { email: "kasir-jog01@kopi-tugu.test", displayName: "Andi (Kasir Malioboro)", role: "cashier" },
  { email: "kasir-jog02@kopi-tugu.test", displayName: "Dewi (Kasir Kotagede)", role: "cashier" },
  { email: "kasir-klt01@kopi-tugu.test", displayName: "Rizky (Kasir Klaten)", role: "cashier" },
];

const STAFF_SCAFFOLD_PASSWORD = "welcome-to-kassa";
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

function uomId(code: string): string {
  return derivedId("uom", `${MERCHANT_SLUG}:${code}`);
}

function itemId(code: string): string {
  return derivedId("item", `${MERCHANT_SLUG}:${code}`);
}

function bomId(menuCode: string): string {
  return derivedId("bom", `${MERCHANT_SLUG}:${menuCode}`);
}

function outletId(code: string): string {
  return derivedId("outlet", `${MERCHANT_SLUG}:${code}`);
}

function staffId(email: string): string {
  return derivedId("staff", `${MERCHANT_SLUG}:${email.toLowerCase()}`);
}

async function seed(db: Database): Promise<SeedSummary> {
  const summary: SeedSummary = {
    merchants: 0,
    outlets: 0,
    uoms: 0,
    items: 0,
    boms: 0,
    bomComponents: 0,
    staff: 0,
    stockSnapshots: 0,
  };

  // 1. Merchant — content-upsert.
  const merchantRows = await db
    .insert(merchants)
    .values({
      id: MERCHANT_ID,
      name: "Kopi Tugu Pilot",
      timezone: "Asia/Jakarta",
    })
    .onConflictDoUpdate({
      target: merchants.id,
      set: { name: sql`excluded.name`, timezone: sql`excluded.timezone`, updatedAt: sql`now()` },
    })
    .returning({ id: merchants.id });
  summary.merchants += merchantRows.length;

  // 2. Outlets — content-upsert on the merchant-scoped natural key.
  for (const def of OUTLET_DEFS) {
    const id = outletId(def.code);
    const rows = await db
      .insert(outlets)
      .values({ id, merchantId: MERCHANT_ID, code: def.code, name: def.name })
      .onConflictDoUpdate({
        target: [outlets.merchantId, outlets.code],
        set: { name: sql`excluded.name`, updatedAt: sql`now()` },
      })
      .returning({ id: outlets.id });
    summary.outlets += rows.length;
  }

  // 3. UOMs.
  for (const def of UOM_DEFS) {
    const id = uomId(def.code);
    const rows = await db
      .insert(uoms)
      .values({ id, merchantId: MERCHANT_ID, code: def.code, name: def.name })
      .onConflictDoUpdate({
        target: [uoms.merchantId, uoms.code],
        set: { name: sql`excluded.name`, updatedAt: sql`now()` },
      })
      .returning({ id: uoms.id });
    summary.uoms += rows.length;
  }

  // 4. Items — first the raw materials, then menu items (without bom_id),
  //    then the BOMs, then the menu-item bom_id back-pointers.
  for (const raw of RAW_MATERIALS) {
    const id = itemId(raw.code);
    const rows = await db
      .insert(items)
      .values({
        id,
        merchantId: MERCHANT_ID,
        code: raw.code,
        name: raw.name,
        priceIdr: 0,
        uomId: uomId(raw.uom),
        bomId: null,
        isStockTracked: true,
        allowNegative: raw.allowNegative,
        isActive: true,
      })
      .onConflictDoUpdate({
        target: [items.merchantId, items.code],
        set: {
          name: sql`excluded.name`,
          priceIdr: sql`excluded.price_idr`,
          uomId: sql`excluded.uom_id`,
          allowNegative: sql`excluded.allow_negative`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ id: items.id });
    summary.items += rows.length;
  }

  for (const menu of MENU) {
    const id = itemId(menu.code);
    const rows = await db
      .insert(items)
      .values({
        id,
        merchantId: MERCHANT_ID,
        code: menu.code,
        name: menu.name,
        priceIdr: menu.priceIdr,
        uomId: uomId("pcs"),
        bomId: null, // set after the BOM exists
        isStockTracked: menu.components.length === 0,
        allowNegative: false,
        isActive: true,
      })
      .onConflictDoUpdate({
        target: [items.merchantId, items.code],
        set: {
          name: sql`excluded.name`,
          priceIdr: sql`excluded.price_idr`,
          uomId: sql`excluded.uom_id`,
          isStockTracked: sql`excluded.is_stock_tracked`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ id: items.id });
    summary.items += rows.length;
  }

  // 5. BOMs and components.
  for (const menu of MENU) {
    if (menu.components.length === 0) continue;
    const bId = bomId(menu.code);
    const itId = itemId(menu.code);
    const bomRows = await db
      .insert(boms)
      .values({ id: bId, merchantId: MERCHANT_ID, itemId: itId })
      .onConflictDoUpdate({
        target: boms.id,
        set: { itemId: sql`excluded.item_id`, updatedAt: sql`now()` },
      })
      .returning({ id: boms.id });
    summary.boms += bomRows.length;

    for (const c of menu.components) {
      const componentId = itemId(c.rawCode);
      const raw = RAW_MATERIALS.find((r) => r.code === c.rawCode);
      if (!raw) {
        throw new Error(`unknown raw material code in BOM for ${menu.code}: ${c.rawCode}`);
      }
      const rows = await db
        .insert(bomComponents)
        .values({
          bomId: bId,
          componentItemId: componentId,
          quantity: c.quantity.toString(),
          uomId: uomId(raw.uom),
        })
        .onConflictDoUpdate({
          target: [bomComponents.bomId, bomComponents.componentItemId],
          set: {
            quantity: sql`excluded.quantity`,
            uomId: sql`excluded.uom_id`,
          },
        })
        .returning({ bomId: bomComponents.bomId });
      summary.bomComponents += rows.length;
    }

    // Back-point the menu item's bom_id at the BOM we just upserted.
    await db
      .update(items)
      .set({ bomId: bId, updatedAt: new Date() })
      .where(sql`${items.id} = ${itId}`);
  }

  // 6. Staff — insert-once. Rerunning would re-hash with a new Argon2 salt
  //    and invalidate any active sessions, which is hostile to the test day.
  for (const s of STAFF) {
    const id = staffId(s.email);
    const passwordHash = await argon2.hash(STAFF_SCAFFOLD_PASSWORD, ARGON2_OPTIONS);
    const rows = await db
      .insert(staff)
      .values({
        id,
        merchantId: MERCHANT_ID,
        email: s.email,
        passwordHash,
        role: s.role,
        pinHash: null,
      })
      .onConflictDoNothing({ target: [staff.merchantId, staff.email] })
      .returning({ id: staff.id });
    summary.staff += rows.length;
  }

  // 7. Stock snapshots. Insert-once so we don't clobber on_hand from a real
  //    test-day's worth of sales. Seeds raw materials per outlet plus the
  //    plain items (e.g. Air Mineral) at their `initialStock` count.
  for (const def of OUTLET_DEFS) {
    const oId = outletId(def.code);

    for (const raw of RAW_MATERIALS) {
      const rows = await db
        .insert(stockSnapshots)
        .values({
          outletId: oId,
          itemId: itemId(raw.code),
          onHand: raw.initialStock.toString(),
        })
        .onConflictDoNothing({ target: [stockSnapshots.outletId, stockSnapshots.itemId] })
        .returning({ outletId: stockSnapshots.outletId });
      summary.stockSnapshots += rows.length;
    }

    for (const menu of MENU) {
      if (menu.initialStock === undefined) continue;
      const rows = await db
        .insert(stockSnapshots)
        .values({
          outletId: oId,
          itemId: itemId(menu.code),
          onHand: menu.initialStock.toString(),
        })
        .onConflictDoNothing({ target: [stockSnapshots.outletId, stockSnapshots.itemId] })
        .returning({ outletId: stockSnapshots.outletId });
      summary.stockSnapshots += rows.length;
    }
  }

  return summary;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set; aborting seed.");
    process.exit(1);
  }
  const ssl = process.env.DATABASE_SSL !== "false";
  const handle = createDatabase({ url, ssl });
  try {
    const summary = await seed(handle.db);
    /* biome-ignore lint/suspicious/noConsole: CLI script output is intentional — this is the human-readable summary the operator reads after running `pnpm seed:pilot`. */
    const log = console.log;
    log("Seed complete. Pilot dataset is ready on this Neon branch.");
    log(`  Merchant id: ${MERCHANT_ID}  (slug: ${MERCHANT_SLUG})`);
    log("  Inserted/upserted:");
    for (const [k, v] of Object.entries(summary)) {
      log(`    ${k.padEnd(16)} ${v}`);
    }
    log("  Owner login (staging only):");
    log("    email:    owner@kopi-tugu.test");
    log("    password: welcome-to-kassa  (rotate before pilot day)");
  } finally {
    await handle.close();
  }
}

main().catch((err) => {
  console.error("seed-pilot failed:", err);
  process.exit(1);
});

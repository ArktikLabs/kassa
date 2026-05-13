import Dexie, { type Table } from "dexie";
import type {
  Bom,
  DeviceMeta,
  DeviceSecret,
  EodClosure,
  Item,
  Outlet,
  PendingCatalogMutation,
  PendingSale,
  PendingShiftEvent,
  PrintedQris,
  ShiftState,
  StockSnapshot,
  SyncState,
  Uom,
} from "./types.ts";

export const DB_NAME = "kassa-pos";
export const DB_VERSION = 6;

export class KassaDexie extends Dexie {
  items!: Table<Item, string>;
  boms!: Table<Bom, string>;
  uoms!: Table<Uom, string>;
  outlets!: Table<Outlet, string>;
  stock_snapshot!: Table<StockSnapshot, string>;
  pending_sales!: Table<PendingSale, string>;
  sync_state!: Table<SyncState, string>;
  device_secret!: Table<DeviceSecret, string>;
  device_meta!: Table<DeviceMeta, string>;
  eod_closures!: Table<EodClosure, string>;
  printed_qris!: Table<PrintedQris, string>;
  pending_shift_events!: Table<PendingShiftEvent, string>;
  shift_state!: Table<ShiftState, string>;
  pending_catalog_mutations!: Table<PendingCatalogMutation, string>;

  constructor(name: string = DB_NAME) {
    super(name);
    this.version(1).stores({
      items: "id, code, name, isActive, updatedAt",
      boms: "id, itemId, updatedAt",
      uoms: "id, code, updatedAt",
      outlets: "id, code, updatedAt",
      stock_snapshot: "key, outletId, itemId, updatedAt",
      pending_sales: "localSaleId, status, outletId, createdAt",
      sync_state: "table",
      device_secret: "id",
      device_meta: "id",
    });
    // v2 — pending_sales.status gains `needs_attention` + `synced`, and
    // rows grow a `serverSaleName` field populated on first 2xx/409.
    // The indexed columns are unchanged, so no store rewrite is needed —
    // we only backfill the new nullable column so existing outbox rows
    // keep a well-defined shape after the upgrade.
    this.version(2)
      .stores({
        items: "id, code, name, isActive, updatedAt",
        boms: "id, itemId, updatedAt",
        uoms: "id, code, updatedAt",
        outlets: "id, code, updatedAt",
        stock_snapshot: "key, outletId, itemId, updatedAt",
        pending_sales: "localSaleId, status, outletId, createdAt",
        sync_state: "table",
        device_secret: "id",
        device_meta: "id",
      })
      .upgrade(async (tx) => {
        await tx
          .table("pending_sales")
          .toCollection()
          .modify((row: { serverSaleName?: string | null }) => {
            if (row.serverSaleName === undefined) row.serverSaleName = null;
          });
      });
    // v3 — add `eod_closures` to mark an (outlet, businessDate) as
    // server-acknowledged closed. New table, no backfill required.
    this.version(3).stores({
      items: "id, code, name, isActive, updatedAt",
      boms: "id, itemId, updatedAt",
      uoms: "id, code, updatedAt",
      outlets: "id, code, updatedAt",
      stock_snapshot: "key, outletId, itemId, updatedAt",
      pending_sales: "localSaleId, status, outletId, createdAt",
      sync_state: "table",
      device_secret: "id",
      device_meta: "id",
      eod_closures: "key, outletId, businessDate, closedAt",
    });
    // v4 — add `printed_qris` to cache the merchant's printed-QR image per
    // outlet so the static-QRIS tender flow (KASA-118) renders offline.
    // New table, no backfill required.
    this.version(4).stores({
      items: "id, code, name, isActive, updatedAt",
      boms: "id, itemId, updatedAt",
      uoms: "id, code, updatedAt",
      outlets: "id, code, updatedAt",
      stock_snapshot: "key, outletId, itemId, updatedAt",
      pending_sales: "localSaleId, status, outletId, createdAt",
      sync_state: "table",
      device_secret: "id",
      device_meta: "id",
      eod_closures: "key, outletId, businessDate, closedAt",
      printed_qris: "outletId, fetchedAt",
    });
    // v5 — KASA-235 cashier shift open/close. `pending_shift_events` is the
    // dedicated outbox for shift events (open + close ride independent rows
    // keyed by their respective uuids); `shift_state` is a singleton row
    // the boot guard reads to decide whether to redirect to /shift/open.
    this.version(5).stores({
      items: "id, code, name, isActive, updatedAt",
      boms: "id, itemId, updatedAt",
      uoms: "id, code, updatedAt",
      outlets: "id, code, updatedAt",
      stock_snapshot: "key, outletId, itemId, updatedAt",
      pending_sales: "localSaleId, status, outletId, createdAt",
      sync_state: "table",
      device_secret: "id",
      device_meta: "id",
      eod_closures: "key, outletId, businessDate, closedAt",
      printed_qris: "outletId, fetchedAt",
      pending_shift_events: "eventId, status, outletId, createdAt, kind",
      shift_state: "id",
    });
    // v6 — KASA-248. `pending_catalog_mutations` is the outbox for the
    // catalog tile's long-press availability toggle; rows are keyed by
    // `itemId` so a flip-flop collapses to the latest desired state.
    // Existing `items` rows are backfilled to `availability='available'`
    // so the catalog screen renders identically until the next sync pull
    // overwrites them with the server's canonical state.
    this.version(6)
      .stores({
        items: "id, code, name, isActive, updatedAt",
        boms: "id, itemId, updatedAt",
        uoms: "id, code, updatedAt",
        outlets: "id, code, updatedAt",
        stock_snapshot: "key, outletId, itemId, updatedAt",
        pending_sales: "localSaleId, status, outletId, createdAt",
        sync_state: "table",
        device_secret: "id",
        device_meta: "id",
        eod_closures: "key, outletId, businessDate, closedAt",
        printed_qris: "outletId, fetchedAt",
        pending_shift_events: "eventId, status, outletId, createdAt, kind",
        shift_state: "id",
        pending_catalog_mutations: "itemId, status, createdAt",
      })
      .upgrade(async (tx) => {
        await tx
          .table("items")
          .toCollection()
          .modify((row: { availability?: string }) => {
            if (row.availability === undefined) row.availability = "available";
          });
      });
  }
}

export class DbOpenError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "DbOpenError";
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export type DexieFactory = (name: string) => KassaDexie;

export interface OpenOptions {
  /**
   * If Dexie refuses to open the database (version mismatch, unreadable store,
   * corruption), delete the local database and reopen fresh. Reference data
   * is pulled from the server anyway, so the only durable loss is the
   * pending-sales outbox — callers must surface that to the merchant.
   *
   * TECH-STACK.md §14 risk 6: read-error rollback guard.
   */
  rollbackOnReadError?: boolean;
  /**
   * Override for tests so we can inject a failing Dexie instance.
   * Production code should not pass this.
   */
  factory?: DexieFactory;
}

const defaultFactory: DexieFactory = (name) => new KassaDexie(name);

export async function openKassaDb(
  name: string = DB_NAME,
  options: OpenOptions = {},
): Promise<KassaDexie> {
  const factory = options.factory ?? defaultFactory;
  const db = factory(name);
  try {
    await db.open();
    return db;
  } catch (err) {
    db.close();
    if (options.rollbackOnReadError) {
      await Dexie.delete(name);
      const recovered = factory(name);
      try {
        await recovered.open();
        return recovered;
      } catch (recoveryErr) {
        recovered.close();
        throw new DbOpenError("Failed to open Kassa Dexie database even after rollback", {
          cause: recoveryErr,
        });
      }
    }
    throw new DbOpenError("Failed to open Kassa Dexie database", { cause: err });
  }
}

export async function resetKassaDb(name: string = DB_NAME): Promise<KassaDexie> {
  await Dexie.delete(name);
  return openKassaDb(name);
}

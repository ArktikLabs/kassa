import Dexie, { type Table } from "dexie";
import type {
  Bom,
  DeviceMeta,
  DeviceSecret,
  Item,
  Outlet,
  PendingSale,
  StockSnapshot,
  SyncState,
  Uom,
} from "./types.ts";

export const DB_NAME = "kassa-pos";
export const DB_VERSION = 1;

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

  constructor(name: string = DB_NAME) {
    super(name);
    this.version(DB_VERSION)
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
      .upgrade(async () => {
        // v1 is the initial schema — nothing to migrate from.
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
        throw new DbOpenError(
          "Failed to open Kassa Dexie database even after rollback",
          { cause: recoveryErr },
        );
      }
    }
    throw new DbOpenError("Failed to open Kassa Dexie database", { cause: err });
  }
}

export async function resetKassaDb(name: string = DB_NAME): Promise<KassaDexie> {
  await Dexie.delete(name);
  return openKassaDb(name);
}

import {
  DB_NAME,
  DB_VERSION,
  DbOpenError,
  KassaDexie,
  openKassaDb,
  resetKassaDb,
  type OpenOptions,
} from "./schema.ts";
import { bomsRepo, type BomsRepo } from "./boms.ts";
import { deviceMetaRepo, type DeviceMetaRepo } from "./device-meta.ts";
import { deviceSecretRepo, type DeviceSecretRepo } from "./device-secret.ts";
import { eodClosuresRepo, type EodClosuresRepo } from "./eod-closures.ts";
import { itemsRepo, type ItemsRepo } from "./items.ts";
import { outletsRepo, type OutletsRepo } from "./outlets.ts";
import { pendingSalesRepo, type PendingSalesRepo } from "./pending-sales.ts";
import { pendingShiftEventsRepo, type PendingShiftEventsRepo } from "./pending-shift-events.ts";
import { pendingVoidsRepo, type PendingVoidsRepo } from "./pending-voids.ts";
import { printedQrisRepo, type PrintedQrisRepo } from "./printed-qris.ts";
import { shiftStateRepo, type ShiftStateRepo } from "./shift-state.ts";
import { stockSnapshotRepo, type StockSnapshotRepo } from "./stock-snapshot.ts";
import { syncStateRepo, type SyncStateRepo } from "./sync-state.ts";
import { uomsRepo, type UomsRepo } from "./uoms.ts";

export interface Repos {
  items: ItemsRepo;
  boms: BomsRepo;
  uoms: UomsRepo;
  outlets: OutletsRepo;
  stockSnapshot: StockSnapshotRepo;
  pendingSales: PendingSalesRepo;
  pendingShiftEvents: PendingShiftEventsRepo;
  pendingVoids: PendingVoidsRepo;
  shiftState: ShiftStateRepo;
  syncState: SyncStateRepo;
  deviceSecret: DeviceSecretRepo;
  deviceMeta: DeviceMetaRepo;
  eodClosures: EodClosuresRepo;
  printedQris: PrintedQrisRepo;
}

export function createRepos(db: KassaDexie): Repos {
  return {
    items: itemsRepo(db),
    boms: bomsRepo(db),
    uoms: uomsRepo(db),
    outlets: outletsRepo(db),
    stockSnapshot: stockSnapshotRepo(db),
    pendingSales: pendingSalesRepo(db),
    pendingShiftEvents: pendingShiftEventsRepo(db),
    pendingVoids: pendingVoidsRepo(db),
    shiftState: shiftStateRepo(db),
    syncState: syncStateRepo(db),
    deviceSecret: deviceSecretRepo(db),
    deviceMeta: deviceMetaRepo(db),
    eodClosures: eodClosuresRepo(db),
    printedQris: printedQrisRepo(db),
  };
}

export interface Database {
  db: KassaDexie;
  repos: Repos;
  close(): void;
}

let singleton: Database | null = null;

export async function getDatabase(options?: OpenOptions): Promise<Database> {
  if (singleton) return singleton;
  const db = await openKassaDb(DB_NAME, options);
  singleton = {
    db,
    repos: createRepos(db),
    close: () => {
      db.close();
      singleton = null;
    },
  };
  return singleton;
}

export function _resetDatabaseSingletonForTest(): void {
  singleton?.close();
  singleton = null;
}

export { DB_NAME, DB_VERSION, DbOpenError, KassaDexie, openKassaDb, resetKassaDb };
export type { OpenOptions };
export * from "./types.ts";

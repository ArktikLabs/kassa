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
import { deviceSecretRepo, type DeviceSecretRepo } from "./device-secret.ts";
import { itemsRepo, type ItemsRepo } from "./items.ts";
import { outletsRepo, type OutletsRepo } from "./outlets.ts";
import { pendingSalesRepo, type PendingSalesRepo } from "./pending-sales.ts";
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
  syncState: SyncStateRepo;
  deviceSecret: DeviceSecretRepo;
}

export function createRepos(db: KassaDexie): Repos {
  return {
    items: itemsRepo(db),
    boms: bomsRepo(db),
    uoms: uomsRepo(db),
    outlets: outletsRepo(db),
    stockSnapshot: stockSnapshotRepo(db),
    pendingSales: pendingSalesRepo(db),
    syncState: syncStateRepo(db),
    deviceSecret: deviceSecretRepo(db),
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

export {
  DB_NAME,
  DB_VERSION,
  DbOpenError,
  KassaDexie,
  openKassaDb,
  resetKassaDb,
};
export type { OpenOptions };
export * from "./types.ts";

/*
 * Dexie schema for the POS PWA. IndexedDB is the offline source of truth —
 * `device_secret` is stored here instead of localStorage because localStorage
 * is synchronous (blocks tender rendering) and ~5 MB (ARCHITECTURE.md §3).
 *
 * The M2 schema covers only the tables device enrolment needs. Catalog,
 * stock, and pending-sale tables land under KASA-57 and add `version(2)`.
 * Version bumps must be additive — never mutate a shipped version() call.
 */

import Dexie, { type Table } from "dexie";

export interface DeviceSecretRow {
  id: "singleton";
  deviceId: string;
  apiKey: string;
  apiSecret: string;
  outletId: string;
  outletName: string;
  merchantId: string;
  merchantName: string;
  enrolledAt: string;
}

export interface DeviceMetaRow {
  id: "singleton";
  fingerprint: string;
}

export class KassaDatabase extends Dexie {
  deviceSecret!: Table<DeviceSecretRow, "singleton">;
  deviceMeta!: Table<DeviceMetaRow, "singleton">;

  constructor(name = "kassa-pos") {
    super(name);
    this.version(1).stores({
      deviceSecret: "id",
      deviceMeta: "id",
    });
  }
}

export const db = new KassaDatabase();

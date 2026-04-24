import type { KassaDexie } from "./schema.ts";
import type { DeviceMeta } from "./types.ts";

const SINGLETON_KEY: DeviceMeta["id"] = "singleton";

export interface DeviceMetaRepo {
  get(): Promise<DeviceMeta | undefined>;
  ensureFingerprint(generate?: () => string): Promise<string>;
  clear(): Promise<void>;
}

export function deviceMetaRepo(db: KassaDexie): DeviceMetaRepo {
  return {
    get() {
      return db.device_meta.get(SINGLETON_KEY);
    },
    async ensureFingerprint(generate = () => crypto.randomUUID()) {
      const existing = await db.device_meta.get(SINGLETON_KEY);
      if (existing) return existing.fingerprint;
      const fingerprint = generate();
      await db.device_meta.put({ id: SINGLETON_KEY, fingerprint });
      return fingerprint;
    },
    async clear() {
      await db.device_meta.delete(SINGLETON_KEY);
    },
  };
}

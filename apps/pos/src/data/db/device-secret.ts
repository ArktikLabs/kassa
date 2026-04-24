import type { KassaDexie } from "./schema.ts";
import type { DeviceSecret } from "./types.ts";

const SINGLETON_KEY: DeviceSecret["id"] = "singleton";

export interface DeviceSecretRepo {
  get(): Promise<DeviceSecret | undefined>;
  set(secret: Omit<DeviceSecret, "id">): Promise<DeviceSecret>;
  clear(): Promise<void>;
}

export function deviceSecretRepo(db: KassaDexie): DeviceSecretRepo {
  return {
    get() {
      return db.device_secret.get(SINGLETON_KEY);
    },
    async set(secret) {
      const row: DeviceSecret = { id: SINGLETON_KEY, ...secret };
      await db.device_secret.put(row);
      return row;
    },
    async clear() {
      await db.device_secret.delete(SINGLETON_KEY);
    },
  };
}

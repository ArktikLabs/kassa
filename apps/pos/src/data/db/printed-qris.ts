import type { KassaDexie } from "./schema.ts";
import type { PrintedQris } from "./types.ts";

export interface PrintedQrisRepo {
  get(outletId: string): Promise<PrintedQris | undefined>;
  put(row: PrintedQris): Promise<void>;
}

export function printedQrisRepo(db: KassaDexie): PrintedQrisRepo {
  return {
    get(outletId) {
      return db.printed_qris.get(outletId);
    },
    async put(row) {
      await db.printed_qris.put(row);
    },
  };
}

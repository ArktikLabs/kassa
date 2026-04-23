export interface DedupeRecord {
  orderId: string;
  status: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  seenCount: number;
}

export interface WebhookDedupeStore {
  /**
   * Returns true if this (orderId, status) pair has already been processed;
   * otherwise records it as seen and returns false.
   */
  checkAndRecord(orderId: string, status: string, now?: Date): boolean;
  get(orderId: string): DedupeRecord | undefined;
  size(): number;
  clear(): void;
}

/**
 * In-memory dedupe for v0 — single-node, process-local. When persistence lands,
 * swap this out for a Postgres-backed store using the same interface.
 */
export function createInMemoryDedupeStore(): WebhookDedupeStore {
  const map = new Map<string, DedupeRecord>();
  return {
    checkAndRecord(orderId, status, now = new Date()) {
      const existing = map.get(orderId);
      if (existing && existing.status === status) {
        existing.lastSeenAt = now;
        existing.seenCount += 1;
        return true;
      }
      map.set(orderId, {
        orderId,
        status,
        firstSeenAt: now,
        lastSeenAt: now,
        seenCount: 1,
      });
      return false;
    },
    get(orderId) {
      return map.get(orderId);
    },
    size() {
      return map.size;
    },
    clear() {
      map.clear();
    },
  };
}

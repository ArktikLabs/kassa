export interface DedupeRecord {
  orderId: string;
  status: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  seenCount: number;
}

export interface WebhookDedupeStore {
  /** True if (orderId, status) was already recorded. Bumps its lastSeenAt/seenCount so replay counts stay accurate. */
  check(orderId: string, status: string, now?: Date): boolean;
  /** Record a first-seen (orderId, status). Overwrites a different prior status for the same order; idempotent on identical status. */
  record(orderId: string, status: string, now?: Date): void;
  /**
   * Check and record in one step. Prefer `check` + `record` for new call
   * sites so the record only lands after downstream work (e.g. event emit)
   * succeeds — otherwise a throwing listener silently drops a retry.
   */
  checkAndRecord(orderId: string, status: string, now?: Date): boolean;
  get(orderId: string): DedupeRecord | undefined;
  size(): number;
  clear(): void;
}

/**
 * In-memory dedupe for v0 — single-node, process-local. When persistence lands,
 * swap this out for a Postgres-backed store using the same interface. The
 * in-memory store keys by `orderId` and overwrites on status transitions
 * (pending → paid); a Postgres-backed store should key on (orderId, status)
 * so we retain full transition history across replicas.
 */
export function createInMemoryDedupeStore(): WebhookDedupeStore {
  const map = new Map<string, DedupeRecord>();

  function doCheck(orderId: string, status: string, now: Date): boolean {
    const existing = map.get(orderId);
    if (existing && existing.status === status) {
      existing.lastSeenAt = now;
      existing.seenCount += 1;
      return true;
    }
    return false;
  }

  function doRecord(orderId: string, status: string, now: Date): void {
    const existing = map.get(orderId);
    if (existing && existing.status === status) {
      existing.lastSeenAt = now;
      return;
    }
    map.set(orderId, {
      orderId,
      status,
      firstSeenAt: now,
      lastSeenAt: now,
      seenCount: 1,
    });
  }

  return {
    check(orderId, status, now = new Date()) {
      return doCheck(orderId, status, now);
    },
    record(orderId, status, now = new Date()) {
      doRecord(orderId, status, now);
    },
    checkAndRecord(orderId, status, now = new Date()) {
      if (doCheck(orderId, status, now)) return true;
      doRecord(orderId, status, now);
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

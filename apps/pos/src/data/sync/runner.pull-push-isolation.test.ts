import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Dexie from "dexie";
import { createRepos, DB_NAME } from "../db/index.ts";
import { type KassaDexie, openKassaDb } from "../db/schema.ts";
import { createSyncRunner } from "./runner.ts";
import { createSyncStatusStore } from "./status.ts";
import { SyncOfflineError } from "./errors.ts";

// KASA-347 / KASA-400 — these tests live in a separate file so vi.mock()
// can stub pullAll without affecting the other runner specs in
// runner.test.ts (which exercise the real pullAll via stub fetchImpls).
const { pullAllMock } = vi.hoisted(() => ({ pullAllMock: vi.fn() }));
vi.mock("./pull.ts", () => ({
  pullAll: pullAllMock,
}));

async function freshDatabase() {
  const name = `${DB_NAME}-runner-iso-${Math.random().toString(36).slice(2)}`;
  await Dexie.delete(name);
  const db = (await openKassaDb(name)) as KassaDexie;
  return {
    name,
    db,
    repos: createRepos(db),
    close: () => db.close(),
  };
}

function noopPushResult() {
  return {
    attempted: 0,
    synced: 0,
    needsAttention: 0,
    errored: 0,
    stoppedBy: "completed" as const,
  };
}

describe("createSyncRunner — pull/push decoupling (KASA-347)", () => {
  let database: Awaited<ReturnType<typeof freshDatabase>>;
  beforeEach(async () => {
    pullAllMock.mockReset();
    database = await freshDatabase();
  });
  afterEach(async () => {
    database.close();
    await Dexie.delete(database.name);
  });

  it("trigger() still drains push exactly once when pull throws a non-offline error", async () => {
    // Regression guard: before KASA-347, a pull-side throw short-circuited
    // the same cycle's push, so locally-queued mutations stayed pinned in
    // the outbox until the next 60s tick.
    pullAllMock.mockRejectedValueOnce(new Error("boom: transient pull error"));
    const status = createSyncStatusStore();
    const pushImpl = vi.fn(async () => noopPushResult());
    const pushShiftsImpl = vi.fn(async () => noopPushResult());
    const pushCatalogImpl = vi.fn(async () => noopPushResult());
    const pushVoidsImpl = vi.fn(async () => noopPushResult());

    const runner = createSyncRunner({
      database,
      baseUrl: "https://api.kassa.test",
      status,
      onlineSource: { isOnline: () => true, subscribe: () => () => {} },
      pushImpl,
      pushShiftsImpl,
      pushCatalogImpl,
      pushVoidsImpl,
    });

    const result = await runner.trigger();

    expect(pullAllMock).toHaveBeenCalledTimes(1);
    expect(pushShiftsImpl).toHaveBeenCalledTimes(1);
    expect(pushCatalogImpl).toHaveBeenCalledTimes(1);
    expect(pushImpl).toHaveBeenCalledTimes(1);
    expect(pushVoidsImpl).toHaveBeenCalledTimes(1);
    expect(result).not.toBeNull();
    expect(result?.pull).toBeNull();
    expect(result?.push).not.toBeNull();
  });

  it("trigger() early-returns and skips push when pull throws SyncOfflineError", async () => {
    pullAllMock.mockRejectedValueOnce(new SyncOfflineError());
    const status = createSyncStatusStore();
    const pushImpl = vi.fn(async () => noopPushResult());
    const pushShiftsImpl = vi.fn(async () => noopPushResult());
    const pushCatalogImpl = vi.fn(async () => noopPushResult());
    const pushVoidsImpl = vi.fn(async () => noopPushResult());

    const runner = createSyncRunner({
      database,
      baseUrl: "https://api.kassa.test",
      status,
      onlineSource: { isOnline: () => true, subscribe: () => () => {} },
      pushImpl,
      pushShiftsImpl,
      pushCatalogImpl,
      pushVoidsImpl,
    });

    const result = await runner.trigger();

    expect(pullAllMock).toHaveBeenCalledTimes(1);
    expect(pushShiftsImpl).not.toHaveBeenCalled();
    expect(pushCatalogImpl).not.toHaveBeenCalled();
    expect(pushImpl).not.toHaveBeenCalled();
    expect(pushVoidsImpl).not.toHaveBeenCalled();
    expect(status.get().phase).toEqual({ kind: "offline" });
    // SyncOfflineError takes the inner early-return path, which still
    // resolves with the cycle envelope (both legs null) — not the
    // top-level Promise<null> reserved for "offline before pull".
    expect(result).not.toBeNull();
    expect(result?.pull).toBeNull();
    expect(result?.push).toBeNull();
  });

  it("clears inFlight in finally so a follow-up trigger() runs a fresh cycle (non-offline pull error)", async () => {
    // Two back-to-back cycles. If inFlight were not cleared in the
    // runner's finally, the second trigger() would return the resolved
    // first promise and pullAll would only run once.
    pullAllMock.mockRejectedValueOnce(new Error("boom one"));
    pullAllMock.mockRejectedValueOnce(new Error("boom two"));
    const status = createSyncStatusStore();
    const pushImpl = vi.fn(async () => noopPushResult());
    const pushShiftsImpl = vi.fn(async () => noopPushResult());
    const pushCatalogImpl = vi.fn(async () => noopPushResult());
    const pushVoidsImpl = vi.fn(async () => noopPushResult());

    const runner = createSyncRunner({
      database,
      baseUrl: "https://api.kassa.test",
      status,
      onlineSource: { isOnline: () => true, subscribe: () => () => {} },
      pushImpl,
      pushShiftsImpl,
      pushCatalogImpl,
      pushVoidsImpl,
    });

    await runner.trigger();
    await runner.trigger();

    expect(pullAllMock).toHaveBeenCalledTimes(2);
    expect(pushImpl).toHaveBeenCalledTimes(2);
  });

  it("clears inFlight in finally so a follow-up trigger() runs a fresh cycle (SyncOfflineError)", async () => {
    pullAllMock.mockRejectedValueOnce(new SyncOfflineError());
    pullAllMock.mockRejectedValueOnce(new SyncOfflineError());
    const status = createSyncStatusStore();
    const pushImpl = vi.fn(async () => noopPushResult());

    const runner = createSyncRunner({
      database,
      baseUrl: "https://api.kassa.test",
      status,
      onlineSource: { isOnline: () => true, subscribe: () => () => {} },
      pushImpl,
    });

    await runner.trigger();
    await runner.trigger();

    expect(pullAllMock).toHaveBeenCalledTimes(2);
    expect(pushImpl).not.toHaveBeenCalled();
  });
});

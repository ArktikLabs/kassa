import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Dexie from "dexie";
import { createRepos, DB_NAME } from "../db/index.ts";
import { KassaDexie, openKassaDb } from "../db/schema.ts";
import { createSyncRunner } from "./runner.ts";
import { createSyncStatusStore } from "./status.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function emptyEnvelope() {
  return { records: [], nextCursor: null, nextPageToken: null };
}

async function freshDatabase() {
  const name = `${DB_NAME}-runner-${Math.random().toString(36).slice(2)}`;
  await Dexie.delete(name);
  const db = (await openKassaDb(name)) as KassaDexie;
  return {
    name,
    db,
    repos: createRepos(db),
    close: () => db.close(),
  };
}

describe("createSyncRunner", () => {
  let database: Awaited<ReturnType<typeof freshDatabase>>;
  beforeEach(async () => {
    database = await freshDatabase();
  });
  afterEach(async () => {
    database.close();
    await Dexie.delete(database.name);
  });

  it("trigger() no-ops and marks offline when isOnline returns false", async () => {
    const status = createSyncStatusStore();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const onlineHandlers: Array<(online: boolean) => void> = [];
    const runner = createSyncRunner({
      database,
      baseUrl: "https://api.kassa.test",
      status,
      fetchImpl,
      onlineSource: {
        isOnline: () => false,
        subscribe: (listener) => {
          onlineHandlers.push(listener);
          return () => {};
        },
      },
    });
    const result = await runner.trigger();
    expect(result).toBeNull();
    expect(status.get().phase).toEqual({ kind: "offline" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns the in-flight promise when trigger() is called concurrently", async () => {
    const status = createSyncStatusStore();
    const fetchImpl = vi.fn(async () =>
      jsonResponse(emptyEnvelope()),
    ) as unknown as typeof fetch;
    const runner = createSyncRunner({
      database,
      baseUrl: "https://api.kassa.test",
      status,
      fetchImpl,
      onlineSource: { isOnline: () => true, subscribe: () => () => {} },
    });
    const p1 = runner.trigger();
    const p2 = runner.trigger();
    expect(p1).toBe(p2);
    await p1;
  });
});

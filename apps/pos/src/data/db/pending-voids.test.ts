import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepos, type Repos } from "./index.ts";
import { type KassaDexie, openKassaDb } from "./schema.ts";
import type { NewPendingVoid } from "./pending-voids.ts";

let dbCounter = 0;
function nextDbName(): string {
  dbCounter += 1;
  return `kassa-pos-voids-test-${dbCounter}-${Math.random().toString(36).slice(2, 10)}`;
}

interface Fixture {
  name: string;
  db: KassaDexie;
  repos: Repos;
}

async function setupFixture(): Promise<Fixture> {
  const name = nextDbName();
  const db = await openKassaDb(name);
  return { name, db, repos: createRepos(db) };
}

async function teardownFixture(fixture: Fixture): Promise<void> {
  fixture.db.close();
  await Dexie.delete(fixture.name);
}

function makeVoid(overrides: Partial<NewPendingVoid> & { localVoidId: string }): NewPendingVoid {
  return {
    localVoidId: overrides.localVoidId,
    saleId: overrides.saleId ?? "sale-server-id",
    localSaleId: overrides.localSaleId ?? "sale-local-id",
    outletId: overrides.outletId ?? "outlet-a",
    managerStaffId: overrides.managerStaffId ?? "staff-mgr-1",
    managerPin: overrides.managerPin ?? "1234",
    voidedAt: overrides.voidedAt ?? "2026-05-12T09:30:00.000Z",
    voidBusinessDate: overrides.voidBusinessDate ?? "2026-05-12",
    reason: overrides.reason ?? null,
    createdAt: overrides.createdAt ?? "2026-05-12T09:30:00.000Z",
  };
}

describe("pendingVoidsRepo", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await setupFixture();
  });

  afterEach(async () => {
    await teardownFixture(fixture);
  });

  it("enqueue stamps the lifecycle defaults", async () => {
    const row = await fixture.repos.pendingVoids.enqueue(makeVoid({ localVoidId: "v1" }));
    expect(row).toMatchObject({
      localVoidId: "v1",
      status: "queued",
      attempts: 0,
      lastError: null,
      lastAttemptAt: null,
    });
    await expect(fixture.repos.pendingVoids.getById("v1")).resolves.toMatchObject({
      status: "queued",
    });
  });

  it("getActiveForSale returns the latest non-synced row", async () => {
    // Two attempts against the same sale; the older one was already synced
    // (a no-op race), the newer is queued. We should land on the newer.
    await fixture.repos.pendingVoids.enqueue(
      makeVoid({ localVoidId: "v-old", createdAt: "2026-05-12T09:00:00.000Z" }),
    );
    await fixture.repos.pendingVoids.markSynced("v-old", "2026-05-12T09:01:00.000Z");
    await fixture.repos.pendingVoids.enqueue(
      makeVoid({ localVoidId: "v-new", createdAt: "2026-05-12T09:05:00.000Z" }),
    );

    const active = await fixture.repos.pendingVoids.getActiveForSale("sale-local-id");
    expect(active?.localVoidId).toBe("v-new");
  });

  it("listDrainable returns queued + error rows, oldest first, excludes synced/needs_attention/sending", async () => {
    await fixture.repos.pendingVoids.enqueue(
      makeVoid({ localVoidId: "v1", createdAt: "2026-05-12T09:00:00.000Z" }),
    );
    await fixture.repos.pendingVoids.enqueue(
      makeVoid({ localVoidId: "v2", createdAt: "2026-05-12T09:01:00.000Z" }),
    );
    await fixture.repos.pendingVoids.enqueue(
      makeVoid({ localVoidId: "v3", createdAt: "2026-05-12T09:02:00.000Z" }),
    );
    await fixture.repos.pendingVoids.enqueue(
      makeVoid({ localVoidId: "v4", createdAt: "2026-05-12T09:03:00.000Z" }),
    );

    await fixture.repos.pendingVoids.markError("v2", "boom", "2026-05-12T09:01:30.000Z");
    await fixture.repos.pendingVoids.markSynced("v3", "2026-05-12T09:02:30.000Z");
    await fixture.repos.pendingVoids.markNeedsAttention(
      "v4",
      "manager pin",
      "2026-05-12T09:03:30.000Z",
    );

    const drainable = await fixture.repos.pendingVoids.listDrainable();
    expect(drainable.map((r) => r.localVoidId)).toEqual(["v1", "v2"]);
  });

  it("markSending transitions queued → sending and stamps lastAttemptAt", async () => {
    await fixture.repos.pendingVoids.enqueue(makeVoid({ localVoidId: "v1" }));
    await fixture.repos.pendingVoids.markSending("v1", "2026-05-12T10:00:00.000Z");
    const row = await fixture.repos.pendingVoids.getById("v1");
    expect(row?.status).toBe("sending");
    expect(row?.lastAttemptAt).toBe("2026-05-12T10:00:00.000Z");
  });

  it("markError increments attempts and records the error", async () => {
    await fixture.repos.pendingVoids.enqueue(makeVoid({ localVoidId: "v1" }));
    await fixture.repos.pendingVoids.markError("v1", "503 upstream", "2026-05-12T10:00:00.000Z");
    await fixture.repos.pendingVoids.markError("v1", "504 again", "2026-05-12T10:01:00.000Z");
    const row = await fixture.repos.pendingVoids.getById("v1");
    expect(row?.status).toBe("error");
    expect(row?.attempts).toBe(2);
    expect(row?.lastError).toBe("504 again");
  });

  it("markNeedsAttention is terminal — attempts increments, error sticks", async () => {
    await fixture.repos.pendingVoids.enqueue(makeVoid({ localVoidId: "v1" }));
    await fixture.repos.pendingVoids.markNeedsAttention(
      "v1",
      "403 manager pin",
      "2026-05-12T10:00:00.000Z",
    );
    const row = await fixture.repos.pendingVoids.getById("v1");
    expect(row?.status).toBe("needs_attention");
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toBe("403 manager pin");
  });

  it("markSynced clears lastError and stamps lastAttemptAt", async () => {
    await fixture.repos.pendingVoids.enqueue(makeVoid({ localVoidId: "v1" }));
    await fixture.repos.pendingVoids.markError("v1", "503", "2026-05-12T10:00:00.000Z");
    await fixture.repos.pendingVoids.markSynced("v1", "2026-05-12T10:05:00.000Z");
    const row = await fixture.repos.pendingVoids.getById("v1");
    expect(row?.status).toBe("synced");
    expect(row?.lastError).toBeNull();
    expect(row?.lastAttemptAt).toBe("2026-05-12T10:05:00.000Z");
  });

  it("countOutstanding ignores synced + needs_attention", async () => {
    await fixture.repos.pendingVoids.enqueue(makeVoid({ localVoidId: "v1" }));
    await fixture.repos.pendingVoids.enqueue(makeVoid({ localVoidId: "v2" }));
    await fixture.repos.pendingVoids.enqueue(makeVoid({ localVoidId: "v3" }));
    await fixture.repos.pendingVoids.enqueue(makeVoid({ localVoidId: "v4" }));
    await fixture.repos.pendingVoids.markSending("v2", "2026-05-12T10:00:00.000Z");
    await fixture.repos.pendingVoids.markError("v3", "boom", "2026-05-12T10:00:00.000Z");
    await fixture.repos.pendingVoids.markSynced("v4", "2026-05-12T10:00:00.000Z");

    await expect(fixture.repos.pendingVoids.countOutstanding()).resolves.toBe(3);
  });

  it("resetInFlight flips sending rows back to queued after a tab kill", async () => {
    await fixture.repos.pendingVoids.enqueue(makeVoid({ localVoidId: "v1" }));
    await fixture.repos.pendingVoids.enqueue(makeVoid({ localVoidId: "v2" }));
    await fixture.repos.pendingVoids.markSending("v1", "2026-05-12T10:00:00.000Z");
    await fixture.repos.pendingVoids.markSending("v2", "2026-05-12T10:00:00.000Z");

    await expect(fixture.repos.pendingVoids.resetInFlight()).resolves.toBe(2);
    const drainable = await fixture.repos.pendingVoids.listDrainable();
    expect(drainable.map((r) => r.localVoidId).sort()).toEqual(["v1", "v2"]);
  });
});

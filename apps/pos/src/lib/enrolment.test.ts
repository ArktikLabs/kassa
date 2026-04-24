import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Dexie from "dexie";
import {
  _resetDatabaseSingletonForTest,
  DB_NAME,
  getDatabase,
} from "../data/db/index";
import {
  _resetForTest,
  enrolDevice,
  getSnapshot,
  hydrateEnrolment,
  isEnrolled,
  resetDevice,
} from "./enrolment";
import { EnrolApiError } from "../data/api/enrolment";

const VALID_CODE = "ABCD2345";

function mockFetchOk(): Response {
  return new Response(
    JSON.stringify({
      deviceId: "11111111-1111-1111-1111-111111111111",
      apiKey: "pk_live_test",
      apiSecret: "sk_live_test",
      outlet: { id: "outlet-1", name: "Warung Maju" },
      merchant: { id: "merchant-1", name: "Toko Maju" },
    }),
    { status: 201, headers: { "content-type": "application/json" } },
  );
}

function mockFetchError(status: number, code: string, message = "nope"): Response {
  return new Response(
    JSON.stringify({ error: { code, message } }),
    { status, headers: { "content-type": "application/json" } },
  );
}

describe("enrolment lib", () => {
  beforeEach(async () => {
    _resetForTest();
    _resetDatabaseSingletonForTest();
    await Dexie.delete(DB_NAME);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts in loading state and resolves to unenrolled with no stored secret", async () => {
    expect(getSnapshot()).toEqual({ state: "loading" });
    const snap = await hydrateEnrolment();
    expect(snap).toEqual({ state: "unenrolled" });
    expect(isEnrolled()).toBe(false);
  });

  it("enrolDevice persists the secret to Dexie and publishes an enrolled snapshot", async () => {
    await hydrateEnrolment();
    vi.stubGlobal("fetch", vi.fn(async () => mockFetchOk()));

    const device = await enrolDevice(VALID_CODE);

    expect(device.outlet.name).toBe("Warung Maju");
    const { repos } = await getDatabase();
    const row = await repos.deviceSecret.get();
    expect(row?.apiKey).toBe("pk_live_test");
    expect(row?.apiSecret).toBe("sk_live_test");
    expect(row?.outletName).toBe("Warung Maju");
    expect(isEnrolled()).toBe(true);

    // Fingerprint is persisted so retries reuse the same value.
    const meta = await repos.deviceMeta.get();
    expect(meta?.fingerprint).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("never writes the device secret to localStorage", async () => {
    await hydrateEnrolment();
    vi.stubGlobal("fetch", vi.fn(async () => mockFetchOk()));
    await enrolDevice(VALID_CODE);
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      const value = localStorage.getItem(key) ?? "";
      expect(value).not.toContain("pk_live_test");
      expect(value).not.toContain("sk_live_test");
    }
  });

  it("maps 410 code_expired to EnrolApiError with code_expired", async () => {
    await hydrateEnrolment();
    vi.stubGlobal("fetch", vi.fn(async () => mockFetchError(410, "code_expired", "expired")));

    await expect(enrolDevice(VALID_CODE)).rejects.toMatchObject({
      name: "EnrolApiError",
      code: "code_expired",
    });
    expect(isEnrolled()).toBe(false);
  });

  it("maps 410 code_already_used to EnrolApiError", async () => {
    await hydrateEnrolment();
    vi.stubGlobal("fetch", vi.fn(async () => mockFetchError(410, "code_already_used", "used")));
    await expect(enrolDevice(VALID_CODE)).rejects.toBeInstanceOf(EnrolApiError);
  });

  it("maps 404 code_not_found to EnrolApiError", async () => {
    await hydrateEnrolment();
    vi.stubGlobal("fetch", vi.fn(async () => mockFetchError(404, "code_not_found", "missing")));
    const err = await enrolDevice(VALID_CODE).catch((e) => e);
    expect(err).toBeInstanceOf(EnrolApiError);
    expect((err as EnrolApiError).code).toBe("code_not_found");
  });

  it("surfaces network failures as network_error", async () => {
    await hydrateEnrolment();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("failed to fetch");
      }),
    );
    const err = await enrolDevice(VALID_CODE).catch((e) => e);
    expect(err).toBeInstanceOf(EnrolApiError);
    expect((err as EnrolApiError).code).toBe("network_error");
  });

  it("resetDevice clears the stored secret and emits unenrolled", async () => {
    await hydrateEnrolment();
    vi.stubGlobal("fetch", vi.fn(async () => mockFetchOk()));
    await enrolDevice(VALID_CODE);
    expect(isEnrolled()).toBe(true);

    await resetDevice();

    expect(isEnrolled()).toBe(false);
    const { repos } = await getDatabase();
    expect(await repos.deviceSecret.get()).toBeUndefined();
    // Fingerprint persists across reset so the re-enrolment can still
    // correlate to the tablet's prior audit log.
    const meta = await repos.deviceMeta.get();
    expect(meta).toBeDefined();
  });

  it("reuses the persisted fingerprint across enrolment attempts", async () => {
    await hydrateEnrolment();
    const captured: Array<{ deviceFingerprint: string }> = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      captured.push(JSON.parse(String(init.body)) as { deviceFingerprint: string });
      return mockFetchOk();
    });
    vi.stubGlobal("fetch", fetchMock);

    await enrolDevice(VALID_CODE);
    await resetDevice();
    await enrolDevice(VALID_CODE);

    expect(captured).toHaveLength(2);
    expect(captured[0]?.deviceFingerprint).toBe(captured[1]?.deviceFingerprint);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

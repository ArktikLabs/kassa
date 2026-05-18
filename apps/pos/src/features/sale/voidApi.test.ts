import { describe, expect, it, vi } from "vitest";
import { voidSale, type VoidSaleApiRequest } from "./voidApi.ts";

function makeRequest(overrides: Partial<VoidSaleApiRequest> = {}): VoidSaleApiRequest {
  return {
    saleId: overrides.saleId ?? "01940000-0000-7000-8000-00000000beef",
    localVoidId: overrides.localVoidId ?? "01940000-0000-7000-8000-00000000feed",
    managerStaffId: overrides.managerStaffId ?? "01940000-0000-7000-8000-000000005ff5",
    managerPin: overrides.managerPin ?? "1234",
    voidedAt: overrides.voidedAt ?? "2026-05-12T09:30:00.000Z",
    voidBusinessDate: overrides.voidBusinessDate ?? "2026-05-12",
    reason: overrides.reason ?? null,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const auth = { apiKey: "k", apiSecret: "s" };

describe("voidSale status-code mapping", () => {
  it("200 → synced", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ id: "x", saleId: "x", voidedAt: "2026-05-12T09:30:00.000Z" }),
    ) as unknown as typeof fetch;
    const result = await voidSale(makeRequest(), {
      baseUrl: "https://api.kassa.test",
      auth,
      fetchImpl,
    });
    expect(result.kind).toBe("synced");
  });

  it("201 → synced (server may return 201 on first apply)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ id: "x", saleId: "x", voidedAt: "2026-05-12T09:30:00.000Z" }, 201),
    ) as unknown as typeof fetch;
    const result = await voidSale(makeRequest(), {
      baseUrl: "https://api.kassa.test",
      auth,
      fetchImpl,
    });
    expect(result.kind).toBe("synced");
  });

  it("403 → manager_pin_required", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: "manager_pin_required", message: "wrong PIN" } }, 403),
    ) as unknown as typeof fetch;
    const result = await voidSale(makeRequest(), {
      baseUrl: "https://api.kassa.test",
      auth,
      fetchImpl,
    });
    expect(result.kind).toBe("manager_pin_required");
    if (result.kind === "manager_pin_required") {
      expect(result.status).toBe(403);
      expect(result.message).toBe("wrong PIN");
    }
  });

  it("422 void_outside_open_shift → outside_open_shift", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: "void_outside_open_shift", message: "shift mismatch" } }, 422),
    ) as unknown as typeof fetch;
    const result = await voidSale(makeRequest(), {
      baseUrl: "https://api.kassa.test",
      auth,
      fetchImpl,
    });
    expect(result.kind).toBe("outside_open_shift");
  });

  it("422 sale_voided → already_voided", async () => {
    // Cross-device race: another tab already voided this sale. The server
    // returns 422 with code `sale_voided`. Map it to a friendly outcome.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: "sale_voided", message: "already voided" } }, 422),
    ) as unknown as typeof fetch;
    const result = await voidSale(makeRequest(), {
      baseUrl: "https://api.kassa.test",
      auth,
      fetchImpl,
    });
    expect(result.kind).toBe("already_voided");
    if (result.kind === "already_voided") {
      expect(result.status).toBe(422);
    }
  });

  it("422 with an unknown code → rejected (carries code+message)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: "some_other_thing", message: "bad" } }, 422),
    ) as unknown as typeof fetch;
    const result = await voidSale(makeRequest(), {
      baseUrl: "https://api.kassa.test",
      auth,
      fetchImpl,
    });
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.status).toBe(422);
      expect(result.code).toBe("some_other_thing");
      expect(result.message).toBe("bad");
    }
  });

  it("409 → rejected (terminal, idempotency conflict)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: "void_idempotency_conflict", message: "dup" } }, 409),
    ) as unknown as typeof fetch;
    const result = await voidSale(makeRequest(), {
      baseUrl: "https://api.kassa.test",
      auth,
      fetchImpl,
    });
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.status).toBe(409);
  });

  it.each([408, 429, 500, 502, 503, 504])("%d → retriable", async (status) => {
    const fetchImpl = vi.fn(
      async () => new Response("{}", { status, headers: { "content-type": "application/json" } }),
    ) as unknown as typeof fetch;
    const result = await voidSale(makeRequest(), {
      baseUrl: "https://api.kassa.test",
      auth,
      fetchImpl,
    });
    expect(result.kind).toBe("retriable");
    if (result.kind === "retriable") expect(result.status).toBe(status);
  });

  it("network error → offline (carries underlying message)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const result = await voidSale(makeRequest(), {
      baseUrl: "https://api.kassa.test",
      auth,
      fetchImpl,
    });
    expect(result.kind).toBe("offline");
    if (result.kind === "offline") expect(result.reason).toBe("fetch failed");
  });

  it("POSTs the canonical wire payload + auth headers + path", async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) =>
      jsonResponse({ id: "x", saleId: "x", voidedAt: "2026-05-12T09:30:00.000Z" }),
    );
    await voidSale(makeRequest({ reason: "salah input", saleId: "sale-uuid" }), {
      baseUrl: "https://api.kassa.test",
      auth,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("https://api.kassa.test/v1/sales/sale-uuid/void");
    const reqInit = init;
    expect(reqInit.method).toBe("POST");
    const headers = reqInit.headers as Record<string, string>;
    expect(headers["x-kassa-api-key"]).toBe("k");
    expect(headers["x-kassa-api-secret"]).toBe("s");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(reqInit.body!))).toEqual({
      localVoidId: "01940000-0000-7000-8000-00000000feed",
      managerStaffId: "01940000-0000-7000-8000-000000005ff5",
      managerPin: "1234",
      voidedAt: "2026-05-12T09:30:00.000Z",
      voidBusinessDate: "2026-05-12",
      reason: "salah input",
    });
  });

  it("omits `reason` from the wire payload when it is null", async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) =>
      jsonResponse({ id: "x", saleId: "x", voidedAt: "2026-05-12T09:30:00.000Z" }),
    );
    await voidSale(makeRequest({ reason: null }), {
      baseUrl: "https://api.kassa.test",
      auth,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body!));
    expect(body).not.toHaveProperty("reason");
  });

  it("falls back to `http <status>` when the error body is unparseable", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("not json", { status: 403 }),
    ) as unknown as typeof fetch;
    const result = await voidSale(makeRequest(), {
      baseUrl: "https://api.kassa.test",
      auth,
      fetchImpl,
    });
    expect(result.kind).toBe("manager_pin_required");
    if (result.kind === "manager_pin_required") {
      expect(result.message).toBe("http 403");
    }
  });
});

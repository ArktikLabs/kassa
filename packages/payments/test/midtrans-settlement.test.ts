import { describe, expect, it } from "vitest";
import { createMidtransProvider } from "../src/providers/midtrans.js";
import { PaymentProviderError } from "../src/types.js";

const SERVER_KEY = "SB-Mid-server-test-integration-0000000000";

function stubFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : String((input as { url?: unknown })?.url ?? "");
    return handler(url, init);
  }) as unknown as typeof fetch;
}

describe("midtrans.fetchQrisSettlements", () => {
  it("rejects a non-YYYY-MM-DD businessDate before hitting the network", async () => {
    let called = false;
    const provider = createMidtransProvider({
      serverKey: SERVER_KEY,
      fetchImpl: stubFetch(() => {
        called = true;
        return new Response("{}", { status: 200 });
      }),
    });
    await expect(provider.fetchQrisSettlements({ businessDate: "2026/04/22" })).rejects.toThrow(
      PaymentProviderError,
    );
    expect(called).toBe(false);
  });

  it("encodes from/to/payment_type/page in the URL and sends Basic auth", async () => {
    let capturedUrl = "";
    let capturedAuth: string | null = null;
    const provider = createMidtransProvider({
      serverKey: SERVER_KEY,
      fetchImpl: stubFetch((url, init) => {
        capturedUrl = url;
        capturedAuth =
          (init?.headers as Record<string, string>)?.Authorization ??
          (init?.headers as Record<string, string>)?.authorization ??
          null;
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    });

    await provider.fetchQrisSettlements({ businessDate: "2026-04-22" });

    expect(capturedUrl.startsWith("https://api.sandbox.midtrans.com/v1/payouts/settlement?")).toBe(
      true,
    );
    expect(capturedUrl).toContain("from=2026-04-22");
    expect(capturedUrl).toContain("to=2026-04-22");
    expect(capturedUrl).toContain("payment_type=qris");
    expect(capturedUrl).toContain("page=1");
    expect(capturedAuth).toMatch(/^Basic /);
  });

  it("parses one settlement row, normalising the Midtrans Asia/Jakarta timestamp to ISO-8601 with offset", async () => {
    const provider = createMidtransProvider({
      serverKey: SERVER_KEY,
      fetchImpl: stubFetch(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              data: [
                {
                  transaction_id: "mt-txn-001",
                  gross_amount: "25000",
                  settlement_time: "2026-04-22 13:32:30",
                  transaction_reference: "REF-9876541234",
                  custom_field1: "outlet-jaksel",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      ),
    });

    const rows = await provider.fetchQrisSettlements({ businessDate: "2026-04-22" });

    expect(rows).toEqual([
      {
        providerTransactionId: "mt-txn-001",
        grossAmountIdr: 25_000,
        last4: "1234",
        settledAt: "2026-04-22T13:32:30+07:00",
        outletId: "outlet-jaksel",
      },
    ]);
  });

  it("falls back to transaction_time when settlement_time is missing", async () => {
    const provider = createMidtransProvider({
      serverKey: SERVER_KEY,
      fetchImpl: stubFetch(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              data: [
                {
                  transaction_id: "mt-002",
                  gross_amount: "12000",
                  transaction_time: "2026-04-22 14:01:05",
                  reference_id: "00009999",
                  custom_field1: "outlet-A",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      ),
    });

    const rows = await provider.fetchQrisSettlements({ businessDate: "2026-04-22" });

    expect(rows[0]?.settledAt).toBe("2026-04-22T14:01:05+07:00");
    expect(rows[0]?.last4).toBe("9999");
  });

  it("extracts last4 from va_numbers when neither reference field is present", async () => {
    const provider = createMidtransProvider({
      serverKey: SERVER_KEY,
      fetchImpl: stubFetch(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              data: [
                {
                  transaction_id: "mt-003",
                  gross_amount: "50000",
                  settlement_time: "2026-04-22 15:00:00",
                  va_numbers: [{ va_number: "00012345-7890" }],
                  custom_field1: "outlet-B",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      ),
    });

    const rows = await provider.fetchQrisSettlements({ businessDate: "2026-04-22" });
    expect(rows[0]?.last4).toBe("7890");
  });

  it("skips rows missing a parseable last4 or outlet identifier", async () => {
    const provider = createMidtransProvider({
      serverKey: SERVER_KEY,
      fetchImpl: stubFetch(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              data: [
                {
                  transaction_id: "mt-no-ref",
                  gross_amount: "10000",
                  settlement_time: "2026-04-22 09:00:00",
                  custom_field1: "outlet-X",
                  // no transaction_reference / reference_id / va_numbers
                },
                {
                  transaction_id: "mt-no-outlet",
                  gross_amount: "10000",
                  settlement_time: "2026-04-22 09:01:00",
                  transaction_reference: "REF-1111",
                  // no custom_field1
                },
                {
                  transaction_id: "mt-good",
                  gross_amount: "10000",
                  settlement_time: "2026-04-22 09:02:00",
                  transaction_reference: "REF-2222",
                  custom_field1: "outlet-X",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      ),
    });

    const rows = await provider.fetchQrisSettlements({ businessDate: "2026-04-22" });
    expect(rows.map((r) => r.providerTransactionId)).toEqual(["mt-good"]);
  });

  it("paginates: keeps fetching until a page returns fewer than 200 rows", async () => {
    const calls: number[] = [];
    const provider = createMidtransProvider({
      serverKey: SERVER_KEY,
      fetchImpl: stubFetch((url) => {
        const page = Number.parseInt(new URL(url).searchParams.get("page") ?? "0", 10);
        calls.push(page);
        // Page 1 returns a full page, page 2 returns the tail (1 row).
        const pageSize = page === 1 ? 200 : 1;
        const data = Array.from({ length: pageSize }, (_v, i) => ({
          transaction_id: `mt-${page}-${i}`,
          gross_amount: "1000",
          settlement_time: "2026-04-22 10:00:00",
          transaction_reference: `REF-${String(i).padStart(4, "0")}`,
          custom_field1: "outlet-A",
        }));
        return new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    });

    const rows = await provider.fetchQrisSettlements({ businessDate: "2026-04-22" });
    expect(calls).toEqual([1, 2]);
    expect(rows).toHaveLength(201);
  });

  it("surfaces a non-2xx response as PaymentProviderError", async () => {
    const provider = createMidtransProvider({
      serverKey: SERVER_KEY,
      fetchImpl: stubFetch(() =>
        Promise.resolve(
          new Response(JSON.stringify({ status_message: "Forbidden" }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    });

    await expect(provider.fetchQrisSettlements({ businessDate: "2026-04-22" })).rejects.toThrow(
      /Forbidden/,
    );
  });

  it("forwards merchantId as a query param when supplied", async () => {
    let capturedUrl = "";
    const provider = createMidtransProvider({
      serverKey: SERVER_KEY,
      fetchImpl: stubFetch((url) => {
        capturedUrl = url;
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    });

    await provider.fetchQrisSettlements({
      businessDate: "2026-04-22",
      merchantId: "M-007",
    });

    expect(capturedUrl).toContain("merchant_id=M-007");
  });
});

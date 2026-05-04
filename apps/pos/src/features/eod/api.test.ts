import { describe, expect, it } from "vitest";
import type { EodCloseRequest } from "@kassa/schemas/eod";
import { EodAlreadyClosedError, EodVarianceReasonRequiredError, closeEod } from "./api.ts";

const REQUEST: EodCloseRequest = {
  outletId: "01890abc-1234-7def-8000-000000000001",
  businessDate: "2026-04-23",
  countedCashIdr: 0,
  varianceReason: null,
  clientSaleIds: [],
};
const AUTH = { apiKey: "ak", apiSecret: "as" };

function makeFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init ?? {});
  }) as typeof fetch;
}

describe("closeEod", () => {
  it("parses a 201 into the canonical EodCloseResponse", async () => {
    const res = await closeEod(REQUEST, {
      baseUrl: "https://api.example",
      auth: AUTH,
      fetchImpl: makeFetch(
        () =>
          new Response(
            JSON.stringify({
              eodId: "01890abc-1234-7def-8000-00000000e001",
              outletId: REQUEST.outletId,
              businessDate: REQUEST.businessDate,
              closedAt: "2026-04-23T18:00:00+07:00",
              countedCashIdr: 0,
              expectedCashIdr: 0,
              varianceIdr: 0,
              varianceReason: null,
              breakdown: {
                saleCount: 0,
                voidCount: 0,
                cashIdr: 0,
                qrisDynamicIdr: 0,
                qrisStaticIdr: 0,
                qrisStaticUnverifiedIdr: 0,
                qrisStaticUnverifiedCount: 0,
                cardIdr: 0,
                otherIdr: 0,
                netIdr: 0,
              },
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          ),
      ),
    });
    expect(res.varianceIdr).toBe(0);
  });

  it("maps 409 eod_sale_mismatch into EodMismatchError with the missing ids", async () => {
    const missingId = "01890abc-1234-7def-8000-000000000999";
    await expect(
      closeEod(REQUEST, {
        baseUrl: "https://api.example",
        auth: AUTH,
        fetchImpl: makeFetch(
          () =>
            new Response(
              JSON.stringify({
                error: {
                  code: "eod_sale_mismatch",
                  message: "1 sale missing",
                  details: { expectedCount: 1, receivedCount: 0, missingSaleIds: [missingId] },
                },
              }),
              { status: 409, headers: { "content-type": "application/json" } },
            ),
        ),
      }),
    ).rejects.toMatchObject({
      name: "EodMismatchError",
      details: { missingSaleIds: [missingId] },
    });
  });

  it("maps 409 eod_already_closed into EodAlreadyClosedError", async () => {
    await expect(
      closeEod(REQUEST, {
        baseUrl: "https://api.example",
        auth: AUTH,
        fetchImpl: makeFetch(
          () =>
            new Response(
              JSON.stringify({
                error: { code: "eod_already_closed", message: "already closed" },
              }),
              { status: 409 },
            ),
        ),
      }),
    ).rejects.toBeInstanceOf(EodAlreadyClosedError);
  });

  it("maps 422 into EodVarianceReasonRequiredError", async () => {
    await expect(
      closeEod(REQUEST, {
        baseUrl: "https://api.example",
        auth: AUTH,
        fetchImpl: makeFetch(() => new Response(null, { status: 422 })),
      }),
    ).rejects.toBeInstanceOf(EodVarianceReasonRequiredError);
  });

  it("wraps network failures in EodCloseError(network)", async () => {
    await expect(
      closeEod(REQUEST, {
        baseUrl: "https://api.example",
        auth: AUTH,
        fetchImpl: makeFetch(() => {
          throw new Error("boom");
        }),
      }),
    ).rejects.toMatchObject({ name: "EodCloseError", code: "network" });
  });

  it("maps 500 into EodCloseError(server_error)", async () => {
    await expect(
      closeEod(REQUEST, {
        baseUrl: "https://api.example",
        auth: AUTH,
        fetchImpl: makeFetch(() => new Response(null, { status: 503 })),
      }),
    ).rejects.toMatchObject({ name: "EodCloseError", code: "server_error" });
  });
});

import type { EodCloseRequest, EodCloseResponse, EodMissingSalesDetails } from "@kassa/schemas/eod";

/*
 * Thin client for POST /v1/eod/close. The network shape and error taxonomy
 * mirror the server's `eodRoutes` in apps/api/src/routes/eod.ts. Anything
 * the UI should react to specifically — mismatch, already-closed,
 * variance-reason-required — is lifted to a concrete error class here so
 * the screen never has to parse HTTP codes.
 */

export const EOD_CLOSE_PATH = "/v1/eod/close";

export interface EodCloseAuth {
  apiKey: string;
  apiSecret: string;
}

export interface EodCloseOptions {
  baseUrl: string;
  auth: EodCloseAuth;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export class EodCloseError extends Error {
  constructor(
    readonly code: "network" | "bad_request" | "unauthorized" | "server_error" | "unknown",
    message: string,
  ) {
    super(message);
    this.name = "EodCloseError";
  }
}

export class EodMismatchError extends Error {
  constructor(readonly details: EodMissingSalesDetails) {
    super(`${details.missingSaleIds.length} sale(s) missing on the server.`);
    this.name = "EodMismatchError";
  }
}

export class EodAlreadyClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EodAlreadyClosedError";
  }
}

export class EodVarianceReasonRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EodVarianceReasonRequiredError";
  }
}

function defaultFetch(): typeof fetch {
  if (typeof fetch !== "function") {
    throw new Error("global fetch is not available; pass options.fetchImpl");
  }
  return fetch;
}

function buildUrl(baseUrl: string): string {
  return new URL(EOD_CLOSE_PATH, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

interface ApiErrorBody {
  code: string | null;
  details: unknown;
}

async function readErrorBody(response: Response): Promise<ApiErrorBody> {
  try {
    const body = (await response.clone().json()) as {
      error?: { code?: unknown; details?: unknown };
    };
    return {
      code: typeof body.error?.code === "string" ? body.error.code : null,
      details: body.error?.details,
    };
  } catch {
    return { code: null, details: undefined };
  }
}

export async function closeEod(
  request: EodCloseRequest,
  opts: EodCloseOptions,
): Promise<EodCloseResponse> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch();
  const url = buildUrl(opts.baseUrl);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-kassa-api-key": opts.auth.apiKey,
        "x-kassa-api-secret": opts.auth.apiSecret,
      },
      body: JSON.stringify(request),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new EodCloseError("network", `network: ${message}`);
  }

  if (response.ok) {
    return (await response.json()) as EodCloseResponse;
  }

  if (response.status === 409) {
    const body = await readErrorBody(response);
    if (body.code === "eod_sale_mismatch") {
      const details = body.details as EodMissingSalesDetails | undefined;
      throw new EodMismatchError(
        details ?? { expectedCount: 0, receivedCount: 0, missingSaleIds: [] },
      );
    }
    throw new EodAlreadyClosedError("End of day is already closed for this outlet and date.");
  }
  if (response.status === 422) {
    throw new EodVarianceReasonRequiredError(
      "A variance reason is required when counted cash does not match expected cash.",
    );
  }
  if (response.status === 400) {
    throw new EodCloseError("bad_request", "Invalid EOD close request.");
  }
  if (response.status === 401 || response.status === 403) {
    throw new EodCloseError("unauthorized", "Device is not authorised to close the day.");
  }
  if (response.status >= 500) {
    throw new EodCloseError("server_error", `Server error (${response.status}).`);
  }
  throw new EodCloseError("unknown", `Unexpected response ${response.status}.`);
}

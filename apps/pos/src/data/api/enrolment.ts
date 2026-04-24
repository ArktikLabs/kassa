/*
 * Device-enrolment API client. Wraps `POST /v1/auth/enroll` — the only
 * unauthenticated endpoint the PWA ever calls. The server contract lives in
 * `packages/schemas/src/auth.ts`; we mirror the response shape here instead
 * of importing the zod package so the client bundle stays runtime-free.
 */
import { apiBaseUrl } from "./config";

export interface DeviceEnrolRequest {
  code: string;
  deviceFingerprint: string;
}

export interface EnrolledDevice {
  deviceId: string;
  apiKey: string;
  apiSecret: string;
  outlet: { id: string; name: string };
  merchant: { id: string; name: string };
}

/**
 * Error codes the API returns. Mirrors `EnrolmentError` in the Fastify service
 * (code_not_found = 404, code_expired/code_already_used = 410). We also emit a
 * synthetic `network_error` when fetch rejects (offline, CORS, DNS, …) and
 * `unknown` for anything else so the UI can still render a Bahasa string.
 */
export type EnrolErrorCode =
  | "code_not_found"
  | "code_expired"
  | "code_already_used"
  | "bad_request"
  | "rate_limited"
  | "network_error"
  | "unknown";

export class EnrolApiError extends Error {
  readonly code: EnrolErrorCode;
  readonly status: number | null;

  constructor(code: EnrolErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "EnrolApiError";
    this.code = code;
    this.status = status;
  }
}

export async function enrolDevice(
  input: DeviceEnrolRequest,
  { signal, fetchImpl }: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<EnrolledDevice> {
  const doFetch = fetchImpl ?? globalThis.fetch.bind(globalThis);
  let response: Response;
  try {
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    };
    if (signal) init.signal = signal;
    response = await doFetch(`${apiBaseUrl()}/v1/auth/enroll`, init);
  } catch (err) {
    throw new EnrolApiError("network_error", err instanceof Error ? err.message : "network error");
  }

  if (response.status === 201) {
    const body = (await response.json()) as EnrolledDevice;
    return body;
  }

  if (response.status === 429) {
    throw new EnrolApiError("rate_limited", "rate limited", 429);
  }

  // The Kassa API wraps errors as `{ error: { code, message } }` — see
  // `apps/api/src/lib/errors.ts`.
  let code: EnrolErrorCode = "unknown";
  let message = `enrolment failed (HTTP ${response.status})`;
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string };
    };
    const bodyCode = body.error?.code;
    if (
      bodyCode === "code_not_found" ||
      bodyCode === "code_expired" ||
      bodyCode === "code_already_used" ||
      bodyCode === "bad_request"
    ) {
      code = bodyCode;
    }
    if (typeof body.error?.message === "string" && body.error.message.length > 0) {
      message = body.error.message;
    }
  } catch {
    // Non-JSON bodies (e.g. Fastify's default rate-limit payload): fall
    // through to the `unknown` code.
  }

  throw new EnrolApiError(code, message, response.status);
}

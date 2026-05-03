/*
 * Staff session API client. Wraps `POST /v1/auth/session/login` and
 * `POST /v1/auth/session/logout` (ARCHITECTURE §4.1). The session
 * itself is held by the server in an HTTP-only cookie — we always send
 * `credentials: "include"` so the browser attaches/keeps it on
 * cross-origin deploys (back-office on Cloudflare Pages, API on Fly).
 *
 * Error codes mirror the API's `{ error: { code, message } }` envelope
 * (`apps/api/src/lib/errors.ts`). We add `network_error` for fetch
 * rejection (offline, DNS, CORS preflight failure) and
 * `not_configured` when no `VITE_API_BASE_URL` is set so the UI can
 * tell ops to wire the deploy env.
 */

import {
  type SessionLoginRequest,
  type SessionLoginResponse,
  sessionLoginResponse,
} from "@kassa/schemas/auth";
import { apiBaseUrl, isApiBaseUrlConfigured } from "./config";

export type SessionLoginErrorCode =
  | "invalid_credentials"
  | "rate_limited"
  | "not_implemented"
  | "not_configured"
  | "network_error"
  | "unknown";

export class SessionLoginError extends Error {
  readonly code: SessionLoginErrorCode;
  readonly status: number | null;

  constructor(code: SessionLoginErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "SessionLoginError";
    this.code = code;
    this.status = status;
  }
}

export async function sessionLogin(
  input: SessionLoginRequest,
  { signal, fetchImpl }: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<SessionLoginResponse> {
  if (!isApiBaseUrlConfigured()) {
    throw new SessionLoginError(
      "not_configured",
      "VITE_API_BASE_URL is not set; the back-office cannot reach the Kassa API.",
    );
  }
  const doFetch = fetchImpl ?? globalThis.fetch.bind(globalThis);
  let response: Response;
  try {
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      credentials: "include",
    };
    if (signal) init.signal = signal;
    response = await doFetch(`${apiBaseUrl()}/v1/auth/session/login`, init);
  } catch (err) {
    throw new SessionLoginError(
      "network_error",
      err instanceof Error ? err.message : "network error",
    );
  }

  if (response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      throw new SessionLoginError(
        "unknown",
        err instanceof Error ? err.message : "invalid response body",
        response.status,
      );
    }
    const parsed = sessionLoginResponse.safeParse(body);
    if (!parsed.success) {
      throw new SessionLoginError(
        "unknown",
        "Login response did not match the expected contract.",
        response.status,
      );
    }
    return parsed.data;
  }

  if (response.status === 429) {
    throw new SessionLoginError("rate_limited", "rate limited", 429);
  }
  if (response.status === 501) {
    throw new SessionLoginError(
      "not_implemented",
      "The Kassa API has not shipped staff session login yet.",
      501,
    );
  }

  let code: SessionLoginErrorCode = "unknown";
  let message = `login failed (HTTP ${response.status})`;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    const bodyCode = body.error?.code;
    if (bodyCode === "invalid_credentials" || bodyCode === "not_implemented") {
      code = bodyCode;
    } else if (response.status === 401 || response.status === 403) {
      code = "invalid_credentials";
    }
    if (typeof body.error?.message === "string" && body.error.message.length > 0) {
      message = body.error.message;
    }
  } catch {
    if (response.status === 401 || response.status === 403) code = "invalid_credentials";
  }

  throw new SessionLoginError(code, message, response.status);
}

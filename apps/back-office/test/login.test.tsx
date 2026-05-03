import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoginScreen } from "../src/routes/login";
import { loadSession } from "../src/lib/session";
import { renderAt } from "./harness";

/*
 * KASA-182: the login page must call `POST /v1/auth/session/login`.
 * These tests pin the network behaviour so a future refactor can't
 * silently revert to the local-snapshot scaffold.
 */

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  // The session client requires `VITE_API_BASE_URL` to be configured;
  // jsdom doesn't carry Vite envs so we stub it on each spec.
  vi.stubEnv("VITE_API_BASE_URL", "https://api.test");
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Login screen", () => {
  it("posts credentials to /v1/auth/session/login and stores the returned session", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        email: "owner@kassa.test",
        displayName: "Owner",
        role: "owner",
        merchantId: "11111111-1111-7111-8111-111111111111",
        issuedAt: "2026-05-03T01:00:00.000+07:00",
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    renderAt("/login", [{ path: "/login", component: LoginScreen }]);

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Email"), "owner@kassa.test");
    await user.type(screen.getByLabelText("Kata sandi"), "rahasia");
    await user.click(screen.getByRole("button", { name: "Masuk" }));

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/v1/auth/session/login");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(JSON.parse(init.body as string)).toEqual({
      email: "owner@kassa.test",
      password: "rahasia",
    });

    await vi.waitFor(() => {
      expect(loadSession()).toMatchObject({
        email: "owner@kassa.test",
        role: "owner",
        merchantId: "11111111-1111-7111-8111-111111111111",
      });
    });
  });

  it("rejects success bodies that don't match sessionLoginResponse", async () => {
    /* If the API drifts off-contract (e.g. role typo, missing merchantId,
     * non-ISO issuedAt), surface the unknown error and refuse to write
     * a malformed Session into localStorage. */
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(200, {
        email: "owner@kassa.test",
        displayName: "Owner",
        role: "supreme_overlord",
        merchantId: "11111111-1111-7111-8111-111111111111",
        issuedAt: "2026-05-03T01:00:00.000+07:00",
      }),
    ) as unknown as typeof fetch;

    renderAt("/login", [{ path: "/login", component: LoginScreen }]);

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Email"), "owner@kassa.test");
    await user.type(screen.getByLabelText("Kata sandi"), "rahasia");
    await user.click(screen.getByRole("button", { name: "Masuk" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Login gagal karena kesalahan tak terduga. Coba lagi sebentar lagi.",
    );
    expect(loadSession()).toBeNull();
  });

  it("surfaces an invalid-credentials error from the API", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(401, { error: { code: "invalid_credentials", message: "nope" } }),
    ) as unknown as typeof fetch;

    renderAt("/login", [{ path: "/login", component: LoginScreen }]);

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Email"), "owner@kassa.test");
    await user.type(screen.getByLabelText("Kata sandi"), "wrong");
    await user.click(screen.getByRole("button", { name: "Masuk" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Email atau kata sandi tidak sesuai.",
    );
    expect(loadSession()).toBeNull();
  });

  it("warns operators when VITE_API_BASE_URL is not configured", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "");
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    renderAt("/login", [{ path: "/login", component: LoginScreen }]);

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Email"), "owner@kassa.test");
    await user.type(screen.getByLabelText("Kata sandi"), "rahasia");
    await user.click(screen.getByRole("button", { name: "Masuk" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/VITE_API_BASE_URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

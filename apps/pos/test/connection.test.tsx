import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "../src/i18n/IntlProvider";
import { ConnectionPill, type ConnectionState } from "../src/components/ConnectionPill";
import { useConnectionState } from "../src/lib/connection";

function setOnLine(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    get: () => value,
  });
}

function Probe() {
  const state: ConnectionState = useConnectionState({
    healthUrl: "/health",
    intervalMs: 5_000,
    fetchTimeoutMs: 1_000,
  });
  return <ConnectionPill state={state} />;
}

function renderProbe() {
  return render(
    <IntlProvider locale="id-ID">
      <Probe />
    </IntlProvider>,
  );
}

beforeEach(() => {
  setOnLine(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useConnectionState", () => {
  it("reports online once the /health probe resolves OK", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    renderProbe();
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveAttribute("data-state", "online");
    });
  });

  it("reports error when /health returns non-OK while the browser claims online", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
    renderProbe();
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveAttribute("data-state", "error");
    });
  });

  it("reports offline when navigator.onLine is false even if fetch would succeed", async () => {
    setOnLine(false);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    renderProbe();
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveAttribute("data-state", "offline");
    });
  });

  it("flips to offline when an offline event fires", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    renderProbe();
    await waitFor(() => expect(screen.getByRole("status")).toHaveAttribute("data-state", "online"));
    setOnLine(false);
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveAttribute("data-state", "offline"),
    );
  });
});

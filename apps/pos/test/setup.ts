import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

window.scrollTo = (() => {}) as typeof window.scrollTo;

afterEach(() => {
  cleanup();
});

/*
 * Default `/health` probe stub. The connection-state hook fires a
 * fetch on mount; without this the unit tests would race the probe
 * and assert against a transient "error" state. Tests that exercise
 * the hook's failure paths override this with `vi.spyOn(globalThis, "fetch")`.
 */
vi.stubGlobal(
  "fetch",
  vi.fn(async () => new Response(null, { status: 200 })),
);

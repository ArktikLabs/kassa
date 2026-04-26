import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import Dexie from "dexie";
import { IntlProvider } from "../src/i18n/IntlProvider";
import { _scrubStringForTest } from "../src/lib/sentry";
import { routeTree } from "../src/router";
import { _resetForTest } from "../src/lib/enrolment";
import { _resetDatabaseSingletonForTest, DB_NAME, getDatabase } from "../src/data/db/index";

function renderShellAt(path: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(
    <IntlProvider locale="id-ID">
      <RouterProvider router={router} />
    </IntlProvider>,
  );
  return router;
}

async function seedEnrolledDevice(): Promise<void> {
  const { repos } = await getDatabase();
  await repos.deviceSecret.set({
    deviceId: "11111111-1111-1111-1111-111111111111",
    apiKey: "pk_live_test",
    apiSecret: "sk_live_test",
    outletId: "outlet-1",
    outletName: "Warung Maju",
    merchantId: "merchant-1",
    merchantName: "Toko Maju",
    enrolledAt: new Date().toISOString(),
  });
}

describe("POS shell", () => {
  beforeEach(async () => {
    _resetForTest();
    _resetDatabaseSingletonForTest();
    await Dexie.delete(DB_NAME);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the id-ID enrol screen with brand chrome and connection pill", async () => {
    renderShellAt("/enrol");
    expect(await screen.findByRole("heading", { name: "Enrol perangkat" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hubungkan perangkat" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Online");
    expect(screen.getByRole("link", { name: /katalog/i })).toBeInTheDocument();
  });

  it("renders the catalog screen when an enrolled device routes to /catalog", async () => {
    await seedEnrolledDevice();
    renderShellAt("/catalog");
    expect(await screen.findByRole("heading", { name: "Katalog" })).toBeInTheDocument();
  });

  it("redirects / to /enrol when the device is not enrolled", async () => {
    renderShellAt("/");
    expect(await screen.findByRole("heading", { name: "Enrol perangkat" })).toBeInTheDocument();
  });

  it("redirects / to /catalog when the device is enrolled", async () => {
    await seedEnrolledDevice();
    renderShellAt("/");
    expect(await screen.findByRole("heading", { name: "Katalog" })).toBeInTheDocument();
  });

  it("scrubs PII (phone, email, address, long digit runs) before sending to Sentry", () => {
    const dirty =
      "Customer 0812-3456-7890 lives at Jl. Sudirman No.1 (acct 1234567890123) email a@b.co";
    const cleaned = _scrubStringForTest(dirty);
    expect(cleaned).not.toMatch(/0812/);
    expect(cleaned).not.toMatch(/Sudirman/);
    expect(cleaned).not.toMatch(/1234567890123/);
    expect(cleaned).not.toMatch(/a@b\.co/);
    expect(cleaned).toContain("[phone]");
    expect(cleaned).toContain("[address]");
    expect(cleaned).toContain("[digits]");
    expect(cleaned).toContain("[email]");
  });
});

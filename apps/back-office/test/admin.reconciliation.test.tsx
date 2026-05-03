import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminReconciliationScreen } from "../src/routes/admin.reconciliation";
import { renderAt } from "./harness";
import { getSnapshot } from "../src/data/store";
import { saveSession } from "../src/lib/session";

/*
 * KASA-119 — back-office /admin/reconciliation page.
 *
 * Three behaviours pinned down by the AC:
 *   1. lists every unverified static-QRIS tender with the seeded shape,
 *   2. owner sees an enabled "Tandai telah diterima" action, cashier
 *      sees it disabled (owner-only manual-match per parent KASA-64),
 *   3. clicking the action posts to /v1/admin/reconciliation/match
 *      (lands in KASA-117) and the row disappears on success.
 */

const FROZEN_NOW = new Date("2026-04-25T10:00:00.000+07:00").getTime();

describe("Admin reconciliation page", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(FROZEN_NOW);
  });

  afterEach(() => {
    /* `vi.restoreAllMocks()` does not unwind `vi.stubGlobal()`, so we
     * need both to keep the global `fetch` stub from leaking across
     * specs. */
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lists seeded unverified static-QRIS tenders", async () => {
    saveSession({
      email: "siti@warungpusat.id",
      displayName: "Siti Rahayu",
      role: "owner",
      merchantId: "11111111-1111-7111-8111-111111111111",
      issuedAt: new Date().toISOString(),
    });
    renderAt("/admin/reconciliation", [
      { path: "/admin/reconciliation", component: AdminReconciliationScreen },
    ]);

    expect(
      await screen.findByRole("heading", { name: "Rekonsiliasi manual QRIS statis" }),
    ).toBeInTheDocument();

    const rows = await screen.findAllByTestId("data-table-row");
    expect(rows).toHaveLength(3);

    expect(screen.getByText("8421")).toBeInTheDocument();
    expect(screen.getByText("1029")).toBeInTheDocument();
    expect(screen.getByText("5566")).toBeInTheDocument();
  });

  it("disables the manual-match action for non-owner roles", async () => {
    saveSession({
      email: "ani@warungpusat.id",
      displayName: "Ani",
      role: "cashier",
      merchantId: "11111111-1111-7111-8111-111111111111",
      issuedAt: new Date().toISOString(),
    });
    renderAt("/admin/reconciliation", [
      { path: "/admin/reconciliation", component: AdminReconciliationScreen },
    ]);

    const buttons = await screen.findAllByRole("button", { name: "Tandai telah diterima" });
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      expect(button).toBeDisabled();
    }
  });

  it("posts to /v1/admin/reconciliation/match and removes the row on success", async () => {
    saveSession({
      email: "siti@warungpusat.id",
      displayName: "Siti Rahayu",
      role: "owner",
      merchantId: "11111111-1111-7111-8111-111111111111",
      issuedAt: new Date().toISOString(),
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    renderAt("/admin/reconciliation", [
      { path: "/admin/reconciliation", component: AdminReconciliationScreen },
    ]);

    const user = userEvent.setup();
    const target = await screen.findByTestId("match-button-01H0000000000000UNMATCH0001");
    await user.click(target);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/v1/admin/reconciliation/match");
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      tenderId: "01H0000000000000UNMATCH0001",
      providerTransactionId: null,
      note: null,
    });

    expect(
      getSnapshot().unmatchedStaticTenders.find((t) => t.id === "01H0000000000000UNMATCH0001"),
    ).toBeUndefined();
    expect(getSnapshot().unmatchedStaticTenders).toHaveLength(2);
  });

  it("surfaces an inline error and keeps the row when the match call fails", async () => {
    saveSession({
      email: "siti@warungpusat.id",
      displayName: "Siti Rahayu",
      role: "owner",
      merchantId: "11111111-1111-7111-8111-111111111111",
      issuedAt: new Date().toISOString(),
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    renderAt("/admin/reconciliation", [
      { path: "/admin/reconciliation", component: AdminReconciliationScreen },
    ]);

    const user = userEvent.setup();
    const target = await screen.findByTestId("match-button-01H0000000000000UNMATCH0001");
    await user.click(target);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("alert")).toHaveTextContent(/Gagal menandai tender/);
    expect(
      getSnapshot().unmatchedStaticTenders.find((t) => t.id === "01H0000000000000UNMATCH0001"),
    ).toBeDefined();
    expect(getSnapshot().unmatchedStaticTenders).toHaveLength(3);
  });
});

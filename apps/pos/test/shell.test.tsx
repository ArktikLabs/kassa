import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { IntlProvider } from "../src/i18n/IntlProvider";
import { RootLayout } from "../src/routes/__root";
import { EnrolScreen } from "../src/routes/enrol";
import { CatalogScreen } from "../src/routes/catalog";
import { _scrubStringForTest } from "../src/lib/sentry";

function renderShellAt(path: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <RootLayout>
        <Outlet />
      </RootLayout>
    ),
  });
  const enrolRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/enrol",
    component: EnrolScreen,
  });
  const catalogRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/catalog",
    component: CatalogScreen,
  });
  const tree = rootRoute.addChildren([enrolRoute, catalogRoute]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  return render(
    <IntlProvider locale="id-ID">
      <RouterProvider router={router} />
    </IntlProvider>,
  );
}

describe("POS shell", () => {
  it("renders the id-ID enrol screen with brand chrome and connection pill", async () => {
    renderShellAt("/enrol");
    expect(
      await screen.findByRole("heading", { name: "Enrol perangkat" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Enrol perangkat" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Online");
    expect(screen.getByRole("link", { name: /katalog/i })).toBeInTheDocument();
  });

  it("renders the catalog screen when routed to /catalog", async () => {
    renderShellAt("/catalog");
    expect(
      await screen.findByRole("heading", { name: "Katalog" }),
    ).toBeInTheDocument();
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

import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { RootLayout } from "./routes/__root";
import { LoginScreen } from "./routes/login";
import { OutletsScreen } from "./routes/outlets";
import { CatalogScreen } from "./routes/catalog";
import { BomsScreen } from "./routes/catalog.boms";
import { StaffScreen } from "./routes/staff";
import { DevicesScreen } from "./routes/devices";
import { ReconciliationScreen } from "./routes/reports.reconciliation";
import { Forbidden } from "./components/Forbidden";
import { loadSession, roleCanManage } from "./lib/session";

/*
 * Route guards.
 *
 * - `requireSession` redirects anonymous users to /login with a
 *   `next=` parameter so login can bounce back.
 * - `requireManager` layers on top: authenticated cashiers and
 *   read-only staff render <Forbidden/> rather than being redirected,
 *   so URL sharing is predictable.
 *
 * The shell uses beforeLoad guards (TanStack Router) because the
 * check is synchronous against localStorage; when the real session
 * lands this becomes an async check against the session cookie via
 * `GET /v1/auth/session/me`.
 */

function requireSession(location: { href: string }) {
  const session = loadSession();
  if (!session) {
    throw redirect({ to: "/login", search: { next: location.href } });
  }
  return session;
}

const rootRoute = createRootRoute();

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (search: Record<string, unknown>) => ({
    next: typeof search.next === "string" ? search.next : undefined,
  }),
  component: LoginScreen,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  beforeLoad: ({ location }) => {
    requireSession(location);
  },
  component: RootLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: ({ location }) => {
    requireSession(location);
    throw redirect({ to: "/outlets" });
  },
});

const outletsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "outlets",
  component: () =>
    loadSession()?.role && roleCanManage(loadSession()!.role) ? <OutletsScreen /> : <Forbidden />,
});

const catalogRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "catalog",
  component: CatalogScreen,
});

const bomsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "catalog/boms",
  component: BomsScreen,
});

const staffRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "staff",
  component: () =>
    loadSession()?.role && roleCanManage(loadSession()!.role) ? <StaffScreen /> : <Forbidden />,
});

const devicesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "devices",
  component: () =>
    loadSession()?.role && roleCanManage(loadSession()!.role) ? <DevicesScreen /> : <Forbidden />,
});

const reconciliationRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "reports/reconciliation",
  component: () =>
    loadSession()?.role && roleCanManage(loadSession()!.role) ? (
      <ReconciliationScreen />
    ) : (
      <Forbidden />
    ),
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  appRoute.addChildren([
    outletsRoute,
    catalogRoute,
    bomsRoute,
    staffRoute,
    devicesRoute,
    reconciliationRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

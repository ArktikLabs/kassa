import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { IntlProvider } from "../src/i18n/IntlProvider";

/*
 * Shared harness for component tests so each spec describes just the
 * routes it needs — without rebuilding the i18n provider or the
 * TanStack Router memory-history plumbing.
 */

export type HarnessRoute = {
  path: string;
  component: () => ReactNode;
};

export function renderAt(path: string, routes: readonly HarnessRoute[]) {
  const rootRoute = createRootRoute({
    component: () => <Outlet />,
  });
  const children = routes.map((r) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path: r.path,
      component: r.component,
    }),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren(children),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  return render(
    <IntlProvider locale="id-ID">
      <RouterProvider router={router} />
    </IntlProvider>,
  );
}

import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { RootLayout } from "./routes/__root";
import { EnrolScreen } from "./routes/enrol";
import { CatalogScreen } from "./routes/catalog";
import { CartScreen } from "./routes/cart";
import { TenderCashScreen } from "./routes/tender.cash";
import { ReceiptScreen } from "./routes/receipt.$id";
import { AdminScreen } from "./routes/admin";
import { isEnrolled } from "./lib/enrolment";

const rootRoute = createRootRoute({
  component: () => (
    <RootLayout>
      <Outlet />
    </RootLayout>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: isEnrolled() ? "/catalog" : "/enrol" });
  },
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

const cartRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/cart",
  component: CartScreen,
});

const tenderCashRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tender/cash",
  component: TenderCashScreen,
});

const receiptRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/receipt/$id",
  component: ReceiptScreen,
});

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  component: AdminScreen,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  enrolRoute,
  catalogRoute,
  cartRoute,
  tenderCashRoute,
  receiptRoute,
  adminRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

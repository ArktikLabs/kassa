import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { RootLayout } from "./routes/__root";
import { hydrateEnrolment, isEnrolled } from "./lib/enrolment";

async function guardEnrolled(): Promise<void> {
  await hydrateEnrolment();
  if (!isEnrolled()) {
    throw redirect({ to: "/enrol" });
  }
}

async function guardUnenrolled(): Promise<void> {
  await hydrateEnrolment();
  if (isEnrolled()) {
    throw redirect({ to: "/catalog" });
  }
}

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
  beforeLoad: async () => {
    await hydrateEnrolment();
    throw redirect({ to: isEnrolled() ? "/catalog" : "/enrol" });
  },
});

const enrolRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/enrol",
  beforeLoad: guardUnenrolled,
  component: lazyRouteComponent(() => import("./routes/enrol"), "EnrolScreen"),
});

const catalogRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/catalog",
  beforeLoad: guardEnrolled,
  component: lazyRouteComponent(() => import("./routes/catalog"), "CatalogScreen"),
});

const cartRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/cart",
  beforeLoad: guardEnrolled,
  component: lazyRouteComponent(() => import("./routes/cart"), "CartScreen"),
});

const tenderCashRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tender/cash",
  beforeLoad: guardEnrolled,
  component: lazyRouteComponent(() => import("./routes/tender.cash"), "TenderCashScreen"),
});

const tenderQrisRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tender/qris",
  beforeLoad: guardEnrolled,
  component: lazyRouteComponent(() => import("./routes/tender.qris"), "TenderQrisScreen"),
});

const tenderQrisStaticRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tender/qris/static",
  beforeLoad: guardEnrolled,
  component: lazyRouteComponent(
    () => import("./routes/tender.qris.static"),
    "TenderQrisStaticScreen",
  ),
});

const receiptRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/receipt/$id",
  beforeLoad: guardEnrolled,
  component: lazyRouteComponent(() => import("./routes/receipt.$id"), "ReceiptScreen"),
});

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  component: lazyRouteComponent(() => import("./routes/admin"), "AdminScreen"),
});

const eodRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/eod",
  beforeLoad: guardEnrolled,
  component: lazyRouteComponent(() => import("./routes/eod"), "EodRoute"),
});

// `/help` is the in-PWA mirror of `docs/ONBOARDING.md` (KASA-69). No guard:
// a fresh tablet on `/enrol` must be able to reach the runbook before the
// device is enrolled to any outlet.
const helpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/help",
  component: lazyRouteComponent(() => import("./routes/help"), "HelpRoute"),
});

export const routeTree = rootRoute.addChildren([
  indexRoute,
  enrolRoute,
  catalogRoute,
  cartRoute,
  tenderCashRoute,
  tenderQrisRoute,
  tenderQrisStaticRoute,
  receiptRoute,
  adminRoute,
  eodRoute,
  helpRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

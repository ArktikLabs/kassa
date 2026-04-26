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
import { TenderQrisScreen } from "./routes/tender.qris";
import { TenderQrisStaticScreen } from "./routes/tender.qris.static";
import { ReceiptScreen } from "./routes/receipt.$id";
import { AdminScreen } from "./routes/admin";
import { EodRoute } from "./routes/eod";
import { HelpRoute } from "./routes/help";
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
  component: EnrolScreen,
});

const catalogRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/catalog",
  beforeLoad: guardEnrolled,
  component: CatalogScreen,
});

const cartRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/cart",
  beforeLoad: guardEnrolled,
  component: CartScreen,
});

const tenderCashRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tender/cash",
  beforeLoad: guardEnrolled,
  component: TenderCashScreen,
});

const tenderQrisRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tender/qris",
  beforeLoad: guardEnrolled,
  component: TenderQrisScreen,
});

const tenderQrisStaticRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tender/qris/static",
  beforeLoad: guardEnrolled,
  component: TenderQrisStaticScreen,
});

const receiptRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/receipt/$id",
  beforeLoad: guardEnrolled,
  component: ReceiptScreen,
});

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  component: AdminScreen,
});

const eodRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/eod",
  beforeLoad: guardEnrolled,
  component: EodRoute,
});

// `/help` is the in-PWA mirror of `docs/ONBOARDING.md` (KASA-69). No guard:
// a fresh tablet on `/enrol` must be able to reach the runbook before the
// device is enrolled to any outlet.
const helpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/help",
  component: HelpRoute,
});

const routeTree = rootRoute.addChildren([
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

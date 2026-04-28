import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { RootLayout } from "./routes/__root";
import { CartScreen } from "./routes/cart";
import { CatalogScreen } from "./routes/catalog";
import { EnrolScreen } from "./routes/enrol";
import { ReceiptScreen } from "./routes/receipt.$id";
import { TenderCashScreen } from "./routes/tender.cash";
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

// The unenrolled cold-load case (Lighthouse's PWA boot scenario) renders
// EnrolScreen in-place at `/` so the LCP heading paints on the first router
// pass instead of after a `/` → `/enrol` navigation cycle. That redirect was
// adding ~700 ms of FCP→LCP delay and pushing the median past the 2500 ms
// budget (KASA-157). Enrolled devices still redirect to /catalog so the rest
// of the workflow keeps a single canonical URL, and `/enrol` remains for the
// admin-driven reset flow and direct deep links.
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: async () => {
    await hydrateEnrolment();
    if (isEnrolled()) {
      throw redirect({ to: "/catalog" });
    }
  },
  component: EnrolScreen,
});

// `/enrol`, `/catalog`, `/cart`, `/tender/cash`, and `/receipt/$id` are the
// offline happy path exercised by the KASA-68 acceptance gate. They stay
// eagerly imported so a clerk can still ring up cash sales after the
// device drops the network — Playwright's `setOffline(true)` (and a real
// dropped connection on a flaky 4G link) blocks the dynamic-import fetch
// even when the chunk is precached, and `lazyRouteComponent` falls back
// to a hard reload that also fails offline. KASA-156 only needs the
// rarely-used routes (admin, eod, tender/qris, tender/qris.static, help)
// split out to fit the 200 kB initial-route budget.
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
  component: ReceiptScreen,
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

import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { RootLayout } from "./routes/__root";
import { EnrolScreen } from "./routes/enrol";
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

// `/enrol` is rendered in-place at `/` for unenrolled devices (see indexRoute
// above) and is the LCP target for the cold-load Lighthouse scenario, so its
// component stays eagerly imported. The rest of the offline happy path
// (`/catalog`, `/cart`, `/tender/cash`, `/receipt/$id`) is split into per-route
// chunks. The Workbox `injectManifest` precache (apps/pos/vite.config.ts
// `globPatterns`) emits every output chunk into the install-time cache, so the
// dynamic import resolves from cache when the clerk navigates offline — the
// KASA-68 acceptance flow exercises that path. KASA-157 needs these out of
// the initial chunk to clear the LCP budget.
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

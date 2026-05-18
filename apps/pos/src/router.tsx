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

/*
 * KASA-235 — sales / cart routes also require an *open shift*. Imported
 * dynamically so the shift module stays out of the initial bundle on the
 * cold-load path and only loads when the cashier reaches a sale screen.
 */
async function guardOpenShift(): Promise<void> {
  await guardEnrolled();
  const { getCurrentShift } = await import("./features/shift/repository");
  const shift = await getCurrentShift();
  if (!shift) {
    throw redirect({ to: "/shift/open" });
  }
}

async function guardShiftOpenScreen(): Promise<void> {
  // Devices that already have an open shift bounce back to /catalog so a
  // second open attempt cannot create a duplicate row.
  await guardEnrolled();
  const { getCurrentShift } = await import("./features/shift/repository");
  const shift = await getCurrentShift();
  if (shift) {
    throw redirect({ to: "/catalog" });
  }
}

async function guardShiftCloseScreen(): Promise<void> {
  // The close screen is reachable only with an open shift; if none exists
  // (already closed, or never opened) bounce to the open screen.
  await guardEnrolled();
  const { getCurrentShift } = await import("./features/shift/repository");
  const shift = await getCurrentShift();
  if (!shift) {
    throw redirect({ to: "/shift/open" });
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
  beforeLoad: guardOpenShift,
  component: lazyRouteComponent(() => import("./routes/catalog"), "CatalogScreen"),
});

const cartRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/cart",
  beforeLoad: guardOpenShift,
  component: lazyRouteComponent(() => import("./routes/cart"), "CartScreen"),
});

const tenderCashRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tender/cash",
  beforeLoad: guardOpenShift,
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

// Sales history + reprint detail (KASA-220). The list lives at
// `/sales/history` (alias of "past receipts"), and tapping a row lands the
// clerk on `/sales/$id` for a SALINAN reprint. We split these from the
// post-sale `/receipt/$id` flow because the labels, copy, and intent differ
// — the print path itself is shared via `usePrintReceipt()`.
const salesHistoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sales/history",
  beforeLoad: guardEnrolled,
  component: lazyRouteComponent(() => import("./routes/sales.history"), "SaleHistoryScreen"),
});

const salesReprintRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sales/$id",
  beforeLoad: guardEnrolled,
  component: lazyRouteComponent(() => import("./routes/sales.$id"), "SaleReprintScreen"),
});

// KASA-236-B — manager-PIN void route. Requires an open shift because the
// server only accepts voids for sales on the currently-open shift's
// business date; surfacing /shift/open instead of a 422 toast keeps the
// dead-end out of the void flow.
const saleVoidRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sale/$id/void",
  beforeLoad: guardOpenShift,
  component: lazyRouteComponent(() => import("./routes/sale.$id.void"), "SaleVoidScreen"),
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

// KASA-235 — cashier shift open / close routes. Code-split so the shift
// module stays out of the cold-load bundle on the LCP path.
const shiftOpenRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/shift/open",
  beforeLoad: guardShiftOpenScreen,
  component: lazyRouteComponent(() => import("./routes/shift.open"), "ShiftOpenRoute"),
});

const shiftCloseRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/shift/close",
  beforeLoad: guardShiftCloseScreen,
  component: lazyRouteComponent(() => import("./routes/shift.close"), "ShiftCloseRoute"),
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
  salesHistoryRoute,
  salesReprintRoute,
  saleVoidRoute,
  adminRoute,
  eodRoute,
  shiftOpenRoute,
  shiftCloseRoute,
  helpRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

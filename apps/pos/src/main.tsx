import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { IntlProvider } from "./i18n/IntlProvider";
import { hydrateEnrolment } from "./lib/enrolment";
import { SyncProvider } from "./lib/sync-provider";
import "./styles/index.css";

// Fire-and-forget: warms the in-memory enrolment snapshot from Dexie before
// the router evaluates its first redirect. Router `beforeLoad` awaits the
// same promise, so hydration races are safe.
void hydrateEnrolment();

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found.");

createRoot(rootEl).render(
  <StrictMode>
    <IntlProvider>
      <SyncProvider>
        <RouterProvider router={router} />
      </SyncProvider>
    </IntlProvider>
  </StrictMode>,
);

// Sentry init and the service-worker registration are not needed on the LCP
// critical path. Lazy-import them so they ship as separate chunks and run
// after first paint — keeps the initial JS bundle small enough to clear the
// mobile Lighthouse Performance/LCP budget (KASA-157, docs/CI-CD.md §8.3).
function deferUntilIdle(fn: () => void): void {
  if (typeof window === "undefined") return;
  type RICWindow = Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
  };
  const w = window as RICWindow;
  if (typeof w.requestIdleCallback === "function") {
    w.requestIdleCallback(fn, { timeout: 2000 });
  } else {
    setTimeout(fn, 0);
  }
}

deferUntilIdle(() => {
  void import("./lib/sentry").then((m) => m.initSentry());
  void import("./lib/pwa").then((m) => m.registerPwa());
});

import { StrictMode, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { IntlProvider } from "./i18n/IntlProvider";
import { hydrateEnrolment } from "./lib/enrolment";
import "./styles/index.css";

// Fire-and-forget: warms the in-memory enrolment snapshot from Dexie before
// the router evaluates its first redirect. Router `beforeLoad` awaits the
// same promise, so hydration races are safe.
void hydrateEnrolment();

// SyncProvider pulls Dexie + the sync runner into its module — that's the
// dominant chunk in the unenrolled cold-load bundle (KASA-157). The
// unenrolled `/` first paint doesn't read any sync state (the consumers
// in `__root.tsx` fall back to no-op defaults), so we render an inert
// passthrough until first paint, then dynamic-import the real provider.
type SyncProviderComponent = ComponentType<{ children: ReactNode }>;

function LazySyncProvider({ children }: { children: ReactNode }) {
  const [Provider, setProvider] = useState<SyncProviderComponent | null>(null);
  useEffect(() => {
    let cancelled = false;
    void import("./lib/sync-provider").then((m) => {
      if (cancelled) return;
      setProvider(() => m.SyncProvider);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!Provider) return <>{children}</>;
  return <Provider>{children}</Provider>;
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found.");

createRoot(rootEl).render(
  <StrictMode>
    <IntlProvider>
      <LazySyncProvider>
        <RouterProvider router={router} />
      </LazySyncProvider>
    </IntlProvider>
  </StrictMode>,
);

// Sentry init and the service-worker registration are not needed on the LCP
// critical path. Lazy-import them so they ship as separate chunks and run
// after first paint — keeps the initial JS bundle small enough to clear the
// mobile Lighthouse Performance/LCP budget (KASA-157, docs/CI-CD.md §8.4).
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

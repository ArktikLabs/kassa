import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { IntlProvider } from "./i18n/IntlProvider";
import { initSentry } from "./lib/sentry";
import { hydrateEnrolment } from "./lib/enrolment";
import "./styles/index.css";

initSentry();
// Fire-and-forget: warms the in-memory enrolment snapshot from Dexie before
// the router evaluates its first redirect. Router `beforeLoad` awaits the
// same promise, so hydration races are safe.
void hydrateEnrolment();

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found.");

createRoot(rootEl).render(
  <StrictMode>
    <IntlProvider>
      <RouterProvider router={router} />
    </IntlProvider>
  </StrictMode>,
);

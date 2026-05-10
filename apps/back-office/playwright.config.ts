import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:4174",
    // Pin the browser locale to id-ID so `navigator.languages` matches the
    // app's primary locale (`apps/back-office/src/i18n/messages.ts`). Without
    // this, CI runners default to en-US and `negotiateLocale()` partial-matches
    // "en", flipping every localized assertion (e.g. the "Kata sandi" password
    // label, "Masuk" submit button, "Outlet"/"Katalog" headings) to the
    // English copy. Mirrors how the app boots on a real Indonesian merchant
    // laptop, and matches the same pin already in the POS config.
    locale: "id-ID",
    trace: "on-first-retry",
  },
  webServer: {
    // KASA-182 wired the login form to a real `POST /v1/auth/session/login`,
    // and the client refuses to fetch when `VITE_API_BASE_URL` is empty
    // (returns "not_configured"). The smoke spec stubs the endpoint with a
    // Playwright route handler, but we still need a non-empty base URL
    // baked into the bundle so `isApiBaseUrlConfigured()` returns true.
    // Rebuild with a same-origin loopback URL so the stubbed POST is caught
    // by the route handler instead of escaping to the real internet.
    command: "pnpm build && pnpm preview --port 4174 --strictPort",
    url: "http://localhost:4174",
    env: { VITE_API_BASE_URL: "http://localhost:4174" },
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  projects: [
    {
      name: "chromium-laptop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
  ],
});

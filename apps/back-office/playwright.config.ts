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
    // Vite bakes `import.meta.env.VITE_API_BASE_URL` at build time, so the
    // env below has to be present during `pnpm build` — not just `pnpm
    // preview`. Building inside `webServer.command` makes the lane hermetic
    // both locally and in CI; mirrors apps/pos/playwright.full-day-offline.
    // The URL only needs to satisfy `isApiBaseUrlConfigured()` so
    // `sessionLogin()` actually fires the request the spec mocks via
    // `page.route()` (KASA-193). No real server is reached on this port.
    command: "pnpm build && pnpm preview --port 4174 --strictPort",
    url: "http://localhost:4174",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      VITE_API_BASE_URL: "http://localhost:4174",
    },
  },
  projects: [
    {
      name: "chromium-laptop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
  ],
});

import { defineConfig, devices } from "@playwright/test";

/*
 * E2E config for the POS PWA. Service-worker tests require a real
 * (non-jsdom) browser, a built bundle, and the `vite preview` server
 * (the dev server doesn't ship a registered SW unless `devOptions` is
 * enabled, which we keep off).
 */

export default defineConfig({
  testDir: "./e2e",
  // `full-day-offline.spec.ts` runs under `playwright.full-day-offline.config.ts`,
  // which brings up the in-memory API harness on :4127 and a separately
  // ported preview server. Excluding it here keeps `pnpm test:e2e` focused
  // on the smoke specs (offline shell + tender flows) and prevents the
  // workflow that drives this default config from double-running the
  // acceptance suite without the harness.
  testIgnore: /full-day-offline\.spec\.ts$/,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm build && pnpm preview --port 4173 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

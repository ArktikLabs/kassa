import { defineConfig, devices } from "@playwright/test";

import { HARNESS_BASE_URL, HARNESS_PORT } from "./e2e/harness/void-fixtures.js";

/*
 * KASA-241 — Playwright config for the void / refund E2E spec.
 *
 * Mirrors `playwright.full-day-offline.config.ts` (KASA-68) but runs only
 * `void.spec.ts` against a separate in-memory harness (port 4128) and a
 * separate Vite preview (port 4175). The void harness wires the
 * manager-PIN + open-shift gates that KASA-68 explicitly keeps off.
 *
 * The PWA build is invoked with `VITE_API_BASE_URL` pointing at the void
 * harness so the bundled `apiBaseUrl()` resolves to the in-memory API at
 * runtime.
 */

const POS_PORT = 4175;
const POS_URL = `http://127.0.0.1:${POS_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /void\.spec\.ts$/,
  timeout: 3 * 60_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // Acceptance is a tripwire — flake quarantine is not permitted.
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: POS_URL,
    locale: "id-ID",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `pnpm exec tsx ./e2e/harness/void-server.ts`,
      url: `${HARNESS_BASE_URL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        HARNESS_PORT: String(HARNESS_PORT),
      },
    },
    {
      command: `pnpm build && pnpm preview --port ${POS_PORT} --strictPort --host 127.0.0.1`,
      url: POS_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        VITE_API_BASE_URL: HARNESS_BASE_URL,
      },
    },
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

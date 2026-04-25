import { defineConfig, devices } from "@playwright/test";

import { HARNESS_BASE_URL, HARNESS_PORT } from "./e2e/harness/fixtures.js";

/*
 * Dedicated Playwright config for the KASA-68 full-day offline acceptance
 * suite. Runs only `e2e/full-day-offline.spec.ts` and brings up *two* web
 * servers: the in-memory API harness on port 4127 and the Vite preview on
 * port 4174 (different from the default 4173 so the two configs can run
 * in parallel locally without stepping on each other).
 *
 * The PWA build is invoked with `VITE_API_BASE_URL` pointing at the harness
 * so the bundled `apiBaseUrl()` resolves to the in-memory API at runtime.
 *
 * The suite is the v0 release gate (vision metric: "merchant completes a
 * full sales day offline without data loss"). It is informational on PR
 * branches but blocking on `main` per the CI gate in `.github/workflows`.
 */

const POS_PORT = 4174;
const POS_URL = `http://127.0.0.1:${POS_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /full-day-offline\.spec\.ts$/,
  // 8-minute ceiling lives in the spec itself via `test.setTimeout`. The
  // outer Playwright timeout is generous so a slow CI runner does not
  // pre-empt a passing test mid-drain.
  timeout: 8 * 60_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // Acceptance is a tripwire — flake quarantine is not permitted. CI surfaces
  // a single failure as a P0 instead of retrying the suite into green.
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: POS_URL,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `pnpm exec tsx ./e2e/harness/server.ts`,
      url: `${HARNESS_BASE_URL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        // Force a deterministic port; harness reads HARNESS_PORT from fixtures.
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

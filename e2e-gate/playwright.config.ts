import { defineConfig } from "@playwright/test";

// gate:p4 only (scripts/gate-p4.ts): the gate starts the production app on a free port with its own database and data
// directory and passes it as E2E_BASE_URL, so this config never starts or reuses a server itself.
export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  workers: 1,
  timeout: 15 * 60_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL,
    channel: process.env.E2E_CHANNEL ?? "chrome",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  outputDir: "../.data/gate-p4/playwright",
});

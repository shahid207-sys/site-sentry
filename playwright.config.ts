import { defineConfig } from "@playwright/test";

// End-to-end tests run against a dev or production server (default http://localhost:3000).
// They use the sample workspace and reset it before and after, so they never touch live data.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    channel: process.env.E2E_CHANNEL ?? "chrome",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } }, testIgnore: /responsive/ },
    { name: "phone", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, testMatch: /responsive/ },
    { name: "tablet", use: { viewport: { width: 768, height: 1024 } }, testMatch: /responsive/ },
    { name: "small-laptop", use: { viewport: { width: 1024, height: 768 } }, testMatch: /responsive/ },
  ],
  webServer: {
    command: "npx next start -p 3000",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});

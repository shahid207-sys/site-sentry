import { mergeConfig } from "vitest/config";
import integration from "./vitest.integration.config.mjs";

// Line coverage of the crawler and the rules (SPEC quality target: ≥ 85%), over unit and integration tests together.
// Needs Postgres and Redis like test:int. Run with `npm run coverage`.
export default mergeConfig(integration, {
  test: {
    include: ["src/**/*.test.ts", "fixtures/**/*.test.ts"],
    exclude: ["node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["src/lib/crawl/**/*.ts", "src/lib/rules/**/*.ts"],
      exclude: ["**/*.test.ts", "**/types.ts"],
      reporter: ["text-summary", "json-summary"],
      reportsDirectory: ".data/coverage",
      thresholds: { lines: 85 },
    },
  },
});

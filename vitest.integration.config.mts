import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Integration tests: need Postgres and Redis from docker-compose.yml. Run with `npm run test:int`.
// They fail (not skip) when the services are down, so a green run always means they really ran.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./src/test/empty.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.int.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    globalSetup: ["./src/test/int-global-setup.ts"],
  },
});

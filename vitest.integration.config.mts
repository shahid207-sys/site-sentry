import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Integration tests: need Postgres and Redis from docker-compose.yml. Run with `npm run test:int`.
// They fail (not skip) when the services are down, so a green run always means they really ran.
// They use their own database (created on demand), never the dev database: worker processes started by the tests
// pick up every unfinished crawl in the database they point at.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://sitesentry:sitesentry@127.0.0.1:5433/sitesentry_test";
// Raw HTML from test crawls goes to a temporary directory, not the repo's .data/blobs.
process.env.BLOB_DIR ??= path.join(tmpdir(), "sitesentry-int-blobs");

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
    // One file at a time: the worker test starts real worker processes against the shared test database.
    fileParallelism: false,
    globalSetup: ["./src/test/int-global-setup.ts"],
  },
});

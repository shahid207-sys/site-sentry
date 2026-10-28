// Helpers for integration tests. Each test creates its own crawl, so files can run in parallel on one database.
import { randomUUID } from "node:crypto";
import { createDb, type Db } from "../lib/db/client";
import { crawls } from "../lib/db/schema";

export function testDb(): Db {
  return createDb(undefined, 10);
}

export async function newCrawl(db: Db, over: Partial<typeof crawls.$inferInsert> = {}): Promise<string> {
  const [row] = await db
    .insert(crawls)
    .values({ workspace: "test", auditId: randomUUID(), siteOrigin: "https://example.test", profile: "custom", config: {}, status: "running", ...over })
    .returning({ id: crawls.id });
  return row.id;
}

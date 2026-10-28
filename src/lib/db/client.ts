// Postgres access for the crawl subsystem. Used by the worker process and (flag on) the web app's read paths.
// Deliberately free of `server-only` and Next imports so the worker can run it under plain Node.
import path from "node:path";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema> & { $client: Pool };

export const DEFAULT_DATABASE_URL = "postgres://sitesentry:sitesentry@127.0.0.1:5433/sitesentry";

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
}

export function createDb(url = databaseUrl(), max = 10): Db {
  const pool = new Pool({ connectionString: url, max });
  return drizzle(pool, { schema }) as Db;
}

const g = globalThis as unknown as { __ssDb?: Db };

/** One pool per process (survives dev hot reloads). */
export function getDb(): Db {
  g.__ssDb ??= createDb();
  return g.__ssDb;
}

/** Apply pending migrations from ./drizzle. Safe to run concurrently: drizzle takes an advisory lock. */
export async function migrateDb(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
}

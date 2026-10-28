// Runs once before the integration suite: fail fast if Postgres is down, then apply migrations.
import { createDb, databaseUrl, migrateDb } from "../lib/db/client";

export default async function setup() {
  const db = createDb(databaseUrl(), 2);
  try {
    await db.$client.query("select 1");
  } catch (e) {
    throw new Error(`Postgres is not reachable at ${databaseUrl()} (${(e as Error).message}). Start it with: docker compose up -d`);
  }
  await migrateDb(db);
  await db.$client.end();
}

// Runs once before the integration suite: fail fast if Postgres is down, create the test database if needed,
// apply migrations and start from empty crawl tables.
import { Client } from "pg";
import { createDb, databaseUrl, migrateDb } from "../lib/db/client";

export default async function setup() {
  const url = new URL(databaseUrl());
  const name = url.pathname.slice(1);
  if (!/_test$/.test(name)) throw new Error(`Integration tests only run against a *_test database, not "${name}".`);
  const admin = new Client({ connectionString: Object.assign(new URL(url), { pathname: "/postgres" }).toString() });
  try {
    await admin.connect();
  } catch (e) {
    throw new Error(`Postgres is not reachable at ${url.host} (${(e as Error).message}). Start it with: docker compose up -d`);
  }
  const exists = await admin.query("select 1 from pg_database where datname = $1", [name]);
  if (!exists.rowCount) await admin.query(`create database "${name}"`);
  await admin.end();

  const db = createDb(url.toString(), 2);
  await migrateDb(db);
  await db.$client.query("truncate crawls cascade");
  await db.$client.end();
}

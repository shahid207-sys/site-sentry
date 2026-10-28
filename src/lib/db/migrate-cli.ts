import { createDb, databaseUrl, migrateDb } from "./client";

async function main() {
  const db = createDb(databaseUrl(), 1);
  await migrateDb(db);
  await db.$client.end();
  console.log(`Migrations applied to ${databaseUrl().replace(/\/\/[^@]*@/, "//***@")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

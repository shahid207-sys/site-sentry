// One-time move of the JSON app store (sites, page intents, audits, audit results, tasks, workspace settings) into
// Postgres. Then set SITE_SENTRY_STORE=postgres so the app reads it from there.
//
//   npx tsx scripts/migrate-json-store.ts --dry-run            report what would be written; writes nothing
//   npx tsx scripts/migrate-json-store.ts                      back up the JSON files, then write
//   options: --data-dir <dir> (default SITE_SENTRY_DATA_DIR or .data)  --db <postgres url> (default DATABASE_URL)
//            --workspace live|sample (default both)  --replace (overwrite a workspace already in Postgres)
//
// Exit codes: 0 counts match, 1 a count differs or the run failed, 2 bad arguments or nothing to migrate.
import path from "node:path";
import { createDb, databaseUrl, migrateDb } from "../src/lib/db/client";
import type { Workspace } from "../src/lib/model";
import { backupJsonStore, migrateJsonStore, MigrationRefused, readJsonStore } from "../src/lib/store/json-to-pg";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dryRun = args.includes("--dry-run");
const replace = args.includes("--replace");
const dataDir = path.resolve(opt("--data-dir") ?? process.env.SITE_SENTRY_DATA_DIR ?? ".data");
const dbUrl = opt("--db") ?? databaseUrl();
const wsArg = opt("--workspace");
if (wsArg && wsArg !== "live" && wsArg !== "sample") {
  console.error("--workspace must be live or sample.");
  process.exit(2);
}
const workspaces: Workspace[] = wsArg ? [wsArg as Workspace] : ["live", "sample"];

async function main() {
  const sources = await readJsonStore(dataDir, workspaces);
  if (!sources.length) {
    console.error(`No JSON store found in ${dataDir} (looked for live/state.json, store.json, sample/state.json).`);
    process.exit(2);
  }
  console.log(`${dryRun ? "DRY RUN (rolled back; nothing is written)" : "MIGRATION"}: ${dataDir} -> ${dbUrl.replace(/:[^:@/]+@/, ":***@")}`);
  for (const s of sources) console.log(`  ${s.workspace}: ${s.from}`);
  const db = createDb(dbUrl, 2);
  try {
    await migrateDb(db);
    if (!dryRun) console.log(`Backup of the JSON files: ${await backupJsonStore(dataDir, sources)}`);
    const rows = await migrateJsonStore(db.$client, sources, { dryRun, replace });
    console.log(`\n${"workspace".padEnd(10)} ${"table".padEnd(14)} ${"json".padStart(6)} ${(dryRun ? "would be" : "postgres").padStart(9)}  match`);
    for (const r of rows) console.log(`${r.workspace.padEnd(10)} ${r.table.padEnd(14)} ${String(r.json).padStart(6)} ${String(r.postgres).padStart(9)}  ${r.json === r.postgres ? "yes" : "NO"}`);
    const bad = rows.filter((r) => r.json !== r.postgres);
    console.log(bad.length ? `\n${bad.length} count(s) differ.` : `\nAll ${rows.length} counts match.${dryRun ? "" : " Set SITE_SENTRY_STORE=postgres to use them."}`);
    process.exitCode = bad.length ? 1 : 0;
  } catch (e) {
    if (e instanceof MigrationRefused) {
      console.error(e.message);
      process.exitCode = 1;
    } else throw e;
  } finally {
    await db.$client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

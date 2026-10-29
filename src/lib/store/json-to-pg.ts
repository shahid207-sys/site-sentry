// One-time move of the JSON app store into Postgres (scripts/migrate-json-store.ts). The JSON files are only read and
// copied to a backup; they are never modified or deleted. A dry run performs the same writes inside a transaction and
// rolls it back, so its row counts are the ones a real run produces.
import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import type { Workspace } from "../model";
import { migrateLegacyFile } from "./migrate";
import { saveState, STORE_TABLES, writeAuditResult, type StoreTable } from "./pg-store";
import { emptyStore, type AuditBlob, type StoreData } from "./store";

export interface JsonSource {
  workspace: Workspace;
  /** What was read, for the report: "live/state.json + 2 audit files" or "store.json (v1, converted)". */
  from: string;
  state: StoreData;
  blobs: Record<string, AuditBlob>;
  /** Files read, relative to the data directory (backed up before a real run). */
  files: string[];
}

const exists = (p: string) => stat(p).then(() => true, () => false);

async function readWorkspaceDir(dataDir: string, ws: Workspace): Promise<JsonSource | null> {
  const dir = path.join(dataDir, ws);
  if (!(await exists(path.join(dir, "state.json")))) return null;
  const state = { ...emptyStore(), ...JSON.parse(await readFile(path.join(dir, "state.json"), "utf8")) } as StoreData;
  const blobs: Record<string, AuditBlob> = {};
  const files = [path.join(ws, "state.json")];
  const auditDir = path.join(dir, "audits");
  for (const f of (await exists(auditDir)) ? (await readdir(auditDir)).filter((f) => f.endsWith(".json")).sort() : []) {
    blobs[f.slice(0, -".json".length)] = JSON.parse(await readFile(path.join(auditDir, f), "utf8"));
    files.push(path.join(ws, "audits", f));
  }
  return { workspace: ws, from: `${ws}/state.json + ${files.length - 1} audit files`, state, blobs, files };
}

/**
 * What the JSON store holds, per workspace. Live: <dataDir>/live, or when that was never created, the v1 file
 * <dataDir>/store.json converted the way the app converts it on first start. Sample: <dataDir>/sample if present.
 */
export async function readJsonStore(dataDir: string, workspaces: Workspace[] = ["live", "sample"]): Promise<JsonSource[]> {
  const out: JsonSource[] = [];
  for (const ws of workspaces) {
    const dir = await readWorkspaceDir(dataDir, ws);
    if (dir) {
      out.push(dir);
      continue;
    }
    if (ws !== "live") continue;
    const v1 = await migrateLegacyFile(dataDir);
    if (v1) out.push({ workspace: "live", from: "store.json (v1, converted)", state: v1.state, blobs: v1.blobs, files: ["store.json"] });
  }
  return out;
}

/** Rows each table gets from a source. */
export function sourceCounts(src: JsonSource): Record<StoreTable, number> {
  return {
    workspaces: 1,
    sites: Object.keys(src.state.sites).length,
    page_intents: Object.keys(src.state.pages).length,
    audits: Object.keys(src.state.audits).length,
    tasks: Object.keys(src.state.tasks).length,
    audit_results: Object.keys(src.blobs).length,
  };
}

export async function countRows(q: Pick<Pool, "query">, ws: Workspace): Promise<Record<StoreTable, number>> {
  const out = {} as Record<StoreTable, number>;
  for (const t of STORE_TABLES) {
    const r = await q.query(`select count(*)::int as n from ${t} where ${t === "workspaces" ? "id" : "workspace"} = $1`, [ws]);
    out[t] = r.rows[0].n;
  }
  return out;
}

export interface MigrationRow {
  workspace: Workspace;
  table: StoreTable;
  json: number;
  /** Rows in Postgres after the run (inside the rolled-back transaction for a dry run). */
  postgres: number;
}

export class MigrationRefused extends Error {}

/**
 * Writes every source into Postgres in one transaction. A workspace that already has rows is refused unless
 * `replace` (then its rows are deleted first). Dry run: rolled back. Returns per-table counts measured in the database.
 */
export async function migrateJsonStore(pool: Pool, sources: JsonSource[], opts: { dryRun: boolean; replace?: boolean }): Promise<MigrationRow[]> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const rows: MigrationRow[] = [];
    for (const src of sources) {
      await c.query("select pg_advisory_xact_lock(hashtext($1))", [`store:${src.workspace}`]);
      const present = Object.values(await countRows(c, src.workspace)).some((n) => n > 0);
      if (present && !opts.replace) throw new MigrationRefused(`Postgres already holds data for the "${src.workspace}" workspace. Nothing was written; pass --replace to overwrite it.`);
      if (present) await c.query("delete from workspaces where id = $1", [src.workspace]);
      await saveState(c, src.workspace, null, src.state);
      for (const [id, blob] of Object.entries(src.blobs)) await writeAuditResult(c, src.workspace, id, blob);
      const json = sourceCounts(src);
      const db = await countRows(c, src.workspace);
      for (const t of STORE_TABLES) rows.push({ workspace: src.workspace, table: t, json: json[t], postgres: db[t] });
    }
    await c.query(opts.dryRun ? "rollback" : "commit");
    return rows;
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** Copies the source files to <dataDir>/backups/json-store-<stamp>/, keeping their relative paths. Returns the folder. */
export async function backupJsonStore(dataDir: string, sources: JsonSource[], stamp = new Date().toISOString().replace(/[:.]/g, "-")): Promise<string> {
  const dest = path.join(dataDir, "backups", `json-store-${stamp}`);
  for (const f of new Set(sources.flatMap((s) => s.files))) {
    await mkdir(path.dirname(path.join(dest, f)), { recursive: true });
    await copyFile(path.join(dataDir, f), path.join(dest, f));
  }
  return dest;
}

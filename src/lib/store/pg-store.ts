// The app store in Postgres (tables in src/lib/db/schema.ts, migration 0009), behind the same Store interface as the
// JSON files it replaces. One row per site, page intent, audit and task, the entity itself in `data`. `update` runs
// the mutation in a transaction under a per-workspace advisory lock, so concurrent requests and processes cannot
// interleave read-modify-write, and writes only the rows that changed.
import type { Pool, PoolClient } from "pg";
import type { Workspace } from "../model";
import { emptyStore, StoreUnavailableError, type AuditBlob, type Store, type StoreData } from "./store";

type Q = Pick<PoolClient, "query">;

/** The entity tables: StoreData key, table, and the query columns copied out of each entity. */
const TABLES = [
  { key: "sites", table: "sites", cols: { origin: (e: Record<string, unknown>) => e.origin } },
  { key: "pages", table: "page_intents", cols: { site_id: (e: Record<string, unknown>) => e.siteId, url: (e: Record<string, unknown>) => e.url } },
  {
    key: "audits",
    table: "audits",
    cols: { site_id: (e: Record<string, unknown>) => e.siteId, status: (e: Record<string, unknown>) => e.status, created_at: (e: Record<string, unknown>) => e.createdAt },
  },
  { key: "tasks", table: "tasks", cols: { site_id: (e: Record<string, unknown>) => e.siteId, workflow_status: (e: Record<string, unknown>) => e.workflowStatus } },
] as const;

export type StoreTable = (typeof TABLES)[number]["table"] | "workspaces" | "audit_results";
export const STORE_TABLES: StoreTable[] = ["workspaces", ...TABLES.map((t) => t.table), "audit_results"];

const unavailable = (e: unknown) => (e instanceof StoreUnavailableError ? e : new StoreUnavailableError("Could not reach the database that holds saved data.", e));

/** The workspace's state, or null when the workspace has no row yet. */
export async function loadState(q: Q, ws: Workspace): Promise<StoreData | null> {
  const w = (await q.query("select schema_version, settings, sample_state, seed_version from workspaces where id = $1", [ws])).rows[0];
  if (!w) return null;
  const data = emptyStore();
  data.settings = w.settings;
  if (w.sample_state) data.sampleState = w.sample_state;
  if (w.seed_version) data.seedVersion = w.seed_version;
  for (const t of TABLES) {
    const rows = (await q.query(`select id, data from ${t.table} where workspace = $1 order by id`, [ws])).rows as { id: string; data: never }[];
    const into = data[t.key] as Record<string, unknown>;
    for (const r of rows) into[r.id] = r.data;
  }
  return data;
}

/** Writes `next` over `prev` (what is in the database now): changed or new rows upserted, removed rows deleted. */
export async function saveState(q: Q, ws: Workspace, prev: StoreData | null, next: StoreData): Promise<void> {
  if (
    !prev ||
    JSON.stringify([prev.settings, prev.sampleState ?? null, prev.seedVersion ?? null]) !== JSON.stringify([next.settings, next.sampleState ?? null, next.seedVersion ?? null])
  ) {
    await q.query(
      `insert into workspaces (id, schema_version, settings, sample_state, seed_version) values ($1, $2, $3, $4, $5)
       on conflict (id) do update set settings = excluded.settings, sample_state = excluded.sample_state, seed_version = excluded.seed_version, updated_at = now()`,
      [ws, next.schemaVersion, JSON.stringify(next.settings), next.sampleState ?? null, next.seedVersion ?? null],
    );
  }
  for (const t of TABLES) {
    const before = (prev?.[t.key] ?? {}) as unknown as Record<string, Record<string, unknown>>;
    const after = (next[t.key] ?? {}) as unknown as Record<string, Record<string, unknown>>;
    const gone = Object.keys(before).filter((id) => !(id in after));
    if (gone.length) await q.query(`delete from ${t.table} where workspace = $1 and id = any($2::text[])`, [ws, gone]);
    const cols = Object.keys(t.cols);
    for (const [id, e] of Object.entries(after)) {
      if (id in before && JSON.stringify(before[id]) === JSON.stringify(e)) continue;
      const values = Object.values(t.cols).map((f) => String((f as (e: Record<string, unknown>) => unknown)(e) ?? ""));
      await q.query(
        `insert into ${t.table} (workspace, id, ${cols.join(", ")}, data) values ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(", ")}, $${cols.length + 3})
         on conflict (workspace, id) do update set ${cols.map((c) => `${c} = excluded.${c}`).join(", ")}, data = excluded.data, updated_at = now()`,
        [ws, id, ...values, JSON.stringify(e)],
      );
    }
  }
}

/** Ensures the workspace row exists (audit results reference it). */
async function ensureWorkspace(q: Q, ws: Workspace) {
  await q.query("insert into workspaces (id, settings) values ($1, $2) on conflict (id) do nothing", [ws, JSON.stringify(emptyStore().settings)]);
}

export async function writeAuditResult(q: Q, ws: Workspace, auditId: string, blob: AuditBlob): Promise<void> {
  await ensureWorkspace(q, ws);
  await q.query(
    `insert into audit_results (workspace, audit_id, snapshots, findings) values ($1, $2, $3, $4)
     on conflict (workspace, audit_id) do update set snapshots = excluded.snapshots, findings = excluded.findings, updated_at = now()`,
    [ws, auditId, JSON.stringify(blob.snapshots), JSON.stringify(blob.findings)],
  );
}

export class PgStore implements Store {
  readonly persistent = true;
  constructor(
    private pool: Pool,
    private ws: Workspace,
  ) {}

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    let c: PoolClient;
    try {
      c = await this.pool.connect();
    } catch (e) {
      throw unavailable(e);
    }
    try {
      await c.query("begin");
      await c.query("select pg_advisory_xact_lock(hashtext($1))", [`store:${this.ws}`]);
      const out = await fn(c);
      await c.query("commit");
      return out;
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      if (e instanceof StoreUnavailableError || (e as { code?: string }).code === undefined) throw e;
      throw unavailable(e);
    } finally {
      c.release();
    }
  }

  async read(): Promise<StoreData> {
    try {
      return (await loadState(this.pool, this.ws)) ?? emptyStore();
    } catch (e) {
      throw unavailable(e);
    }
  }

  update<T>(fn: (data: StoreData) => T): Promise<T> {
    return this.tx(async (c) => {
      const prev = await loadState(c, this.ws);
      const draft = structuredClone(prev ?? emptyStore());
      const result = fn(draft);
      await saveState(c, this.ws, prev, draft);
      return result;
    });
  }

  async readAudit(id: string): Promise<AuditBlob> {
    try {
      const r = (await this.pool.query("select snapshots, findings from audit_results where workspace = $1 and audit_id = $2", [this.ws, id])).rows[0];
      return r ? { snapshots: r.snapshots, findings: r.findings } : { snapshots: [], findings: [] };
    } catch (e) {
      throw unavailable(e);
    }
  }

  async writeAudit(id: string, blob: AuditBlob): Promise<void> {
    try {
      await writeAuditResult(this.pool, this.ws, id, blob);
    } catch (e) {
      throw unavailable(e);
    }
  }

  async deleteAudit(id: string): Promise<void> {
    try {
      await this.pool.query("delete from audit_results where workspace = $1 and audit_id = $2", [this.ws, id]);
    } catch (e) {
      throw unavailable(e);
    }
  }
}

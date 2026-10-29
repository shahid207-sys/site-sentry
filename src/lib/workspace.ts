// Server-only: resolves a workspace name to its store, fetcher and clock.
import "server-only";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { liveFetcher, SafeFetchError, type Fetcher } from "./fetch/safe-fetch";
import type { Workspace } from "./model";
import { sampleFetcher } from "./sample/fetcher";
import { buildSampleSeed, SEED_VERSION } from "./sample/seed";
import { migrateLegacyFile } from "./store/migrate";
import { JsonFileStore, MemoryStore, StoreUnavailableError, type AuditBlob, type Store, type StoreData } from "./store/store";
import { WorkflowError, type Deps } from "./workflow/deps";

export const WORKSPACES: Workspace[] = ["live", "sample"];
export const isWorkspace = (v: unknown): v is Workspace => v === "live" || v === "sample";

export function dataDir(): string {
  if (process.env.SITE_SENTRY_DATA_DIR) return path.resolve(process.env.SITE_SENTRY_DATA_DIR);
  // Serverless file systems are read-only except /tmp (which is ephemeral and per-instance).
  if (process.env.VERCEL) return "/tmp/site-sentry";
  // Runtime data, not a build input: without the comment Turbopack traces every file under .data (51,077 on a dev
  // machine after the Phase 2 runs) into the server bundle analysis.
  return path.join(/* turbopackIgnore: true */ process.cwd(), ".data");
}

export const dataIsEphemeral = () => !process.env.SITE_SENTRY_DATA_DIR && !!process.env.VERCEL;

// ---------- live scan policy ----------

export function liveScansEnabled(): boolean {
  return (process.env.SITE_SENTRY_LIVE_SCANS ?? "enabled").toLowerCase() !== "disabled";
}

/** Optional allowlist of hostnames (and their subdomains) that live scans may reach. */
export function allowedHosts(): string[] | null {
  const raw = process.env.SITE_SENTRY_ALLOWED_HOSTS?.trim();
  if (!raw) return null;
  return raw.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
}

function policyFetcher(inner: Fetcher): Fetcher {
  return async (url, opts) => {
    if (!liveScansEnabled()) throw new SafeFetchError("BLOCKED_HOST", "Live scanning is disabled on this deployment.");
    const hosts = allowedHosts();
    if (hosts) {
      let host = "";
      try {
        host = new URL(url).hostname.toLowerCase();
      } catch {
        /* validated by the inner fetcher */
      }
      if (!hosts.some((h) => host === h || host.endsWith(`.${h}`))) {
        throw new SafeFetchError("BLOCKED_HOST", `This deployment only scans: ${hosts.join(", ")}.`);
      }
    }
    return inner(url, opts);
  };
}

// ---------- sample store: seeded, resettable, falls back to memory ----------

class SampleStore implements Store {
  private inner: Store | null = null;
  private init: Promise<Store> | null = null;
  constructor(private dir: string) {}

  get persistent() {
    return this.inner?.persistent ?? false;
  }

  private async seeded(): Promise<Store> {
    if (this.inner) return this.inner;
    this.init ??= (async () => {
      const file = new JsonFileStore(this.dir);
      try {
        const current = await file.read();
        if (current.seedVersion === SEED_VERSION) return file;
        await this.writeSeed(file);
        return file;
      } catch (e) {
        if (!(e instanceof StoreUnavailableError)) throw e;
        // Read-only or broken disk: the sample must still work, so keep it in memory.
        const seed = await buildSampleSeed();
        return new MemoryStore(seed.state, { blobs: seed.blobs });
      }
    })();
    this.inner = await this.init;
    return this.inner;
  }

  private async writeSeed(target: Store) {
    const seed = await buildSampleSeed();
    const old = await target.read().catch(() => null);
    for (const id of Object.keys(old?.audits ?? {})) if (!seed.state.audits[id]) await target.deleteAudit(id);
    for (const [id, blob] of Object.entries(seed.blobs)) await target.writeAudit(id, blob);
    await target.update((d) => {
      Object.assign(d, structuredClone(seed.state));
    });
  }

  /** Restore the deterministic seed, discarding sample tasks and audits created since. */
  async reset() {
    const s = await this.seeded();
    if (s instanceof MemoryStore) {
      const seed = await buildSampleSeed();
      this.inner = new MemoryStore(seed.state, { blobs: seed.blobs });
      return;
    }
    await this.writeSeed(s);
  }

  async read(): Promise<StoreData> {
    return (await this.seeded()).read();
  }
  async update<T>(fn: (data: StoreData) => T): Promise<T> {
    return (await this.seeded()).update(fn);
  }
  async readAudit(id: string): Promise<AuditBlob> {
    return (await this.seeded()).readAudit(id);
  }
  async writeAudit(id: string, blob: AuditBlob) {
    return (await this.seeded()).writeAudit(id, blob);
  }
  async deleteAudit(id: string) {
    return (await this.seeded()).deleteAudit(id);
  }
}

// One instance per server process, surviving dev hot reloads (otherwise two mutexes could race).
const g = globalThis as unknown as { __siteSentry?: { live: Store; sample: SampleStore } };

function stores() {
  g.__siteSentry ??= {
    live: new JsonFileStore(path.join(dataDir(), "live"), () => migrateLegacyFile(dataDir())),
    sample: new SampleStore(path.join(dataDir(), "sample")),
  };
  return g.__siteSentry;
}

export function getStore(ws: Workspace): Store {
  return stores()[ws];
}

export async function resetSample() {
  await stores().sample.reset();
}

/** Test hook: replace both stores (e.g. with MemoryStores). */
export function __setStoresForTests(live: Store, sample: Store) {
  g.__siteSentry = { live, sample: sample as SampleStore };
}

export async function getDeps(ws: Workspace): Promise<Deps> {
  const store = getStore(ws);
  if (ws === "sample") {
    const { sampleState } = await store.read();
    return { store, fetch: sampleFetcher(sampleState ?? "current"), now: () => new Date(), newId: () => randomUUID(), source: "sample" };
  }
  return { store, fetch: policyFetcher(liveFetcher), now: () => new Date(), newId: () => randomUUID(), source: "live" };
}

export function assertLiveScans(ws: Workspace) {
  if (ws === "live" && !liveScansEnabled()) {
    throw new WorkflowError("LIVE_DISABLED", "Live scanning is disabled on this deployment (SITE_SENTRY_LIVE_SCANS=disabled). The sample workspace still works.");
  }
}

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_RULE_CONFIG, type AuditFinding } from "../audit/types";
import type { PageSnapshot, StoreDataV2 } from "../model";

export type StoreData = StoreDataV2;

/** Per-audit results, kept out of the main state so the state file stays small. */
export interface AuditBlob {
  snapshots: PageSnapshot[];
  findings: AuditFinding[];
}

export const emptyStore = (): StoreData => ({
  schemaVersion: 2,
  sites: {},
  pages: {},
  audits: {},
  tasks: {},
  settings: { ruleConfig: { ...DEFAULT_RULE_CONFIG }, severityOverrides: {} },
});

export class StoreUnavailableError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = "StoreUnavailableError";
  }
}

/**
 * Persistence boundary. `read` returns a snapshot; `update` runs a mutation under a lock.
 * Keep slow work (network fetches) OUTSIDE `update` — read, do the work, then update.
 */
export interface Store {
  /** Whether data survives a restart. False for in-memory fallbacks. */
  readonly persistent: boolean;
  read(): Promise<StoreData>;
  update<T>(fn: (data: StoreData) => T): Promise<T>;
  readAudit(auditId: string): Promise<AuditBlob>;
  writeAudit(auditId: string, blob: AuditBlob): Promise<void>;
  deleteAudit(auditId: string): Promise<void>;
}

/** Serialises async work so concurrent requests can't interleave read-modify-write. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export class MemoryStore implements Store {
  readonly persistent: boolean;
  private data: StoreData;
  private blobs = new Map<string, AuditBlob>();
  private lock = new Mutex();
  constructor(initial: StoreData = emptyStore(), opts: { persistent?: boolean; blobs?: Record<string, AuditBlob> } = {}) {
    this.data = structuredClone(initial);
    this.persistent = opts.persistent ?? false;
    for (const [id, b] of Object.entries(opts.blobs ?? {})) this.blobs.set(id, structuredClone(b));
  }
  async read() {
    return structuredClone(this.data);
  }
  update<T>(fn: (data: StoreData) => T) {
    return this.lock.run(async () => {
      const draft = structuredClone(this.data);
      const result = fn(draft);
      this.data = draft;
      return structuredClone(result);
    });
  }
  async readAudit(id: string) {
    return structuredClone(this.blobs.get(id) ?? { snapshots: [], findings: [] });
  }
  async writeAudit(id: string, blob: AuditBlob) {
    this.blobs.set(id, structuredClone(blob));
  }
  async deleteAudit(id: string) {
    this.blobs.delete(id);
  }
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * JSON files: `<dir>/state.json` plus `<dir>/audits/<id>.json`. Fine for one server process;
 * use a database behind the same interface for multi-instance deployments.
 */
export class JsonFileStore implements Store {
  readonly persistent = true;
  private lock = new Mutex();
  private blobLock = new Mutex();
  constructor(
    private dir: string,
    private migrate?: (dir: string) => Promise<{ state: StoreData; blobs: Record<string, AuditBlob> } | null>,
  ) {}

  private get file() {
    return path.join(this.dir, "state.json");
  }

  private blobFile(id: string) {
    if (!SAFE_ID.test(id)) throw new StoreUnavailableError("Invalid audit id.");
    return path.join(this.dir, "audits", `${id}.json`);
  }

  private async load(): Promise<StoreData> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new StoreUnavailableError("Could not read saved data.", e);
      const migrated = this.migrate ? await this.migrate(this.dir) : null;
      if (!migrated) return emptyStore();
      for (const [id, blob] of Object.entries(migrated.blobs)) await this.writeBlobFile(id, blob);
      await this.save(migrated.state);
      return migrated.state;
    }
    try {
      const parsed = JSON.parse(text);
      return { ...emptyStore(), ...parsed };
    } catch (e) {
      // Never overwrite a file we cannot parse: that would destroy the user's data.
      throw new StoreUnavailableError(`Saved data in ${this.file} is not valid JSON. Fix or move the file; it was not modified.`, e);
    }
  }

  private async save(data: StoreData) {
    try {
      await mkdir(this.dir, { recursive: true });
      // Direct write behind the mutex: rename-over-existing can fail with EPERM on Windows.
      await writeFile(this.file, JSON.stringify(data), "utf8");
    } catch (e) {
      throw new StoreUnavailableError("Could not save data (is the data directory writable?).", e);
    }
  }

  read() {
    return this.lock.run(() => this.load());
  }

  update<T>(fn: (data: StoreData) => T) {
    return this.lock.run(async () => {
      const data = await this.load();
      const result = fn(data);
      await this.save(data);
      return result;
    });
  }

  private async writeBlobFile(id: string, blob: AuditBlob) {
    try {
      await mkdir(path.join(this.dir, "audits"), { recursive: true });
      await writeFile(this.blobFile(id), JSON.stringify(blob), "utf8");
    } catch (e) {
      if (e instanceof StoreUnavailableError) throw e;
      throw new StoreUnavailableError("Could not save audit results.", e);
    }
  }

  readAudit(id: string) {
    return this.blobLock.run(async () => {
      try {
        return JSON.parse(await readFile(this.blobFile(id), "utf8")) as AuditBlob;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return { snapshots: [], findings: [] };
        if (e instanceof StoreUnavailableError) throw e;
        throw new StoreUnavailableError(`Could not read results for audit ${id}.`, e);
      }
    });
  }

  writeAudit(id: string, blob: AuditBlob) {
    return this.blobLock.run(() => this.writeBlobFile(id, blob));
  }

  deleteAudit(id: string) {
    return this.blobLock.run(async () => {
      await rm(this.blobFile(id), { force: true });
    });
  }
}

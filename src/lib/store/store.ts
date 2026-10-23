import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuditResult, PageExpectations, TrackedFinding } from "../audit/types";
import type { SampleState } from "../sample/sample-page";

export interface StoreData {
  audits: Record<string, AuditResult>;
  findings: Record<string, TrackedFinding>;
  /** Keyed by normalised page URL. */
  expectations: Record<string, PageExpectations>;
  sampleState: SampleState;
}

const MAX_AUDITS = 50;

export const emptyStore = (): StoreData => ({ audits: {}, findings: {}, expectations: {}, sampleState: "broken" });

/**
 * Persistence boundary. `read` returns a snapshot; `update` runs a mutation under a lock.
 * Keep slow work (network fetches) OUTSIDE `update` — read, do the work, then update.
 */
export interface Store {
  read(): Promise<StoreData>;
  update<T>(fn: (data: StoreData) => T): Promise<T>;
}

function prune(data: StoreData) {
  const ids = Object.keys(data.audits);
  if (ids.length <= MAX_AUDITS) return;
  const keep = new Set(
    Object.values(data.findings).map((f) => f.auditId), // never drop audits that tracked findings came from
  );
  const removable = Object.values(data.audits)
    .filter((a) => !keep.has(a.id))
    .sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
  for (const a of removable.slice(0, ids.length - MAX_AUDITS)) delete data.audits[a.id];
}

/** Serialises async work so concurrent requests can't interleave read-modify-write. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export class MemoryStore implements Store {
  private data: StoreData;
  private lock = new Mutex();
  constructor(initial: StoreData = emptyStore()) {
    this.data = structuredClone(initial);
  }
  async read() {
    return structuredClone(this.data);
  }
  update<T>(fn: (data: StoreData) => T) {
    return this.lock.run(async () => {
      const draft = structuredClone(this.data);
      const result = fn(draft);
      prune(draft);
      this.data = draft;
      return structuredClone(result);
    });
  }
}

/** Single JSON file. Fine for a local MVP; swap for a database behind the same interface later. */
export class JsonFileStore implements Store {
  private lock = new Mutex();
  constructor(private file: string) {}

  private async load(): Promise<StoreData> {
    try {
      return { ...emptyStore(), ...JSON.parse(await readFile(this.file, "utf8")) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
      throw e;
    }
  }

  read() {
    return this.lock.run(() => this.load());
  }

  update<T>(fn: (data: StoreData) => T) {
    return this.lock.run(async () => {
      const data = await this.load();
      const result = fn(data);
      prune(data);
      await mkdir(path.dirname(this.file), { recursive: true });
      // Direct write behind the mutex: rename-over-existing can fail with EPERM on Windows.
      await writeFile(this.file, JSON.stringify(data, null, 2), "utf8");
      return result;
    });
  }
}

// One instance per server process, surviving dev hot reloads (otherwise two mutexes could race).
const g = globalThis as unknown as { __siteSentryStore?: Store };

export function getStore(): Store {
  g.__siteSentryStore ??= new JsonFileStore(
    process.env.SITE_SENTRY_DATA_FILE ?? path.join(process.cwd(), ".data", "store.json"),
  );
  return g.__siteSentryStore;
}

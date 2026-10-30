// Object storage for raw HTML (docs/SPEC.md "Storage": gzip in S3/R2, Postgres keeps pointers). The interface
// mirrors the S3 object calls (PutObject/GetObject/HeadObject/DeleteObject with Key, Body, ContentType,
// ContentEncoding), so an R2 or S3 client can implement it later without touching callers. Only the local-disk
// implementation exists now.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

export interface PutObjectInput {
  Key: string;
  Body: Buffer;
  ContentType: string;
  ContentEncoding?: "gzip";
}

export interface ObjectHead {
  ContentLength: number;
  ContentType: string;
  ContentEncoding?: "gzip";
}

export interface BlobStore {
  putObject(input: PutObjectInput): Promise<void>;
  /** null when the key does not exist. */
  getObject(key: string): Promise<(ObjectHead & { Body: Buffer }) | null>;
  headObject(key: string): Promise<ObjectHead | null>;
  deleteObject(key: string): Promise<void>;
}

/** S3-safe keys only: lower-case letters, digits and . _ - / segments; no empty, "." or ".." segments. */
const KEY = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;
export function assertKey(key: string): void {
  if (key.length > 512 || !KEY.test(key) || key.split("/").some((s) => s === "." || s === "..")) throw new Error(`Invalid blob key: ${JSON.stringify(key.slice(0, 100))}`);
}

/**
 * Files under `root`, one per key, with a `.meta.json` sidecar for content type and encoding. Writes go to a
 * temporary file that is then renamed, so a reader never sees a half-written object.
 */
export class LocalBlobStore implements BlobStore {
  constructor(readonly root: string) {}

  private file(key: string): string {
    assertKey(key);
    return path.join(this.root, ...key.split("/"));
  }

  async putObject({ Key, Body, ContentType, ContentEncoding }: PutObjectInput): Promise<void> {
    const file = this.file(Key);
    await mkdir(path.dirname(file), { recursive: true });
    const meta: ObjectHead = { ContentLength: Body.length, ContentType, ...(ContentEncoding ? { ContentEncoding } : {}) };
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(`${tmp}.meta`, JSON.stringify(meta));
    await rename(`${tmp}.meta`, `${file}.meta.json`);
    await writeFile(tmp, Body);
    await rename(tmp, file);
  }

  async headObject(key: string): Promise<ObjectHead | null> {
    const file = this.file(key);
    try {
      const [meta, st] = await Promise.all([readFile(`${file}.meta.json`, "utf8"), stat(file)]);
      return { ...(JSON.parse(meta) as ObjectHead), ContentLength: st.size };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async getObject(key: string): Promise<(ObjectHead & { Body: Buffer }) | null> {
    const head = await this.headObject(key);
    if (!head) return null;
    return { ...head, Body: await readFile(this.file(key)) };
  }

  async deleteObject(key: string): Promise<void> {
    const file = this.file(key);
    await rm(file, { force: true });
    await rm(`${file}.meta.json`, { force: true });
  }
}

/** The worker's store: BLOB_DIR (default .data/blobs, gitignored). An S3/R2 store would be chosen here too. */
export function blobStoreFromEnv(env: Record<string, string | undefined> = process.env): BlobStore {
  return new LocalBlobStore(path.resolve(env.BLOB_DIR || path.join(".data", "blobs")));
}

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export const rawHtmlKey = (crawlId: string, urlId: number) => `crawls/${crawlId.toLowerCase()}/html/${urlId}.html.gz`;
/** The DOM after a headless-browser render (src/lib/render). */
export const renderedHtmlKey = (crawlId: string, urlId: number) => `crawls/${crawlId.toLowerCase()}/rendered/${urlId}.html.gz`;

async function putHtml(store: BlobStore, Key: string, html: string): Promise<string> {
  await store.putObject({ Key, Body: await gzipAsync(Buffer.from(html, "utf8")), ContentType: "text/html; charset=utf-8", ContentEncoding: "gzip" });
  return Key;
}

/** Store a page's raw HTML gzipped; returns the key. */
export function putRawHtml(store: BlobStore, crawlId: string, urlId: number, html: string): Promise<string> {
  return putHtml(store, rawHtmlKey(crawlId, urlId), html);
}

/** Store a page's rendered DOM gzipped; returns the key. Read it back with getRawHtml. */
export function putRenderedHtml(store: BlobStore, crawlId: string, urlId: number, html: string): Promise<string> {
  return putHtml(store, renderedHtmlKey(crawlId, urlId), html);
}

export async function getRawHtml(store: BlobStore, key: string): Promise<string | null> {
  const obj = await store.getObject(key);
  if (!obj) return null;
  return (obj.ContentEncoding === "gzip" ? await gunzipAsync(obj.Body) : obj.Body).toString("utf8");
}

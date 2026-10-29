// Gate check "a killed worker resumes with no duplicate fetches": real worker processes, a hard kill mid-crawl.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newCrawl, testDb } from "@/test/db";
import { startLocalServer, type LocalServer } from "@/test/local-server";
import { activeCount, stateCounts } from "../lib/crawl/v2/frontier";
import { createCrawlQueue, enqueueCrawl } from "../lib/crawl/v2/queue";

const db = testDb();
const PAGES = 150;
const CONCURRENCY = 3;
const queueName = `crawl-test-${randomUUID()}`;
let srv: LocalServer;

beforeAll(async () => {
  // Files run one at a time; start from an empty database so the workers only see this test's crawl.
  await db.execute(sql`truncate crawls cascade`);
  srv = await startLocalServer();
  // A binary tree of pages; each response takes 30 ms so the kill lands while requests are in flight.
  for (let i = 0; i < PAGES; i++) {
    const kids = [2 * i + 1, 2 * i + 2].filter((k) => k < PAGES).map((k) => `<a href="/p/${k}">p${k}</a>`);
    srv.routes.set(i === 0 ? "/" : `/p/${i}`, (_req, res) => {
      setTimeout(() => res.writeHead(200, { "content-type": "text/html" }).end(`<title>p${i}</title><main>${kids.join("")}</main>`), 30);
    });
  }
});
afterAll(async () => {
  await srv.close();
  await db.$client.end();
});

function startWorker(extra: Record<string, string> = {}): { child: ChildProcess; output: () => string; exited: Promise<number | null> } {
  let out = "";
  const child = spawn(process.execPath, ["--import", "tsx", "src/worker/crawl-worker.ts"], {
    env: {
      ...process.env,
      CRAWL_QUEUE_NAME: queueName,
      ANALYSIS_QUEUE_NAME: `${queueName}-analysis`,
      CRAWLER_LOCAL_HOSTS: "kill.test=127.0.0.1",
      CRAWLER_LOCAL_PORTS: String(srv.port),
      CRAWLER_HOST_CONCURRENCY: String(CONCURRENCY),
      // Well above the 5 req/s default, so requests overlap and the kill lands while some are in flight.
      CRAWLER_HOST_RATE: "1000",
      CRAWL_JOB_LOCK_MS: "2000",
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  return { child, output: () => out, exited };
}

const pageHits = () => [...srv.hits.entries()].filter(([p]) => p === "/" || p.startsWith("/p/"));

async function until(cond: () => Promise<boolean> | boolean, ms: number, what: string) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("crawl worker", () => {
  it("resumes a crawl after a hard kill, without requesting any URL twice", async () => {
    const origin = `http://kill.test:${srv.port}`;
    const c = await newCrawl(db, { siteOrigin: origin, status: "queued" });
    process.env.CRAWL_QUEUE_NAME = queueName;
    const queue = createCrawlQueue();
    await enqueueCrawl(queue, c);

    const w1 = startWorker();
    await until(() => pageHits().length >= 40, 60_000, "40 page requests from worker 1");
    w1.child.kill("SIGKILL"); // TerminateProcess on Windows: no shutdown handlers run
    await w1.exited;
    const hitsAtKill = pageHits().length;
    const mid = await activeCount(db, c);
    expect(hitsAtKill).toBeLessThan(PAGES);
    expect(mid.fetching).toBeGreaterThan(0); // the kill really landed mid-request

    const w2 = startWorker();
    try {
      await until(
        async () => ((await db.execute(sql`select status from crawls where id = ${c}::uuid`)).rows[0] as { status: string }).status === "completed",
        90_000,
        "worker 2 to complete the crawl",
      );
    } finally {
      w2.child.kill("SIGKILL");
      await w2.exited;
      await queue.close();
    }

    // No URL was requested twice, across both workers.
    for (const [path, n] of srv.hits) expect(n, `${path} requested ${n} times`).toBe(1);
    const counts = await stateCounts(db, c);
    const interrupted = counts.interrupted ?? 0;
    expect(await activeCount(db, c)).toEqual({ discovered: 0, queued: 0, fetching: 0 });
    expect(interrupted).toBeGreaterThan(0);
    expect(interrupted).toBeLessThanOrEqual(CONCURRENCY);
    // Every known URL was committed exactly once and ended fetched (or analysed), or interrupted if it was in flight at the kill.
    // Links on an interrupted page are never read, so pages reachable only through it stay undiscovered (here there
    // is no sitemap); see docs/CRAWLER-STATES.md.
    const rows = Object.values(counts).reduce((a, b) => a + b, 0);
    const committed = ((await db.execute(sql`select fetches_committed as n from crawls where id = ${c}::uuid`)).rows[0] as { n: number }).n;
    // The in-process analysis worker may already have moved fetched rows to analysed.
    expect((counts.fetched ?? 0) + (counts.analysed ?? 0) + interrupted).toBe(rows);
    expect(committed).toBe(rows);
    expect(pageHits().length).toBeLessThanOrEqual(committed);
    expect(committed - pageHits().length).toBeLessThanOrEqual(interrupted); // committed, killed before it was sent
    expect(w2.output()).toMatch(/"event":"crawl.recovered".*"interrupted":[1-9]/);
    console.log(JSON.stringify({ hitsAtKill, stateCounts: counts, totalPageHits: pageHits().length }));
  });
});

describe("crawl job takeover at the production lock settings", () => {
  it("a second worker picks up a killed worker's crawl within 40 s (lock 25 s + stall check 15 s)", async () => {
    // Production defaults: no CRAWL_JOB_LOCK_MS / CRAWL_JOB_STALLED_MS (an empty value falls back to the default).
    // One request a second, so the crawl is still running when worker 1 is killed.
    const prod = { CRAWL_JOB_LOCK_MS: "", CRAWL_JOB_STALLED_MS: "", CRAWLER_HOST_RATE: "1" };
    const origin = `http://kill.test:${srv.port}`;
    const c = await newCrawl(db, { siteOrigin: origin, status: "queued" });
    process.env.CRAWL_QUEUE_NAME = queueName;
    const queue = createCrawlQueue();
    const started = (w: { output: () => string }) => w.output().includes(`"event":"crawl.start","crawlId":"${c}"`);
    const w1 = startWorker(prod);
    let w2: ReturnType<typeof startWorker> | null = null;
    try {
      await until(() => w1.output().includes('"event":"worker.boot"'), 60_000, "worker 1 to boot");
      await enqueueCrawl(queue, c);
      await until(() => started(w1), 30_000, "worker 1 to start the crawl");
      w2 = startWorker(prod);
      await until(() => w2!.output().includes('"event":"worker.boot"'), 60_000, "worker 2 to boot");
      expect(started(w2)).toBe(false); // the job is worker 1's
      w1.child.kill("SIGKILL"); // no shutdown handlers: the job lock is left to expire
      await w1.exited;
      const killedAt = Date.now();
      await until(() => started(w2!), 60_000, "worker 2 to take over the crawl");
      const takeoverS = (Date.now() - killedAt) / 1000;
      console.log(JSON.stringify({ takeoverS }));
      expect(takeoverS).toBeLessThanOrEqual(40);
    } finally {
      w1.child.kill("SIGKILL");
      if (w2) {
        w2.child.kill("SIGKILL");
        await w2.exited;
      }
      // Never leave a running crawl for the workers of later tests to resume at boot.
      await db.execute(sql`update crawls set status = 'cancelled', finished_at = now() where id = ${c}::uuid`);
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
});

describe("crawl workers sharing a host", () => {
  // Two crawls of one host in two worker processes. Every response takes 200 ms, and the rate cap is lifted, so
  // concurrency is the only limit: without a shared budget each worker would keep 3 requests in flight (6 in all).
  const PER_CRAWL = 30;
  let inFlight = 0;
  let peak = 0;
  const bySection = { a: 0, b: 0 };
  let overlap = false;
  let total = 0;
  const host = createServer((req, res) => {
    const section = req.url?.startsWith("/a/") ? "a" : req.url?.startsWith("/b/") ? "b" : null;
    total++;
    inFlight++;
    peak = Math.max(peak, inFlight);
    if (section) bySection[section]++;
    if (bySection.a > 0 && bySection.b > 0) overlap = true;
    setTimeout(() => {
      inFlight--;
      if (section) bySection[section]--;
      const m = /^\/([ab])\/$/.exec(req.url ?? "");
      if (m) return void res.writeHead(200, { "content-type": "text/html" }).end(Array.from({ length: PER_CRAWL - 1 }, (_, i) => `<a href="/${m[1]}/p-${i}">${i}</a>`).join(""));
      if (section) return void res.writeHead(200, { "content-type": "text/html" }).end("<title>page</title>");
      res.writeHead(404, { "content-type": "text/plain" }).end("not found"); // robots.txt, sitemaps
    }, 200);
  });
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((r) => host.listen(0, "127.0.0.1", r));
    port = (host.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => host.close(() => r())));

  /** Run one crawl of /a/ and one of /b/ on the same host, one per worker; return the peak requests in flight. */
  async function runPair(prefixes: [string, string]) {
    inFlight = peak = total = 0;
    overlap = false;
    // A queue of its own: a job left stalled by the kill test above would otherwise be redelivered to these workers.
    const queueName = `crawl-test-${randomUUID()}`;
    process.env.CRAWL_QUEUE_NAME = queueName;
    const env = (prefix: string) => ({
      CRAWL_QUEUE_NAME: queueName,
      ANALYSIS_QUEUE_NAME: `${queueName}-analysis`,
      CRAWLER_LOCAL_HOSTS: "shared.test=127.0.0.1",
      CRAWLER_LOCAL_PORTS: String(port),
      CRAWLER_HOST_RATE: "1000",
      CRAWL_WORKER_CONCURRENCY: "1",
      CRAWLER_THROTTLE_PREFIX: prefix,
    });
    const workers = prefixes.map((p) => startWorker(env(p)));
    const queue = createCrawlQueue();
    try {
      await until(() => workers.every((w) => w.output().includes('"event":"worker.boot"')), 60_000, "both workers to boot");
      const origin = `http://shared.test:${port}`;
      const crawls: string[] = [];
      for (const subfolder of ["/a/", "/b/"]) {
        const c = await newCrawl(db, { siteOrigin: origin, status: "queued", config: { scope: { include: [], exclude: [], subfolder } } });
        crawls.push(c);
        await enqueueCrawl(queue, c);
      }
      const done = async () =>
        ((await db.execute(sql`select count(*)::int as n from crawls where id = any(${`{${crawls.join(",")}}`}::uuid[]) and status = 'completed'`)).rows[0] as { n: number }).n === 2;
      await until(done, 90_000, "both crawls to complete");
      // One crawl per worker, so the two crawls really ran in two processes.
      for (const w of workers) expect(w.output().match(/"event":"crawl.start"/g), w.output()).toHaveLength(1);
      return { peak, overlap, total };
    } finally {
      for (const w of workers) w.child.kill("SIGKILL");
      await Promise.all(workers.map((w) => w.exited));
      await queue.close();
    }
  }

  it("never has more than 3 requests in flight to one host across two workers", async () => {
    const shared = `test:shared:${randomUUID()}:`;
    const r = await runPair([shared, shared]);
    expect(r.total).toBeGreaterThanOrEqual(2 * PER_CRAWL);
    expect(r.overlap).toBe(true); // both crawls had requests in flight at the same moment
    expect(r.peak).toBe(3); // reached the cap, never above it

    // Control: the same two crawls with a budget per worker (separate keys) go over the cap, so the check above can fail.
    const control = await runPair([`test:solo:${randomUUID()}:`, `test:solo:${randomUUID()}:`]);
    expect(control.peak).toBeGreaterThan(3);
    console.log(JSON.stringify({ shared: r, control }));
  });
});

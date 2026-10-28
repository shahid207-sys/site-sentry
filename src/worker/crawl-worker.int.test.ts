// Gate check "a killed worker resumes with no duplicate fetches": real worker processes, a hard kill mid-crawl.
import { spawn, type ChildProcess } from "node:child_process";
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

function startWorker(): { child: ChildProcess; output: () => string; exited: Promise<number | null> } {
  let out = "";
  const child = spawn(process.execPath, ["--import", "tsx", "src/worker/crawl-worker.ts"], {
    env: {
      ...process.env,
      CRAWL_QUEUE_NAME: queueName,
      CRAWLER_LOCAL_HOSTS: "kill.test=127.0.0.1",
      CRAWLER_LOCAL_PORTS: String(srv.port),
      CRAWLER_CONCURRENCY: String(CONCURRENCY),
      CRAWL_JOB_LOCK_MS: "2000",
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
    // Every known URL was committed exactly once and ended fetched, or interrupted if it was in flight at the kill.
    // Links on an interrupted page are never read, so pages reachable only through it stay undiscovered (here there
    // is no sitemap); see docs/CRAWLER-STATES.md.
    const rows = Object.values(counts).reduce((a, b) => a + b, 0);
    const committed = ((await db.execute(sql`select fetches_committed as n from crawls where id = ${c}::uuid`)).rows[0] as { n: number }).n;
    expect((counts.fetched ?? 0) + interrupted).toBe(rows);
    expect(committed).toBe(rows);
    expect(pageHits().length).toBeLessThanOrEqual(committed);
    expect(committed - pageHits().length).toBeLessThanOrEqual(interrupted); // committed, killed before it was sent
    expect(w2.output()).toMatch(/"event":"crawl.recovered".*"interrupted":[1-9]/);
    console.log(JSON.stringify({ hitsAtKill, stateCounts: counts, totalPageHits: pageHits().length }));
  });
});

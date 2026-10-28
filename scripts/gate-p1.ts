// Phase 1 gate (docs/SPEC.md "P1 · Crawler + coverage"), run against the fixture site with real worker processes:
//   1. Standard discovers 100% of the fixture's manifest URLs, including sitemap-only pages, and every URL (trap
//      URLs included) ends in a terminal state with a reason. This run is also the timing run: 1,000 fetches at
//      default politeness on localhost in under 6 minutes, /slow/ included.
//   2. /deep/ is reachable by links to depth 8 (Custom: home + /deep/, unlimited depth).
//   3. A worker killed mid-crawl is replaced and the crawl completes with no URL requested twice.
//   4. The SSRF suites pass, and no /ssrf/ redirect reached the canary listener on 127.0.0.1.
//
// Run: npm run gate:p1   (needs `docker compose up -d`; uses its own database, sitesentry_gate)
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { DEEP_CHAIN_DEPTH, deepChainPath, manifestPaths, ROBOTS_BLOCKED_PREFIX, SECTIONS, sectionPaths } from "../fixtures/site/definition";
import { startFixtureSite, type FixtureSite } from "../fixtures/site/server";
import { createDb, migrateDb, type Db } from "../src/lib/db/client";
import { crawls } from "../src/lib/db/schema";
import { PROFILES } from "../src/lib/crawl/profiles";
import { createCrawlQueue, enqueueCrawl } from "../src/lib/crawl/v2/queue";
import type { CrawlConfig } from "../src/lib/crawl/v2/runner";

const DB_URL = process.env.GATE_DATABASE_URL ?? "postgres://sitesentry:sitesentry@127.0.0.1:5433/sitesentry_gate";
const QUEUE = `crawl-gate-${randomUUID()}`;
const TIME_LIMIT_S = 360;
const ACTIVE = ["discovered", "queued", "fetching"];

const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}: ${detail}`);
}
const info = (msg: string) => console.log(`      ${msg}`);

async function setupDb(): Promise<Db> {
  const url = new URL(DB_URL);
  const admin = new Client({ connectionString: Object.assign(new URL(url), { pathname: "/postgres" }).toString() });
  await admin.connect();
  const name = url.pathname.slice(1);
  if (!(await admin.query("select 1 from pg_database where datname = $1", [name])).rowCount) await admin.query(`create database "${name}"`);
  await admin.end();
  const db = createDb(url.toString(), 4);
  await migrateDb(db);
  await db.$client.query("truncate crawls cascade");
  return db;
}

/** A real worker process with the production politeness defaults: only the fixture host mapping (which needs NODE_ENV=test) and the database differ. */
function startWorker(site: FixtureSite, label: string): { child: ChildProcess; booted: Promise<void>; exited: Promise<number | null> } {
  const env = {} as NodeJS.ProcessEnv;
  for (const [k, v] of Object.entries(process.env)) if (!/^CRAWL(ER)?_/.test(k)) env[k] = v; // no tuned politeness or locks
  Object.assign(env, {
    DATABASE_URL: DB_URL,
    CRAWL_QUEUE_NAME: QUEUE,
    CRAWLER_LOCAL_HOSTS: "fixture.test=127.0.0.1",
    CRAWLER_LOCAL_PORTS: String(site.port),
    NODE_ENV: "test", // the loopback mapping above is refused under any other NODE_ENV
  });
  const child = spawn(process.execPath, ["--import", "tsx", "src/worker/crawl-worker.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let booted!: () => void;
  const bootedP = new Promise<void>((r) => (booted = r));
  child.stdout!.on("data", (d: Buffer) => {
    out += d;
    if (out.includes('"event":"worker.boot"')) booted();
  });
  child.stderr!.on("data", (d: Buffer) => process.stderr.write(`[${label}] ${d}`));
  const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
  return { child, booted: bootedP, exited };
}

async function newCrawl(db: Db, site: FixtureSite, profile: string, budget: number | null, maxDepth: number | null, config: CrawlConfig = {}): Promise<string> {
  const [row] = await db
    .insert(crawls)
    .values({ workspace: "gate", auditId: randomUUID(), siteOrigin: site.origin, profile, config, status: "queued", budget, maxDepth })
    .returning({ id: crawls.id });
  return row.id;
}

async function waitFor(what: string, ms: number, cond: () => boolean | Promise<boolean>) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`Timed out after ${ms / 1000} s waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const status = async (db: Db, id: string) =>
  (await db.$client.query<{ status: string; discovery_done: boolean; fetches_committed: number }>("select status, discovery_done, fetches_committed from crawls where id = $1", [id])).rows[0];
const finished = async (db: Db, id: string) => ["completed", "failed", "cancelled"].includes((await status(db, id)).status);

async function rows(db: Db, id: string) {
  const r = await db.$client.query<{ normalised_url: string; state: string; reason: string | null; depth: number | null; discovered_via: string[] }>(
    "select normalised_url, state, reason, depth, discovered_via from crawl_urls where crawl_id = $1",
    [id],
  );
  return new Map(r.rows.map((x) => [x.normalised_url, x]));
}
const histogram = (xs: Iterable<{ state: string }>) => {
  const h: Record<string, number> = {};
  for (const x of xs) h[x.state] = (h[x.state] ?? 0) + 1;
  return Object.entries(h).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ");
};
function hitCounts(hits: { path: string }[]) {
  const m = new Map<string, number>();
  for (const h of hits) m.set(h.path, (m.get(h.path) ?? 0) + 1);
  return m;
}

async function main() {
  const db = await setupDb();
  const site = await startFixtureSite();
  const abs = (p: string) => `${site.origin}${p}`;
  process.env.CRAWL_QUEUE_NAME = QUEUE; // a queue of its own, so no other worker picks these crawls up
  const q = createCrawlQueue();
  console.log(`Fixture ${site.origin}: ${manifestPaths().length} manifest URLs in ${SECTIONS.length} sections. Gate database ${new URL(DB_URL).pathname.slice(1)}.\n`);

  try {
    // ---------- 1. Standard: discovery, terminal states, timing ----------
    const w = startWorker(site, "worker");
    await w.booted;
    const std = await newCrawl(db, site, "standard", PROFILES.standard.budget, PROFILES.standard.maxDepth);
    const t0 = Date.now();
    await enqueueCrawl(q, std);
    await waitFor("the Standard crawl to finish", 15 * 60_000, () => finished(db, std));
    const elapsedS = (Date.now() - t0) / 1000;
    const s = await status(db, std);
    const r = await rows(db, std);
    const manifest = manifestPaths().map(abs);
    const missing = manifest.filter((u) => !r.has(u));
    check("Standard crawl completes", s.status === "completed", `status ${s.status}`);
    check("Standard discovers 100% of manifest URLs", missing.length === 0, `${manifest.length - missing.length} / ${manifest.length} found${missing.length ? `; missing e.g. ${missing.slice(0, 5).join(", ")}` : ""}`);
    const active = [...r.values()].filter((x) => ACTIVE.includes(x.state));
    const noReason = [...r.values()].filter((x) => !ACTIVE.includes(x.state) && !x.reason);
    const extra = [...r.keys()].filter((u) => !manifest.includes(u));
    check("Every URL ends in one terminal state with a reason", active.length === 0 && noReason.length === 0, `${r.size} URL rows (${extra.length} outside the manifest: traps, broken links, SSRF targets); ${active.length} active, ${noReason.length} without a reason`);
    info(`states: ${histogram(r.values())}`);
    info(`outside the manifest: ${histogram(extra.map((u) => r.get(u)!))}`);
    const orphans = sectionPaths(SECTIONS.find((x) => x.path === "/orphans/")!).map(abs);
    const notSitemapOnly = orphans.filter((u) => r.get(u)?.discovered_via.join(",") !== "sitemap");
    check("Sitemap-only /orphans/ pages found through the sitemap alone", notSitemapOnly.length === 0, `${orphans.length - notSitemapOnly.length} / ${orphans.length} have discovered_via = {sitemap}`);
    const jsPages = sectionPaths(SECTIONS.find((x) => x.path === "/js/")!).slice(1).map(abs);
    info(`/js/ pages (links only via JavaScript) with discovered_via = {sitemap}: ${jsPages.filter((u) => r.get(u)?.discovered_via.join(",") === "sitemap").length} / ${jsPages.length}`);
    const trap = extra.filter((u) => u.includes("/products/?"));
    check("Faceted trap URLs are bounded and terminal", trap.length > 0 && trap.every((u) => !ACTIVE.includes(r.get(u)!.state)), `${trap.length} trap URLs: ${histogram(trap.map((u) => r.get(u)!))}`);
    const blocked = [...r.entries()].filter(([u]) => u.startsWith(abs(ROBOTS_BLOCKED_PREFIX)));
    check("robots.txt-blocked section is not fetched", blocked.length === 5 && blocked.every(([, x]) => x.state === "blocked_robots"), `${blocked.length} URLs: ${histogram(blocked.map(([, x]) => x))}`);
    check("Budget is fetches: exactly 1,000 committed", s.fetches_committed === PROFILES.standard.budget, `${s.fetches_committed} fetches committed`);
    check(`1,000 URLs in under ${TIME_LIMIT_S / 60} minutes at default politeness`, elapsedS < TIME_LIMIT_S, `${elapsedS.toFixed(1)} s from enqueue to completed (${(s.fetches_committed / elapsedS).toFixed(2)} fetches/s; spec target ≥ 3 URLs/s)`);
    const repeats = [...hitCounts(site.hits)].filter(([, n]) => n > 1);
    info(`paths requested more than once: ${repeats.length ? repeats.map(([p, n]) => `${p} ×${n}`).join(", ") : "none"} (429 retries under the same claim are expected)`);
    const slow = sectionPaths(SECTIONS.find((x) => x.path === "/slow/")!).map(abs);
    info(`/slow/: ${slow.map((u) => `${new URL(u).pathname} ${r.get(u)?.state}`).join(", ")}`);

    // ---------- 2. /deep/ reachable by links to depth 8 ----------
    const deep = await newCrawl(db, site, "custom", 1_000, null, { scope: { include: ["^http://fixture\\.test:\\d+/$", "^http://fixture\\.test:\\d+/deep/"], exclude: [] } });
    await enqueueCrawl(q, deep);
    await waitFor("the /deep/ crawl to finish", 10 * 60_000, () => finished(db, deep));
    const d = await rows(db, deep);
    const edges = await db.$client.query<{ from_url: string; to_url: string }>("select from_url, to_url from url_edges where crawl_id = $1 and via = 'link'", [deep]);
    const edgeSet = new Set(edges.rows.map((e) => `${e.from_url} ${e.to_url}`));
    const chain: string[] = [];
    let chainOk = true;
    for (let depth = 1; depth <= 8; depth++) {
      const u = abs(deepChainPath(depth));
      const row = d.get(u);
      const parent = depth === 1 ? abs("/") : abs(deepChainPath(depth - 1));
      const ok = !!row && row.depth === depth && row.discovered_via.includes("link") && edgeSet.has(`${parent} ${u}`) && ["fetched", "analysed"].includes(d.get(parent)?.state ?? "");
      chainOk &&= ok;
      chain.push(`${new URL(u).pathname}@${row?.depth}${ok ? "" : "✗"}`);
    }
    check("/deep/ reachable by links to depth 8 (edge from a fetched parent at each level)", chainOk, chain.join(" → "));
    info(`chain end ${deepChainPath(DEEP_CHAIN_DEPTH)}: depth ${d.get(abs(deepChainPath(DEEP_CHAIN_DEPTH)))?.depth}, ${d.get(abs(deepChainPath(DEEP_CHAIN_DEPTH)))?.state}`);

    // ---------- 3. Kill and resume ----------
    w.child.kill("SIGKILL");
    await w.exited;
    // Counted by arrival (site.requests), so a request the killed worker had open still counts as sent.
    const from = site.requests.length;
    const fromHits = site.hits.length;
    // /slow/p-1..6 are excluded (their 429/503 retries are a separate behaviour); /slow/ and p-7..9 answer after 4 s,
    // which gives the kill a request to land in the middle of.
    const kc = await newCrawl(db, site, "custom", 400, 10, { scope: { include: [], exclude: [String.raw`^http://fixture\.test:\d+/slow/p-[1-6]$`] } });
    const w1 = startWorker(site, "worker-1");
    await w1.booted;
    await enqueueCrawl(q, kc);
    const open = () => {
      const answered = new Set(site.hits.slice(fromHits).map((h) => h.path)); // run 1 already answered every /slow/ path
      return site.requests.slice(from).filter((h) => h.path.startsWith("/slow/") && !answered.has(h.path)).map((h) => h.path);
    };
    await waitFor("a /slow/ request to be open", 5 * 60_000, () => open().length > 0);
    const inFlight = open();
    const discoveryDone = (await status(db, kc)).discovery_done;
    w1.child.kill("SIGKILL"); // TerminateProcess on Windows: no shutdown handlers run
    await w1.exited;
    const killedAt = Date.now();
    const fetchingAtKill = (await db.$client.query<{ n: number }>("select count(*)::int as n from crawl_urls where crawl_id = $1 and state = 'fetching'", [kc])).rows[0].n;
    await new Promise((r) => setTimeout(r, 3_000));
    const afterKill = site.requests.filter((h) => h.t > killedAt).length;
    check(
      "Killed worker is dead (no requests in the 3 s after the kill)",
      afterKill === 0,
      `${afterKill} requests after the kill; ${site.requests.length - from} before it; killed with ${inFlight.join(", ")} awaiting a response (discovery ${discoveryDone ? "done" : "still running"}); ${fetchingAtKill} rows in fetching`,
    );
    const w2 = startWorker(site, "worker-2");
    const resumedAt = Date.now();
    await waitFor("the resumed crawl to finish", 10 * 60_000, () => finished(db, kc));
    const k = await rows(db, kc);
    const kHits = site.requests.slice(from);
    const dupes = [...hitCounts(kHits)].filter(([, n]) => n > 1);
    const ks = await status(db, kc);
    check("Resumed crawl completes", ks.status === "completed", `status ${ks.status} after ${((Date.now() - resumedAt) / 1000).toFixed(1)} s on worker 2`);
    check("No URL requested twice across the kill", dupes.length === 0, `${kHits.length} requests for ${hitCounts(kHits).size} paths${dupes.length ? `; repeated: ${dupes.slice(0, 10).map(([p, n]) => `${p} ×${n}`).join(", ")}` : ""}`);
    const cut = inFlight.map((p) => `${p} ${k.get(abs(p))?.state} (${k.get(abs(p))?.reason ?? "no reason"})`);
    const ruled = [1, 2, 3, 4, 5, 6].map((i) => k.get(abs(`/slow/p-${i}`)));
    check("Custom exclude rule applies (/slow/p-1..6)", ruled.every((x) => x?.state === "excluded_by_rule"), histogram(ruled.filter((x) => !!x)));
    check("URLs cut off by the kill end interrupted, not refetched", inFlight.every((p) => k.get(abs(p))?.state === "interrupted"), cut.join("; "));
    info(`states: ${histogram(k.values())}; fetches committed ${ks.fetches_committed}`);
    w2.child.kill("SIGKILL");
    await w2.exited;

    // ---------- 4. SSRF ----------
    check("No request reached the 127.0.0.1 canary (SSRF redirects)", site.canaryHits.length === 0, `${site.canaryHits.length} canary hits; /ssrf/ pages: ${histogram(sectionPaths(SECTIONS.find((x) => x.path === "/ssrf/")!).map((p) => r.get(abs(p))!).filter(Boolean))}`);
    const vt = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "src/lib/fetch"], { encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" } });
    const out = `${vt.stdout}${vt.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
    const files = /Test Files\s+(.+)/.exec(out)?.[1]?.trim() ?? "?";
    const tests = /Tests\s+(.+)/.exec(out)?.[1]?.trim() ?? "?";
    check("SSRF and safe-fetch suites pass (src/lib/fetch)", vt.status === 0, `files: ${files}; tests: ${tests}`);
  } finally {
    await q.close();
    await site.close();
    await db.$client.end();
  }

  const failed = results.filter((x) => !x.pass);
  console.log(`\n${failed.length ? "GATE FAILED" : "GATE PASSED"}: ${results.length - failed.length} / ${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

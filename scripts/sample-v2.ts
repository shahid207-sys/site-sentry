// Regenerates src/lib/sample/v2-sample.json: a real crawler v2 audit of the Northwind Outdoor sample site
// (fixtures/sample-v2/site.ts), shown by the homepage preview card and the public sample audit.
//
// It serves the site over HTTPS on loopback under its .example host name, runs the crawler (runCrawl) and the full
// analysis (analyseCrawl) twice, the "original" site and then the "fixed" one, in a database of its own, and writes
// the second audit's report (reportData, the object the product's report is built from) with the history of both.
// Only the crawl's local port is rewritten out of the URLs; every title, count, priority and score is the engine's.
//
// Run: npm run sample:v2   (needs `docker compose up -d postgres redis`; uses its own database, sitesentry_sample)
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer, type AddressInfo, type Socket } from "node:net";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { Redis } from "ioredis";
import { Client } from "pg";
import { generate } from "selfsigned";
import { BRAND_WORDS, HOST, sampleSite, SITE_NAME, type Resp, type SampleV2State } from "../fixtures/sample-v2/site";
import { PROFILES } from "../src/lib/crawl/profiles";
import { redisConnection } from "../src/lib/crawl/v2/queue";
import { runCrawl } from "../src/lib/crawl/v2/runner";
import { createDb, migrateDb, type Db } from "../src/lib/db/client";
import { crawls } from "../src/lib/db/schema";
import { isBlockedIp } from "../src/lib/fetch/ip-guard";
import { createPeerCertReader, createSafeFetch, type FetchPolicy } from "../src/lib/fetch/safe-fetch";
import { crawlOverview } from "../src/lib/results/queries";
import { reportData } from "../src/lib/results/report";
import { analyseCrawl } from "../src/lib/rules/analyse";
import { LocalBlobStore } from "../src/lib/snapshot/blob-store";
import type { SampleV2Snapshot } from "../src/lib/sample/v2-types";

const DB_URL = process.env.SAMPLE_DATABASE_URL ?? "postgres://sitesentry:sitesentry@127.0.0.1:5433/sitesentry_sample";
const OUT = path.join(process.cwd(), "src/lib/sample/v2-sample.json");
const APEX = HOST.replace(/^www\./, "");
const DISPLAY_ORIGIN = `https://${HOST}`;
const STANDARD = PROFILES.standard;

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

/** HTTPS and plain HTTP on one loopback port (the first byte picks), serving whichever state `site()` returns. */
async function startServer(site: () => ReturnType<typeof sampleSite>) {
  const pems = await generate([{ name: "commonName", value: HOST }], {
    keyType: "ec",
    algorithm: "sha256",
    notBeforeDate: new Date(Date.now() - 86_400_000),
    notAfterDate: new Date(Date.now() + 365 * 86_400_000),
    extensions: [
      { name: "basicConstraints", cA: false, critical: true },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: [HOST, APEX].map((value) => ({ type: 2, value })) },
    ],
  });
  let port = 0;
  const send = (req: IncomingMessage, res: ServerResponse, r: Resp) => {
    let body = typeof r.body === "string" ? Buffer.from(r.body) : r.body;
    const headers: Record<string, string> = { "content-type": r.type, ...r.headers };
    if (/^(text|application\/(xml|json))/.test(r.type) && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
      body = gzipSync(body);
      headers["content-encoding"] = "gzip";
    }
    headers["content-length"] = String(body.length);
    res.writeHead(r.status, headers).end(req.method === "HEAD" ? undefined : body);
  };
  const handler = (scheme: "http" | "https") => (req: IncomingMessage, res: ServerResponse) => {
    const host = (req.headers.host ?? HOST).replace(/:\d+$/, "");
    const target = req.url ?? "/";
    // http and the bare domain redirect to https://www. permanently, as a well-configured shop does.
    if (scheme === "http" || host !== HOST) return send(req, res, { status: 301, type: "text/html", body: "", headers: { location: `https://${HOST}:${port}${target}` } });
    send(req, res, site().respond(target, req.method));
  };
  const http = createHttpServer(handler("http"));
  const https = createHttpsServer({ key: pems.private, cert: pems.cert }, handler("https"));
  const sockets = new Set<Socket>();
  const server = createNetServer({ pauseOnConnect: true }, (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.once("data", (first) => {
      socket.pause();
      socket.unshift(first);
      (first[0] === 0x16 ? https : http).emit("connection", socket);
      process.nextTick(() => socket.resume());
    });
    socket.resume();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  return {
    port,
    ca: pems.cert,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

async function main() {
  const db = await setupDb();
  const redis = new Redis({ ...(redisConnection(process.env.REDIS_URL) as object), maxRetriesPerRequest: null });
  const blobDir = path.join(process.cwd(), ".data", "sample-v2-blobs");
  const crawlDate = new Date();
  let state: SampleV2State = "original";
  let origin = "";
  const srv = await startServer(() => sampleSite(origin, state, crawlDate));
  origin = `https://${HOST}:${srv.port}`;
  const policy: FetchPolicy = {
    resolve: async (h) => (h === HOST || h === APEX ? ["127.0.0.1"] : []),
    isBlocked: (ip) => ip !== "127.0.0.1" && isBlockedIp(ip),
    allowedPorts: new Set([String(srv.port)]),
    allowLocalNames: false,
    ca: [srv.ca],
  };
  const fetch = createSafeFetch(policy);
  const peerCert = createPeerCertReader(policy);
  const log = (e: string, d?: Record<string, unknown>) => {
    if (/error|fail/i.test(e)) console.log(e, JSON.stringify(d ?? {}));
  };

  const audit = async (n: number, createdAt: Date): Promise<string> => {
    const [row] = await db
      .insert(crawls)
      .values({
        workspace: "sample",
        auditId: `smp-v2-${n}`,
        siteOrigin: `${origin}/`,
        profile: "standard",
        budget: STANDARD.budget,
        maxDepth: STANDARD.maxDepth,
        // Rendering is off: it needs a browser pool, and the sample shows the rules that read the HTML.
        config: { aiCrawlers: "allow", brand: SITE_NAME, spellingAllow: BRAND_WORDS, render: "off" },
        status: "queued",
        createdAt,
      })
      .returning({ id: crawls.id });
    const outcome = await runCrawl({ db, redis, fetch, peerCert, owner: `sample-v2-${randomUUID().slice(0, 8)}`, leaseMs: 60_000, politeness: { keyPrefix: `sample-v2:${randomUUID()}:`, maxConcurrency: 6, ratePerSecond: 200 }, blobs: new LocalBlobStore(blobDir), log }, row.id);
    if (outcome !== "completed") throw new Error(`Crawl ${n} ended ${outcome}`);
    const res = await analyseCrawl(db, row.id);
    if (res.outcome !== "analysed") throw new Error(`Analysis ${n}: ${res.outcome}`);
    const errors = res.stats.filter((s) => s.status === "error");
    if (errors.length) throw new Error(`Rules errored: ${errors.map((e) => `${e.ruleId} ${e.detail}`).join("; ")}`);
    console.log(`audit ${n} (${state}): ${res.pages} pages, ${res.findings} findings`);
    return row.id;
  };

  try {
    const first = await audit(1, new Date(crawlDate.getTime() - 28 * 86_400_000));
    state = "fixed";
    const second = await audit(2, crawlDate);
    const report = await reportData(db, second);
    const before = await crawlOverview(db, first);
    const strip = (s: string) => s.split(origin).join(DISPLAY_ORIGIN);
    const snapshot: SampleV2Snapshot = JSON.parse(
      strip(
        JSON.stringify({
          generator: "scripts/sample-v2.ts",
          generatedAt: crawlDate.toISOString(),
          siteName: SITE_NAME,
          origin: DISPLAY_ORIGIN,
          overview: report.overview,
          crawl: { budget: report.crawl.budget, maxDepth: report.crawl.maxDepth, fetchesCommitted: report.crawl.fetchesCommitted },
          groups: report.groups.map((g) => ({ ...g, urls: g.urls.slice(0, 20) })),
          rulesRan: report.ruleRuns.filter((r) => r.status === "ran").length,
          comparison: report.comparison && { totals: report.comparison.totals, groups: report.comparison.groups.map((g) => ({ ruleId: g.ruleId, change: g.change })) },
          history: [
            { at: before.createdAt, health: before.health?.score ?? null },
            { at: report.overview.createdAt, health: report.overview.health?.score ?? null },
          ],
        }),
      ),
    );
    writeFileSync(OUT, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(`wrote ${path.relative(process.cwd(), OUT)}: health ${snapshot.overview.health?.score}, ${snapshot.groups.length} issue groups`);
  } finally {
    await srv.close();
    await redis.quit();
    await db.$client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Real-site validation (Phase 2 Part B): crawl one live site with crawler v2 and the production fetch policy, run the
// rule analysis on it, and print what a reviewer needs to judge the findings: URL states, coverage, crawl time,
// findings per rule (issue and inconclusive), and for each rule with findings three sample URLs with their evidence.
//
// Production settings on purpose: the default SSRF policy (CRAWLER_LOCAL_HOSTS and NODE_ENV=test are refused), the
// default politeness (3 requests in flight, 5 per second per host), the real crawler user agent, and robots.txt obeyed.
// The AI-crawler setting is left unset, so AIS-002 reports needs_config. Read-only: GET and HEAD requests only.
//
// Run: npx tsx scripts/validate-site.ts https://example.com [--profile standard] [--out report.json]
//      (needs `docker compose up -d`; uses its own database, sitesentry_validate, and keeps earlier runs)
import { randomUUID } from "node:crypto";
import { appendFile, writeFile } from "node:fs/promises";
import { Redis } from "ioredis";
import { Client } from "pg";
import { PROFILES, type ProfileId } from "../src/lib/crawl/profiles";
import { workerFetchPolicy } from "../src/lib/crawl/v2/fetch-policy";
import { cdnManagedLinks, stateCounts } from "../src/lib/crawl/v2/frontier";
import { redisConnection } from "../src/lib/crawl/v2/queue";
import { runCrawl, V2_USER_AGENT } from "../src/lib/crawl/v2/runner";
import { createDb, migrateDb, type Db } from "../src/lib/db/client";
import { crawls } from "../src/lib/db/schema";
import { createSafeFetch } from "../src/lib/fetch/safe-fetch";
import { analyseCrawl } from "../src/lib/rules/analyse";

const DB_URL = process.env.VALIDATE_DATABASE_URL ?? "postgres://sitesentry:sitesentry@127.0.0.1:5433/sitesentry_validate";
const SAMPLES = 3;
/** Memory is sampled every 10 s; past this RSS the crawl is stopped (as a pause) so the machine never runs out. */
const MEMORY_SAMPLE_MS = 10_000;
const MAX_RSS_BYTES = 1.5 * 1024 ** 3;
const mb = (n: number) => `${Math.round(n / 1024 ** 2)} MB`;
/** URL states that mean the URL was requested and answered. */
const ANSWERED = ["fetched", "analysed", "redirected", "non_html", "oversized"];
/**
 * States the site owner or the audit's own rules ruled out; the only ones not counted against coverage. Everything
 * else found counts, including out_of_scope (reported by reason: another host is usually the site's www/apex twin,
 * which is a coverage miss, not a choice) and budget_exhausted / depth_exceeded (found but not reached).
 */
const NOT_OURS = ["blocked_robots", "excluded_by_rule", "cdn_managed"];

function args() {
  const a = process.argv.slice(2);
  const site = a.find((x) => !x.startsWith("--"));
  const opt = (name: string) => {
    const i = a.indexOf(`--${name}`);
    return i >= 0 ? a[i + 1] : undefined;
  };
  if (!site) throw new Error("Usage: tsx scripts/validate-site.ts <https://site> [--profile standard] [--out file.json]");
  const profile = (opt("profile") ?? "standard") as ProfileId;
  if (!PROFILES[profile] || profile === "custom") throw new Error(`Unknown or unsupported profile "${profile}".`);
  return { site: new URL(site).origin, profile, out: opt("out") };
}

async function setupDb(): Promise<Db> {
  const url = new URL(DB_URL);
  const admin = new Client({ connectionString: Object.assign(new URL(url), { pathname: "/postgres" }).toString() });
  await admin.connect();
  const name = url.pathname.slice(1);
  if (!(await admin.query("select 1 from pg_database where datname = $1", [name])).rowCount) await admin.query(`create database "${name}"`);
  await admin.end();
  const db = createDb(url.toString(), 6);
  await migrateDb(db);
  return db;
}

/** Evenly spread picks, so the samples are not all from one corner of the site. */
function spread<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  return Array.from({ length: n }, (_, i) => xs[Math.floor((i * (xs.length - 1)) / (n - 1))]);
}

const clip = (v: unknown, max = 600) => {
  const s = JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

async function main() {
  const { site, profile, out } = args();
  if (process.env.NODE_ENV === "test" || process.env.CRAWLER_LOCAL_HOSTS) throw new Error("Validation runs with the production fetch policy: unset NODE_ENV=test and CRAWLER_LOCAL_HOSTS.");
  const policy = workerFetchPolicy(process.env); // the default SSRF policy when nothing local is configured
  const { budget, maxDepth } = PROFILES[profile];
  const db = await setupDb();
  const redis = new Redis({ ...redisConnection(), maxRetriesPerRequest: null });
  const [row] = await db
    .insert(crawls)
    .values({ workspace: "validation", auditId: randomUUID(), siteOrigin: site, profile, config: {}, status: "queued", budget, maxDepth })
    .returning({ id: crawls.id });
  console.log(`Crawling ${site}: profile ${profile} (budget ${budget}, depth ${maxDepth}), user agent "${V2_USER_AGENT}", default politeness. Crawl ${row.id} in ${new URL(DB_URL).pathname.slice(1)}.`);

  const t0 = Date.now();
  // Memory: process RSS and V8 heap every 10 s to <out>.memory.log (or stdout), with the peak in the report.
  const memLog = out ? `${out.replace(/\.json$/, "")}.memory.log` : null;
  const peak = { rss: 0, heapUsed: 0, at: 0 };
  const stopper = new AbortController();
  let memoryStop: string | null = null;
  const sample = async () => {
    const m = process.memoryUsage();
    if (m.rss > peak.rss) Object.assign(peak, { rss: m.rss, at: Math.round((Date.now() - t0) / 1000) });
    peak.heapUsed = Math.max(peak.heapUsed, m.heapUsed);
    const c = (await stateCounts(db, row.id).catch(() => ({}))) as Record<string, number>;
    const line = `${new Date().toISOString()} t=${Math.round((Date.now() - t0) / 1000)}s rss=${mb(m.rss)} heapUsed=${mb(m.heapUsed)} heapTotal=${mb(m.heapTotal)} external=${mb(m.external)} arrayBuffers=${mb(m.arrayBuffers)} urls=${JSON.stringify(c)}`;
    if (memLog) await appendFile(memLog, line + "\n");
    else console.log(`  mem ${line}`);
    if (m.rss > MAX_RSS_BYTES && !memoryStop) {
      memoryStop = `RSS ${mb(m.rss)} passed the ${mb(MAX_RSS_BYTES)} limit at ${Math.round((Date.now() - t0) / 1000)} s`;
      console.log(`  STOPPING: ${memoryStop}`);
      stopper.abort();
    }
  };
  const memTimer = setInterval(() => void sample(), MEMORY_SAMPLE_MS);
  const progress = setInterval(() => {
    void stateCounts(db, row.id).then((c) => console.log(`  … ${((Date.now() - t0) / 1000).toFixed(0)} s: ${Object.entries(c).map(([k, n]) => `${k} ${n}`).join(", ")}`));
  }, 30_000);
  const outcome = await runCrawl(
    {
      db,
      redis,
      fetch: createSafeFetch(policy),
      owner: `validate-${process.pid}`,
      signal: stopper.signal,
      log: (event, data) => {
        if (/error|failed|refused|halt|throttle|requeued/.test(event)) console.log(`  ${event} ${clip(data, 300)}`);
      },
    },
    row.id,
  );
  clearInterval(progress);
  const crawlMs = Date.now() - t0;
  if (memoryStop) {
    clearInterval(memTimer);
    await sample();
    console.log(`\nStopped for memory: ${memoryStop}. Peak RSS ${mb(peak.rss)} at ${peak.at} s, peak heap ${mb(peak.heapUsed)}. Crawl left as ${outcome}; no analysis was run.${memLog ? ` Samples: ${memLog}` : ""}`);
    redis.disconnect();
    await db.$client.end();
    process.exit(2);
  }
  const t1 = Date.now();
  const analysis = await analyseCrawl(db, row.id);
  const analysisMs = Date.now() - t1;
  clearInterval(memTimer);
  await sample();

  const states = (await stateCounts(db, row.id)) as Record<string, number>;
  const total = Object.values(states).reduce((a, b) => a + b, 0);
  const sum = (ks: string[]) => ks.reduce((n, k) => n + (states[k] ?? 0), 0);
  const answered = sum(ANSWERED);
  const eligible = total - sum(NOT_OURS);
  const crawl = (await db.$client.query("select status, robots, probes, sitemaps, error from crawls where id = $1", [row.id])).rows[0] as Record<string, unknown>;
  const blob = (await db.$client.query<{ blob_status: string | null; n: number }>("select blob_status, count(*)::int as n from page_snapshots where crawl_id = $1 group by 1", [row.id])).rows;
  const runs = (await db.$client.query<{ rule_id: string; status: string; evaluated: number; findings: number; total_ms: number; detail: string | null }>("select rule_id, status, evaluated, findings, total_ms, detail from rule_runs where crawl_id = $1 order by rule_id", [row.id])).rows;
  const f = (await db.$client.query<{ rule_id: string; outcome: string; url: string; message: string; evidence: unknown }>("select rule_id, outcome, url, message, evidence from findings where crawl_id = $1 order by rule_id, outcome, url", [row.id])).rows;

  const byRule = new Map<string, typeof f>();
  for (const x of f) {
    const k = x.outcome === "issue" ? x.rule_id : `${x.rule_id} (${x.outcome})`;
    if (!byRule.has(k)) byRule.set(k, []);
    byRule.get(k)!.push(x);
  }

  console.log(`\nCrawl ${outcome} in ${(crawlMs / 1000).toFixed(1)} s; analysis ${analysis.outcome} in ${(analysisMs / 1000).toFixed(1)} s (${analysis.pages} pages, ${analysis.findings} findings).`);
  console.log(`Memory: peak RSS ${mb(peak.rss)} at ${peak.at} s, peak V8 heap ${mb(peak.heapUsed)} (limit ${mb(MAX_RSS_BYTES)})${memLog ? `; samples every 10 s in ${memLog}` : ""}`);
  console.log(`URL states (${total} URLs): ${Object.entries(states).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  console.log(`Coverage: ${answered} answered of ${eligible} eligible URLs = ${eligible ? ((100 * answered) / eligible).toFixed(1) : "n/a"}% (eligible = every URL found except blocked_robots, excluded_by_rule and cdn_managed)`);
  const cdn = await cdnManagedLinks(db, row.id);
  console.log(`CDN-managed links: ${cdn.links} (${cdn.urls} URL(s) on ${cdn.pages} page(s); recorded, not fetched, not reported as broken)`);
  const scope = (
    await db.$client.query<{ kind: string; host: string; n: number }>(
      `select case when reason like 'Different host%' then 'other host' else 'outside subfolder' end as kind,
              split_part(split_part(url, '//', 2), '/', 1) as host, count(*)::int as n
       from crawl_urls where crawl_id = $1 and state = 'out_of_scope' group by 1, 2 order by 3 desc`,
      [row.id],
    )
  ).rows;
  if (scope.length) console.log(`Out of scope: ${scope.slice(0, 8).map((r) => `${r.kind} ${r.host} ${r.n}`).join("; ")}${scope.length > 8 ? `; … ${scope.length - 8} more hosts` : ""}`);
  const start = (await db.$client.query<{ state: string; status_code: number | null; redirect_target: string | null }>("select state, status_code, redirect_target from crawl_urls where crawl_id = $1 and 'seed' = any(discovered_via) order by id limit 1", [row.id])).rows[0];
  if (start?.redirect_target) console.log(`Start URL ${site}/ answered ${start.status_code} → ${start.redirect_target}`);
  console.log(`Raw HTML storage: ${blob.map((b) => `${b.blob_status ?? "no body"} ${b.n}`).join(", ")}`);
  console.log(`robots.txt: ${clip(crawl.robots && { ...(crawl.robots as object), body: undefined }, 300)}`);
  console.log(`Probes: ${clip((crawl.probes as { kind: string; url: string; status: number | null; skipCode?: string; error?: unknown }[]).map((p) => [p.kind, p.url, p.status, p.skipCode ?? (p.error ? "error" : "")]), 1200)}`);
  console.log(`Rules not run normally: ${runs.filter((r) => r.status !== "ran").map((r) => `${r.rule_id} ${r.status}${r.detail ? ` (${r.detail})` : ""}`).join("; ") || "none"}`);
  console.log(`\nFindings per rule:`);
  for (const [k, xs] of [...byRule].sort()) console.log(`  ${k.padEnd(28)} ${xs.length}`);
  for (const [k, xs] of [...byRule].sort()) {
    console.log(`\n== ${k}: ${xs.length} finding(s); samples:`);
    for (const x of spread(xs, SAMPLES)) console.log(`  - ${x.url}\n    ${x.message}\n    evidence ${clip(x.evidence)}`);
  }

  if (out) {
    await writeFile(out, JSON.stringify({ site, profile, crawlId: row.id, outcome, crawlMs, analysisMs, states, answered, eligible, scope, start, peakMemory: peak, blob, robots: crawl.robots, probes: crawl.probes, sitemaps: crawl.sitemaps, runs, findings: f }, null, 2));
    console.log(`\nFull report: ${out}`);
  }
  redis.disconnect();
  await db.$client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

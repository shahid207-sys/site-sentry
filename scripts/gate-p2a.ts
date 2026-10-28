// Phase 2a gate (docs/SPEC.md "Phase 2"), run against the fixture site with a real worker process, the analysis job
// going through its queue:
//   1. Every implemented rule fires on its positive fixture and is silent on its negative: the findings on the five
//      defect sections (/clean/ /meta/ /index/ /redirects/ /content/), the home page, the /index/ extras and the
//      site-level subjects (robots.txt, sitemaps, llms.txt) equal the declared manifest exactly, on fixture.test and
//      on the three alternate hosts.
//   2. Zero findings on /clean/.
//   3. Every rule was evaluated; AIS-002 reports needs_config where the AI-crawler setting is unset.
//   4. Average rule time per page, per rule and in total (targets: 5 ms per rule, 50 ms for all rules).
//
// Run: npm run gate:p2a   (needs `docker compose up -d`; uses its own database, sitesentry_gate2a)
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { SECTIONS } from "../fixtures/site/definition";
import { DEFECT_COUNTS, EXACT_SECTIONS, expectedFindings } from "../fixtures/site/defects";
import { HOSTS, LOCAL_HOSTS_ENV, startFixtureSite, type FixtureSite, type HostKey } from "../fixtures/site/server";
import { createDb, migrateDb, type Db } from "../src/lib/db/client";
import { crawls } from "../src/lib/db/schema";
import { createCrawlQueue, enqueueCrawl } from "../src/lib/crawl/v2/queue";
import type { CrawlConfig } from "../src/lib/crawl/v2/runner";
import { DEFERRED_RULES, RULES } from "../src/lib/rules/registry";

const DB_URL = process.env.GATE_DATABASE_URL ?? "postgres://sitesentry:sitesentry@127.0.0.1:5433/sitesentry_gate2a";
const QUEUE = `crawl-gate2a-${randomUUID()}`;
/** Rules whose positive case cannot be served by a plain-http local fixture; covered by their unit test only. */
const UNIT_ONLY: Record<string, string> = {
  "IDX-020": "needs http and https on one host; the local fixture has no TLS listener, so its https probe fails (a negative)",
};
const TARGET_MS = { perRule: 5, total: 50 };

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

/** A real worker (crawl + in-process analysis worker). Politeness is raised: this gate measures rules, not crawl speed. */
function startWorker(site: FixtureSite): { child: ChildProcess; booted: Promise<void>; exited: Promise<number | null> } {
  const env = {} as NodeJS.ProcessEnv;
  for (const [k, v] of Object.entries(process.env)) if (!/^(CRAWL(ER)?|ANALYSIS)_/.test(k)) env[k] = v;
  Object.assign(env, {
    DATABASE_URL: DB_URL,
    CRAWL_QUEUE_NAME: QUEUE,
    ANALYSIS_QUEUE_NAME: `${QUEUE}-analysis`,
    CRAWLER_LOCAL_HOSTS: LOCAL_HOSTS_ENV,
    CRAWLER_LOCAL_PORTS: String(site.port),
    CRAWLER_HOST_RATE: "100",
    CRAWLER_HOST_CONCURRENCY: "8",
    NODE_ENV: "test", // the loopback mapping above is refused under any other NODE_ENV
  });
  const child = spawn(process.execPath, ["--import", "tsx", "src/worker/crawl-worker.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let booted!: () => void;
  const bootedP = new Promise<void>((r) => (booted = r));
  child.stdout!.on("data", (d: Buffer) => {
    out += d;
    if (out.includes('"event":"worker.boot"')) booted();
    if (out.length > 1_000_000) out = out.slice(-10_000);
  });
  child.stderr!.on("data", (d: Buffer) => process.stderr.write(`[worker] ${d}`));
  const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
  return { child, booted: bootedP, exited };
}

async function waitFor(what: string, ms: number, cond: () => boolean | Promise<boolean>) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`Timed out after ${ms / 1000} s waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

interface Analysis {
  status: string;
  pages?: number;
  findings?: number;
  msPerPage?: number;
  error?: string;
}
const crawlRow = async (db: Db, id: string) =>
  (await db.$client.query<{ status: string; analysis: Analysis | null }>("select status, analysis from crawls where id = $1", [id])).rows[0];

/** What one crawl must produce, by absolute URL; and which URL prefixes are compared exactly. */
interface Plan {
  key: HostKey;
  label: string;
  config: CrawlConfig;
  budget: number;
  expected: Map<string, string[]>;
  exactPrefixes: string[];
}

function plans(site: FixtureSite): Plan[] {
  const o = site.origins;
  const abs = (key: HostKey, p: string) => new URL(p, o[key]).toString();
  const main = new Map<string, string[]>();
  for (const [p, ids] of expectedFindings()) main.set(abs("main", p), ids);
  main.set(abs("main", "/robots.txt"), ["AIS-001", "AIS-002"]); // AIS-001 reports; AIS-002: GPTBot blocked, setting "allow"
  main.set(abs("main", "/sitemaps/index.xml.gz"), ["IDX-031"]); // one lastmod for every URL
  main.set(abs("main", "/sitemaps/index-noindex.xml.gz"), ["IDX-031"]); // a lastmod in the future
  main.set(abs("main", "/llms.txt"), []);
  main.set(abs("main", "/sitemap_index.xml"), []);
  for (const s of SECTIONS) if (!main.has(abs("main", `/sitemaps/${s.path.slice(1, -1)}.xml.gz`))) main.set(abs("main", `/sitemaps/${s.path.slice(1, -1)}.xml.gz`), []);
  return [
    {
      key: "main",
      label: HOSTS.main,
      // Custom, unlimited depth; the products facet trap is excluded (it is a Phase 1 subject and never ends).
      config: { scope: { include: [], exclude: [String.raw`^http://fixture\.test:\d+/products/\?`] }, aiCrawlers: "allow" },
      budget: 5_000,
      expected: main,
      exactPrefixes: [...EXACT_SECTIONS.map((s) => abs("main", s)), abs("main", "/robots.txt"), abs("main", "/sitemaps/"), abs("main", "/sitemap_index.xml"), abs("main", "/llms.txt")],
    },
    {
      key: "alt",
      label: `${HOSTS.alt} (robots.txt 503)`,
      config: { aiCrawlers: "block" },
      budget: 10,
      expected: new Map([[abs("alt", "/robots.txt"), ["IDX-025", "IDX-027"]], [abs("alt", "/"), []]]),
      exactPrefixes: [o.alt],
    },
    {
      key: "alt2",
      label: `${HOSTS.alt2} (no sitemap, www serves 200, no favicon)`,
      config: { aiCrawlers: "block" },
      budget: 10,
      expected: new Map([
        [abs("alt2", "/robots.txt"), ["IDX-027", "AIS-001"]],
        [abs("alt2", "/"), ["IDX-021", "META-019"]],
        [abs("alt2", "/llms.txt"), ["AIS-003"]], // missing (404); alt3 covers the malformed case
      ]),
      exactPrefixes: [o.alt2],
    },
    {
      key: "alt3",
      label: `${HOSTS.alt3} (50,001-URL sitemap, HTML llms.txt, AI setting unset)`,
      config: {},
      budget: 3,
      expected: new Map([
        [abs("alt3", "/robots.txt"), ["AIS-001"]],
        [abs("alt3", "/sitemap.xml.gz"), ["IDX-030"]],
        [abs("alt3", "/llms.txt"), ["AIS-003"]],
        [abs("alt3", "/"), []], // and the two /item-N pages the budget of 3 reaches: silent (any finding on alt3 is compared)
      ]),
      exactPrefixes: [o.alt3],
    },
  ];
}

async function main() {
  const db = await setupDb();
  const site = await startFixtureSite();
  process.env.CRAWL_QUEUE_NAME = QUEUE;
  const q = createCrawlQueue();
  console.log(`Fixture ${site.origin} (+ ${Object.keys(HOSTS).length - 1} host variants). Defects: /meta/ ${DEFECT_COUNTS.meta}, /index/ ${DEFECT_COUNTS.index}, /content/ ${DEFECT_COUNTS.content}. Gate database ${new URL(DB_URL).pathname.slice(1)}.\n`);
  const w = startWorker(site);
  const fired = new Set<string>();
  const evaluated = new Map<string, number>();
  const timing = new Map<string, { ms: number; evaluated: number; scope: string }>();
  let pagesTotal = 0;
  let msTotal = 0;

  try {
    await w.booted;
    for (const plan of plans(site)) {
      const [row] = await db
        .insert(crawls)
        .values({ workspace: "gate", auditId: randomUUID(), siteOrigin: site.origins[plan.key], profile: "custom", config: plan.config, status: "queued", budget: plan.budget, maxDepth: null })
        .returning({ id: crawls.id });
      const t0 = Date.now();
      await enqueueCrawl(q, row.id);
      // The worker enqueues the analysis job when the crawl ends; the gate only watches the database.
      await waitFor(`${plan.label}: crawl and analysis`, 15 * 60_000, async () => {
        const c = await crawlRow(db, row.id);
        return ["completed", "failed"].includes(c.analysis?.status ?? "") || c.status === "failed";
      });
      const c = await crawlRow(db, row.id);
      console.log(`\n== ${plan.label}`);
      check(`${plan.key}: crawl completed and analysed through the queue`, c.status === "completed" && c.analysis?.status === "completed", `crawl ${c.status}, analysis ${JSON.stringify(c.analysis)} after ${((Date.now() - t0) / 1000).toFixed(1)} s`);

      const f = await db.$client.query<{ rule_id: string; url: string }>("select rule_id, url from findings where crawl_id = $1", [row.id]);
      const got = new Map<string, Set<string>>();
      for (const x of f.rows) {
        if (!got.has(x.url)) got.set(x.url, new Set());
        got.get(x.url)!.add(x.rule_id);
        fired.add(x.rule_id);
      }
      const exact = (u: string) => plan.exactPrefixes.some((p) => u.startsWith(p));
      const subjects = new Set([...plan.expected.keys(), ...[...got.keys()].filter(exact)]);
      const diffs: string[] = [];
      let compared = 0;
      for (const u of subjects) {
        const want = [...new Set(plan.expected.get(u) ?? [])].sort();
        const have = [...(got.get(u) ?? [])].sort();
        compared++;
        if (want.join() !== have.join()) diffs.push(`${u.replace(site.origins[plan.key], "")}: expected [${want}] got [${have}]`);
      }
      check(`${plan.key}: findings equal the manifest`, diffs.length === 0, `${compared} subjects compared, ${f.rows.length} findings in the crawl${diffs.length ? `; ${diffs.length} differ:\n        ${diffs.slice(0, 40).join("\n        ")}` : ""}`);
      if (plan.key === "main") {
        const clean = [...got.entries()].filter(([u]) => u.startsWith(new URL("/clean/", site.origin).toString()));
        check("Zero findings on /clean/", clean.length === 0, clean.length ? clean.map(([u, ids]) => `${u} ${[...ids]}`).slice(0, 10).join("; ") : "100 pages, 0 findings");
        const elsewhere = new Map<string, number>();
        for (const [u, ids] of got) if (!exact(u)) for (const id of ids) elsewhere.set(id, (elsewhere.get(id) ?? 0) + 1);
        info(`outside the exact sections (presence only; their defects are later phases or Phase 1 subjects): ${[...elsewhere].sort().map(([id, n]) => `${id}×${n}`).join(", ") || "none"}`);
      }

      const runs = await db.$client.query<{ rule_id: string; status: string; evaluated: number; total_ms: number; detail: string | null }>(
        "select rule_id, status, evaluated, total_ms, detail from rule_runs where crawl_id = $1",
        [row.id],
      );
      const errors = runs.rows.filter((r) => r.status === "error");
      check(`${plan.key}: no rule errored`, errors.length === 0, errors.length ? errors.map((r) => `${r.rule_id}: ${r.detail}`).join("; ") : `${runs.rows.length} rules ran`);
      if (plan.key === "alt3") {
        const ais = runs.rows.find((r) => r.rule_id === "AIS-002");
        check("AIS-002 reports needs_config when the AI-crawler setting is unset", ais?.status === "needs_config", `${ais?.status}: ${ais?.detail}`);
      }
      for (const r of runs.rows) {
        evaluated.set(r.rule_id, (evaluated.get(r.rule_id) ?? 0) + r.evaluated);
        const scope = RULES.find((x) => x.id === r.rule_id)?.scope ?? "?";
        const t = timing.get(r.rule_id) ?? { ms: 0, evaluated: 0, scope };
        t.ms += r.total_ms;
        t.evaluated += r.evaluated;
        timing.set(r.rule_id, t);
      }
      pagesTotal += c.analysis?.pages ?? 0;
      msTotal += runs.rows.reduce((n, r) => n + r.total_ms, 0);
    }

    console.log("\n== Rules");
    const notEvaluated = RULES.filter((r) => !evaluated.get(r.id));
    check("Every implemented rule was evaluated", notEvaluated.length === 0, `${RULES.length} rules${notEvaluated.length ? `; never evaluated: ${notEvaluated.map((r) => r.id).join(", ")}` : ""}`);
    const silent = RULES.filter((r) => !fired.has(r.id) && !UNIT_ONLY[r.id]);
    check("Every implemented rule fires on its positive fixture", silent.length === 0, `${RULES.length - silent.length - Object.keys(UNIT_ONLY).length} fired in the crawls${silent.length ? `; never fired: ${silent.map((r) => r.id).join(", ")}` : ""}`);
    for (const [id, why] of Object.entries(UNIT_ONLY)) info(`${id} positive is unit-test only (src/lib/rules/rules.test.ts): ${why}; fired here: ${fired.has(id) ? "yes" : "no"}`);
    info(`deferred, not implemented: ${Object.entries(DEFERRED_RULES).map(([id, why]) => `${id} (${why})`).join("; ")}`);

    console.log("\n== Rule time (all four crawls)");
    const perPage = [...timing].filter(([, t]) => t.scope === "page").map(([id, t]) => ({ id, ms: t.evaluated ? t.ms / t.evaluated : 0 }));
    const siteRules = [...timing].filter(([, t]) => t.scope === "site").map(([id, t]) => ({ id, ms: t.ms / Math.max(1, t.evaluated) }));
    perPage.sort((a, b) => b.ms - a.ms);
    siteRules.sort((a, b) => b.ms - a.ms);
    info(`page rules, mean ms per page (slowest first): ${perPage.map((x) => `${x.id} ${x.ms.toFixed(3)}`).join(", ")}`);
    info(`site rules, ms per crawl (slowest first): ${siteRules.slice(0, 10).map((x) => `${x.id} ${x.ms.toFixed(2)}`).join(", ")}`);
    const worst = perPage[0];
    check(`Average time per page rule under ${TARGET_MS.perRule} ms`, worst.ms < TARGET_MS.perRule, `slowest ${worst.id} ${worst.ms.toFixed(3)} ms per page; mean over page rules ${(perPage.reduce((n, x) => n + x.ms, 0) / perPage.length).toFixed(3)} ms`);
    const total = msTotal / Math.max(1, pagesTotal);
    check(`All rules (page + site, amortised) under ${TARGET_MS.total} ms per page`, total < TARGET_MS.total, `${total.toFixed(2)} ms per page over ${pagesTotal} pages (${msTotal.toFixed(0)} ms of rule time)`);
  } finally {
    w.child.kill("SIGKILL");
    await w.exited;
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

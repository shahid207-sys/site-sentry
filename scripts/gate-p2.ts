// Phase 2 gates (docs/SPEC.md "Phase 2"), run against the fixture site with a real worker process, the analysis job
// going through its queue. gate:p2a and gate:p2b share the crawls and the manifest; they differ in which rule
// families must fire and in the 2b-only checks.
//   1. Every rule of the phase's families fires on its positive fixture and is silent on its negative: the findings on
//      every exact section (defects.ts EXACT_SECTIONS), the home page, the extras, the resources (images, external
//      links), the probes and the site-level subjects (robots.txt, sitemaps, llms.txt) equal the declared manifest
//      exactly, on fixture.test and on the three alternate hosts. Analysis runs every implemented rule, so the
//      manifest is compared over all of them in both gates.
//   2. Zero findings on /clean/.
//   3. Every rule was evaluated; AIS-002 reports needs_config where the AI-crawler setting is unset.
//   4. Average rule time per page, per rule and in total (targets: 5 ms per rule, 50 ms for all rules).
//   2b only:
//   5. SITE-001 reports /products/ as one template group of 300 pages (one finding, not 300).
//   6. The resource budgets hold, counted at the fixture server: at most 500 external URLs and 2,000 image URLs requested.
//   7. No /.env body content is stored anywhere: its canary value is absent from every table and every blob.
//
// Run: npm run gate:p2a | npm run gate:p2b   (needs `docker compose up -d`; uses its own database)
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { Client } from "pg";
import { EXT_HOSTS, SECTIONS } from "../fixtures/site/definition";
import { DEFECT_COUNTS, EXACT_SECTIONS, expectedFindings, findingKey } from "../fixtures/site/defects";
import { CDN_LINKS, DEFECT_COUNTS_2B, ENV_CANARY, EXTERNAL_LINK_URLS, FACET_PATH, IMAGE_BUDGET_URLS, KEY_PAGES, MAIN_EXCLUDE, PLAIN_HTTP_PAGE, resourceExpectations, urlOf } from "../fixtures/site/defects-2b";
import { HOSTS, LOCAL_HOSTS_ENV, startFixtureSite, type FixtureSite, type HostKey } from "../fixtures/site/server";
import { createDb, migrateDb, type Db } from "../src/lib/db/client";
import { crawls } from "../src/lib/db/schema";
import { createCrawlQueue, enqueueCrawl } from "../src/lib/crawl/v2/queue";
import type { CrawlConfig } from "../src/lib/crawl/v2/runner";
import { cdnManagedLinks } from "../src/lib/crawl/v2/frontier";
import { MAX_EXTERNAL_LINKS, MAX_IMAGE_URLS } from "../src/lib/crawl/v2/resources";
import { startMemoryLog } from "../src/lib/memory-log";
import { DEFERRED_RULES, RULES } from "../src/lib/rules/registry";

export type Phase = "2a" | "2b";
/** Rule families each gate requires to fire. */
const FAMILIES: Record<Phase, RegExp> = { "2a": /^(IDX|META|CNT|AIS)-/, "2b": /^(IDX|META|CNT|AIS|LNK|I18N|IMG|SD|SEC|SITE)-/ };
let PHASE: Phase = "2a";
let DB_URL = "";
let QUEUE = "";
/** Memory: every process logs RSS and heap every 10 s; past this RSS it writes a heap snapshot and the gate stops. */
export const MEMORY_LIMIT_MB = 700;
/** V8 heap cap for the worker (the gate gets the same from its npm script), so a leak fails fast with a clear error. */
const HEAP_CAP_FLAGS = ["--max-old-space-size=768", "--heapsnapshot-near-heap-limit=1"];
/** Rules whose positive case cannot be served by the local fixture; covered by their unit test only. */
const UNIT_ONLY: Record<string, string> = {};
const TARGET_MS = { perRule: 5, total: 50 };

const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}: ${detail}`);
}
const info = (msg: string) => console.log(`      ${msg}`);

export async function setupDb(dbUrl: string): Promise<Db> {
  const url = new URL(dbUrl);
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
export function startWorker(
  site: FixtureSite,
  blobDir: string,
  memDir: string,
  onMemoryLimit: (detail: string) => void,
  dbUrl: string,
  queue: string,
  /** Set last, over the defaults (gate:p6 adds its webhook receiver's host and the secret key). */
  extraEnv: Record<string, string> = {},
): { child: ChildProcess; booted: Promise<void>; exited: Promise<number | null> } {
  const env = {} as NodeJS.ProcessEnv;
  for (const [k, v] of Object.entries(process.env)) if (!/^(CRAWL(ER)?|ANALYSIS)_/.test(k)) env[k] = v;
  Object.assign(env, {
    DATABASE_URL: dbUrl,
    CRAWL_QUEUE_NAME: queue,
    ANALYSIS_QUEUE_NAME: `${queue}-analysis`,
    CRAWLER_LOCAL_HOSTS: LOCAL_HOSTS_ENV,
    CRAWLER_LOCAL_PORTS: String(site.port),
    CRAWLER_LOCAL_CA: site.ca, // the fixture TLS listener's certificates; read only under NODE_ENV=test
    CRAWLER_HOST_RATE: "100",
    CRAWLER_HOST_CONCURRENCY: "8",
    BLOB_DIR: blobDir, // a fresh blob store, so the canary search covers exactly this gate's blobs
    WORKER_MEMORY_LOG: path.join(memDir, "memory.log"),
    WORKER_MEMORY_LIMIT_MB: String(MEMORY_LIMIT_MB),
    NODE_ENV: "test", // the loopback mapping above is refused under any other NODE_ENV
    ...extraEnv,
  });
  // A heap snapshot taken near the cap (--heapsnapshot-near-heap-limit) is written to memDir (--diagnostic-dir).
  const child = spawn(process.execPath, [...HEAP_CAP_FLAGS, "--diagnostic-dir", memDir, "--import", "tsx", "src/worker/crawl-worker.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let booted!: () => void;
  const bootedP = new Promise<void>((r) => (booted = r));
  child.stdout!.on("data", (d: Buffer) => {
    out += d;
    if (out.includes('"event":"worker.boot"')) booted();
    const lim = out.split("\n").find((l) => l.includes('"event":"memory.limit"'));
    if (lim) onMemoryLimit(lim);
    if (out.length > 1_000_000) out = out.slice(-10_000);
  });
  child.stderr!.on("data", (d: Buffer) => process.stderr.write(`[worker] ${d}`));
  const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
  return { child, booted: bootedP, exited };
}

export async function waitFor(what: string, ms: number, cond: () => boolean | Promise<boolean>) {
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
export const crawlRow = async (db: Db, id: string) =>
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

export function plans(site: FixtureSite): Plan[] {
  const o = site.origins;
  const abs = (key: HostKey, p: string) => new URL(p, o[key]).toString();
  const main = new Map<string, string[]>();
  for (const [p, ids] of expectedFindings()) main.set(urlOf(o.main, p), ids);
  for (const [u, ids] of resourceExpectations(o.main)) main.set(u, ids);
  main.set(abs("main", "/"), ["SEC-003"]); // fixture.test's certificate expires inside 21 days (TLS_DAYS.main)
  main.set(abs("main", "/sitemaps/slow.xml.gz"), ["SITE-002"]); // the first urlset: the /index/ extras and the 2b extras are not listed
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
      config: { scope: { include: [], exclude: MAIN_EXCLUDE }, aiCrawlers: "allow", keyPages: KEY_PAGES.map((p) => abs("main", p)) },
      budget: 5_000,
      expected: main,
      exactPrefixes: [
        ...EXACT_SECTIONS.map((s) => abs("main", s)),
        ...["/robots.txt", "/sitemaps/", "/sitemap_index.xml", "/llms.txt", "/img/", "/.env", "/.git/", FACET_PATH].map((p) => abs("main", p)),
        urlOf(o.main, PLAIN_HTTP_PAGE),
        o.ext,
        o.ext2,
      ],
    },
    {
      key: "alt",
      label: `${HOSTS.alt} (robots.txt 503)`,
      config: { aiCrawlers: "block" },
      budget: 10,
      expected: new Map([
        [abs("alt", "/robots.txt"), ["IDX-025", "IDX-027"]],
        // robots.txt 503 disallows the whole host, so its probes are skipped (probe_skipped_robots) and their rules say so.
        [abs("alt", "/"), ["META-019:inconclusive"]],
        [abs("alt", "/llms.txt"), ["AIS-003:inconclusive"]],
        [abs("alt", "/.env"), ["SEC-006:inconclusive"]],
        [abs("alt", "/.git/HEAD"), ["SEC-006:inconclusive"]],
      ]),
      exactPrefixes: [o.alt],
    },
    {
      key: "alt2",
      label: `${HOSTS.alt2} (no sitemap, www and plain http serve 200, no favicon)`,
      config: { aiCrawlers: "block" },
      budget: 10,
      expected: new Map([
        [abs("alt2", "/robots.txt"), ["IDX-027", "AIS-001"]],
        // http, https, www and non-www all serve 200; no favicon; no security headers and no Organization block (2b).
        [abs("alt2", "/"), ["IDX-020", "IDX-021", "META-019", "SEC-004", "SEC-005", "SD-007"]],
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
        [abs("alt3", "/sitemap.xml.gz"), ["IDX-030", "SITE-002"]], // over 50,000 URLs; and it lists the noindex items
        [abs("alt3", "/llms.txt"), ["AIS-003"]],
        // The budget of 3 reaches / and two noindex /item-N pages: 1 of 3 indexable (SITE-003); the items are noindex
        // but listed in the sitemap (IDX-008, IDX-029, SITE-002). Any finding on alt3 is compared.
        [abs("alt3", "/"), ["SITE-003"]],
        [abs("alt3", "/item-1"), ["IDX-008", "IDX-029"]],
        [abs("alt3", "/item-10"), ["IDX-008", "IDX-029"]],
        [abs("alt3", "/.env"), []], // a soft 200 (HTML), not an exposed file
        [abs("alt3", "/.git/HEAD"), []],
      ]),
      exactPrefixes: [o.alt3],
    },
  ];
}

export async function runGate(phase: Phase) {
  PHASE = phase;
  DB_URL = process.env.GATE_DATABASE_URL ?? `postgres://sitesentry:sitesentry@127.0.0.1:5433/sitesentry_gate${phase}`;
  QUEUE = `crawl-gate${phase}-${randomUUID()}`;
  const db = await setupDb(DB_URL);
  const site = await startFixtureSite();
  process.env.CRAWL_QUEUE_NAME = QUEUE;
  const q = createCrawlQueue();
  const blobDir = await mkdtemp(path.join(tmpdir(), `sitesentry-gate${phase}-blobs-`));
  // Memory log for the gate and the worker (one JSON line per sample) and any heap snapshot: .data/gate-<phase>/.
  const memDir = path.resolve(".data", `gate-${phase}`);
  await rm(memDir, { recursive: true, force: true });
  await mkdir(memDir, { recursive: true });
  const memLog = path.join(memDir, "memory.log");
  const stopForMemory = (who: string, detail: string) => {
    console.error(`\nGATE STOPPED: ${who} passed ${MEMORY_LIMIT_MB} MB RSS. ${detail}\nMemory log: ${memLog}`);
    w.child.kill("SIGKILL");
    process.exit(2);
  };
  const gateMem = startMemoryLog({ file: memLog, label: "gate", limitBytes: MEMORY_LIMIT_MB * 1048576, onLimit: (rss, snap) => stopForMemory("the gate process", `RSS ${Math.round(rss / 1048576)} MB; heap snapshot ${snap}`) });
  console.log(
    `Phase ${phase} gate. Fixture ${site.origin} (+ ${Object.keys(HOSTS).length - 1} host variants). Defects: /meta/ ${DEFECT_COUNTS.meta}, /index/ ${DEFECT_COUNTS.index}, /content/ ${DEFECT_COUNTS.content}, ` +
      `/links/ ${DEFECT_COUNTS_2B.links}, /images/ ${DEFECT_COUNTS_2B.images}, /schema/ ${DEFECT_COUNTS_2B.schema}, /intl/ ${DEFECT_COUNTS_2B.intl}, /security/ ${DEFECT_COUNTS_2B.security}, /products/ 300 (one template defect). ` +
      `Gate database ${new URL(DB_URL).pathname.slice(1)}.\n`,
  );
  const w = startWorker(site, blobDir, memDir, (d) => stopForMemory("the worker", d), DB_URL, QUEUE);
  const mainCrawl = { id: "" };
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
      if (plan.key === "main") mainCrawl.id = row.id;
      await enqueueCrawl(q, row.id);
      // The worker enqueues the analysis job when the crawl ends; the gate only watches the database.
      await waitFor(`${plan.label}: crawl and analysis`, 15 * 60_000, async () => {
        const c = await crawlRow(db, row.id);
        return ["completed", "failed"].includes(c.analysis?.status ?? "") || c.status === "failed";
      });
      const c = await crawlRow(db, row.id);
      console.log(`\n== ${plan.label}`);
      check(`${plan.key}: crawl completed and analysed through the queue`, c.status === "completed" && c.analysis?.status === "completed", `crawl ${c.status}, analysis ${JSON.stringify(c.analysis)} after ${((Date.now() - t0) / 1000).toFixed(1)} s`);

      const f = await db.$client.query<{ rule_id: string; url: string; outcome: string; evidence: Record<string, unknown> }>("select rule_id, url, outcome, evidence from findings where crawl_id = $1", [row.id]);
      const got = new Map<string, Set<string>>();
      for (const x of f.rows) {
        fired.add(x.rule_id);
        // SITE-001 is reported at a sample page of its template group, which depends on crawl order: checked below.
        if (x.rule_id === "SITE-001") continue;
        if (!got.has(x.url)) got.set(x.url, new Set());
        got.get(x.url)!.add(findingKey(x.rule_id, x.outcome));
      }
      const site001 = f.rows.filter((x) => x.rule_id === "SITE-001").map((x) => ({ ruleId: x.evidence.ruleId, pages: x.evidence.pages, groupSize: x.evidence.groupSize, at: x.url.replace(site.origins[plan.key], "") }));
      const site001Ok = plan.key === "main" ? site001.length === 1 && site001[0].ruleId === "IMG-007" && site001[0].pages === 300 && site001[0].groupSize === 300 && site001[0].at.startsWith("/products/") : site001.length === 0;
      check(`${plan.key}: SITE-001 ${plan.key === "main" ? "reports /products/ as one template group of 300 pages" : "is silent"}`, site001Ok, JSON.stringify(site001));
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
      const needsConfig = runs.rows.filter((r) => r.status === "needs_config").map((r) => r.rule_id);
      if (needsConfig.length) info(`needs_config: ${needsConfig.join(", ")}`);
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

    if (PHASE === "2b") await phase2bChecks(db, site, mainCrawl.id, blobDir);

    console.log(`\n== Rules (phase ${PHASE}: ${FAMILIES[PHASE].source})`);
    const phaseRules = RULES.filter((r) => FAMILIES[PHASE].test(r.id));
    const notEvaluated = phaseRules.filter((r) => !evaluated.get(r.id));
    check(`Every phase ${PHASE} rule was evaluated`, notEvaluated.length === 0, `${phaseRules.length} rules${notEvaluated.length ? `; never evaluated: ${notEvaluated.map((r) => r.id).join(", ")}` : ""}`);
    const silent = phaseRules.filter((r) => !fired.has(r.id) && !UNIT_ONLY[r.id]);
    check(`Every phase ${PHASE} rule fires on its positive fixture`, silent.length === 0, `${phaseRules.length - silent.length - Object.keys(UNIT_ONLY).length} of ${phaseRules.length} fired in the crawls${silent.length ? `; never fired: ${silent.map((r) => r.id).join(", ")}` : ""}`);
    for (const [id, why] of Object.entries(UNIT_ONLY)) info(`${id} positive is unit-test only (src/lib/rules/rules.test.ts): ${why}; fired here: ${fired.has(id) ? "yes" : "no"}`);
    info(`deferred, not implemented: ${Object.entries(DEFERRED_RULES).map(([id, why]) => `${id} (${why})`).join("; ")}`);

    console.log(`\n== Rule time (all ${plans(site).length} crawls)`);
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
    await rm(blobDir, { recursive: true, force: true });
  }

  // Peak memory per process, from the shared log (the worker's last samples are in it; it was killed after them).
  const gatePeak = gateMem.stop();
  const lines = readFileSync(memLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { label: string; pid: number; s: number; rssMb: number; heapUsedMb: number });
  console.log(`\n== Memory (sampled every 10 s; log ${memLog})`);
  for (const label of ["gate", "worker"]) {
    const ls = lines.filter((l) => l.label === label);
    if (!ls.length) continue;
    const top = ls.reduce((a, b) => (b.rssMb > a.rssMb ? b : a));
    info(`${label} (pid ${top.pid}): peak RSS ${top.rssMb} MB at ${top.s} s, peak heap used ${Math.max(...ls.map((l) => l.heapUsedMb))} MB, ${ls.length} samples`);
  }
  check(`Every process stayed under ${MEMORY_LIMIT_MB} MB RSS`, lines.every((l) => l.rssMb < MEMORY_LIMIT_MB) && gatePeak.rss < MEMORY_LIMIT_MB * 1048576, `max ${Math.max(...lines.map((l) => l.rssMb))} MB`);

  const failed = results.filter((x) => !x.pass);
  console.log(`\n${failed.length ? "GATE FAILED" : "GATE PASSED"}: ${results.length - failed.length} / ${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
}

/** 2b: resource budgets counted at the server, and no trace of the /.env body in the database or the blob store. */
async function phase2bChecks(db: Db, site: FixtureSite, mainId: string, blobDir: string) {
  console.log("\n== Phase 2b: budgets and secrets");
  const summary = (await db.$client.query<{ resources: { external: { found: number; planned: number; overBudget: number }; images: { found: number; planned: number; overBudget: number } } }>("select resources from crawls where id = $1", [mainId])).rows[0].resources;
  // Requests at the fixture server: every external host request but robots.txt, and every /img/ request on fixture.test.
  const extHosts = new Set<string>(Object.values(EXT_HOSTS));
  const extUrls = new Set(site.requests.filter((h) => h.host && extHosts.has(h.host) && h.path !== "/robots.txt").map((h) => `${h.host}${h.path}`));
  const imgUrls = new Set(site.requests.filter((h) => !h.host && h.path.startsWith("/img/")).map((h) => h.path));
  const imgRequests = site.requests.filter((h) => !h.host && h.path.startsWith("/img/"));
  check(
    `External links: at most ${MAX_EXTERNAL_LINKS} unique URLs requested`,
    extUrls.size <= MAX_EXTERNAL_LINKS && summary.external.found > MAX_EXTERNAL_LINKS && summary.external.planned === MAX_EXTERNAL_LINKS,
    `${extUrls.size} unique external URLs requested (${site.requests.filter((h) => h.host && extHosts.has(h.host) && h.path !== "/robots.txt").length} requests); crawl summary ${JSON.stringify(summary.external)}; fixture links ${EXTERNAL_LINK_URLS} + 2`,
  );
  check(
    `Images: at most ${MAX_IMAGE_URLS} unique URLs requested`,
    imgUrls.size <= MAX_IMAGE_URLS && summary.images.found > MAX_IMAGE_URLS && summary.images.planned === MAX_IMAGE_URLS,
    `${imgUrls.size} unique image URLs requested (${imgRequests.length} requests: ${imgRequests.filter((h) => h.method === "HEAD").length} HEAD, ${imgRequests.filter((h) => !h.method && h.range).length} ranged GET, ${imgRequests.filter((h) => !h.method && !h.range).length} plain GET); crawl summary ${JSON.stringify(summary.images)}; fixture images ${IMAGE_BUDGET_URLS} + defects`,
  );
  const cdn = await cdnManagedLinks(db, mainId);
  const cdnHits = site.requests.filter((h) => !h.host && h.path.startsWith("/cdn-cgi/"));
  check(
    "CDN-managed links are recorded, never fetched and never reported broken",
    cdn.urls === CDN_LINKS.length && cdn.links === CDN_LINKS.length && cdn.pages === 1 && cdnHits.length === 0,
    `CDN-managed links: ${cdn.links} (${cdn.urls} URL(s) on ${cdn.pages} page(s)); /cdn-cgi/ requests at the server: ${cdnHits.length}; LNK-001 on that page is checked by the manifest`,
  );
  const envHits = site.requests.filter((h) => !h.host && h.path === "/.env");
  info(`/.env requested ${envHits.length} time(s) on fixture.test (the probe)`);

  // The canary: every row of every table as text, and every blob (gunzipped when gzipped).
  const tables = (await db.$client.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'")).rows.map((r) => r.table_name);
  const inDb: string[] = [];
  for (const t of tables) {
    const n = (await db.$client.query<{ n: string }>(`select count(*) as n from "${t}" x where x::text like $1`, [`%${ENV_CANARY}%`])).rows[0].n;
    if (Number(n)) inDb.push(`${t} (${n} rows)`);
  }
  const inBlobs: string[] = [];
  let blobs = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        blobs++;
        let b = await readFile(p);
        if (b[0] === 0x1f && b[1] === 0x8b) b = gunzipSync(b);
        if (b.includes(ENV_CANARY)) inBlobs.push(p);
      }
    }
  };
  await walk(blobDir);
  check("No /.env body content stored (canary absent from the database and the blob store)", inDb.length === 0 && inBlobs.length === 0 && envHits.length > 0, `${tables.length} tables searched${inDb.length ? `; found in ${inDb.join(", ")}` : ", none contain it"}; ${blobs} blobs searched${inBlobs.length ? `; found in ${inBlobs.join(", ")}` : ", none contain it"}`);
}

// Phase 5 gate (docs/SPEC.md "Phase 5": "JS-only fixture pages detected; diff visible in Page inspector; no lab metric
// labelled as field"), against a real worker (crawl, render and analysis queues) and the render fixture
// (fixtures/render/site.ts: render.test, plus widgets.test as a third-party script host):
//   1. Full rendering: every HTML page is rendered; the rendered rules' findings (IDX-018, AIS-004, LNK-009, IMG-009,
//      PERF-001/003/007/009/011, A11Y-001..004) equal the fixture's manifest on every URL; the 40 JavaScript-only
//      pages are detected; links that exist only after JavaScript are reported, not crawled (no URL row, no request).
//   2. No lab metric is labelled field: every stored render's metrics and every finding's evidence say source "lab".
//   3. Sampled rendering: one page per template plus the start URL; the rendered rules judge only those pages.
//   4. The Page inspector of the production app (`next start`, needs `npm run build`) in a real browser: the "Raw vs
//      rendered" tab shows the before/after table, the Lab tag, the rendered-only links, and the HTML diff after
//      "Compare HTML".
//   5. Memory: the worker's Node process stays under 700 MB RSS (its Chromium processes are separate and not counted).
//
// Run: npm run build && npm run gate:p5   (needs `docker compose up -d` and `npx playwright install chromium`; its own
// database sitesentry_gate5 and app data directory)
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { findingKey } from "../fixtures/site/defects";
import { JS_PAGES, PAGES, RENDER_LOCAL_HOSTS_ENV, SCRIPT_ONLY_TARGETS, expectedFindings, jsPaths, startRenderFixture, type RenderFixture } from "../fixtures/render/site";
import { createAudit } from "../src/lib/crawl/engine";
import { createCrawlQueue, enqueueCrawl } from "../src/lib/crawl/v2/queue";
import type { Db } from "../src/lib/db/client";
import { crawls } from "../src/lib/db/schema";
import { startMemoryLog } from "../src/lib/memory-log";
import type { CrawlerV2Ref } from "../src/lib/model";
import type { RenderProgress } from "../src/lib/render/run";
import { pageRender } from "../src/lib/results/render";
import { RULES } from "../src/lib/rules/registry";
import { blobStoreFromEnv } from "../src/lib/snapshot/blob-store";
import { JsonFileStore } from "../src/lib/store/store";
import { MEMORY_LIMIT_MB, setupDb, startWorker, waitFor } from "./gate-p2";

const DB_URL = process.env.GATE_DATABASE_URL ?? "postgres://sitesentry:sitesentry@127.0.0.1:5433/sitesentry_gate5";
const QUEUE = `crawl-gate5-${randomUUID()}`;
const WS = "live";
const RENDERED = RULES.filter((r) => r.needs.includes("rendered")).map((r) => r.id);
/** Rules whose evidence carries lab metrics (source "lab"). */
const LAB_RULES = ["IMG-009", "PERF-001", "PERF-003", "PERF-007"];

const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}: ${detail}`);
}
const info = (msg: string) => console.log(`      ${msg}`);

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

interface CrawlState {
  status: string;
  render: RenderProgress | null;
  analysis: { status: string } | null;
}
const crawlState = async (db: Db, id: string) => (await db.$client.query<CrawlState>("select status, render, analysis from crawls where id = $1", [id])).rows[0];

/** One crawl of the fixture through the worker, until its analysis ends. */
async function crawlFixture(db: Db, fx: RenderFixture, render: "full" | "sampled"): Promise<string> {
  const q = createCrawlQueue();
  const [row] = await db
    .insert(crawls)
    .values({ workspace: WS, auditId: randomUUID(), siteOrigin: fx.origin, profile: "custom", config: { render, aiCrawlers: "allow" }, status: "queued", budget: 200, maxDepth: null })
    .returning({ id: crawls.id });
  const t0 = Date.now();
  await enqueueCrawl(q, row.id);
  await q.close();
  await waitFor(`the ${render} crawl, its render phase and analysis`, 10 * 60_000, async () => {
    const c = await crawlState(db, row.id);
    return ["completed", "failed"].includes(c.analysis?.status ?? "") || c.status === "failed";
  });
  const c = await crawlState(db, row.id);
  check(
    `${render}: crawl completed, render phase done, analysis completed`,
    c.status === "completed" && c.render?.status === "done" && c.analysis?.status === "completed",
    `crawl ${c.status}, render ${JSON.stringify(c.render)}, analysis ${c.analysis?.status} after ${((Date.now() - t0) / 1000).toFixed(1)} s`,
  );
  return row.id;
}

type Finding = { rule_id: string; url: string; outcome: string; evidence: Record<string, unknown> };
const renderedFindings = async (db: Db, crawlId: string) =>
  (await db.$client.query<Finding>("select rule_id, url, outcome, evidence from findings where crawl_id = $1 and rule_id = any($2)", [crawlId, RENDERED])).rows;

async function fullChecks(db: Db, fx: RenderFixture, crawlId: string) {
  const abs = (p: string) => new URL(p, fx.origin).toString();
  const pr = (await db.$client.query<{ url: string; status: string; metrics: { source?: string } | null }>("select url, status, metrics from page_renders where crawl_id = $1", [crawlId])).rows;
  const notRendered = pr.filter((r) => r.status !== "rendered").map((r) => `${r.url} ${r.status}`);
  check(
    "full: every HTML page of the fixture is rendered",
    pr.length === PAGES.length && notRendered.length === 0,
    `${pr.length} renders for ${PAGES.length} pages${notRendered.length ? `; not rendered: ${notRendered.join(", ")}` : ", all status rendered"}`,
  );

  const runs = (await db.$client.query<{ rule_id: string; status: string; evaluated: number }>("select rule_id, status, evaluated from rule_runs where crawl_id = $1 and rule_id = any($2)", [crawlId, RENDERED])).rows;
  const badRuns = runs.filter((r) => r.status !== "ran" || r.evaluated !== PAGES.length);
  check(
    `full: the ${RENDERED.length} rendered rules ran on every rendered page`,
    runs.length === RENDERED.length && badRuns.length === 0,
    `${runs.length} rule runs${badRuns.length ? `; wrong: ${badRuns.map((r) => `${r.rule_id} ${r.status} ${r.evaluated}`).join(", ")}` : `, each evaluated ${PAGES.length} pages`}`,
  );

  // Exact on every URL of the crawl: the manifest's findings and nothing else from the rendered rules.
  const f = await renderedFindings(db, crawlId);
  const got = new Map<string, string[]>();
  for (const x of f) got.set(x.url, [...(got.get(x.url) ?? []), findingKey(x.rule_id, x.outcome)]);
  const want = new Map([...expectedFindings()].map(([p, ids]) => [abs(p), ids]));
  const diffs: string[] = [];
  for (const u of new Set([...want.keys(), ...got.keys(), ...PAGES.map(abs)])) {
    const a = [...(want.get(u) ?? [])].sort().join();
    const b = [...(got.get(u) ?? [])].sort().join();
    if (a !== b) diffs.push(`${u.replace(fx.origin, "")}: expected [${a}] got [${b}]`);
  }
  const fired = new Set(f.map((x) => x.rule_id));
  check("full: the rendered rules' findings equal the fixture manifest", diffs.length === 0, `${f.length} findings on ${got.size} URLs${diffs.length ? `; ${diffs.length} differ:\n        ${diffs.join("\n        ")}` : ", every URL exact"}`);
  const silent = RENDERED.filter((id) => !fired.has(id));
  check(`full: every rendered rule fires on its fixture page`, silent.length === 0, silent.length ? `silent: ${silent.join(", ")}` : `${RENDERED.length} of ${RENDERED.length} rules fired`);

  // Spec: JS-only fixture pages detected.
  const ais = f.filter((x) => x.rule_id === "AIS-004" && x.outcome === "issue" && jsPaths().map(abs).includes(x.url));
  const idx = f.filter((x) => x.rule_id === "IDX-018" && x.outcome === "issue" && jsPaths().map(abs).includes(x.url));
  const rawZero = ais.every((x) => x.evidence.rawWords === 0 && Number(x.evidence.renderedWords) >= 100);
  const canonAdded = idx.every((x) => x.evidence.raw === null && x.evidence.rendered === x.url);
  check(
    `full: the ${JS_PAGES} JavaScript-only pages are detected`,
    ais.length === JS_PAGES && idx.length === JS_PAGES && rawZero && canonAdded,
    `AIS-004 on ${ais.length}/${JS_PAGES} (raw 0 words, rendered ${ais[0]?.evidence.renderedWords ?? "?"}); IDX-018 "adds a canonical" on ${idx.length}/${JS_PAGES}`,
  );

  // Links only JavaScript makes are reported where they are, never crawled.
  const rows = (await db.$client.query<{ url: string }>("select url from crawl_urls where crawl_id = $1 and (url like '%/js/hidden%' or url like '%/links/onclick-target%')", [crawlId])).rows;
  const hits = SCRIPT_ONLY_TARGETS.map((p) => fx.hits.get(`render.test${p}`) ?? 0);
  const store = blobStoreFromEnv({ BLOB_DIR: process.env.GATE_P5_BLOB_DIR });
  const index = await pageRender(db, store, crawlId, abs("/js/"));
  const onclick = await pageRender(db, store, crawlId, abs("/links/onclick"));
  const reported = index?.links?.renderedOnly ?? [];
  const onclickTargets = onclick?.render?.scriptLinks?.onclick.map((l) => l.target) ?? [];
  check(
    "full: links that exist only after JavaScript are reported, not crawled",
    rows.length === 0 && hits.every((h) => h === 0) && reported.includes(abs("/js/hidden")) && index?.links?.renderedOnlyCount === JS_PAGES + 1 && onclickTargets.includes("/links/onclick-target"),
    `crawl_urls rows for ${SCRIPT_ONLY_TARGETS.join(", ")}: ${rows.length}; requests to them: ${hits.join(", ")}; /js/ reports ${index?.links?.renderedOnlyCount ?? 0} rendered-only links (incl. /js/hidden: ${reported.includes(abs("/js/hidden"))}); /links/onclick reports onclick target ${JSON.stringify(onclickTargets)}`,
  );

  // Spec: no lab metric labelled as field.
  const withMetrics = pr.filter((r) => r.metrics);
  const notLab = withMetrics.filter((r) => r.metrics!.source !== "lab");
  const labFindings = f.filter((x) => LAB_RULES.includes(x.rule_id));
  const badLab = labFindings.filter((x) => x.evidence.source !== "lab" || (x.evidence.field !== undefined && x.evidence.field !== null));
  const anyField = Number(
    (
      await db.$client.query<{ n: string }>(
        "select count(*) as n from findings where crawl_id = $1 and (evidence->>'source' = 'field' or (evidence ? 'field' and evidence->'field' <> 'null'::jsonb))",
        [crawlId],
      )
    ).rows[0].n,
  );
  check(
    "full: no lab metric is labelled as field",
    withMetrics.length === PAGES.length && notLab.length === 0 && labFindings.length > 0 && badLab.length === 0 && anyField === 0,
    `${withMetrics.length} renders with metrics, source "lab" on ${withMetrics.length - notLab.length}; ${labFindings.length} metric findings (${[...new Set(labFindings.map((x) => x.rule_id))].join(", ")}), source "lab" and field null on ${labFindings.length - badLab.length}; findings with a field source or value in the whole crawl: ${anyField}`,
  );
  const lcp = f.find((x) => x.rule_id === "PERF-001");
  if (lcp) info(`PERF-001 on /images/lazy-lcp: ${lcp.evidence.lcpMs} ms (hero image delayed 4,000 ms by the fixture)`);
  const cls = f.find((x) => x.rule_id === "PERF-003");
  if (cls) info(`PERF-003 on /perf/shift: CLS ${cls.evidence.cls}`);
}

async function sampledChecks(db: Db, fx: RenderFixture, crawlId: string) {
  const abs = (p: string) => new URL(p, fx.origin).toString();
  const templates = Number(
    (
      await db.$client.query<{ n: string }>(
        `select count(distinct coalesce(s.template_fingerprint, u.normalised_url)) as n from page_snapshots s join crawl_urls u on u.id = s.url_id
         where s.crawl_id = $1 and s.status_code = 200 and s.facts is not null`,
        [crawlId],
      )
    ).rows[0].n,
  );
  const pr = (await db.$client.query<{ url: string }>("select url from page_renders where crawl_id = $1", [crawlId])).rows.map((r) => r.url);
  const js = pr.filter((u) => jsPaths().map(abs).includes(u));
  check(
    "sampled: one page per template plus the start URL",
    pr.length <= templates + 1 && pr.length < PAGES.length && js.length === 1 && js[0] === abs("/js/p-1") && pr.includes(abs("/")),
    `${pr.length} pages rendered of ${PAGES.length}, ${templates} templates; of the ${JS_PAGES} /js/ pages (one template) only ${js.map((u) => u.replace(fx.origin, "")).join(", ")}`,
  );
  const ais = (await renderedFindings(db, crawlId)).filter((x) => x.rule_id === "AIS-004");
  check(
    "sampled: the rendered rules judge only rendered pages",
    ais.length === 1 && ais[0].url === abs("/js/p-1"),
    `AIS-004 on ${ais.map((x) => x.url.replace(fx.origin, "")).join(", ") || "no page"}`,
  );
  const reason = await pageRender(db, blobStoreFromEnv({ BLOB_DIR: process.env.GATE_P5_BLOB_DIR }), crawlId, abs("/js/p-2"));
  check("sampled: an unsampled page says why it has no render", reason?.reason === "not_sampled" && reason.render === null, `/js/p-2 reason ${reason?.reason}`);
}

/** The Page inspector in the production app, in Chromium. The worker is stopped first: one heavy process at a time. */
async function inspector(db: Db, fx: RenderFixture, crawlId: string, blobDir: string, outDir: string) {
  console.log("\n== Page inspector (next start, Chromium)");
  if (!existsSync(path.resolve(".next", "BUILD_ID"))) {
    check("Inspector: the production app starts", false, "no production build in .next: run `npm run build` first");
    return;
  }
  const dataDir = await mkdtemp(path.join(tmpdir(), "sitesentry-gate5-app-"));
  const store = new JsonFileStore(path.join(dataDir, WS));
  const siteId = `render-fixture-${randomUUID().slice(0, 8)}`;
  const now = new Date();
  await store.update((d) => {
    d.sites[siteId] = { id: siteId, name: "Render fixture", origin: fx.origin, createdAt: now.toISOString() };
  });
  const { audit } = await createAudit(
    { siteId, config: { mode: "single", urls: [`${fx.origin}/`], profile: "custom", maxPages: 200, maxDepth: null, categories: [], checkLinks: false, includeImportant: false } },
    { store, fetch: () => Promise.reject(new Error("gate:p5: the crawl already ran")), now: () => now, newId: () => randomUUID(), source: WS },
  );
  const n = Number((await db.$client.query<{ n: string }>("select count(*) as n from crawl_urls where crawl_id = $1", [crawlId])).rows[0].n);
  await db.$client.query("update crawls set audit_id = $2 where id = $1", [crawlId, audit.id]);
  const ref: CrawlerV2Ref = { version: 2, crawlId, status: "completed", states: { analysed: n }, analysis: "completed", syncedAt: now.toISOString() };
  await store.update((d) => {
    Object.assign(d.audits[audit.id], { crawler: ref, status: "completed", phase: "done", finishedAt: now.toISOString(), progress: { planned: n, done: n, inspected: n, failed: 0, skipped: 0, linksChecked: 0 } });
  });

  const port = await freePort();
  const env = {} as NodeJS.ProcessEnv;
  for (const [k, v] of Object.entries(process.env)) if (!/^(SITE_SENTRY_|CRAWL(ER)?_|ANALYSIS_|RENDER_|DATABASE_URL$|BLOB_DIR$)/.test(k)) env[k] = v;
  Object.assign(env, { NODE_ENV: "production", NODE_OPTIONS: "--max-old-space-size=768", DATABASE_URL: DB_URL, SITE_SENTRY_STORE: "json", SITE_SENTRY_DATA_DIR: dataDir, CRAWLER_V2: "true", BLOB_DIR: blobDir });
  const app: ChildProcess = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port), "-H", "127.0.0.1"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  app.stdout!.on("data", (d: Buffer) => (log = (log + d).slice(-4000)));
  app.stderr!.on("data", (d: Buffer) => (log = (log + d).slice(-4000)));
  const exited = new Promise<void>((r) => app.on("exit", () => r()));
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();
  try {
    await waitFor("the production app", 90_000, async () => !!(await fetch(`${base}/api/live/sites`).catch(() => null)));
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const inspect = (p: string) => `${base}/live/audits/${audit.id}/inspect?url=${encodeURIComponent(new URL(p, fx.origin).toString())}&tab=rendered`;

    await page.goto(inspect("/js/p-1"));
    const table = page.getByRole("table", { name: "The HTML as served compared with the rendered DOM" });
    await table.waitFor({ timeout: 30_000 });
    const row = async (field: string) => (await table.getByRole("row", { name: new RegExp(`^${field}\\b`) }).first().locator("td").allInnerTexts()).map((t) => t.trim());
    const canon = await row("Canonical");
    const title = await row("Title");
    const words = await row("Main-content words");
    check(
      "Inspector: the before/after table shows what JavaScript changed on a JavaScript-only page",
      canon[0] === "—" && canon[1] === new URL("/js/p-1", fx.origin).toString() && title[0] === "—" && title[1] === "JavaScript page 1" && words[0] === "0" && Number(words[1].replace(/,/g, "")) >= 100,
      `Canonical ${JSON.stringify(canon)}, Title ${JSON.stringify(title)}, Main-content words ${JSON.stringify(words)}`,
    );
    const source = (await page.locator("dt", { hasText: /^Source$/ }).locator("xpath=following-sibling::dd[1]").innerText()).trim();
    const fieldLabels = await page.locator("dd", { hasText: /^Field$/i }).count();
    check("Inspector: lab metrics are tagged Lab, nothing is labelled Field", source === "Lab" && fieldLabels === 0, `Source "${source}"; values reading "Field": ${fieldLabels}`);

    await page.getByRole("button", { name: "Compare HTML" }).click();
    // The diff itself (a scrollable region inside the "HTML diff" panel, which is a region too), once loaded.
    const diff = page.locator('div[role="region"][aria-label="HTML diff"]');
    await diff.waitFor({ timeout: 30_000 });
    const added = await diff.locator('[aria-label="added"]').count();
    const text = await diff.innerText();
    await page.screenshot({ path: path.join(outDir, "inspector-js-p-1.png"), fullPage: true });
    check(
      "Inspector: the HTML diff is visible after Compare HTML",
      added > 0 && text.includes("<h1>JavaScript page 1</h1>") && text.includes('<div id="root">'),
      `${added} added lines, the injected <h1> ${text.includes("<h1>JavaScript page 1</h1>") ? "shown" : "missing"}; screenshot ${path.join(outDir, "inspector-js-p-1.png")}`,
    );

    await page.goto(inspect("/js/"));
    const links = page.getByRole("region", { name: "Links that exist only after JavaScript" });
    await links.waitFor({ timeout: 30_000 });
    const panel = await links.innerText();
    check(
      "Inspector: rendered-only links are listed as reported, not crawled",
      panel.includes(new URL("/js/hidden", fx.origin).toString()) && /reported here, not crawled/.test(panel),
      `the /js/ panel ${panel.includes("/js/hidden") ? "lists" : "does not list"} /js/hidden and says "reported here, not crawled": ${/reported here, not crawled/.test(panel)}`,
    );
  } catch (e) {
    check("Inspector: the production app answers", false, `${(e as Error).message}\n${log}`);
  } finally {
    await browser.close();
    app.kill();
    await exited;
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  const outDir = path.resolve(".data", "gate-p5");
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const memLog = path.join(outDir, "memory.log");
  let worker: ReturnType<typeof startWorker> | null = null;
  const stopForMemory = (who: string, detail: string) => {
    console.error(`\nGATE STOPPED: ${who} passed ${MEMORY_LIMIT_MB} MB RSS. ${detail}\nMemory log: ${memLog}`);
    worker?.child.kill("SIGKILL");
    process.exit(2);
  };
  const gateMem = startMemoryLog({ file: memLog, label: "gate", limitBytes: MEMORY_LIMIT_MB * 1048576, onLimit: (rss, snap) => stopForMemory("the gate process", `RSS ${Math.round(rss / 1048576)} MB; heap snapshot ${snap}`) });

  const db = await setupDb(DB_URL);
  const fx = await startRenderFixture();
  const blobDir = await mkdtemp(path.join(tmpdir(), "sitesentry-gate5-blobs-"));
  process.env.GATE_P5_BLOB_DIR = blobDir;
  process.env.CRAWL_QUEUE_NAME = QUEUE;
  console.log(`Phase 5 gate. Fixture ${fx.origin} (${PAGES.length} pages, third-party scripts on ${fx.thirdPartyOrigin}); gate database ${new URL(DB_URL).pathname.slice(1)}.\n`);
  let full = "";
  try {
    worker = startWorker({ port: fx.port, ca: "" }, blobDir, outDir, (d) => stopForMemory("the worker", d), DB_URL, QUEUE, { CRAWLER_LOCAL_HOSTS: RENDER_LOCAL_HOSTS_ENV, CRAWLER_LOCAL_CA: "" });
    await worker.booted;
    console.log("== Full rendering");
    full = await crawlFixture(db, fx, "full");
    await fullChecks(db, fx, full);
    console.log("\n== Sampled rendering");
    const sampled = await crawlFixture(db, fx, "sampled");
    await sampledChecks(db, fx, sampled);
  } catch (e) {
    check("The worker crawls, renders and analyses the fixture", false, (e as Error).stack ?? String(e));
  } finally {
    worker?.child.kill();
    if (worker) await worker.exited;
  }
  const workerPeak = readFileSync(memLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { label: string; rssMb: number })
    .filter((l) => l.label === "worker")
    .reduce((m, l) => Math.max(m, l.rssMb), 0);
  check(`The worker's Node process stays under ${MEMORY_LIMIT_MB} MB RSS`, workerPeak > 0 && workerPeak < MEMORY_LIMIT_MB, `peak ${workerPeak} MB (Chromium runs in separate processes, not counted here); log ${memLog}`);

  if (full) await inspector(db, fx, full, blobDir, outDir);
  gateMem.stop();
  await fx.close();
  await db.$client.end();
  await rm(blobDir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.pass);
  console.log(`\nPhase 5 gate: ${results.length - failed.length}/${results.length} checks passed.`);
  console.log("Not part of this gate (not built): PageSpeed Insights (lab) and CrUX (field) need an API key; PERF-002 (INP) needs field data.");
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

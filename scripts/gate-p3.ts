// Phase 3 gate (docs/SPEC.md "Phase 3"), against the fixture site with a real worker process and its queues.
//   1. Audit 1 crawls the fixture. The fix patch is switched on (FIXTURE_FIX_PATCH, fixtures/site/defects.ts
//      FIX_PATCH): the patched groups' verifications resolve exactly the patched fingerprints and nothing else.
//   2. Audit 2, partial (only / and /meta/, /meta/p-6 excluded): it resolves exactly the patched finding it fetched;
//      every open finding on a URL it did not answer, and every site-rule finding, is not_rechecked.
//   3. Audit 3, full (audit 1's settings): it resolves the last patched finding; nothing is new, regressed or
//      not_rechecked; the comparison with audit 1 gives the manifest's resolved and persistent counts.
//   In every crawl after audit 1: zero resolutions outside the manifest, and none for a URL the crawl did not answer.
//   4. Priority inputs and score of 5 groups equal values computed here by hand (impact and confidence from the SPEC
//      catalog, affected pages from the defect manifest, indexable pages counted with this gate's own SQL); the health
//      score equals its recomputation from rule_runs and issue_groups with the published weights.
//   5. Every number in the HTML report of audit 3 equals its database query and the API's; the PDF renders (saved to
//      .data/gate-p3/report.pdf, page count printed).
//   6. A share link, over HTTP against the production app (`next start` on the gate database): opens with the right
//      password, refuses a wrong one, stops after expiry; every response noindex and Referrer-Policy no-referrer.
//   7. The JSON-store migration: dry run and real run of scripts/migrate-json-store.ts on a copy of .data/store.json,
//      into a database of its own; their row counts match each other and the JSON.
//
// Run: npm run gate:p3   (needs `docker compose up -d`; uses its own databases, sitesentry_gate3 and sitesentry_gate3_store)
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { FIX_PATCH, FIX_PATCH_ENV } from "../fixtures/site/defects";
import { MAIN_EXCLUDE } from "../fixtures/site/defects-2b";
import { startFixtureSite } from "../fixtures/site/server";
import { createCrawlQueue, enqueueCrawl } from "../src/lib/crawl/v2/queue";
import type { CrawlConfig } from "../src/lib/crawl/v2/runner";
import { crawls } from "../src/lib/db/schema";
import { startMemoryLog } from "../src/lib/memory-log";
import { checkAgainstApi, checkReportMetrics } from "../src/lib/report/metrics";
import { renderReport } from "../src/lib/report/html";
import { renderPdf } from "../src/lib/report/pdf";
import { createShare, SHARE_COOKIE } from "../src/lib/report/shares";
import { ANSWERED } from "../src/lib/results/coverage";
import { compareCrawls, crawlOverview, issueGroups } from "../src/lib/results/queries";
import { reportData } from "../src/lib/results/report";
import { startVerification } from "../src/lib/results/verify";
import { buildSampleSeed } from "../src/lib/sample/seed";
import { JsonFileStore } from "../src/lib/store/store";
import { crawlRow, MEMORY_LIMIT_MB, plans, setupDb, startWorker, waitFor } from "./gate-p2";

const DB_URL = process.env.GATE_DATABASE_URL ?? "postgres://sitesentry:sitesentry@127.0.0.1:5433/sitesentry_gate3";
const STORE_DB_URL = process.env.GATE_STORE_DATABASE_URL ?? "postgres://sitesentry:sitesentry@127.0.0.1:5433/sitesentry_gate3_store";
const QUEUE = `crawl-gate3-${randomUUID()}`;
const SITE_ID = "gate-p3-fixture";
/** An app workspace: the share route looks the audit's branding up in the app store, which has live and sample. */
const WORKSPACE = "live";
const OPEN = ["new", "persistent", "regressed", "not_rechecked"];

const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}: ${detail}`);
}
const info = (msg: string) => console.log(`      ${msg}`);
const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/** Published weights (docs/HEALTH-SCORE.md), written out here rather than imported. */
const CONF_W: Record<string, number> = { verified: 1, heuristic: 0.6, advisory: 0.3 };
const CATEGORY_W: Record<string, number> = { indexability: 25, content: 15, metadata: 12, links: 12, structured_data: 8, images: 8, international: 6, security: 6, ai_search: 4, site: 4 };
const BANDS: [string, number][] = [["critical", 3.5], ["high", 2.5], ["medium", 1.5], ["low", 0.5]];

/**
 * Five groups computed by hand. Impact and type from the SPEC catalog rows (docs/SPEC.md: D = verified, H =
 * heuristic); affected pages from the defect list (fixtures/site/defects.ts META, page p-N carries defect N).
 */
const HAND: { ruleId: string; impact: number; confidence: string; affected: { a1: number; a3: number }; why: string }[] = [
  { ruleId: "META-001", impact: 5, confidence: "verified", affected: { a1: 1, a3: 1 }, why: "| META-001 | Missing title | D | 5 |; /meta/p-1" },
  { ruleId: "META-003", impact: 3, confidence: "verified", affected: { a1: 1, a3: 0 }, why: "| META-003 | Multiple title tags | D | 3 |; /meta/p-3, fixed by the patch" },
  { ruleId: "META-008", impact: 2, confidence: "heuristic", affected: { a1: 2, a3: 1 }, why: "| META-008 | Missing meta description | H | 2 |; /meta/p-11 and p-12, p-11 fixed" },
  { ruleId: "META-013", impact: 4, confidence: "verified", affected: { a1: 1, a3: 1 }, why: "| META-013 | Missing viewport meta | D | 4 |; /meta/p-21" },
  { ruleId: "META-014", impact: 2, confidence: "verified", affected: { a1: 1, a3: 0 }, why: "| META-014 | Viewport disables zoom | D | 2 |; /meta/p-22, fixed by the patch" },
];

interface StateRow {
  fingerprint: string;
  rule_id: string;
  url: string;
  state: string;
  page_subject: boolean;
}

async function main() {
  delete process.env[FIX_PATCH_ENV];
  const db = await setupDb(DB_URL);
  const site = await startFixtureSite();
  process.env.CRAWL_QUEUE_NAME = QUEUE;
  const q = createCrawlQueue();
  const blobDir = await mkdtemp(path.join(tmpdir(), "sitesentry-gate3-blobs-"));
  const memDir = path.resolve(".data", "gate-p3");
  await rm(memDir, { recursive: true, force: true });
  await mkdir(memDir, { recursive: true });
  const memLog = path.join(memDir, "memory.log");
  let worker: ReturnType<typeof startWorker> | null = null;
  const stopWorker = async () => {
    if (!worker) return;
    worker.child.kill("SIGKILL");
    await worker.exited;
    worker = null;
  };
  const stopForMemory = (who: string, detail: string) => {
    console.error(`\nGATE STOPPED: ${who} passed ${MEMORY_LIMIT_MB} MB RSS. ${detail}\nMemory log: ${memLog}`);
    worker?.child.kill("SIGKILL");
    process.exit(2);
  };
  const gateMem = startMemoryLog({ file: memLog, label: "gate", limitBytes: MEMORY_LIMIT_MB * 1048576, onLimit: (rss, snap) => stopForMemory("the gate process", `RSS ${Math.round(rss / 1048576)} MB; heap snapshot ${snap}`) });
  const origin = site.origins.main;
  const host = origin.replace(/[.]/g, "\\.");
  const main = plans(site)[0];
  // /slow/ (timing-dependent 429 and 503 answers) and /ssrf/ are Phase 1 subjects: left out of every audit, so two
  // audits of the unchanged site observe the same findings.
  const fullScope = { include: [], exclude: [...MAIN_EXCLUDE, `^${host}/slow/`, `^${host}/ssrf/`] };
  const FULL: CrawlConfig = { ...main.config, scope: fullScope };
  const PARTIAL: CrawlConfig = { ...main.config, scope: { include: [], exclude: [...fullScope.exclude, `^${host}/(?!$|meta/)`, `^${host}/meta/p-6$`] } };
  console.log(`Phase 3 gate. Fixture ${origin}; fix patch: ${FIX_PATCH.map((f) => `${f.ruleId} ${f.path}${f.verify ? " (verified)" : ""}`).join(", ")}. Gate database ${new URL(DB_URL).pathname.slice(1)}.\n`);

  const states = async (crawl: string) => (await db.$client.query<StateRow>("select fingerprint, rule_id, url, state, page_subject from issue_states where crawl_id = $1", [crawl])).rows;
  const answered = async (crawl: string) => new Set((await db.$client.query<{ u: string }>("select normalised_url as u from crawl_urls where crawl_id = $1 and state = any($2)", [crawl, ANSWERED])).rows.map((r) => r.u));
  const waitAnalysed = async (label: string, id: string, t0: number) => {
    await waitFor(`${label}: crawl and analysis`, 15 * 60_000, async () => {
      const c = await crawlRow(db, id);
      return ["completed", "failed"].includes(c.analysis?.status ?? "") || c.status === "failed";
    });
    const c = await crawlRow(db, id);
    check(`${label}: crawl completed and analysed through the queue`, c.status === "completed" && c.analysis?.status === "completed", `crawl ${c.status}, analysis ${c.analysis?.status} (${c.analysis?.pages ?? "?"} pages) after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  };
  const audit = async (label: string, config: CrawlConfig): Promise<string> => {
    const [row] = await db
      .insert(crawls)
      .values({ workspace: WORKSPACE, auditId: randomUUID(), siteId: SITE_ID, siteOrigin: origin, profile: "custom", config, status: "queued", budget: main.budget, maxDepth: null })
      .returning({ id: crawls.id });
    const t0 = Date.now();
    await enqueueCrawl(q, row.id);
    console.log(`\n== ${label}`);
    await waitAnalysed(label, row.id, t0);
    return row.id;
  };
  /** Resolved rows of `crawl`: each must be expected, and its URL answered by the crawl when the subject is a URL. */
  const resolutions = async (label: string, crawl: string, want: string[]) => {
    const rows = (await states(crawl)).filter((r) => r.state === "resolved");
    const got = rows.map((r) => r.fingerprint);
    const ans = await answered(crawl);
    const unchecked = rows.filter((r) => r.page_subject && !ans.has(r.url));
    const extra = rows.filter((r) => !want.includes(r.fingerprint));
    check(`${label}: resolved equals the manifest exactly`, same(got, want), `${got.length} resolved, ${want.length} expected${extra.length ? `; not in the manifest: ${extra.map((r) => `${r.rule_id} ${r.url.replace(origin, "")}`).join(", ")}` : ""}${want.filter((f) => !got.includes(f)).length ? `; missing: ${want.filter((f) => !got.includes(f)).map((f) => fpName.get(f)).join(", ")}` : ""}`);
    check(`${label}: zero false resolutions, zero resolutions for a URL not re-checked`, extra.length === 0 && unchecked.length === 0, `${extra.length} outside the manifest; ${unchecked.length} on a URL the crawl did not answer${unchecked.length ? `: ${unchecked.slice(0, 10).map((r) => `${r.rule_id} ${r.url}`).join(", ")}` : ""}`);
    return rows;
  };
  const fpName = new Map<string, string>();
  let a3 = "";

  try {
    worker = startWorker(site, blobDir, memDir, (d) => stopForMemory("the worker", d), DB_URL, QUEUE);
    await worker.booted;

    // ---------- 1. Audit 1, then the fix patch and its verifications ----------
    const a1 = await audit("Audit 1 (full, unpatched)", FULL);
    const s1 = await states(a1);
    const open1 = s1.filter((r) => OPEN.includes(r.state));
    info(`audit 1: ${s1.length} states, ${open1.length} open`);
    const patched = FIX_PATCH.map((f) => ({ ...f, row: s1.find((r) => r.rule_id === f.ruleId && r.url === new URL(f.path, origin).toString() && r.state === "new") }));
    for (const p of patched) if (p.row) fpName.set(p.row.fingerprint, `${p.ruleId} ${p.path}`);
    check("Audit 1 observes every finding the fix patch fixes, as new", patched.every((p) => p.row), patched.map((p) => `${p.ruleId} ${p.path}: ${p.row ? "new" : "MISSING"}`).join("; "));
    const fp = (pred: (p: (typeof patched)[number]) => boolean) => patched.filter((p) => p.row && pred(p)).map((p) => p.row!.fingerprint);
    await priorityAndHealth(db, a1, "audit 1", "a1");

    process.env[FIX_PATCH_ENV] = "1";
    console.log(`\n== Fix patch on (${FIX_PATCH_ENV}=1); verifications of the patched groups`);
    const verified: string[] = [];
    for (const ruleId of [...new Set(FIX_PATCH.filter((f) => f.verify).map((f) => f.ruleId))]) {
      const t0 = Date.now();
      const v = await startVerification(db, q, a1, ruleId);
      await waitAnalysed(`Verify ${ruleId}`, v.verifyCrawlId, t0);
      const want = fp((p) => p.verify && p.ruleId === ruleId);
      const targets = open1.filter((r) => r.rule_id === ruleId).map((r) => r.fingerprint);
      const rows = await resolutions(`Verify ${ruleId}`, v.verifyCrawlId, want);
      const vs = await states(v.verifyCrawlId);
      const others = vs.filter((r) => r.state !== "resolved");
      check(
        `Verify ${ruleId}: every other target persists, nothing else is touched`,
        same(vs.map((r) => r.fingerprint), targets) && others.every((r) => r.state === "persistent"),
        `${targets.length} target(s) (${v.urls.length} URL(s) fetched): ${rows.length} resolved, ${others.map((r) => `${r.url.replace(origin, "")} ${r.state}`).join(", ") || "none other"}`,
      );
      verified.push(...rows.map((r) => r.fingerprint));
    }

    // ---------- 2. Audit 2, partial ----------
    const a2 = await audit("Audit 2 (partial: / and /meta/ only, /meta/p-6 excluded; patch on)", PARTIAL);
    await resolutions("Audit 2", a2, fp((p) => !p.verify && p.path !== "/meta/p-6"));
    const s2 = new Map((await states(a2)).map((r) => [r.fingerprint, r]));
    const ans2 = await answered(a2);
    const stillOpen = open1.filter((r) => !verified.includes(r.fingerprint));
    const unvisited = stillOpen.filter((r) => r.page_subject && !ans2.has(r.url));
    const siteRule = new Set((await db.$client.query<{ id: string }>("select id from rules where scope = 'site'")).rows.map((r) => r.id));
    const siteOpen = stillOpen.filter((r) => siteRule.has(r.rule_id) && !unvisited.includes(r));
    const badUnvisited = unvisited.filter((r) => s2.get(r.fingerprint)?.state !== "not_rechecked");
    const badSite = siteOpen.filter((r) => !["not_rechecked", "persistent", "inconclusive"].includes(s2.get(r.fingerprint)?.state ?? ""));
    check(
      "Audit 2: every open finding on a URL it did not answer is not_rechecked",
      unvisited.length > 0 && badUnvisited.length === 0 && s2.get(fp((p) => p.path === "/meta/p-6")[0])?.state === "not_rechecked",
      `${unvisited.length} open findings on unvisited URLs (the patched /meta/p-6 among them): ${unvisited.length - badUnvisited.length} not_rechecked${badUnvisited.length ? `; wrong: ${badUnvisited.slice(0, 10).map((r) => `${r.rule_id} ${r.url} ${s2.get(r.fingerprint)?.state}`).join(", ")}` : ""}`,
    );
    check("Audit 2: no site-rule finding resolves in the narrower crawl", badSite.length === 0, `${siteOpen.length} open site-rule findings on answered or site-wide subjects: ${badSite.length ? badSite.map((r) => `${r.rule_id} ${s2.get(r.fingerprint)?.state}`).join(", ") : "none resolved"}`);

    // ---------- 3. Audit 3, full ----------
    a3 = await audit("Audit 3 (full, audit 1's settings; patch on)", FULL);
    await resolutions("Audit 3", a3, fp((p) => p.path === "/meta/p-6"));
    const s3 = await states(a3);
    const count = (st: string) => s3.filter((r) => r.state === st).length;
    check("Audit 3: nothing new, regressed or not_rechecked", count("new") === 0 && count("regressed") === 0 && count("not_rechecked") === 0, `new ${count("new")}, regressed ${count("regressed")}, not_rechecked ${count("not_rechecked")}, persistent ${count("persistent")}, resolved ${count("resolved")}, inconclusive ${count("inconclusive")}${count("new") ? `; new: ${s3.filter((r) => r.state === "new").slice(0, 10).map((r) => `${r.rule_id} ${r.url}`).join(", ")}` : ""}`);
    const allResolved = (await db.$client.query<{ fingerprint: string; n: string }>("select s.fingerprint, count(*) as n from issue_states s join crawls c on c.id = s.crawl_id where c.site_id = $1 and s.state = 'resolved' group by 1", [SITE_ID])).rows;
    check(
      "Across every crawl: each patched finding resolved exactly once, nothing else resolved",
      same(allResolved.map((r) => r.fingerprint), fp(() => true)) && allResolved.every((r) => Number(r.n) === 1),
      `${allResolved.length} resolved fingerprint(s) in the project, manifest ${FIX_PATCH.length}: ${allResolved.map((r) => `${fpName.get(r.fingerprint) ?? r.fingerprint} ×${r.n}`).join(", ")}`,
    );
    const cmp = await compareCrawls(db, a1, a3);
    const sum = (k: "new" | "persistent" | "resolved" | "regressed" | "not_rechecked") => cmp.groups.reduce((n, g) => n + g.counts[k], 0);
    const g = (r: string) => cmp.groups.find((x) => x.ruleId === r);
    const persistentWant = open1.length - FIX_PATCH.length;
    check(
      "Audit 1 → audit 3 comparison: per-fingerprint and per-group changes",
      sum("resolved") === FIX_PATCH.length && sum("new") === 0 && sum("regressed") === 0 && sum("not_rechecked") === 0 && sum("persistent") === persistentWant &&
        ["META-003", "META-005", "META-006", "META-014"].every((r) => g(r)?.change === "resolved") && g("META-008")?.change === "persistent" && g("META-008")?.counts.resolved === 1 && g("META-008")?.counts.persistent === 1,
      `fingerprints: resolved ${sum("resolved")} (want ${FIX_PATCH.length}), persistent ${sum("persistent")} (want ${persistentWant}: audit 1's ${open1.length} open less the patched), new ${sum("new")}, regressed ${sum("regressed")}, not_rechecked ${sum("not_rechecked")}; groups ${JSON.stringify(cmp.totals)}; ` +
        ["META-003", "META-005", "META-006", "META-008", "META-014"].map((r) => `${r} ${g(r)?.change} ${JSON.stringify(g(r)?.counts)}`).join("; "),
    );
    await priorityAndHealth(db, a3, "audit 3", "a3");
  } finally {
    await stopWorker();
    await q.close();
    await site.close();
    await rm(blobDir, { recursive: true, force: true });
  }

  // The heavy steps after the crawls run one at a time, the worker and the fixture already stopped: the migration's
  // child processes first, then the production app for the share link (stopped after), then Chromium for the PDF.
  // ---------- 7. JSON → Postgres migration ----------
  await migrationCheck();

  // ---------- 6. Share link, over HTTP against the production app ----------
  if (a3) await shareOverHttp(db, a3);

  // ---------- 5. Report ----------
  if (a3) {
    console.log("\n== Report of audit 3");
    const data = await reportData(db, a3, { agencyName: "Gate Agency", brandColor: "#0a7d52" });
    const html = renderReport(data, { csvHref: (r) => `csv/${r}` });
    await writeFile(path.join(memDir, "report.html"), html);
    const m = await checkReportMetrics(db, a3, html);
    check("Every number in the HTML report equals its database query", m.mismatches.length === 0 && m.checked > 0, `${m.checked} numbers (${m.keys} keys)${m.mismatches.length ? `; differ: ${JSON.stringify(m.mismatches.slice(0, 10))}` : ", all equal"}`);
    const api = await checkAgainstApi(html, { overview: await crawlOverview(db, a3), groups: await issueGroups(db, a3), comparison: data.comparison && (await compareCrawls(db, data.comparison.base.crawlId, a3)) });
    check("Every API-backed number in the report equals the API's", api.mismatches.length === 0 && api.apiBacked > 0, `${api.apiBacked} equal the API; not in an API response: ${api.notInApi.join(", ")}${api.mismatches.length ? `; differ: ${JSON.stringify(api.mismatches.slice(0, 10))}` : ""}`);
    const t0 = Date.now();
    const pdf = await renderPdf(html, "Gate Agency");
    const pdfPath = path.join(memDir, "report.pdf");
    await writeFile(pdfPath, pdf.pdf);
    check("The PDF renders", pdf.pdf.subarray(0, 5).toString() === "%PDF-" && pdf.pages > 1, `${pdf.pages} pages, ${(pdf.pdf.length / 1024).toFixed(0)} KB in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${pdfPath}`);
  }
  await db.$client.end();

  const gatePeak = gateMem.stop();
  const lines = readFileSync(memLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { label: string; rssMb: number });
  console.log(`\n== Memory (log ${memLog})`);
  for (const label of ["gate", "worker"]) {
    const ls = lines.filter((l) => l.label === label);
    if (ls.length) info(`${label}: peak RSS ${Math.max(...ls.map((l) => l.rssMb))} MB, ${ls.length} samples`);
  }
  check(`Every process stayed under ${MEMORY_LIMIT_MB} MB RSS`, lines.every((l) => l.rssMb < MEMORY_LIMIT_MB) && gatePeak.rss < MEMORY_LIMIT_MB * 1048576, `max ${Math.max(...lines.map((l) => l.rssMb))} MB`);
  const failed = results.filter((x) => !x.pass);
  console.log(`\n${failed.length ? "GATE FAILED" : "GATE PASSED"}: ${results.length - failed.length} / ${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
}

/** 4: the stored priority inputs of the HAND groups, and the health score, against this gate's own arithmetic. */
async function priorityAndHealth(db: Awaited<ReturnType<typeof setupDb>>, crawl: string, label: string, which: "a1" | "a3") {
  console.log(`\n== Priority and health, ${label}`);
  // Indexable pages, counted here: a 200 HTML page with no noindex (meta or header) whose first head/header canonical
  // is absent or the page itself.
  const ix = await db.$client.query<{ n: number }>(`select count(*)::int as n from crawl_urls u join page_snapshots s on s.url_id = u.id
    where u.crawl_id = $1 and u.status_code = 200 and s.content_type like 'text/html%'
      and not coalesce((s.robots->'noindex'->>'meta')::boolean or (s.robots->'noindex'->>'header')::boolean, false)
      and coalesce((select c->>'resolved' from jsonb_array_elements(s.canonicals) with ordinality as t(c, i)
                    where c->>'location' <> 'body' and c->>'resolved' is not null order by i limit 1), u.normalised_url) = u.normalised_url`, [crawl]);
  const indexable = ix.rows[0].n;
  const rows = (await db.$client.query<{ rule_id: string; impact: number; confidence: string; confidence_weight: number; affected_pages: number; indexable_pages: number; reach: number; score: number; priority: string }>(
    "select rule_id, impact, confidence, confidence_weight, affected_pages, indexable_pages, reach, score, priority from issue_groups where crawl_id = $1", [crawl])).rows;
  for (const h of HAND) {
    const affected = h.affected[which];
    const w = CONF_W[h.confidence];
    const reach = affected > 0 ? Math.min(1, Math.log(1 + affected) / Math.log(1 + indexable)) : 0;
    const score = Math.round(h.impact * reach * w * 10000) / 10000;
    const band = BANDS.find(([, min]) => score >= min)?.[0] ?? "info";
    const g = rows.find((r) => r.rule_id === h.ruleId);
    const close = (a: number, b: number) => Math.abs(a - b) < 1e-4;
    const ok = affected === 0 ? !g || (g.affected_pages === 0 && close(g.score, 0)) : !!g && g.impact === h.impact && g.confidence === h.confidence && close(g.confidence_weight, w) && g.affected_pages === affected && g.indexable_pages === indexable && close(g.reach, reach) && close(g.score, score) && g.priority === band;
    check(
      `${label}: ${h.ruleId} priority inputs equal the hand computation`,
      ok,
      `hand: impact ${h.impact} × reach ln(1+${affected})/ln(1+${indexable}) = ${reach.toFixed(4)} × ${h.confidence} ${w} = ${score} → ${band} (${h.why}); stored: ${g ? `impact ${g.impact}, ${g.confidence} ${g.confidence_weight}, affected ${g.affected_pages}/${g.indexable_pages}, reach ${g.reach}, score ${g.score} → ${g.priority}` : "no group"}`,
    );
  }
  // Health: every rule that ran (history rules summarise others and are left out), its group's score as the deduction (0 without a group), impact × weight as the maximum.
  const ran = (await db.$client.query<{ category: string; impact: number; confidence: string; score: number | null }>(
    `select r.category, r.impact, r.confidence, g.score from rule_runs rr join rules r on r.id = rr.rule_id
     left join issue_groups g on g.crawl_id = rr.crawl_id and g.rule_id = rr.rule_id where rr.crawl_id = $1 and rr.status = 'ran' and r.scope <> 'history'`, [crawl])).rows;
  const cats = new Map<string, { d: number; m: number }>();
  for (const r of ran) {
    if (!(r.category in CATEGORY_W)) continue; // performance and accessibility have no published weight
    const c = cats.get(r.category) ?? { d: 0, m: 0 };
    c.d += r.score ?? 0;
    c.m += r.impact * CONF_W[r.confidence];
    cats.set(r.category, c);
  }
  const catScore = new Map([...cats].map(([k, c]) => [k, c.m ? Math.round(1000 * (1 - Math.min(c.d, c.m) / c.m)) / 10 : 100]));
  const total = Math.round((10 * [...catScore].reduce((n, [k, s]) => n + CATEGORY_W[k] * s, 0)) / [...catScore.keys()].reduce((n, k) => n + CATEGORY_W[k], 0)) / 10;
  const stored = (await db.$client.query<{ health: { score: number; categories: Record<string, { score: number }> } }>("select health from crawls where id = $1", [crawl])).rows[0].health;
  const catDiff = [...catScore].filter(([k, s]) => Math.abs((stored.categories[k]?.score ?? NaN) - s) > 0.05);
  check(`${label}: health score equals its recomputation`, Math.abs(stored.score - total) <= 0.05 && catDiff.length === 0, `recomputed ${total} over ${ran.length} rules in ${catScore.size} categories (${[...catScore].map(([k, s]) => `${k} ${s}`).join(", ")}); stored ${stored.score}${catDiff.length ? `; categories differ: ${catDiff.map(([k, s]) => `${k} ${s} vs ${stored.categories[k]?.score}`).join(", ")}` : ""}`);
}

/**
 * 6: a share link of audit 3 through the production app (`next start`, needs `npm run build`) on a free loopback
 * port, reading the gate database and an empty data directory: status codes, the access cookie, and the headers
 * as a browser receives them (Next's site-wide headers included).
 */
async function shareOverHttp(db: Awaited<ReturnType<typeof setupDb>>, crawl: string) {
  console.log("\n== Share link over HTTP (next start)");
  if (!existsSync(path.resolve(".next", "BUILD_ID"))) {
    check("Share link over HTTP: the production app starts", false, "no production build in .next: run `npm run build` first");
    return;
  }
  const port = await new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
  const dataDir = await mkdtemp(path.join(tmpdir(), "sitesentry-gate3-app-"));
  const env = {} as NodeJS.ProcessEnv;
  for (const [k, v] of Object.entries(process.env)) if (!/^(SITE_SENTRY_|CRAWL(ER)?_|ANALYSIS_|DATABASE_URL$)/.test(k)) env[k] = v;
  Object.assign(env, { NODE_ENV: "production", DATABASE_URL: DB_URL, SITE_SENTRY_STORE: "json", SITE_SENTRY_DATA_DIR: dataDir });
  const app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port), "-H", "127.0.0.1"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  app.stdout!.on("data", (d: Buffer) => (log = (log + d).slice(-4000)));
  app.stderr!.on("data", (d: Buffer) => (log = (log + d).slice(-4000)));
  const exited = new Promise<void>((r) => app.on("exit", () => r()));
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor("the production app", 90_000, async () => !!(await fetch(`${base}/r/not-a-token`).catch(() => null)));
    const share = await createShare(db, { workspace: WORKSPACE, auditId: `gate-${randomUUID()}`, crawlId: crawl, password: "gate-p3-password", expiresInDays: 7 });
    const url = `${base}/r/${share.token}`;
    const get = (cookie?: string, sub = "") => fetch(`${url}${sub}`, { redirect: "manual", headers: cookie ? { cookie: `${SHARE_COOKIE}=${cookie}` } : {} });
    const post = (password: string) => fetch(url, { method: "POST", redirect: "manual", body: new URLSearchParams({ password }) });
    // Every share response, refusals included: exactly these values, as the browser receives them.
    const headerFaults = (r: Response) => {
      const h = (k: string) => r.headers.get(k);
      const out: string[] = [];
      if (h("referrer-policy") !== "no-referrer") out.push(`referrer-policy "${h("referrer-policy")}"`);
      if (!/^noindex\b/.test(h("x-robots-tag") ?? "")) out.push(`x-robots-tag "${h("x-robots-tag")}"`);
      if (h("cache-control") !== "private, no-store") out.push(`cache-control "${h("cache-control")}"`);
      if (!/default-src 'none'/.test(h("content-security-policy") ?? "")) out.push("content-security-policy missing");
      return out;
    };
    const seen: { what: string; faults: string[] }[] = [];
    const note = async (what: string, r: Response) => {
      seen.push({ what, faults: headerFaults(r) });
      return { status: r.status, cookie: r.headers.get("set-cookie"), location: r.headers.get("location"), type: r.headers.get("content-type") ?? "", body: await r.text() };
    };

    const form = await note("GET no cookie", await get());
    const wrong = await note("POST wrong password", await post("not-the-password"));
    check(
      "Share link over HTTP: no password or a wrong one is refused",
      form.status === 401 && form.body.includes('type="password"') && !form.body.includes("data-metric") && wrong.status === 401 && !wrong.cookie && wrong.body.includes("not right"),
      `GET without cookie → ${form.status} (password form), POST wrong password → ${wrong.status}, set-cookie ${wrong.cookie ?? "none"}`,
    );
    const right = await note("POST right password", await post("gate-p3-password"));
    const cookieOk = new RegExp(`^${SHARE_COOKIE}=[A-Za-z0-9_-]{43}; Path=/r/${share.token}; HttpOnly; SameSite=Strict; Max-Age=\\d+$`).test(right.cookie ?? "");
    const cookie = (right.cookie ?? "").split(";")[0].slice(SHARE_COOKIE.length + 1);
    const opened = await note("GET with cookie", await get(cookie));
    const csv = await note("GET CSV with cookie", await get(cookie, "/csv/META-008"));
    check(
      "Share link over HTTP: the right password sets a path-scoped HttpOnly cookie that opens the report and CSV",
      right.status === 303 && right.location === `/r/${share.token}` && cookieOk && opened.status === 200 && opened.type.startsWith("text/html") && opened.body.includes("data-metric") && csv.status === 200 && csv.type.startsWith("text/csv") && csv.body.startsWith("url,state"),
      `POST → ${right.status} to ${right.location}, set-cookie "${(right.cookie ?? "").replace(cookie, "<43 chars>")}" (no Secure over http); GET with it → ${opened.status} ${opened.type} (${opened.body.length} bytes); CSV → ${csv.status} ${csv.type}`,
    );
    await db.$client.query("update report_shares set expires_at = now() - interval '1 second' where id = $1", [share.id]);
    const expired = await note("GET after expiry", await get(cookie));
    const expiredPost = await note("POST after expiry", await post("gate-p3-password"));
    const unknown = await note("GET unknown token", await fetch(`${base}/r/${"A".repeat(43)}`, { redirect: "manual" }));
    check(
      "Share link over HTTP: refused after expiry, even with the right cookie or password",
      expired.status === 410 && expiredPost.status === 410 && !expired.body.includes("data-metric") && unknown.status === 404,
      `GET with cookie → ${expired.status}, POST right password → ${expiredPost.status}; unknown token → ${unknown.status}`,
    );
    const faulty = seen.filter((x) => x.faults.length);
    check(
      "Share link over HTTP: every response has Referrer-Policy no-referrer, X-Robots-Tag noindex, no-store and the report CSP",
      faulty.length === 0,
      `${seen.length} responses${faulty.length ? `; wrong: ${faulty.map((x) => `${x.what}: ${x.faults.join(", ")}`).join("; ")}` : ", all exact"}`,
    );
  } catch (e) {
    check("Share link over HTTP: the production app answers", false, `${(e as Error).message}\n${log}`);
  } finally {
    app.kill();
    await exited;
    await rm(dataDir, { recursive: true, force: true });
  }
}

/**
 * 7: scripts/migrate-json-store.ts on a copy of .data/store.json (or, without one, the sample seed), dry run then real
 * run, into a fresh database.
 */
async function migrationCheck() {
  console.log("\n== JSON store → Postgres migration (copy of .data/store.json)");
  const url = new URL(STORE_DB_URL);
  const name = url.pathname.slice(1);
  const admin = new Client({ connectionString: Object.assign(new URL(url), { pathname: "/postgres" }).toString() });
  await admin.connect();
  await admin.query(`drop database if exists "${name}" with (force)`);
  await admin.query(`create database "${name}"`);
  await admin.end();
  const dir = await mkdtemp(path.join(tmpdir(), "sitesentry-gate3-store-"));
  try {
    const local = path.resolve(".data", "store.json");
    if (existsSync(local)) await copyFile(local, path.join(dir, "store.json"));
    else {
      // No local store (a fresh checkout, CI): migrate the app's deterministic sample seed instead.
      info("no .data/store.json: migrating the sample workspace seed (buildSampleSeed)");
      const seed = await buildSampleSeed();
      const store = new JsonFileStore(path.join(dir, "sample"));
      for (const [id, blob] of Object.entries(seed.blobs)) await store.writeAudit(id, blob);
      await store.update((d) => void Object.assign(d, structuredClone(seed.state)));
    }
    const run = (dry: boolean) => {
      const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/migrate-json-store.ts", ...(dry ? ["--dry-run"] : []), "--data-dir", dir, "--db", url.toString()], { encoding: "utf8" });
      const table = (r.stdout ?? "").split("\n").filter((l) => /\s(yes|NO)$/.test(l)).map((l) => l.trim().split(/\s+/));
      return { code: r.status, table, out: `${r.stdout}${r.stderr}` };
    };
    const dry = run(true);
    const real = run(false);
    for (const [label, r] of [["dry run", dry], ["real run", real]] as const) info(`${label} (exit ${r.code}): ${r.table.map((t) => `${t[0]}.${t[1]} json ${t[2]} → ${t[3]}`).join(", ")}`);
    const key = (t: string[]) => `${t[0]}.${t[1]}=${t[2]}/${t[3]}`;
    const rows = new Client({ connectionString: url.toString() });
    await rows.connect();
    const counted: string[] = [];
    for (const t of real.table) {
      const n = (await rows.query<{ n: string }>(`select count(*) as n from "${t[1]}" where ${t[1] === "workspaces" ? "id" : "workspace"} = $1`, [t[0]])).rows[0].n;
      counted.push(`${t[0]}.${t[1]} ${n}`);
      if (Number(n) !== Number(t[2])) counted.push("MISMATCH");
    }
    await rows.end();
    check(
      "Migration: dry run and real run row counts match each other, the JSON and the database",
      dry.code === 0 && real.code === 0 && dry.table.length > 0 && same(dry.table.map(key), real.table.map(key)) && real.table.every((t) => t[2] === t[3]) && !counted.includes("MISMATCH"),
      `dry exit ${dry.code}, real exit ${real.code}; ${real.table.length} tables; counted in Postgres: ${counted.join(", ")}${dry.code || real.code ? `\n${dry.out}\n${real.out}` : ""}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

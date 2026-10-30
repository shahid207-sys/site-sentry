// Phase 4 gate (docs/SPEC.md "Phase 4"), against the production app (`next start`), a real worker and the fixture site:
//   1. E2E in a real browser (Playwright, e2e-gate/journey.spec.ts): add a site → audit wizard → live monitor until the
//      rule analysis finishes → Overview → Issues: triage (assign a group, ignore a finding with a reason, mark one
//      fixed) → CSV export of a group → the fix patch is switched on → Verify the fix → the group is Verified on the Fix
//      board.
//   2. axe-core (WCAG 2.1 A/AA rules) on every v2 screen of that audit, in light and dark: zero serious or critical
//      violations.
//   3. Lighthouse (preset "desktop", stated in the output) on Overview and Issues: accessibility ≥ 95, performance ≥ 90.
//   4. Filtering 50,000 findings: the Issues screen of a generated audit (scripts/gate-p4-data.ts, labelled as
//      generated) re-renders the table within 200 ms of a filter change, measured in the browser (performance measure
//      "ss-filter": from the input event to the layout effect after React commits the filtered table, before paint).
//
// Run: npm run build && npm run gate:p4   (needs `docker compose up -d`; uses its own database, sitesentry_gate4, and
// its own app data directory; the fixture site listens on port 8080, one the app accepts for a site)
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { FIX_PATCH_ENV } from "../fixtures/site/defects";
import { startFixtureSite } from "../fixtures/site/server";
import { startMemoryLog } from "../src/lib/memory-log";
import { JsonFileStore } from "../src/lib/store/store";
import { MEMORY_LIMIT_MB, setupDb, startWorker, waitFor } from "./gate-p2";
import { GENERATED_FINDINGS, seedGenerated } from "./gate-p4-data";

const DB_URL = process.env.GATE_DATABASE_URL ?? "postgres://sitesentry:sitesentry@127.0.0.1:5433/sitesentry_gate4";
const QUEUE = `crawl-gate4-${randomUUID()}`;
const FIXTURE_PORT = 8080;
const LIGHTHOUSE_PRESET = "desktop";
const TARGETS = { a11y: 95, perf: 90, filterMs: 200 };

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

/** What the browser spec writes for the gate to judge (e2e-gate/journey.spec.ts). */
interface SpecOut {
  auditId?: string;
  steps?: { name: string; ok: boolean; detail: string }[];
  axe?: { screen: string; theme: string; violations: { id: string; impact: string | null; nodes: number; help: string }[] }[];
  filter?: { label: string; rows: number; ms: number }[];
}

function runSpec(base: string, step: "audit" | "verify" | "filter", env: Record<string, string>, outFile: string): { ok: boolean; out: SpecOut } {
  const r = spawnSync(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "--config", "e2e-gate/playwright.config.ts", "--grep", `@${step}`], {
    env: { ...process.env, ...env, E2E_BASE_URL: base, GATE_P4_STEP: step, GATE_P4_OUT: outFile },
    stdio: "inherit",
    timeout: 20 * 60_000,
  });
  const out = existsSync(outFile) ? (JSON.parse(readFileSync(outFile, "utf8")) as SpecOut) : {};
  return { ok: r.status === 0, out };
}

/** Lighthouse CLI (its own Chrome launcher) on one URL; scores 0–100. */
function lighthouse(url: string, outFile: string): { perf: number; a11y: number; failing: string[] } | { error: string } {
  const r = spawnSync(
    process.execPath,
    ["node_modules/lighthouse/cli/index.js", url, `--preset=${LIGHTHOUSE_PRESET}`, "--only-categories=performance,accessibility", "--output=json", `--output-path=${outFile}`, "--quiet", "--chrome-flags=--headless=new --no-first-run"],
    { stdio: ["ignore", "ignore", "pipe"], timeout: 5 * 60_000 },
  );
  if (r.status !== 0 || !existsSync(outFile)) return { error: `lighthouse exited ${r.status}: ${String(r.stderr).slice(-400)}` };
  const lhr = JSON.parse(readFileSync(outFile, "utf8")) as { categories: Record<string, { score: number | null; auditRefs: { id: string }[] }>; audits: Record<string, { score: number | null; scoreDisplayMode: string; title: string }> };
  const score = (k: string) => Math.round((lhr.categories[k]?.score ?? 0) * 100);
  const failing = lhr.categories.accessibility.auditRefs
    .map((a) => lhr.audits[a.id])
    .filter((a) => a && a.scoreDisplayMode === "binary" && a.score === 0)
    .map((a) => a.title);
  return { perf: score("performance"), a11y: score("accessibility"), failing };
}

async function main() {
  if (!existsSync(path.resolve(".next", "BUILD_ID"))) {
    console.error("No production build in .next: run `npm run build` first.");
    process.exit(1);
  }
  delete process.env[FIX_PATCH_ENV];
  const outDir = path.resolve(".data", "gate-p4");
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const memLog = path.join(outDir, "memory.log");
  let worker: ReturnType<typeof startWorker> | null = null;
  let app: ChildProcess | null = null;
  const stopForMemory = (who: string, detail: string) => {
    console.error(`\nGATE STOPPED: ${who} passed ${MEMORY_LIMIT_MB} MB RSS. ${detail}\nMemory log: ${memLog}`);
    worker?.child.kill("SIGKILL");
    app?.kill();
    process.exit(2);
  };
  const gateMem = startMemoryLog({ file: memLog, label: "gate", limitBytes: MEMORY_LIMIT_MB * 1048576, onLimit: (rss, snap) => stopForMemory("the gate process", `RSS ${Math.round(rss / 1048576)} MB; heap snapshot ${snap}`) });

  const db = await setupDb(DB_URL);
  const site = await startFixtureSite({ port: FIXTURE_PORT });
  const blobDir = await mkdtemp(path.join(tmpdir(), "sitesentry-gate4-blobs-"));
  const dataDir = await mkdtemp(path.join(tmpdir(), "sitesentry-gate4-app-"));
  console.log(`Phase 4 gate. Fixture ${site.origins.main}; gate database ${new URL(DB_URL).pathname.slice(1)}; app data ${dataDir}.\n`);

  try {
    worker = startWorker(site, blobDir, outDir, (d) => stopForMemory("the worker", d), DB_URL, QUEUE);
    await worker.booted;

    console.log("== Generated load-test data");
    const t0 = Date.now();
    const generated = await seedGenerated(db, new JsonFileStore(path.join(dataDir, "live")), "live");
    info(`${GENERATED_FINDINGS.toLocaleString("en")} generated findings (labelled "Generated load test") written in ${((Date.now() - t0) / 1000).toFixed(1)} s; audit ${generated.auditId}`);

    const port = await freePort();
    const env = {} as NodeJS.ProcessEnv;
    for (const [k, v] of Object.entries(process.env)) if (!/^(SITE_SENTRY_|CRAWL(ER)?_|ANALYSIS_|DATABASE_URL$)/.test(k)) env[k] = v;
    Object.assign(env, {
      NODE_ENV: "production",
      NODE_OPTIONS: "--max-old-space-size=768",
      DATABASE_URL: DB_URL,
      SITE_SENTRY_STORE: "json",
      SITE_SENTRY_DATA_DIR: dataDir,
      CRAWLER_V2: "true",
      CRAWL_QUEUE_NAME: QUEUE,
      ANALYSIS_QUEUE_NAME: `${QUEUE}-analysis`,
    });
    app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port), "-H", "127.0.0.1"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    app.stdout!.on("data", (d: Buffer) => (log = (log + d).slice(-4000)));
    app.stderr!.on("data", (d: Buffer) => (log = (log + d).slice(-4000)));
    const base = `http://127.0.0.1:${port}`;
    await waitFor("the production app", 90_000, async () => !!(await fetch(`${base}/api/live/sites`).catch(() => null)));

    console.log("\n== E2E: add a site, audit, monitor, triage, export");
    const specEnv = { GATE_P4_ORIGIN: site.origins.main, GATE_P4_GENERATED: generated.auditId };
    const audit = runSpec(base, "audit", specEnv, path.join(outDir, "audit.json"));
    for (const s of audit.out.steps ?? []) info(`${s.ok ? "ok  " : "FAIL"} ${s.name}: ${s.detail}`);
    check("E2E: add site → wizard → monitor → Issues triage → CSV export", audit.ok && !!audit.out.auditId, audit.ok ? `audit ${audit.out.auditId}; ${audit.out.steps?.length ?? 0} steps` : "the spec failed (output above)");

    console.log("\n== E2E: the fix patch is on; verify the fix");
    process.env[FIX_PATCH_ENV] = "1";
    const verify = audit.out.auditId ? runSpec(base, "verify", { ...specEnv, GATE_P4_AUDIT: audit.out.auditId }, path.join(outDir, "verify.json")) : { ok: false, out: {} as SpecOut };
    delete process.env[FIX_PATCH_ENV];
    for (const s of verify.out.steps ?? []) info(`${s.ok ? "ok  " : "FAIL"} ${s.name}: ${s.detail}`);
    check("E2E: Verify fix resolves the patched finding and the board shows it Verified", verify.ok, verify.ok ? `${verify.out.steps?.length ?? 0} steps` : "the spec failed (output above)");

    const axe = [...(audit.out.axe ?? []), ...(verify.out.axe ?? [])];
    const serious = axe.flatMap((a) => a.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${a.screen} (${a.theme}): ${v.id} ×${v.nodes} (${v.help})`));
    const minor = axe.flatMap((a) => a.violations.filter((v) => v.impact !== "serious" && v.impact !== "critical").map((v) => `${a.screen} (${a.theme}): ${v.id} [${v.impact}]`));
    check(
      "axe-core WCAG 2.1 A/AA: zero serious or critical violations on every v2 screen, light and dark",
      axe.length > 0 && serious.length === 0,
      `${axe.length} screen checks (${[...new Set(axe.map((a) => a.screen))].join(", ")})${serious.length ? `; ${serious.join("; ")}` : ""}${minor.length ? `; minor: ${minor.join("; ")}` : "; no minor or moderate either"}`,
    );

    console.log("\n== Filtering 50,000 findings");
    const filter = runSpec(base, "filter", specEnv, path.join(outDir, "filter.json"));
    const timings = filter.out.filter ?? [];
    for (const t of timings) info(`${t.label}: ${t.rows.toLocaleString("en")} rows shown, ${t.ms.toFixed(1)} ms`);
    const worst = timings.length ? Math.max(...timings.map((t) => t.ms)) : Infinity;
    check(`Issues: a filter change over ${GENERATED_FINDINGS.toLocaleString("en")} findings renders within ${TARGETS.filterMs} ms`, filter.ok && timings.length > 0 && worst < TARGETS.filterMs, timings.length ? `slowest ${worst.toFixed(1)} ms over ${timings.length} filter changes (performance measure "ss-filter", in the browser)` : "no timings recorded");

    console.log(`\n== Lighthouse (preset "${LIGHTHOUSE_PRESET}")`);
    if (audit.out.auditId) {
      for (const [screen, sub] of [["Overview", ""], ["Issues", "/issues"]] as const) {
        const r = lighthouse(`${base}/live/audits/${audit.out.auditId}${sub}`, path.join(outDir, `lighthouse-${screen.toLowerCase()}.json`));
        if ("error" in r) {
          check(`Lighthouse ${screen}`, false, r.error);
          continue;
        }
        check(`Lighthouse ${screen}: accessibility ≥ ${TARGETS.a11y}, performance ≥ ${TARGETS.perf} (preset ${LIGHTHOUSE_PRESET})`, r.a11y >= TARGETS.a11y && r.perf >= TARGETS.perf, `accessibility ${r.a11y}, performance ${r.perf}${r.failing.length ? `; failing a11y audits: ${r.failing.join("; ")}` : ""}`);
      }
    } else check("Lighthouse", false, "no audit to measure: the E2E audit step failed");
  } catch (e) {
    check("Gate run", false, (e as Error).stack ?? String(e));
  } finally {
    app?.kill();
    if (worker) {
      worker.child.kill("SIGKILL");
      await worker.exited;
    }
    await site.close();
    gateMem.stop();
    await db.$client.end();
    await rm(blobDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.${failed.length ? ` FAILED: ${failed.map((f) => f.name).join("; ")}` : ""}`);
  process.exit(failed.length ? 1 : 0);
}

void main();

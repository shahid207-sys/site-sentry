// Phase 6 gate, local part (docs/SPEC.md "Phase 6": scheduled audits with webhook regression alerts), against the
// production app (`next start` with its scheduler tick), a real worker and the fixture site:
//   A schedule audits the fixture's /meta/ section (Custom profile, subfolder /meta/) and posts alerts to a local
//   receiver. Three runs, each started with "Run now" and launched by the app's scheduler tick:
//     run 1, fix patch off: first audit of the site, nothing to compare with → no alert (delivery "skipped");
//     run 2, fix patch on:  issue groups only resolve → no alert;
//     run 3, fix patch off: the patched defects come back → one alert, META-003 regressed.
//   The alert's HMAC-SHA256 signature verifies with the secret the API returned once, and its groups and totals are
//   the Compare API's for the same two audits.
// Integrations that need real accounts (Search Console, GA4, Jira/Linear/Trello, Slack, SMTP) are not part of this
// gate: they are reported as not built.
//
// Run: npm run build && npm run gate:p6   (needs `docker compose up -d`; its own database sitesentry_gate6; the fixture
// listens on 8080 and the webhook receiver on 8443, ports the app accepts)
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { FIX_PATCH_ENV } from "../fixtures/site/defects";
import { LOCAL_HOSTS_ENV, startFixtureSite } from "../fixtures/site/server";
import { verifySignature, SIGNATURE_HEADER, type RegressionAlert } from "../src/lib/schedule/alert";
import { MEMORY_LIMIT_MB, setupDb, startWorker, waitFor } from "./gate-p2";

const DB_URL = process.env.GATE_DATABASE_URL ?? "postgres://sitesentry:sitesentry@127.0.0.1:5433/sitesentry_gate6";
const QUEUE = `crawl-gate6-${randomUUID()}`;
const FIXTURE_PORT = 8080;
const HOOK_PORT = 8443;
const HOOK_HOST = "hooks.test";
const TICK_MS = 2_000;
const RUN_TIMEOUT_MS = 6 * 60_000;

const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}: ${detail}`);
}
const info = (s: string) => console.log(`      ${s}`);

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

interface Hit {
  body: string;
  signature: string | undefined;
}

function startReceiver(): Promise<{ server: Server; hits: Hit[] }> {
  const hits: Hit[] = [];
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/hook") hits.push({ body, signature: req.headers[SIGNATURE_HEADER] as string | undefined });
      res.writeHead(req.url === "/hook" ? 204 : 404).end();
    });
  });
  return new Promise((r) => server.listen(HOOK_PORT, "127.0.0.1", () => r({ server, hits })));
}

type Schedule = { id: string; lastRun: { auditId: string | null; error: string | null; startedAt: string } | null };
type Delivery = { auditId: string | null; crawlId: string; baseCrawlId: string | null; status: string; detail: string; httpStatus: number | null; payload: RegressionAlert | null };
type Comparison = { base: { crawlId: string }; head: { crawlId: string }; groups: { ruleId: string; change: string; counts: Record<string, number> }[]; totals: Record<string, number> };

async function main() {
  if (!existsSync(path.resolve(".next", "BUILD_ID"))) {
    console.error("No production build in .next: run `npm run build` first.");
    process.exit(1);
  }
  delete process.env[FIX_PATCH_ENV];
  const outDir = path.resolve(".data", "gate-p6");
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const key = randomBytes(32).toString("base64");
  let worker: ReturnType<typeof startWorker> | null = null;
  let app: ChildProcess | null = null;
  const stop = (who: string, detail: string) => {
    console.error(`\nGATE STOPPED: ${who} passed ${MEMORY_LIMIT_MB} MB RSS. ${detail}`);
    worker?.child.kill("SIGKILL");
    app?.kill();
    process.exit(2);
  };

  const db = await setupDb(DB_URL);
  const site = await startFixtureSite({ port: FIXTURE_PORT });
  const receiver = await startReceiver();
  const blobDir = await mkdtemp(path.join(tmpdir(), "sitesentry-gate6-blobs-"));
  const dataDir = await mkdtemp(path.join(tmpdir(), "sitesentry-gate6-app-"));
  console.log(`Phase 6 gate (local). Fixture ${site.origins.main}; webhook http://${HOOK_HOST}:${HOOK_PORT}/hook; database ${new URL(DB_URL).pathname.slice(1)}.\n`);
  const runs: { auditId: string; delivery: Delivery }[] = [];

  try {
    worker = startWorker(site, blobDir, outDir, (d) => stop("the worker", d), DB_URL, QUEUE, {
      CRAWLER_LOCAL_HOSTS: `${LOCAL_HOSTS_ENV},${HOOK_HOST}=127.0.0.1`,
      CRAWLER_LOCAL_PORTS: `${site.port},${HOOK_PORT}`,
      CRAWLER_SECRET_KEY: key,
    });
    await worker.booted;

    const port = await freePort();
    const env = {} as NodeJS.ProcessEnv;
    for (const [k, v] of Object.entries(process.env)) if (!/^(SITE_SENTRY_|CRAWL(ER)?_|ANALYSIS_|SCHEDULER|DATABASE_URL$)/.test(k)) env[k] = v;
    Object.assign(env, {
      NODE_ENV: "production",
      NODE_OPTIONS: "--max-old-space-size=768",
      DATABASE_URL: DB_URL,
      SITE_SENTRY_STORE: "json",
      SITE_SENTRY_DATA_DIR: dataDir,
      CRAWLER_V2: "true",
      CRAWLER_SECRET_KEY: key,
      CRAWL_QUEUE_NAME: QUEUE,
      ANALYSIS_QUEUE_NAME: `${QUEUE}-analysis`,
      SCHEDULER_TICK_MS: String(TICK_MS),
    });
    app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port), "-H", "127.0.0.1"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    app.stdout!.on("data", (d: Buffer) => (log = (log + d).slice(-20_000)));
    app.stderr!.on("data", (d: Buffer) => (log = (log + d).slice(-20_000)));
    const base = `http://127.0.0.1:${port}`;
    const call = async <T>(p: string, init?: { method?: string; body?: unknown }): Promise<T> => {
      const r = await fetch(`${base}/api/live${p}`, { method: init?.method ?? "GET", headers: init?.body ? { "content-type": "application/json" } : undefined, body: init?.body ? JSON.stringify(init.body) : undefined });
      const j = (await r.json()) as T & { error?: { message: string } };
      if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${p}: HTTP ${r.status} ${j.error?.message ?? ""}`);
      return j;
    };
    await waitFor("the production app", 90_000, async () => !!(await fetch(`${base}/api/live/sites`).catch(() => null)));

    console.log("== Schedule");
    const created = await call<{ id: string }>("/sites", { method: "POST", body: { name: "Fixture (gate p6)", origin: site.origins.main } });
    const siteId = created.id;
    const { schedule, webhookSecret } = await call<{ schedule: Schedule; webhookSecret: string | null }>("/schedules", {
      method: "POST",
      body: {
        siteId,
        cadence: "weekly",
        hourUtc: 3,
        weekday: 0,
        request: { mode: "sitemap", urls: [], profile: "custom", budget: 120, maxDepth: 3, scope: { include: [], exclude: [], subfolder: "/meta/" }, categories: ["metadata"], checkLinks: false, includeImportant: false },
        webhookUrl: `http://${HOOK_HOST}:${HOOK_PORT}/hook`,
      },
    });
    check("A schedule with a webhook returns its signing secret once", !!webhookSecret && webhookSecret.length >= 32, `schedule ${schedule.id}`);
    const listed = await call<(Schedule & { webhookUrl: string })[]>(`/schedules?site=${siteId}`);
    check("The schedule list never includes the secret", listed.length === 1 && !JSON.stringify(listed).includes(webhookSecret ?? "\u0000"), `${listed.length} schedule(s)`);

    for (const [i, patch] of [false, true, false].entries()) {
      const n = i + 1;
      if (patch) process.env[FIX_PATCH_ENV] = "1";
      else delete process.env[FIX_PATCH_ENV];
      console.log(`\n== Run ${n} (fix patch ${patch ? "on" : "off"})`);
      const before = new Set(runs.map((r) => r.auditId));
      await call(`/schedules/${schedule.id}`, { method: "PATCH", body: { runNow: true } });
      let auditId = "";
      await waitFor(`run ${n} to be launched by the scheduler tick`, 60_000, async () => {
        const s = (await call<Schedule[]>(`/schedules?site=${siteId}`))[0];
        if (s.lastRun?.error) throw new Error(`run ${n} failed to launch: ${s.lastRun.error}`);
        auditId = s.lastRun?.auditId && !before.has(s.lastRun.auditId) ? s.lastRun.auditId : "";
        return !!auditId;
      });
      info(`launched audit ${auditId}`);
      let delivery: Delivery | undefined;
      await waitFor(`run ${n} to be crawled, analysed and checked for regressions`, RUN_TIMEOUT_MS, async () => {
        delivery = (await call<Delivery[]>(`/schedules/${schedule.id}/deliveries`)).find((d) => d.auditId === auditId);
        return !!delivery;
      });
      info(`delivery: ${delivery!.status}: ${delivery!.detail}`);
      runs.push({ auditId, delivery: delivery! });
    }

    const [r1, r2, r3] = runs;
    check("Run 1 (first audit) sends no alert", r1.delivery.status === "skipped" && receiver.hits.length >= 0 && /First analysed audit/.test(r1.delivery.detail), r1.delivery.detail);
    check("Run 2 (fixes only) sends no alert", r2.delivery.status === "skipped" && r2.delivery.payload === null, r2.delivery.detail);
    check("Run 3 (defects back) sends exactly one alert", r3.delivery.status === "sent" && receiver.hits.length === 1, `${r3.delivery.detail}; receiver got ${receiver.hits.length} POST(s)`);

    const hit = receiver.hits[0];
    check("The alert's signature verifies with the secret (and not with another)", !!hit && verifySignature(hit.body, webhookSecret!, hit.signature) && !verifySignature(hit.body, "not-the-secret", hit.signature), hit ? `${SIGNATURE_HEADER}: ${hit.signature?.slice(0, 20)}…` : "no POST");
    const alert = hit ? (JSON.parse(hit.body) as RegressionAlert) : null;
    await writeFile(path.join(outDir, "alert.json"), hit?.body ?? "null");
    const meta3 = alert?.groups.find((g) => g.ruleId === "META-003");
    check("The alert lists META-003 as regressed", meta3?.change === "regressed", alert ? alert.groups.map((g) => `${g.ruleId} ${g.change} ×${g.fingerprints}`).join(", ") : "no alert");

    if (alert) {
      const cmp = await call<Comparison>(`/audits/${r3.auditId}/compare/groups`);
      await writeFile(path.join(outDir, "compare.json"), JSON.stringify(cmp, null, 2));
      const expected = cmp.groups
        .filter((g) => g.change === "new" || g.change === "regressed")
        .map((g) => `${g.ruleId}:${g.change}:${g.counts[g.change] ?? 0}`)
        .sort();
      const got = alert.groups.map((g) => `${g.ruleId}:${g.change}:${g.fingerprints}`).sort();
      const sameTotals = JSON.stringify(alert.totals) === JSON.stringify(cmp.totals);
      check(
        "The alert's groups, fingerprint counts and totals are the Compare API's",
        JSON.stringify(expected) === JSON.stringify(got) && sameTotals && alert.base.crawlId === cmp.base.crawlId && alert.audit.crawlId === cmp.head.crawlId,
        `compare: ${expected.join(", ")}; totals ${JSON.stringify(cmp.totals)}${sameTotals ? "" : ` vs alert ${JSON.stringify(alert.totals)}`}`,
      );
      check("The alert compares run 3 with run 2", alert.base.crawlId === r2.delivery.crawlId && r3.delivery.baseCrawlId === r2.delivery.crawlId, `base ${alert.base.crawlId}`);
    }

    const paused = await call<{ enabled: boolean }>(`/schedules/${schedule.id}`, { method: "PATCH", body: { enabled: false } });
    check("Pausing a schedule", paused.enabled === false, "enabled: false");
    await call(`/sites/${siteId}`, { method: "DELETE" });
    const after = await call<Schedule[]>(`/schedules?site=${siteId}`);
    check("Deleting the site deletes its schedules", after.length === 0, `${after.length} left`);
    if (log.includes("schedule.tick_failed")) info(`app log has tick failures:\n${log.split("\n").filter((l) => l.includes("tick_failed")).join("\n")}`);
  } catch (e) {
    check("Gate run", false, (e as Error).stack ?? String(e));
  } finally {
    delete process.env[FIX_PATCH_ENV];
    app?.kill();
    if (worker) {
      worker.child.kill("SIGKILL");
      await worker.exited;
    }
    await new Promise((r) => receiver.server.close(r));
    await site.close();
    await db.$client.end();
    await rm(blobDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }

  console.log("\n== Not built (need real accounts or credentials; not passed)");
  for (const x of ["Google Search Console and GA4 (OAuth)", "Jira, Linear and Trello issue sync", "Slack and SMTP (email) alerts"]) console.log(`NOT BUILT  ${x}`);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.${failed.length ? ` FAILED: ${failed.map((f) => f.name).join("; ")}` : ""}`);
  process.exit(failed.length ? 1 : 0);
}

void main();

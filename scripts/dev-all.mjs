// `npm run dev:all`: the app, the crawl worker and the analysis worker together, with .env.local loaded for all three
// (Next reads it by itself; the workers do not). Ctrl+C or one process exiting stops them all. docs/RUNBOOK.md.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
else console.warn("[dev:all] no .env.local: using the defaults (cp .env.example .env.local to change them)");

const tsx = ["--import", "tsx"];
const processes = [
  { name: "app", args: [path.join("node_modules", "next", "dist", "bin", "next"), "dev"], env: {} },
  // This command runs the analysis worker on its own, so the crawl worker does not run one in-process.
  { name: "crawl", args: [...tsx, "src/worker/crawl-worker.ts"], env: { ANALYSIS_WORKER: "off" } },
  { name: "analysis", args: [...tsx, "src/worker/analysis-worker.ts"], env: {} },
];

const reachable = ({ hostname, port }) =>
  new Promise((resolve) => {
    const s = connect({ host: hostname, port: Number(port) }, () => (s.destroy(), resolve(true)));
    s.setTimeout(2_000, () => (s.destroy(), resolve(false)));
    s.on("error", () => resolve(false));
  });

const services = [
  ["Postgres", new URL(process.env.DATABASE_URL ?? "postgres://127.0.0.1:5433")],
  ["Redis", new URL(process.env.REDIS_URL ?? "redis://127.0.0.1:6379")],
];
for (const [name, url] of services) {
  if (!(await reachable(url))) {
    console.error(`[dev:all] ${name} is not reachable at ${url.hostname}:${url.port}. Start it: docker compose up -d postgres redis`);
    process.exit(1);
  }
}

const children = [];
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    if (c.exitCode !== null) continue;
    // Next's dev server has children of its own; on Windows only taskkill /T reaches them.
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" });
    else c.kill("SIGTERM");
  }
  process.exitCode = code;
}

const prefixed = (name, stream, out) => {
  let rest = "";
  stream.on("data", (chunk) => {
    const lines = (rest + chunk).split(/\r?\n/);
    rest = lines.pop();
    for (const line of lines) out.write(`[${name}] ${line}\n`);
  });
};

for (const p of processes) {
  const child = spawn(process.execPath, p.args, { env: { ...process.env, ...p.env }, stdio: ["ignore", "pipe", "pipe"] });
  prefixed(p.name, child.stdout, process.stdout);
  prefixed(p.name, child.stderr, process.stderr);
  child.on("exit", (code) => {
    if (!stopping) console.error(`[dev:all] ${p.name} exited with code ${code}; stopping the others`);
    stop(code ?? 1);
  });
  children.push(child);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

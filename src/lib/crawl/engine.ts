// Step-based crawler. Each call to stepAudit does a bounded amount of work and persists its state,
// so an audit makes real progress under serverless time limits, can be cancelled between steps,
// and an interrupted audit can be resumed. There is no hidden background queue.
import { analyzeAudit, countBySeverity } from "../audit/analyze";
import { parseHtml } from "../audit/parse";
import { runRules } from "../audit/run";
import { canonicalRule } from "../audit/rules/canonical";
import { contentRule } from "../audit/rules/content";
import { headingsRule } from "../audit/rules/headings";
import { indexabilityRule } from "../audit/rules/indexability";
import { metaDescriptionRule } from "../audit/rules/meta-description";
import { titleRule } from "../audit/rules/title";
import { RULE_CATEGORIES, type PageExpectations, type RuleCategory } from "../audit/types";
import { SafeFetchError, type FetchResult } from "../fetch/safe-fetch";
import type { AuditConfig, AuditRun, CoverageNote, LinkCheck, PageSnapshot, QueueItem, RobotsSnapshot, Site, SitemapSnapshot } from "../model";
import type { AuditBlob, StoreData } from "../store/store";
import { WorkflowError, type Deps } from "../workflow/deps";
import { extractLinks } from "./extract";
import { describeLimits, LEGACY_ENGINE_LIMITS, PROFILES } from "./profiles";
import { isAllowed, parseRobots, type ParsedRobots } from "./robots";
import { parseSitemap } from "./sitemap";
import { isInternal, normalizePageUrl } from "./url";

/** This in-request engine runs while CRAWLER_V2=false; its page and depth ceiling is shared with the profiles. */
export const LIMITS = {
  ...LEGACY_ENGINE_LIMITS,
  concurrency: 4,
  linkChecks: 60,
  sitemapChildren: 5,
  storedSitemapUrls: 2000,
  stepBudgetMs: 8_000,
  leaseMs: 45_000,
  /** A running audit with no step for this long is shown as interrupted and can be resumed. */
  staleMs: 2 * 60_000,
};

/** The route clamps audits to LEGACY_ENGINE_LIMITS, so null (unlimited) never reaches this engine; read it safely anyway. */
const depthOf = (c: AuditConfig) => c.maxDepth ?? LEGACY_ENGINE_LIMITS.maxDepth;

/**
 * The engine clamp (engine_limit) only matters when it cut something: a page or depth limit fired. A small site
 * covered completely under the clamped limits is not partial.
 */
const clampCut = (audit: AuditRun) => audit.coverage.some((c) => c.code === "engine_limit") && audit.coverage.some((c) => c.code === "depth_limit");

export const ROBOTS_TOKEN = "SiteSentryBot";
export const ALL_CATEGORIES: RuleCategory[] = RULE_CATEGORIES.map((c) => c.id);

const errOf = (e: unknown) =>
  e instanceof SafeFetchError ? { code: e.code, message: e.message } : { code: "INTERNAL", message: (e as Error)?.message ?? "Unexpected error" };

/** Expectations for each important URL on a site, keyed by normalised URL. */
export function intentsFor(data: StoreData, siteId: string): Record<string, PageExpectations> {
  const out: Record<string, PageExpectations> = {};
  for (const p of Object.values(data.pages)) {
    if (p.siteId !== siteId) continue;
    out[p.url] = { important: true, ...(p.indexability ? { indexability: p.indexability } : {}), ...(p.canonicalUrl ? { canonicalUrl: p.canonicalUrl } : {}) };
  }
  return out;
}

function expectationsFor(intents: Record<string, PageExpectations>, ...urls: string[]): PageExpectations {
  for (const u of urls) if (intents[u]) return intents[u];
  return { important: false };
}

export function isStale(audit: AuditRun, now: Date): boolean {
  return audit.status === "running" && now.getTime() - Date.parse(audit.heartbeatAt) > LIMITS.staleMs;
}

// ---------- create ----------

export interface CreateAuditInput {
  siteId: string;
  config: AuditConfig;
  /** Notes known before the crawl starts, such as engine_limit from clampToLegacyEngine. */
  coverage?: CoverageNote[];
}

/**
 * Fit a profile's budget and depth to this engine (CRAWLER_V2=false). The audit keeps the profile name and gets an
 * engine_limit note saying what was asked for and what will run, so the report never implies a larger crawl.
 */
export function clampToLegacyEngine(config: AuditConfig): { config: AuditConfig; coverage: CoverageNote[] } {
  const maxPages = Math.min(config.maxPages, LEGACY_ENGINE_LIMITS.maxPages);
  const maxDepth = config.maxDepth === null ? LEGACY_ENGINE_LIMITS.maxDepth : Math.min(config.maxDepth, LEGACY_ENGINE_LIMITS.maxDepth);
  if (maxPages === config.maxPages && maxDepth === config.maxDepth) return { config, coverage: [] };
  const label = config.profile ? `The ${PROFILES[config.profile].label} profile asks for` : "This audit asked for";
  const message =
    `${label} ${describeLimits(config.maxPages, config.maxDepth)}. The in-request engine running this audit ` +
    `(crawler v2 is off) stops at ${describeLimits(maxPages, maxDepth)}, so this audit covers at most that.`;
  return { config: { ...config, maxPages, maxDepth }, coverage: [{ code: "engine_limit", message }] };
}

/** Create an audit run. Idempotent: if the site already has a live (non-stale) running audit, that run is returned. */
export async function createAudit({ siteId, config, coverage = [] }: CreateAuditInput, deps: Deps): Promise<{ audit: AuditRun; reused: boolean }> {
  const now = deps.now();
  return deps.store.update((d) => {
    const site = d.sites[siteId];
    if (!site) throw new WorkflowError("NOT_FOUND", "Site not found.");
    const running = Object.values(d.audits).find((a) => a.siteId === siteId && a.status === "running" && !isStale(a, now));
    if (running) return { audit: running, reused: true };

    const intents = intentsFor(d, siteId);
    const queue: QueueItem[] = [];
    const seen = new Set<string>();
    const push = (url: string, via: QueueItem["via"]) => {
      if (seen.has(url) || queue.length >= config.maxPages) return;
      seen.add(url);
      queue.push({ url, depth: 0, via });
    };
    for (const u of config.urls) {
      const n = normalizePageUrl(u);
      if (!n || !isInternal(n, site.origin)) throw new WorkflowError("INVALID", `${u} is not on ${site.origin}.`);
      push(n, "seed");
    }
    if (config.includeImportant) for (const u of Object.keys(intents).sort()) push(u, "important");
    if (config.mode !== "sitemap" && queue.length === 0) throw new WorkflowError("INVALID", "Add at least one URL to audit.");

    const at = now.toISOString();
    const audit: AuditRun = {
      id: deps.newId(),
      siteId,
      source: deps.source,
      createdAt: at,
      startedAt: at,
      finishedAt: null,
      heartbeatAt: at,
      leaseUntil: null,
      cancelRequested: false,
      linkQueueBuilt: false,
      status: "running",
      phase: "robots",
      config,
      queue,
      seen: [...seen],
      linkQueue: [],
      linkChecks: {},
      robots: null,
      sitemap: null,
      progress: { planned: queue.length, done: 0, inspected: 0, failed: 0, skipped: 0, linksChecked: 0 },
      coverage: [...coverage],
      ruleConfig: d.settings.ruleConfig,
    };
    d.audits[audit.id] = audit;
    return { audit, reused: false };
  });
}

// ---------- step ----------

interface StepState {
  audit: AuditRun;
  site: Site;
  blob: AuditBlob;
  intents: Record<string, PageExpectations>;
  robots: ParsedRobots | null;
  severityOverrides: StoreData["settings"]["severityOverrides"];
}

async function doRobots(s: StepState, deps: Deps) {
  const url = `${s.site.origin}/robots.txt`;
  const fetchedAt = deps.now().toISOString();
  let snap: RobotsSnapshot;
  try {
    const res = await deps.fetch(url, { accept: "robots" });
    if (res.status >= 200 && res.status < 300) {
      const parsed = parseRobots(res.body);
      snap = { url, fetchedAt, status: res.status, outcome: "ok", body: res.body.slice(0, 50_000), sitemaps: parsed.sitemaps };
    } else if (res.status >= 400 && res.status < 500) {
      snap = { url, fetchedAt, status: res.status, outcome: "missing", body: "", sitemaps: [] };
    } else {
      snap = { url, fetchedAt, status: res.status, outcome: "error", body: "", sitemaps: [] };
    }
  } catch (e) {
    snap = { url, fetchedAt, status: null, outcome: "error", error: errOf(e), body: "", sitemaps: [] };
  }
  s.audit.robots = snap;
  s.robots = snap.outcome === "ok" ? parseRobots(snap.body) : null;
  if (snap.outcome === "error") {
    note(s.audit, {
      code: "robots_error",
      message: `robots.txt could not be read (${snap.status ? `HTTP ${snap.status}` : snap.error?.message}). Only the listed URLs were audited; links were not followed.`,
    });
  }
  const wantsSitemap = s.audit.config.mode === "sitemap" || s.audit.config.categories.includes("crawlability");
  s.audit.phase = wantsSitemap ? "sitemap" : "pages";
}

async function fetchSitemapDoc(url: string, deps: Deps) {
  try {
    const res = await deps.fetch(url, { accept: "xml" });
    if (res.status < 200 || res.status >= 300 || !res.contentTypeAccepted) return { res, parsed: null, error: undefined };
    return { res, parsed: parseSitemap(res.body), error: undefined };
  } catch (e) {
    return { res: null, parsed: null, error: errOf(e) };
  }
}

async function doSitemap(s: StepState, deps: Deps) {
  const { config } = s.audit;
  const candidates: { url: string; via: SitemapSnapshot["via"] }[] = [];
  if (config.sitemapUrl) candidates.push({ url: config.sitemapUrl, via: "audit" });
  if (s.site.sitemapUrl) candidates.push({ url: s.site.sitemapUrl, via: "config" });
  for (const u of s.audit.robots?.sitemaps ?? []) candidates.push({ url: u, via: "robots" });
  candidates.push({ url: `${s.site.origin}/sitemap.xml`, via: "default" });
  const chosen = candidates[0];

  const { res, parsed, error } = await fetchSitemapDoc(chosen.url, deps);
  const snap: SitemapSnapshot = {
    url: chosen.url,
    via: chosen.via,
    fetchedAt: deps.now().toISOString(),
    status: res?.status ?? null,
    contentType: res?.contentType ?? "",
    error,
    kind: parsed?.kind ?? null,
    errors: parsed?.errors ?? [],
    urls: [],
    urlCount: 0,
    children: [],
  };
  const locs: string[] = [];
  if (parsed?.kind === "sitemapindex") {
    for (const child of parsed.locs.slice(0, LIMITS.sitemapChildren)) {
      const c = await fetchSitemapDoc(child, deps);
      snap.children.push({ url: child, status: c.res?.status ?? null, errors: c.parsed?.errors ?? [], urlCount: c.parsed?.locs.length ?? 0, error: c.error });
      if (c.parsed?.kind === "urlset") locs.push(...c.parsed.locs);
    }
    if (parsed.locs.length > LIMITS.sitemapChildren) {
      note(s.audit, { code: "sitemap_unavailable", message: `The sitemap index lists ${parsed.locs.length} sitemaps; only the first ${LIMITS.sitemapChildren} were read.` });
    }
  } else if (parsed?.kind === "urlset") {
    locs.push(...parsed.locs);
  }
  const normalized = [...new Set(locs.map((l) => normalizePageUrl(l)).filter((u): u is string => !!u))];
  snap.urlCount = normalized.length;
  snap.urls = normalized.slice(0, LIMITS.storedSitemapUrls);
  s.audit.sitemap = snap;

  if (config.mode === "sitemap") {
    if (!parsed) {
      note(s.audit, { code: "sitemap_unavailable", message: `The sitemap ${chosen.url} could not be read, so there were no URLs to audit.` });
    }
    const seen = new Set(s.audit.seen);
    for (const url of normalized) {
      if (s.audit.queue.length + s.blob.snapshots.length >= config.maxPages) break;
      if (!isInternal(url, s.site.origin) || seen.has(url)) continue;
      seen.add(url);
      s.audit.queue.push({ url, depth: 0, via: "sitemap" });
    }
    const internalCount = normalized.filter((u) => isInternal(u, s.site.origin)).length;
    if (internalCount > config.maxPages) {
      note(s.audit, { code: "page_limit", message: `The sitemap lists ${internalCount} URLs; this audit's page limit is ${config.maxPages}.` });
    }
    s.audit.seen = [...seen];
  }
  s.audit.phase = "pages";
}

function note(audit: AuditRun, n: CoverageNote) {
  const existing = audit.coverage.findIndex((c) => c.code === n.code);
  if (existing >= 0) audit.coverage[existing] = n;
  else audit.coverage.push(n);
}

const SUMMARY_RULES = [titleRule, metaDescriptionRule, headingsRule, canonicalRule, indexabilityRule, contentRule];

function summarize(html: string | null, pageUrl: string, headers: Record<string, string>, audit: AuditRun): PageSnapshot["summary"] {
  const empty = { title: null, description: null, h1: null, wordCount: null, noindex: null, canonical: null, canonicalSelf: null };
  if (html === null) return empty;
  const results = runRules({ html, pageUrl, headers }, {}, { config: audit.ruleConfig, rules: SUMMARY_RULES as never });
  const f = Object.assign({}, ...results.map((r) => r.facts)) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    title: s(f.titleText),
    description: s(f.descriptionText),
    h1: s(f.h1Text),
    wordCount: typeof f.wordCount === "number" ? f.wordCount : null,
    noindex: f.metaNoindex === true || f.headerNoindex === true,
    canonical: s(f.canonicalResolved),
    canonicalSelf: f.canonicalCount === 0 ? null : f.canonicalSelf === true,
  };
}

function buildSnapshot(s: StepState, item: QueueItem, result: { res: FetchResult } | { error: { code: string; message: string } }, fetchedAt: string): PageSnapshot {
  const { audit, site } = s;
  const base = { auditId: audit.id, url: item.url, depth: item.depth, via: item.via, fetchedAt };
  if ("error" in result) {
    return {
      ...base,
      finalUrl: item.url,
      outcome: "fetch_failed",
      status: null,
      redirectChain: [],
      contentType: "",
      bytes: 0,
      truncated: false,
      elapsedMs: null,
      error: result.error,
      expectations: expectationsFor(s.intents, item.url),
      rules: [],
      links: null,
      summary: summarize(null, item.url, {}, audit),
    };
  }
  const { res } = result;
  const finalUrl = normalizePageUrl(res.finalUrl) ?? res.finalUrl;
  const exp = expectationsFor(s.intents, item.url, finalUrl);
  const response = { requestedUrl: item.url, finalUrl, status: res.status, redirectChain: res.redirectChain, contentType: res.contentType };
  const alreadyInspected = s.blob.snapshots.some((p) => p.outcome === "inspected" && p.finalUrl === finalUrl);

  let outcome: PageSnapshot["outcome"];
  if (!isInternal(finalUrl, site.origin)) outcome = "external_redirect";
  else if (res.status >= 400) outcome = "http_error";
  else if (res.status >= 300) outcome = "http_error"; // a 3xx without a usable Location header
  else if (!res.contentTypeAccepted) outcome = "non_html";
  else if (alreadyInspected) outcome = "redirect_duplicate";
  else outcome = "inspected";

  const html = outcome === "inspected" ? res.body : null;
  const rules = runRules({ html, pageUrl: finalUrl, headers: res.headers, response }, exp, { config: audit.ruleConfig, categories: audit.config.categories });
  return {
    ...base,
    finalUrl,
    outcome,
    status: res.status,
    redirectChain: res.redirectChain,
    contentType: res.contentType,
    bytes: res.bytes,
    truncated: res.truncated,
    elapsedMs: res.elapsedMs,
    expectations: exp,
    rules,
    links: html !== null ? extractLinks(parseHtml(html), finalUrl, site.origin) : null,
    summary: summarize(html, finalUrl, res.headers, audit),
  };
}

function robotsBlocked(s: StepState, url: string): string | null {
  if (!s.robots) return null;
  const d = isAllowed(s.robots, ROBOTS_TOKEN, url);
  return d.allowed ? null : (d.matchedRule ?? "Disallow");
}

async function doPagesBatch(s: StepState, deps: Deps): Promise<void> {
  const { audit } = s;
  const remaining = audit.config.maxPages - s.blob.snapshots.length;
  if (audit.queue.length === 0 || remaining <= 0) {
    if (audit.queue.length > 0) {
      note(audit, { code: "page_limit", message: `Stopped at the page limit of ${audit.config.maxPages}; ${audit.queue.length} discovered URL(s) were not audited.` });
      if (depthOf(audit.config) > 0) note(audit, { code: "graph_incomplete", message: "The link graph is incomplete, so orphan candidates and inbound link counts were not computed." });
    }
    audit.phase = audit.config.checkLinks ? "links" : "finalize";
    return;
  }
  const batch = audit.queue.splice(0, Math.min(LIMITS.concurrency, remaining));
  const fetchedAt = deps.now().toISOString();
  const results = await Promise.all(
    batch.map(async (item) => {
      const blocked = robotsBlocked(s, item.url);
      if (blocked) return { item, blocked };
      try {
        return { item, res: await deps.fetch(item.url, { accept: "html" }) };
      } catch (e) {
        return { item, error: errOf(e) };
      }
    }),
  );

  const seen = new Set(audit.seen);
  // Traversal is disabled when robots.txt could not be read.
  const maxDepth = audit.robots?.outcome === "error" ? 0 : depthOf(audit.config);
  for (const r of results) {
    let snap: PageSnapshot;
    if ("blocked" in r && r.blocked) {
      snap = {
        auditId: audit.id,
        url: r.item.url,
        finalUrl: r.item.url,
        depth: r.item.depth,
        via: r.item.via,
        fetchedAt,
        outcome: "robots_blocked",
        status: null,
        redirectChain: [],
        contentType: "",
        bytes: 0,
        truncated: false,
        elapsedMs: null,
        robotsRule: r.blocked,
        expectations: expectationsFor(s.intents, r.item.url),
        rules: [],
        links: null,
        summary: summarize(null, r.item.url, {}, audit),
      };
      audit.progress.skipped++;
    } else {
      snap = buildSnapshot(s, r.item, "res" in r && r.res ? { res: r.res } : { error: (r as { error: { code: string; message: string } }).error }, fetchedAt);
      if (snap.outcome === "fetch_failed") audit.progress.failed++;
      if (snap.outcome === "inspected") audit.progress.inspected++;
    }
    s.blob.snapshots = s.blob.snapshots.filter((p) => p.url !== snap.url);
    s.blob.snapshots.push(snap);
    seen.add(snap.finalUrl);

    if (snap.links && r.item.depth < maxDepth) {
      for (const target of snap.links.internal) {
        if (seen.has(target)) continue;
        if (snap.links.nofollowInternal.includes(target)) continue;
        seen.add(target);
        audit.queue.push({ url: target, depth: r.item.depth + 1, via: "link" });
      }
    } else if (snap.links && r.item.depth >= maxDepth && depthOf(audit.config) > 0) {
      const beyond = snap.links.internal.filter((t) => !seen.has(t)).length;
      if (beyond) note(audit, { code: "depth_limit", message: `Some links were not followed because they are deeper than ${depthOf(audit.config)} click(s) from the start URLs.` });
    }
  }
  audit.seen = [...seen];
  audit.progress.done = s.blob.snapshots.length;
  audit.progress.planned = Math.min(audit.config.maxPages, s.blob.snapshots.length + audit.queue.length);
}

function buildLinkQueue(s: StepState) {
  const { audit, blob } = s;
  const known = new Set(blob.snapshots.flatMap((p) => [p.url, p.finalUrl]));
  const inbound = new Map<string, { kind: "link" | "image"; n: number }>();
  for (const p of blob.snapshots) {
    if (!p.links) continue;
    for (const t of p.links.internal) if (!known.has(t)) inbound.set(t, { kind: "link", n: (inbound.get(t)?.n ?? 0) + 1 });
    for (const t of p.links.images) if (!known.has(t)) inbound.set(t, { kind: "image", n: (inbound.get(t)?.n ?? 0) + 1 });
  }
  const sitemapExtra = (audit.sitemap?.urls ?? []).filter((u) => !known.has(u) && !inbound.has(u) && isInternal(u, s.site.origin));
  const ordered = [
    ...[...inbound.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0])).map(([url, v]) => ({ url, kind: v.kind })),
    ...sitemapExtra.map((url) => ({ url, kind: "link" as const })),
  ].filter((t) => !robotsBlocked(s, t.url));
  audit.linkQueue = ordered.slice(0, LIMITS.linkChecks);
  if (ordered.length > LIMITS.linkChecks) {
    note(audit, { code: "link_check_limit", message: `${ordered.length} uncrawled link, image and sitemap targets were found; the first ${LIMITS.linkChecks} were status-checked.` });
  }
  audit.linkQueueBuilt = true;
}

async function doLinksBatch(s: StepState, deps: Deps) {
  const { audit } = s;
  if (!audit.linkQueueBuilt) buildLinkQueue(s);
  if (audit.linkQueue.length === 0) {
    audit.phase = "finalize";
    return;
  }
  const batch = audit.linkQueue.splice(0, LIMITS.concurrency);
  const checkedAt = deps.now().toISOString();
  const results = await Promise.all(
    batch.map(async (t): Promise<LinkCheck> => {
      try {
        const res = await deps.fetch(t.url, { accept: "status" });
        return { url: t.url, kind: t.kind, status: res.status, finalUrl: normalizePageUrl(res.finalUrl) ?? res.finalUrl, redirectCount: res.redirectChain.length, checkedAt };
      } catch (e) {
        return { url: t.url, kind: t.kind, status: null, finalUrl: null, redirectCount: 0, error: errOf(e), checkedAt };
      }
    }),
  );
  for (const r of results) audit.linkChecks[r.url] = r;
  audit.progress.linksChecked = Object.keys(audit.linkChecks).length;
}

function finalize(s: StepState, deps: Deps, cancelled: boolean) {
  const { audit, blob } = s;
  if (cancelled) note(audit, { code: "cancelled", message: "The audit was cancelled; results cover only the URLs fetched before cancelling." });
  if (cancelled && depthOf(audit.config) > 0) note(audit, { code: "graph_incomplete", message: "The link graph is incomplete, so orphan candidates were not computed." });
  const truncated = blob.snapshots.filter((p) => p.truncated).length;
  if (truncated) note(audit, { code: "truncated", message: `${truncated} page(s) exceeded the 2 MB limit and were only partially read.` });

  const graphComplete = depthOf(audit.config) > 0 && !audit.coverage.some((c) => ["page_limit", "graph_incomplete", "cancelled", "robots_error"].includes(c.code));
  blob.findings = analyzeAudit({
    auditId: audit.id,
    origin: s.site.origin,
    pages: blob.snapshots,
    linkChecks: audit.linkChecks,
    robots: audit.robots,
    sitemap: audit.sitemap,
    intents: s.intents,
    config: audit.ruleConfig,
    categories: audit.config.categories,
    severityOverrides: s.severityOverrides,
    graphComplete,
    maxDepth: depthOf(audit.config),
  });
  audit.findingCounts = countBySeverity(blob.findings);
  const fetched = blob.snapshots.filter((p) => p.status !== null).length;
  const failed = blob.snapshots.filter((p) => p.outcome === "fetch_failed").length;
  if (cancelled) audit.status = "cancelled";
  else if (blob.snapshots.length > 0 && fetched === 0) {
    audit.status = "failed";
    const first = blob.snapshots.find((p) => p.error)?.error;
    audit.error = { code: "NO_PAGES", message: `None of the ${blob.snapshots.length} URL(s) could be fetched${first ? `: ${first.message}` : ""}.` };
  } else if (blob.snapshots.length === 0) {
    audit.status = "failed";
    audit.error = { code: "NO_PAGES", message: audit.config.mode === "sitemap" ? "The sitemap provided no URLs on this site to audit." : "No URLs were audited." };
  } else if (failed > 0 || audit.coverage.some((c) => ["page_limit", "robots_error", "truncated", "link_check_limit", "sitemap_unavailable"].includes(c.code)) || clampCut(audit)) {
    audit.status = "partial";
  } else audit.status = "completed";
  audit.queue = [];
  audit.linkQueue = [];
  audit.phase = "done";
  audit.finishedAt = deps.now().toISOString();
}

/**
 * Do up to `budgetMs` of crawl work and persist it. Returns the updated run. Safe to call repeatedly;
 * concurrent calls for the same audit return immediately while another step holds the lease.
 */
export async function stepAudit(auditId: string, deps: Deps, opts: { budgetMs?: number } = {}): Promise<{ audit: AuditRun; busy: boolean }> {
  const clock = deps.clockMs ?? Date.now;
  const leaseUntil = new Date(deps.now().getTime() + LIMITS.leaseMs).toISOString();
  const acquired = await deps.store.update((d) => {
    const a = d.audits[auditId];
    if (!a) throw new WorkflowError("NOT_FOUND", "Audit not found.");
    if (a.status !== "running") return { audit: a, busy: false, got: false };
    if (a.leaseUntil && Date.parse(a.leaseUntil) > deps.now().getTime()) return { audit: a, busy: true, got: false };
    a.leaseUntil = leaseUntil;
    return { audit: a, busy: false, got: true };
  });
  if (!acquired.got) return { audit: acquired.audit, busy: acquired.busy };

  const data = await deps.store.read();
  const site = data.sites[acquired.audit.siteId];
  const s: StepState = {
    audit: acquired.audit,
    site,
    blob: await deps.store.readAudit(auditId),
    intents: intentsFor(data, acquired.audit.siteId),
    robots: acquired.audit.robots?.outcome === "ok" ? parseRobots(acquired.audit.robots.body) : null,
    severityOverrides: data.settings.severityOverrides,
  };

  const deadline = clock() + (opts.budgetMs ?? LIMITS.stepBudgetMs);
  let cancelled = false;
  try {
    while (s.audit.phase !== "done") {
      const fresh = (await deps.store.read()).audits[auditId];
      if (fresh?.cancelRequested) {
        cancelled = true;
        finalize(s, deps, true);
        break;
      }
      if (s.audit.phase === "robots") await doRobots(s, deps);
      else if (s.audit.phase === "sitemap") await doSitemap(s, deps);
      else if (s.audit.phase === "pages") await doPagesBatch(s, deps);
      else if (s.audit.phase === "links") await doLinksBatch(s, deps);
      else if (s.audit.phase === "finalize") finalize(s, deps, false);
      if (clock() >= deadline) break;
    }
  } catch (e) {
    // An unexpected failure must not corrupt earlier results: record it and keep what was collected.
    s.audit.status = "failed";
    s.audit.phase = "done";
    s.audit.error = { code: "INTERNAL", message: `The audit stopped unexpectedly: ${(e as Error)?.message ?? "error"}` };
    s.audit.finishedAt = deps.now().toISOString();
    console.error(`[site-sentry] audit ${auditId} failed`, (e as Error)?.message);
  }

  await deps.store.writeAudit(auditId, s.blob);
  const saved = await deps.store.update((d) => {
    const current = d.audits[auditId];
    const next: AuditRun = { ...s.audit, leaseUntil: null, heartbeatAt: deps.now().toISOString(), cancelRequested: current?.cancelRequested ?? cancelled };
    d.audits[auditId] = next;
    if (next.phase === "done" && next.status !== "failed") flagRegressions(d, next, s.blob);
    return next;
  });
  return { audit: saved, busy: false };
}

/** Reopen resolved tasks whose findings were detected again by this audit. */
function flagRegressions(d: StoreData, audit: AuditRun, blob: AuditBlob) {
  const present = new Map(blob.findings.map((f) => [f.fingerprint, f]));
  for (const task of Object.values(d.tasks)) {
    if (task.siteId !== audit.siteId || task.workflowStatus !== "resolved") continue;
    const back = task.items.filter((i) => present.has(i.fingerprint));
    if (!back.length) continue;
    task.history.push({ at: audit.finishedAt!, kind: "regression", from: "resolved", to: "open", note: `Detected again by audit ${audit.id} (${back.length} of ${task.items.length} item(s)).` });
    task.workflowStatus = "open";
    task.updatedAt = audit.finishedAt!;
  }
}

/** Request cancellation. A step in progress finalises at its next checkpoint; otherwise this finalises now. */
export async function cancelAudit(auditId: string, deps: Deps): Promise<AuditRun> {
  const a = await deps.store.update((d) => {
    const audit = d.audits[auditId];
    if (!audit) throw new WorkflowError("NOT_FOUND", "Audit not found.");
    if (audit.status === "running") audit.cancelRequested = true;
    return audit;
  });
  if (a.status !== "running") return a;
  // If no step holds the lease, run a step now: it sees cancelRequested and finalises.
  return (await stepAudit(auditId, deps, { budgetMs: 0 })).audit;
}

/** Drive an audit to completion in-process (tests, sample seeding, CLI). */
export async function runAuditToCompletion(auditId: string, deps: Deps, maxSteps = 500): Promise<AuditRun> {
  for (let i = 0; i < maxSteps; i++) {
    const { audit, busy } = await stepAudit(auditId, deps, { budgetMs: 60_000 });
    if (audit.status !== "running") return audit;
    if (busy) throw new WorkflowError("BUSY", "Another step is running for this audit.");
  }
  throw new Error("Audit did not finish within the step limit.");
}

export function describeConfig(config: AuditConfig): string[] {
  const lines: string[] = [];
  if (config.mode === "single") lines.push(`1 URL: ${config.urls[0]}`);
  else if (config.mode === "list") lines.push(`${config.urls.length} listed URL(s)`);
  else lines.push(`URLs from the sitemap${config.sitemapUrl ? ` ${config.sitemapUrl}` : " (robots.txt declaration, else /sitemap.xml)"}`);
  if (config.includeImportant) lines.push("Plus the site's important URLs");
  if (config.profile) lines.push(`${PROFILES[config.profile].label} profile: ${describeLimits(config.maxPages, config.maxDepth)}`);
  lines.push(config.maxDepth === null ? "Follow internal links with no depth limit" : config.maxDepth > 0 ? `Follow internal links up to ${config.maxDepth} click(s) deep` : "Do not follow links");
  lines.push(`At most ${config.maxPages} pages`);
  if (config.checkLinks) lines.push(`Status-check up to ${LIMITS.linkChecks} uncrawled internal link and image targets`);
  lines.push("Read robots.txt first and skip URLs it disallows for SiteSentryBot");
  return lines;
}

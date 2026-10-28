// Server-only read models. All SEO logic lives in src/lib/audit; this file only assembles views.
import "server-only";
import { CHECKS } from "../audit/catalog";
import { compareAudits } from "../audit/compare";
import { groupIssues } from "../audit/groups";
import { countIssueTypes, healthScore } from "../audit/health";
import { buildIssues, finishedAudits, type AuditBundle, type Issue } from "../audit/issues";
import type { AuditFinding } from "../audit/types";
import { describeConfig, isStale } from "../crawl/engine";
import { crawlerV2Enabled } from "../crawl/v2/flag";
import { secretKey } from "../crawl/v2/secrets";
import type { AuditRun, FixTask, PageSnapshot, Workspace } from "../model";
import type { Store, StoreData } from "../store/store";
import { WorkflowError } from "../workflow/deps";
import { isActive } from "../workflow/tasks";
import { allowedHosts, dataIsEphemeral, getStore, liveScansEnabled } from "../workspace";
import {
  emptyCounts,
  type ActionItem,
  type IssueGroupRow,
  type AuditDetail,
  type AuditSummary,
  type ComparisonData,
  type IssueDetail,
  type IssueRow,
  type OverviewData,
  type SettingsData,
  type SiteDetail,
  type SiteRow,
  type SlimSnapshot,
  type TaskRow,
} from "../views";

const FINISHED = new Set(["completed", "partial", "cancelled"]);

export function summarize(a: AuditRun, data: StoreData, now = new Date()): AuditSummary {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { queue, seen, linkQueue, linkChecks, robots, sitemap, ...rest } = a;
  return { ...rest, siteName: data.sites[a.siteId]?.name ?? "Deleted site", stale: isStale(a, now) };
}

export function slim(p: PageSnapshot): SlimSnapshot {
  const { rules, links, ...rest } = p;
  return {
    ...rest,
    ruleStatus: rules.map((r) => ({ ruleId: r.ruleId, name: r.name, status: r.status, missingExpectations: r.missingExpectations })),
    outLinks: links ? links.internal.length + links.externalCount : null,
  };
}

const byStartDesc = (a: AuditRun, b: AuditRun) => b.startedAt.localeCompare(a.startedAt);

async function bundlesFor(store: Store, data: StoreData, siteId: string): Promise<AuditBundle[]> {
  const audits = Object.values(data.audits).filter((a) => a.siteId === siteId && FINISHED.has(a.status));
  return Promise.all(
    audits.map(async (audit) => {
      const blob = await store.readAudit(audit.id);
      return { audit, pages: blob.snapshots, findings: blob.findings };
    }),
  );
}

function activeTaskIndex(data: StoreData) {
  const idx = new Map<string, FixTask>();
  const tasks = Object.values(data.tasks).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // Prefer an active task; fall back to the most recent closed one so the issue still links somewhere.
  for (const t of tasks) if (isActive(t)) for (const i of t.items) if (!idx.has(i.fingerprint)) idx.set(i.fingerprint, t);
  for (const t of tasks) for (const i of t.items) if (!idx.has(i.fingerprint)) idx.set(i.fingerprint, t);
  return idx;
}

function issueRow(i: Issue, data: StoreData, tasks: Map<string, FixTask>): IssueRow {
  const t = tasks.get(i.fingerprint);
  return {
    fingerprint: i.fingerprint,
    siteId: i.siteId,
    siteName: data.sites[i.siteId]?.name ?? "",
    state: i.state,
    stale: i.stale,
    firstSeenAt: i.firstSeenAt,
    lastSeenAt: i.lastSeenAt,
    lastSeenAuditId: i.lastSeenAuditId,
    resolvedAt: i.resolvedAt,
    regressedAt: i.regressedAt,
    finding: i.latest,
    task: t ? { id: t.id, title: t.title, workflowStatus: t.workflowStatus, verificationStatus: t.verificationStatus } : null,
  };
}

export async function siteIssues(store: Store, data: StoreData, siteId: string) {
  const bundles = await bundlesFor(store, data, siteId);
  return { bundles, issues: buildIssues(siteId, bundles) };
}

function latestPair(bundles: AuditBundle[]) {
  const done = finishedAudits(bundles);
  return { head: done.at(-1) ?? null, base: done.at(-2) ?? null };
}

export async function getOverview(ws: Workspace): Promise<OverviewData> {
  const store = getStore(ws);
  const data = await store.read();
  const now = new Date();
  const tasks = activeTaskIndex(data);
  const sites: SiteRow[] = [];
  const open = emptyCounts();
  let openTotal = 0;
  let resolvedTotal = 0;
  let pagesInspected = 0;
  let since: OverviewData["totals"]["sinceLast"] = null;
  const actions: ActionItem[] = [];
  const groups: IssueGroupRow[] = [];

  for (const site of Object.values(data.sites).sort((a, b) => a.name.localeCompare(b.name))) {
    const { bundles, issues } = await siteIssues(store, data, site.id);
    const siteOpen = emptyCounts();
    for (const i of issues) {
      if (i.state === "open") siteOpen[i.latest.priority.severity]++;
      if (i.state === "resolved") resolvedTotal++;
    }
    const n = siteOpen.high + siteOpen.medium + siteOpen.low;
    for (const k of ["high", "medium", "low"] as const) open[k] += siteOpen[k];
    openTotal += n;

    const audits = Object.values(data.audits).filter((a) => a.siteId === site.id).sort(byStartDesc);
    const running = audits.find((a) => a.status === "running");
    const last = audits.find((a) => a.status !== "running");
    const { head, base } = latestPair(bundles);
    if (head) pagesInspected += head.audit.progress.inspected;
    if (head && base) {
      const c = compareAudits({ audit: base.audit, pages: base.pages, findings: base.findings }, { audit: head.audit, pages: head.pages, findings: head.findings });
      since ??= { regression: 0, firstDetected: 0, resolved: 0, notRechecked: 0, comparedSites: 0, narrowerBaselineSites: [] };
      since.regression += c.counts.regression;
      since.firstDetected += c.counts.new;
      since.resolved += c.counts.resolved;
      since.notRechecked += c.counts.not_rechecked;
      since.comparedSites++;
      const baseCats = new Set(base.audit.config.categories);
      if (c.newCoverage.length || head.audit.config.categories.some((k) => !baseCats.has(k))) since.narrowerBaselineSites.push(site.name);
    }
    const openRows = issues.filter((i) => i.state === "open").map((i) => issueRow(i, data, tasks));
    const openTypes = countIssueTypes(openRows.map((r) => r.finding));
    for (const g of groupIssues(openRows)) {
      groups.push({
        siteId: site.id,
        siteName: site.name,
        ruleCode: g.ruleCode,
        title: g.title,
        category: g.category,
        kind: g.kind,
        certainty: g.certainty,
        severity: g.severity,
        priority: g.priority,
        instances: g.instances.length,
        pages: g.pages.length,
        samplePages: g.pages.slice(0, 5),
        withActiveTask: g.withActiveTask,
        fingerprint: g.instances.length === 1 ? g.instances[0].fingerprint : null,
      });
    }
    const siteTasks = Object.values(data.tasks).filter((t) => t.siteId === site.id);
    sites.push({
      site,
      importantUrls: Object.values(data.pages).filter((p) => p.siteId === site.id).length,
      lastAudit: last ? summarize(last, data, now) : null,
      runningAudit: running ? summarize(running, data, now) : null,
      open: siteOpen,
      openTotal: n,
      openTypes,
      health: head ? healthScore(openTypes) : null,
      activeTasks: siteTasks.filter(isActive).length,
    });

    if (running) {
      actions.push({
        kind: "resume",
        title: isStale(running, now) ? "Resume interrupted audit" : "Audit in progress",
        detail: `${running.progress.done} of ${running.progress.planned} pages processed`,
        href: `/${ws}/audits/${running.id}`,
        siteName: site.name,
      });
    }
    if (audits.length === 0) {
      actions.push({ kind: "configure", title: "Run the first audit", detail: site.origin, href: `/${ws}/audits/new?site=${site.id}`, siteName: site.name });
    }
  }

  for (const t of Object.values(data.tasks).filter((x) => x.workflowStatus === "ready_to_verify")) {
    actions.push({ kind: "verify", title: t.title, detail: `Ready to verify · ${t.items.length} item(s)`, href: `/${ws}/tasks/${t.id}`, siteName: data.sites[t.siteId]?.name ?? "" });
  }
  const order = { resume: 0, verify: 1, fix: 2, configure: 3 } as const;
  actions.sort((a, b) => order[a.kind] - order[b.kind] || (a.priority ?? 9) - (b.priority ?? 9));

  const all = Object.values(data.audits);
  const allTasks = Object.values(data.tasks);
  groups.sort((a, b) => a.priority - b.priority || b.instances - a.instances || a.title.localeCompare(b.title));
  return {
    workspace: ws,
    sites,
    totals: {
      sites: sites.length,
      auditsFinished: all.filter((a) => FINISHED.has(a.status)).length,
      open,
      openTotal,
      openGroups: groups.length,
      pagesInspected,
      sinceLast: since,
      resolvedTotal,
      verifiedTasks: allTasks.filter((t) => t.verificationStatus === "passing").length,
      tasksActive: allTasks.filter(isActive).length,
      tasksReady: allTasks.filter((t) => t.workflowStatus === "ready_to_verify").length,
    },
    groups,
    actions: actions.slice(0, 8),
    recentAudits: all.sort(byStartDesc).slice(0, 6).map((a) => summarize(a, data, now)),
  };
}

export async function listAudits(ws: Workspace, siteId?: string): Promise<AuditSummary[]> {
  const data = await getStore(ws).read();
  const now = new Date();
  return Object.values(data.audits)
    .filter((a) => !siteId || a.siteId === siteId)
    .sort(byStartDesc)
    .map((a) => summarize(a, data, now));
}

function previousFinished(data: StoreData, audit: AuditRun): AuditRun | null {
  return (
    Object.values(data.audits)
      .filter((a) => a.siteId === audit.siteId && a.id !== audit.id && FINISHED.has(a.status) && a.startedAt < audit.startedAt)
      .sort(byStartDesc)[0] ?? null
  );
}

export async function getAuditDetail(ws: Workspace, id: string): Promise<AuditDetail> {
  const store = getStore(ws);
  const data = await store.read();
  const audit = data.audits[id];
  if (!audit) throw new WorkflowError("NOT_FOUND", "Audit not found.");
  const site = data.sites[audit.siteId];
  if (!site) throw new WorkflowError("NOT_FOUND", "This audit's site was deleted.");
  const blob = await store.readAudit(id);
  const prev = previousFinished(data, audit);
  let changes: AuditDetail["changes"] = null;
  let gone: AuditDetail["gone"] = null;
  if (prev && FINISHED.has(audit.status)) {
    const pb = await store.readAudit(prev.id);
    const c = compareAudits({ audit: prev, pages: pb.snapshots, findings: pb.findings }, { audit, pages: blob.snapshots, findings: blob.findings });
    changes = Object.fromEntries(c.entries.filter((e) => e.head).map((e) => [e.fingerprint, e.kind]));
    gone = { resolved: c.counts.resolved, notRechecked: c.counts.not_rechecked };
  }
  const tasks = activeTaskIndex(data);
  const tasksByFingerprint: AuditDetail["tasksByFingerprint"] = {};
  for (const f of blob.findings) {
    const t = tasks.get(f.fingerprint);
    if (t) tasksByFingerprint[f.fingerprint] = { id: t.id, title: t.title, workflowStatus: t.workflowStatus };
  }
  const now = new Date();
  return {
    audit: summarize(audit, data, now),
    site,
    configLines: describeConfig(audit.config),
    pages: blob.snapshots.map(slim),
    findings: blob.findings,
    robots: audit.robots,
    sitemap: audit.sitemap ? (({ urls, ...s }) => (void urls, s))(audit.sitemap) : null,
    linkChecks: Object.values(audit.linkChecks),
    previous: prev ? summarize(prev, data, now) : null,
    changes,
    gone,
    tasksByFingerprint,
  };
}

export async function getComparison(ws: Workspace, headId: string, baseId?: string): Promise<ComparisonData> {
  const store = getStore(ws);
  const data = await store.read();
  const head = data.audits[headId];
  if (!head) throw new WorkflowError("NOT_FOUND", "Audit not found.");
  if (!FINISHED.has(head.status)) throw new WorkflowError("INVALID", "Only finished audits can be compared.");
  const candidates = Object.values(data.audits)
    .filter((a) => a.siteId === head.siteId && a.id !== head.id && FINISHED.has(a.status))
    .sort(byStartDesc);
  const base = baseId ? data.audits[baseId] : previousFinished(data, head);
  if (!base) throw new WorkflowError("NOT_FOUND", candidates.length ? "Comparison audit not found." : "This site has no other finished audit to compare with yet.");
  if (base.siteId !== head.siteId) throw new WorkflowError("INVALID", "Both audits must belong to the same site.");
  if (!FINISHED.has(base.status)) throw new WorkflowError("INVALID", "Only finished audits can be compared.");
  const [bb, hb] = await Promise.all([store.readAudit(base.id), store.readAudit(head.id)]);
  // Always compare older → newer, whichever order the user picked.
  const [older, newer, ob, nb] = base.startedAt <= head.startedAt ? [base, head, bb, hb] : [head, base, hb, bb];
  const comparison = compareAudits({ audit: older, pages: ob.snapshots, findings: ob.findings }, { audit: newer, pages: nb.snapshots, findings: nb.findings });
  const now = new Date();
  return {
    base: summarize(older, data, now),
    head: summarize(newer, data, now),
    site: data.sites[head.siteId],
    comparison,
    candidates: [head, ...candidates].sort(byStartDesc).map((a) => summarize(a, data, now)),
  };
}

export async function listIssues(ws: Workspace, siteId?: string): Promise<IssueRow[]> {
  const store = getStore(ws);
  const data = await store.read();
  const tasks = activeTaskIndex(data);
  const rows: IssueRow[] = [];
  for (const site of Object.values(data.sites)) {
    if (siteId && site.id !== siteId) continue;
    const { issues } = await siteIssues(store, data, site.id);
    rows.push(...issues.map((i) => issueRow(i, data, tasks)));
  }
  return rows;
}

export async function getIssue(ws: Workspace, siteId: string, fingerprint: string): Promise<IssueDetail> {
  const store = getStore(ws);
  const data = await store.read();
  if (!data.sites[siteId]) throw new WorkflowError("NOT_FOUND", "Site not found.");
  const { bundles, issues } = await siteIssues(store, data, siteId);
  const issue = issues.find((i) => i.fingerprint === fingerprint);
  if (!issue) throw new WorkflowError("NOT_FOUND", "Issue not found on this site.");
  const tasks = activeTaskIndex(data);
  const f = issue.latest;
  const lastBundle = bundles.find((b) => b.audit.id === issue.lastSeenAuditId);
  const snap = lastBundle?.pages.find((p) => p.finalUrl === f.pageUrl || p.url === f.pageUrl) ?? null;
  const related = issues
    .filter((i) => i.fingerprint !== fingerprint && (i.latest.pageUrl === f.pageUrl || i.latest.ruleCode === f.ruleCode))
    .slice(0, 8)
    .map((i) => issueRow(i, data, tasks));
  return {
    ...issueRow(issue, data, tasks),
    history: issue.history,
    related,
    snapshot: snap ? slim(snap) : null,
    tasks: Object.values(data.tasks)
      .filter((t) => t.items.some((i) => i.fingerprint === fingerprint))
      .map((t) => ({ id: t.id, title: t.title, workflowStatus: t.workflowStatus, verificationStatus: t.verificationStatus, verifications: t.verifications })),
  };
}

export async function getSiteDetail(ws: Workspace, siteId: string): Promise<SiteDetail> {
  const store = getStore(ws);
  const data = await store.read();
  const site = data.sites[siteId];
  if (!site) throw new WorkflowError("NOT_FOUND", "Site not found.");
  const { issues } = await siteIssues(store, data, siteId);
  const tasks = activeTaskIndex(data);
  const open = emptyCounts();
  for (const i of issues) if (i.state === "open") open[i.latest.priority.severity]++;
  const siteTasks = Object.values(data.tasks).filter((t) => t.siteId === siteId);
  const now = new Date();
  return {
    site,
    pages: Object.values(data.pages)
      .filter((p) => p.siteId === siteId)
      .sort((a, b) => a.url.localeCompare(b.url)),
    audits: Object.values(data.audits)
      .filter((a) => a.siteId === siteId)
      .sort(byStartDesc)
      .map((a) => summarize(a, data, now)),
    open,
    openTotal: open.high + open.medium + open.low,
    resolvedTotal: issues.filter((i) => i.state === "resolved").length,
    tasks: { active: siteTasks.filter(isActive).length, ready: siteTasks.filter((t) => t.workflowStatus === "ready_to_verify").length },
    topIssues: issues
      .filter((i) => i.state === "open")
      .slice(0, 6)
      .map((i) => issueRow(i, data, tasks)),
  };
}

export async function listTasks(ws: Workspace): Promise<TaskRow[]> {
  const data = await getStore(ws).read();
  return Object.values(data.tasks)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((t) => ({ ...t, siteName: data.sites[t.siteId]?.name ?? "Deleted site", siteOrigin: data.sites[t.siteId]?.origin ?? "" }));
}

export async function getTask(ws: Workspace, id: string): Promise<TaskRow> {
  const data = await getStore(ws).read();
  const t = data.tasks[id];
  if (!t) throw new WorkflowError("NOT_FOUND", "Task not found.");
  return { ...t, siteName: data.sites[t.siteId]?.name ?? "Deleted site", siteOrigin: data.sites[t.siteId]?.origin ?? "" };
}

export async function getSettings(ws: Workspace): Promise<SettingsData> {
  const store = getStore(ws);
  const data = await store.read();
  return {
    workspace: ws,
    settings: data.settings,
    checks: CHECKS,
    sampleState: ws === "sample" ? (data.sampleState ?? "current") : null,
    storage: { persistent: store.persistent, ephemeral: dataIsEphemeral() },
    liveScans: { enabled: liveScansEnabled(), allowedHosts: allowedHosts() },
    crawler: { v2: crawlerV2Enabled(ws), basicAuth: crawlerV2Enabled(ws) && hasSecretKey() },
  };
}

function hasSecretKey(): boolean {
  try {
    return secretKey() !== null;
  } catch {
    return false; // set but malformed: basic auth would fail, so do not offer it
  }
}

export type { AuditFinding };

"use client";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, CircleAlert, CircleCheck, CircleDashed, CircleQuestionMark, Search, SearchX, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { groupIssues, type IssueGroup } from "@/lib/audit/groups";
import { RULE_CATEGORIES, type Certainty, type Severity } from "@/lib/audit/types";
import { SEVERITIES, type IssueDetail, type IssueRow } from "@/lib/views";
import { CriteriaList } from "../domain";
import { api, useApi } from "../lib/api";
import { fmtAgo, fmtDate, fmtDateTime, plural, shortUrl } from "../lib/format";
import { useToast } from "../overlays";
import { useWs } from "../shell/context";
import {
  Button,
  CertaintyBadge,
  EmptyState,
  ErrorState,
  ExternalUrl,
  Field,
  Input,
  LinkButton,
  Mono,
  Notice,
  PageHeader,
  PageSkeleton,
  Panel,
  SampleTag,
  Segmented,
  Select,
  SeverityBadge,
  Textarea,
  VerificationBadge,
  WorkflowBadge,
  cx,
} from "../ui";

export function IssueStateBadge({ row }: { row: Pick<IssueRow, "state" | "stale" | "regressedAt"> }) {
  if (row.state === "resolved")
    return <span className="inline-flex items-center gap-1 text-[13px] text-ok"><CircleCheck className="size-3.5" aria-hidden />Resolved</span>;
  if (row.stale)
    return <span className="inline-flex items-center gap-1 text-[13px] text-sev-medium" title="The latest audit did not re-examine this issue's scope"><CircleQuestionMark className="size-3.5" aria-hidden />Not re-checked</span>;
  if (row.regressedAt)
    return <span className="inline-flex items-center gap-1 text-[13px] text-sev-high"><CircleAlert className="size-3.5" aria-hidden />Regressed</span>;
  return <span className="inline-flex items-center gap-1 text-[13px] text-fg"><CircleDashed className="size-3.5 text-fg-3" aria-hidden />Open</span>;
}

type StateFilter = "open" | "resolved" | "all";
type ViewMode = "grouped" | "list";

const KIND_LABEL = { defect: "Defect", warning: "Warning", opportunity: "Improvement", observation: "Needs review" } as const;

function GroupedIssues({ groups, base, showSite, openAll }: { groups: IssueGroup<IssueRow>[]; base: string; showSite: boolean; openAll: boolean }) {
  return (
    <ul className="divide-y divide-line-subtle">
      {groups.map((g) => {
        const first = g.instances[0];
        return (
          <li key={g.key}>
            <details className="group/d" open={openAll || undefined}>
              <summary className="flex cursor-pointer list-none items-start gap-3 px-4 py-3 hover:bg-elevated sm:items-center [&::-webkit-details-marker]:hidden">
                <ChevronRight className="mt-0.5 size-4 shrink-0 text-fg-3 transition-transform group-open/d:rotate-90 sm:mt-0" aria-hidden />
                <span className="w-[112px] shrink-0"><SeverityBadge severity={g.severity} priority={g.priority} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-fg">{g.title}</span>
                  <span className="mt-0.5 flex flex-wrap gap-x-2 text-[13px] text-fg-3">
                    {showSite ? <><span>{first.siteName}</span><span aria-hidden>·</span></> : null}
                    <span className="font-medium text-fg-2">{plural(g.pages.length, "affected page")}</span>
                    <span aria-hidden>·</span>
                    <span>{KIND_LABEL[g.kind]}</span>
                    <span aria-hidden>·</span>
                    <Mono>{g.ruleCode}</Mono>
                  </span>
                </span>
                <span className="hidden shrink-0 text-xs text-fg-3 md:block">
                  {g.withActiveTask ? <span className="text-info">{g.withActiveTask} of {g.instances.length} in fix queue</span> : "No task yet"}
                </span>
              </summary>
              <div className="border-t border-line-subtle bg-bg px-4 py-3 sm:pl-11">
                <p className="mb-2 text-[13px] text-fg-2">{first.finding.why}</p>
                <ul className="divide-y divide-line-subtle overflow-hidden rounded-lg border border-line bg-surface">
                  {g.instances.map((i) => (
                    <li key={i.fingerprint}>
                      <Link href={`${base}/issues/${encodeURIComponent(i.fingerprint)}?site=${i.siteId}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 hover:bg-elevated">
                        <Mono className="min-w-0 flex-1 truncate text-fg">{i.finding.scope.kind === "page" ? shortUrl(i.finding.pageUrl) : i.finding.observed}</Mono>
                        <span className="hidden truncate text-[13px] text-fg-3 sm:inline sm:max-w-[40%]">{i.finding.observed}</span>
                        <IssueStateBadge row={i} />
                        {i.task ? <WorkflowBadge status={i.task.workflowStatus} /> : null}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          </li>
        );
      })}
    </ul>
  );
}

export function IssuesView() {
  const { ws, base, apiBase, sites } = useWs();
  const sp = useSearchParams();
  const router = useRouter();
  const site = sp.get("site") ?? "";
  const state = (sp.get("state") as StateFilter | null) ?? "open";
  const sev = (sp.get("severity") ?? "") as Severity | "";
  const cat = sp.get("category") ?? "";
  const taskF = sp.get("task") ?? "";
  const rule = sp.get("rule") ?? "";
  const view = (sp.get("view") as ViewMode | null) === "list" ? "list" : "grouped";
  const [q, setQ] = useState(sp.get("q") ?? "");
  const [selectedFps, setSelectedFps] = useState<Set<string>>(new Set());
  const { data, error, loading, reload } = useApi<IssueRow[]>(`${apiBase}/issues${site ? `?site=${site}` : ""}`);

  const set = (patch: Record<string, string>) => {
    const p = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v && !(k === "state" && v === "open") && !(k === "view" && v === "grouped")) p.set(k, v);
      else p.delete(k);
    }
    router.replace(`${base}/issues${p.size ? `?${p}` : ""}`, { scroll: false });
  };
  // Debounced search: edits the URL as it is when the timer fires, never a stale copy of it.
  useEffect(() => {
    const t = setTimeout(() => {
      const p = new URLSearchParams(window.location.search);
      if ((p.get("q") ?? "") === q) return;
      if (q) p.set("q", q);
      else p.delete("q");
      router.replace(`${base}/issues${p.size ? `?${p}` : ""}`, { scroll: false });
    }, 250);
    return () => clearTimeout(t);
  }, [q, base, router]);

  const counts = useMemo(() => ({ open: data?.filter((i) => i.state === "open").length ?? 0, resolved: data?.filter((i) => i.state === "resolved").length ?? 0, all: data?.length ?? 0 }), [data]);
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (data ?? []).filter(
      (i) =>
        (state === "all" || i.state === state) &&
        (!sev || i.finding.priority.severity === sev) &&
        (!cat || i.finding.category === cat) &&
        (!taskF || (taskF === "none" ? !i.task : !!i.task)) &&
        (!rule || i.finding.ruleCode === rule) &&
        (!t || `${i.finding.title} ${i.finding.ruleCode} ${i.finding.pageUrl} ${i.finding.observed}`.toLowerCase().includes(t)),
    );
  }, [data, state, sev, cat, taskF, rule, q]);
  const groups = useMemo(() => groupIssues(rows), [rows]);
  const filtered = !!(sev || cat || taskF || rule || q);
  const siteName = sites.data?.find((s) => s.site.id === site)?.site.name;

  const toggleSelectAll = () => {
    if (selectedFps.size === rows.length) {
      setSelectedFps(new Set());
    } else {
      setSelectedFps(new Set(rows.map((r) => r.fingerprint)));
    }
  };

  const toggleSelectOne = (fp: string) => {
    const next = new Set(selectedFps);
    if (next.has(fp)) next.delete(fp);
    else next.add(fp);
    setSelectedFps(next);
  };

  const exportIssues = (format: "csv" | "json") => {
    const exportData = rows.map((r) => ({
      fingerprint: r.fingerprint,
      title: r.finding.title,
      ruleCode: r.finding.ruleCode,
      severity: r.finding.priority.severity,
      priority: r.finding.priority.level,
      site: r.siteName,
      pageUrl: r.finding.pageUrl,
      observed: r.finding.observed,
      state: r.state,
      taskStatus: r.task?.workflowStatus ?? "none",
    }));

    if (format === "json") {
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `issues-${site || "all"}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } else {
      const headers = ["Title", "Rule", "Severity", "Priority", "Site", "URL", "Observed", "State", "Task"];
      const csvLines = [headers.join(",")];
      for (const row of exportData) {
        csvLines.push(
          [
            JSON.stringify(row.title),
            JSON.stringify(row.ruleCode),
            JSON.stringify(row.severity),
            JSON.stringify(row.priority),
            JSON.stringify(row.site),
            JSON.stringify(row.pageUrl),
            JSON.stringify(row.observed),
            JSON.stringify(row.state),
            JSON.stringify(row.taskStatus),
          ].join(",")
        );
      }
      const blob = new Blob([csvLines.join("\n")], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `issues-${site || "all"}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  const header = (
    <PageHeader
      crumbs={[{ label: "Issues" }]}
      title="Issues"
      description="Investigate findings from your website audits and prioritize the next fixes."
      meta={siteName ? <span className="text-[13px] text-fg-2">Site: <span className="text-fg">{siteName}</span></span> : undefined}
      actions={
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => exportIssues("csv")}>
            Export CSV
          </Button>
          <Button size="sm" variant="secondary" onClick={() => exportIssues("json")}>
            Export JSON
          </Button>
        </div>
      }
    />
  );
  if (error) return (<>{header}<ErrorState error={error} onRetry={reload} /></>);
  if (loading && !data) return <PageSkeleton />;

  return (
    <>
      {header}
      {data?.length || site ? (<>
      <div className="mb-3 flex flex-col gap-2 lg:flex-row lg:items-center">
        <Segmented<StateFilter>
          label="Issue state"
          value={state}
          onChange={(v) => set({ state: v })}
          options={[
            { value: "open", label: <>Open <span className="ml-1 tabular text-fg-3">{counts.open}</span></> },
            { value: "resolved", label: <>Resolved <span className="ml-1 tabular text-fg-3">{counts.resolved}</span></> },
            { value: "all", label: <>All <span className="ml-1 tabular text-fg-3">{counts.all}</span></> },
          ]}
        />
        <label className="relative min-w-0 flex-1 lg:max-w-xs">
          <span className="sr-only">Search issues</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-3" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, rule, URL…" className="h-8 pl-8 text-[13px]" />
        </label>
        <div className="flex flex-wrap gap-2">
          <Select aria-label="Site" value={site} onChange={(e) => set({ site: e.target.value })} className="h-8 w-auto text-[13px]">
            <option value="">All sites</option>
            {(sites.data ?? []).map((s) => <option key={s.site.id} value={s.site.id}>{s.site.name}</option>)}
          </Select>
          <Select aria-label="Severity" value={sev} onChange={(e) => set({ severity: e.target.value })} className="h-8 w-auto text-[13px]">
            <option value="">Any severity</option>
            {SEVERITIES.map((s) => <option key={s} value={s} className="capitalize">{s[0].toUpperCase() + s.slice(1)}</option>)}
          </Select>
          <Select aria-label="Category" value={cat} onChange={(e) => set({ category: e.target.value })} className="h-8 w-auto text-[13px]">
            <option value="">All categories</option>
            {RULE_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </Select>
          <Select aria-label="Task" value={taskF} onChange={(e) => set({ task: e.target.value })} className="h-8 w-auto text-[13px]">
            <option value="">With or without task</option>
            <option value="none">No task yet</option>
            <option value="has">Has a task</option>
          </Select>
          {filtered ? <Button size="sm" variant="ghost" icon={X} onClick={() => { setQ(""); router.replace(`${base}/issues${site ? `?site=${site}` : ""}`); }}>Clear</Button> : null}
        </div>
      </div>

      {selectedFps.size > 0 && (
        <div className="mb-3 flex items-center justify-between rounded-lg border border-accent/30 bg-accent-soft px-4 py-2 text-xs font-medium text-fg">
          <span>{selectedFps.size} {selectedFps.size === 1 ? "issue" : "issues"} selected</span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setSelectedFps(new Set())}>
              Clear selection
            </Button>
          </div>
        </div>
      )}

      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-fg-3">
          {view === "grouped" ? <>{plural(groups.length, "issue type")} · {plural(rows.length, "instance")}</> : plural(rows.length, "issue")}
          {rule ? <> · check <Mono className="text-fg-2">{rule}</Mono></> : null}
        </p>
        <Segmented<ViewMode>
          label="Issue layout"
          value={view}
          onChange={(v) => set({ view: v })}
          options={[
            { value: "grouped", label: "Grouped by check" },
            { value: "list", label: "Every page" },
          ]}
        />
      </div>
      </>) : null}

      <Panel flush>
        {rows.length === 0 ? (
          data?.length === 0 ? (
            <EmptyState icon={CircleAlert} title="No issues yet" action={<LinkButton href={`${base}/audits/new`} variant="primary">Run an audit</LinkButton>}>
              Issues appear here after the first audit of a site finishes.
            </EmptyState>
          ) : filtered ? (
            <EmptyState icon={SearchX} title="No issues match these filters" />
          ) : (
            <EmptyState icon={CircleCheck} title={state === "open" ? "No open issues" : "No resolved issues yet"}>
              {state === "open" ? "Every issue found so far has been confirmed fixed by a later audit." : "Issues move here when a later audit re-checks them and they are gone."}
            </EmptyState>
          )
        ) : view === "grouped" ? (
          <GroupedIssues groups={groups} base={base} showSite={!site} openAll={!!rule || groups.length === 1} />
        ) : (
          <>
            <table className="hidden w-full table-fixed text-sm lg:table">
              <thead>
                <tr className="border-b border-line-subtle text-left text-xs text-fg-3">
                  <th className="w-10 px-3 py-2.5 text-center">
                    <input
                      type="checkbox"
                      aria-label="Select all issues"
                      checked={rows.length > 0 && selectedFps.size === rows.length}
                      onChange={toggleSelectAll}
                      className="size-3.5 rounded accent-[var(--accent)]"
                    />
                  </th>
                  <th className="w-[124px] px-4 py-2.5 font-medium">Severity</th>
                  <th className="px-4 py-2.5 font-medium">Issue</th>
                  <th className="w-[110px] px-4 py-2.5 font-medium">Category</th>
                  {!site ? <th className="w-[15%] px-4 py-2.5 font-medium">Site</th> : null}
                  <th className="w-[110px] px-4 py-2.5 font-medium">Status</th>
                  <th className="w-[130px] px-4 py-2.5 font-medium">Task</th>
                  <th className="w-[70px] px-3 py-2.5 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-subtle">
                {rows.map((i) => {
                  const href = `${base}/issues/${encodeURIComponent(i.fingerprint)}?site=${i.siteId}`;
                  const isSelected = selectedFps.has(i.fingerprint);
                  return (
                    <tr key={i.fingerprint} className={cx("hover:bg-elevated/50", isSelected ? "bg-sidebar-active/50" : undefined)}>
                      <td className="w-10 px-3 py-3 text-center">
                        <input
                          type="checkbox"
                          aria-label={`Select ${i.finding.title}`}
                          checked={isSelected}
                          onChange={() => toggleSelectOne(i.fingerprint)}
                          className="size-3.5 rounded accent-[var(--accent)]"
                        />
                      </td>
                      <td className="px-4 py-3"><SeverityBadge severity={i.finding.priority.severity} priority={i.finding.priority.level} /></td>
                      <td className="px-4 py-3">
                        <Link href={href} className="block truncate font-medium text-fg hover:text-accent-ink">{i.finding.title}</Link>
                        <Mono className="mt-0.5 block truncate text-fg-3">{i.finding.scope.kind === "page" ? shortUrl(i.finding.pageUrl) : i.finding.ruleCode}</Mono>
                      </td>
                      <td className="px-4 py-3 text-xs text-fg-2 capitalize">{i.finding.category}</td>
                      {!site ? <td className="truncate px-4 py-3 text-[13px] text-fg-2">{i.siteName}</td> : null}
                      <td className="px-4 py-3"><IssueStateBadge row={i} /></td>
                      <td className="px-4 py-3">{i.task ? <WorkflowBadge status={i.task.workflowStatus} /> : <span className="text-[13px] text-fg-3">—</span>}</td>
                      <td className="px-3 py-3 text-right">
                        <LinkButton href={href} size="sm" variant="ghost">
                          View
                        </LinkButton>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <ul className="divide-y divide-line-subtle lg:hidden">
              {rows.map((i) => (
                <li key={i.fingerprint}>
                  <Link href={`${base}/issues/${encodeURIComponent(i.fingerprint)}?site=${i.siteId}`} className="block px-4 py-3">
                    <span className="flex flex-wrap items-center gap-2">
                      <SeverityBadge severity={i.finding.priority.severity} priority={i.finding.priority.level} />
                      <IssueStateBadge row={i} />
                      {i.task ? <WorkflowBadge status={i.task.workflowStatus} /> : null}
                    </span>
                    <span className="mt-2 block text-sm text-fg font-medium">{i.finding.title}</span>
                    <span className="mt-0.5 block truncate text-[13px] text-fg-3">
                      {i.siteName} · <Mono>{i.finding.scope.kind === "page" ? shortUrl(i.finding.pageUrl) : i.finding.ruleCode}</Mono>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>
      {ws === "sample" ? <p className="mt-3 text-xs text-fg-3">Sample data: issue history comes from the fictional sites&apos; two audit rounds.</p> : null}
    </>
  );
}

type DetailTab = "overview" | "evidence" | "fix" | "activity";
const DETAIL_TABS: { id: DetailTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "evidence", label: "Evidence" },
  { id: "fix", label: "How to fix" },
  { id: "activity", label: "History" },
];
const CONFIDENCE: Record<Certainty, string> = {
  verified: "Verified: measured directly from the page SiteSentry fetched.",
  heuristic: "Heuristic: based on a configurable threshold or convention, so treat it as a judgement call.",
  needs_review: "Needs review: measured correctly, but it may be intentional. A person should decide.",
};

export function IssueDetailView() {
  const { fp } = useParams<{ fp: string }>();
  const sp = useSearchParams();
  const site = sp.get("site");
  const { ws, base, apiBase } = useWs();
  const toast = useToast();
  const fingerprint = decodeURIComponent(fp);
  const { data, error, loading, reload } = useApi<IssueDetail>(site ? `${apiBase}/issues/${encodeURIComponent(fingerprint)}?site=${site}` : null);

  const [activeTab, setActiveTab] = useState<DetailTab>("overview");

  // Task creation form state
  const [customTaskTitle, setCustomTaskTitle] = useState<string | null>(null);
  const [taskOwner, setTaskOwner] = useState("");
  const [taskNotes, setTaskNotes] = useState("");
  const [taskBusy, setTaskBusy] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);

  const taskTitle = customTaskTitle ?? data?.finding.title ?? "";

  const crumbs = [
    { label: "Issues", href: `${base}/issues` },
    ...(data ? [{ label: data.siteName, href: `${base}/issues?site=${data.siteId}` }] : []),
    { label: "Issue" },
  ];

  if (!site) return (<><PageHeader title="Issue" crumbs={crumbs} /><ErrorState error={new Error("This link is missing the site. Open the issue from the Issues list.")} /></>);
  if (error) return (<><PageHeader title="Issue" crumbs={crumbs} /><ErrorState error={error} onRetry={reload} /></>);
  if (loading && !data) return <PageSkeleton rows={4} />;
  if (!data) return null;

  const f = data.finding;
  const activeTask = data.task && data.task.workflowStatus !== "resolved" && data.task.workflowStatus !== "wont_fix" ? data.task : null;
  const attempts = data.tasks.flatMap((t) => t.verifications.map((v) => ({ ...v, taskId: t.id, item: v.items.find((i) => i.fingerprint === data.fingerprint) }))).sort((a, b) => b.at.localeCompare(a.at));

  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!taskTitle.trim()) return setTaskError("Give the task a title.");
    setTaskBusy(true);
    setTaskError(null);
    try {
      await api<{ task: { id: string } }>(`${apiBase}/tasks`, {
        method: "POST",
        body: {
          auditId: data.lastSeenAuditId,
          fingerprints: [data.fingerprint],
          title: taskTitle.trim(),
          owner: taskOwner.trim() || null,
          notes: taskNotes.trim(),
        },
      });
      toast({ tone: "ok", title: "Fix task created", detail: "Added to the fix queue with frozen acceptance criteria." });
      await reload();
    } catch (err) {
      setTaskError((err as Error).message);
    } finally {
      setTaskBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title={f.title}
        description={`Rule: ${f.ruleCode} · Category: ${f.category} · Priority P${f.priority.level} (${f.priority.severity})`}
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={f.priority.severity} priority={f.priority.level} />
            <IssueStateBadge row={data} />
            {ws === "sample" ? <SampleTag /> : null}
            <span className="text-[13px] text-fg-3">First seen {fmtDate(data.firstSeenAt)} · last seen {fmtAgo(data.lastSeenAt)}</span>
          </div>
        }
        actions={
          <div className="flex items-center gap-2">
            <ExternalUrl url={f.pageUrl} className="h-9 rounded-md border border-line bg-elevated px-3 text-sm text-fg hover:bg-hover inline-flex items-center gap-1.5">
              Open page
            </ExternalUrl>
            <LinkButton href={`${base}/issues${site ? `?site=${site}` : ""}`} variant="ghost" size="sm">
              Back to issues
            </LinkButton>
          </div>
        }
      />

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <div role="tablist" aria-label="Issue sections" className="flex gap-1 overflow-x-auto rounded-xl border border-line bg-surface p-1 shadow-card">
            {DETAIL_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`issue-tab-${t.id}`}
                aria-selected={activeTab === t.id}
                aria-controls="issue-tabpanel"
                onClick={() => setActiveTab(t.id)}
                className={cx(
                  "h-10 flex-1 whitespace-nowrap rounded-lg px-3 text-sm font-medium transition-colors",
                  activeTab === t.id ? "bg-sidebar-active font-semibold text-accent-ink" : "text-fg-2 hover:bg-hover hover:text-fg",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div role="tabpanel" id="issue-tabpanel" aria-labelledby={`issue-tab-${activeTab}`}>
          {activeTab === "overview" && (
            <div className="space-y-4">
              <Panel title="What we found">
                <div className="space-y-3 text-sm">
                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-fg-3">What was observed</h4>
                    <p className="mt-1 text-fg font-medium">{f.observed}</p>
                  </div>
                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-fg-3">Why it matters</h4>
                    <p className="mt-1 text-fg-2 leading-relaxed">{f.why}</p>
                  </div>
                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-fg-3">Expected behavior</h4>
                    <p className="mt-1 text-ok font-medium">{f.expected}</p>
                  </div>
                  <div className="flex items-start gap-2 rounded-lg border border-line-subtle bg-surface-secondary p-3 text-[13px] text-fg-2">
                    <CertaintyBadge certainty={f.certainty} />
                    <span>{CONFIDENCE[f.certainty]} Priority score {f.priority.score}.</span>
                  </div>
                </div>
              </Panel>

              {data.related.length > 0 && (
                <Panel title={`Related issues on this site (${data.related.length})`} flush>
                  <ul className="divide-y divide-line-subtle">
                    {data.related.slice(0, 4).map((r) => (
                      <li key={r.fingerprint}>
                        <Link href={`${base}/issues/${encodeURIComponent(r.fingerprint)}?site=${r.siteId}`} className="flex items-center justify-between p-3 hover:bg-elevated text-xs">
                          <span className="truncate font-medium text-fg">{r.finding.title}</span>
                          <span className="font-mono text-fg-3 shrink-0 ml-2">{shortUrl(r.finding.pageUrl)}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Panel>
              )}
            </div>
          )}

          {activeTab === "evidence" && (
            <div className="space-y-4">
              <Panel title="Observed page values">
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
                  <dt className="text-fg-3">URL</dt>
                  <dd className="font-mono text-fg break-all">{f.pageUrl}</dd>
                  <dt className="text-fg-3">Observed</dt>
                  <dd className="font-mono text-sev-high break-all">{f.observed}</dd>
                  <dt className="text-fg-3">Expected</dt>
                  <dd className="font-mono text-ok break-all">{f.expected}</dd>
                  {data.snapshot && (
                    <>
                      <dt className="text-fg-3">HTTP status</dt>
                      <dd className="font-mono text-fg">{data.snapshot.status ?? "—"}</dd>
                      <dt className="text-fg-3">Title tag</dt>
                      <dd className="text-fg">{data.snapshot.summary.title ?? "—"}</dd>
                      <dt className="text-fg-3">Canonical</dt>
                      <dd className="font-mono text-fg-2">{data.snapshot.summary.canonical ?? "None"}</dd>
                    </>
                  )}
                </dl>
              </Panel>

              {f.evidence.snippets?.length ? (
                <Panel title="HTML excerpt">
                  <div className="space-y-2">
                    {f.evidence.snippets.map((snip, idx) => (
                      <pre key={idx} className="evidence rounded-lg border border-line bg-elevated p-3 font-mono text-xs leading-relaxed text-fg">
                        {snip}
                      </pre>
                    ))}
                  </div>
                </Panel>
              ) : null}

              {f.evidence.urls?.length ? (
                <Panel title={`Affected URLs (${f.evidence.urls.length})`}>
                  <ul className="space-y-1 text-xs font-mono text-fg-2">
                    {f.evidence.urls.map((u, i) => (
                      <li key={i} className="truncate flex items-center gap-2">
                        <ExternalUrl url={u.url} className="text-accent-ink hover:underline">
                          {u.url}
                        </ExternalUrl>
                        {u.detail ? <span className="text-fg-3 font-sans">({u.detail})</span> : null}
                      </li>
                    ))}
                  </ul>
                </Panel>
              ) : null}
            </div>
          )}

          {activeTab === "fix" && (
            <div className="space-y-4">
              <Panel title="Recommended fix">
                <ul className="space-y-2 text-sm text-fg-2">
                  {f.recommendations.map((rec, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span className="mt-1 size-1.5 shrink-0 rounded-full bg-accent-ink" />
                      <span>{rec}</span>
                    </li>
                  ))}
                </ul>
              </Panel>

              <Panel
                title="Acceptance criteria"
                actions={<span className="text-xs text-fg-3">{f.verify === "reaudit" ? "Verified by new audit" : "Checked by live re-fetch"}</span>}
              >
                <CriteriaList criteria={f.acceptanceCriteria} />
              </Panel>

              <Panel title="How the fix is verified">
                <p className="text-[13px] leading-relaxed text-fg-2">
                  {f.verify === "reaudit"
                    ? "This check needs site-wide data, so it is confirmed by the next audit of the site."
                    : <>After the change is deployed, open the fix task and choose <strong className="text-fg">Verify now</strong>. SiteSentry re-fetches <code className="font-mono text-fg">{shortUrl(f.pageUrl)}</code> and checks it against the frozen criteria above.</>}
                </p>
              </Panel>
            </div>
          )}

          {activeTab === "activity" && (
            <Panel title="Audit history" description="One entry per completed audit of this site.">
              <ol className="relative flex flex-col gap-4 border-l border-line pl-4">
                {[...data.history].reverse().map((h) => (
                  <li key={h.auditId} className="relative">
                    <span className={cx("absolute -left-[21px] top-1 size-2.5 rounded-full ring-4 ring-surface", h.state === "present" ? "bg-sev-high" : h.state === "absent" ? "bg-ok" : "bg-sev-medium")} aria-hidden />
                    <Link href={`${base}/audits/${h.auditId}`} className="text-xs font-semibold text-fg hover:text-accent-ink">{fmtDateTime(h.at)}</Link>
                    <p className="text-xs text-fg-2">{h.state === "present" ? "Detected defect on page" : h.state === "absent" ? "Re-checked: not detected" : "Not re-checked by this audit"}</p>
                    {h.observed ? <Mono className="evidence mt-0.5 block text-fg-3 text-[11px]">{h.observed}</Mono> : null}
                  </li>
                ))}
              </ol>
            </Panel>
          )}
          </div>
        </div>

        <div className="space-y-6">
          {activeTask ? (
            <Panel
              title="Fix task"
              description="This issue is already tracked in the fix queue."
              actions={
                <LinkButton href={`${base}/tasks/${activeTask.id}`} size="sm" variant="primary">
                  Open task
                </LinkButton>
              }
            >
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="font-semibold text-sm text-fg">{activeTask.title}</h4>
                  <WorkflowBadge status={activeTask.workflowStatus} />
                </div>
                <div className="rounded-lg border border-line-subtle bg-surface-secondary p-3 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-fg-3">Verification status</span>
                    <VerificationBadge status={data.task?.verificationStatus ?? "unverified"} />
                  </div>
                </div>
              </div>
            </Panel>
          ) : (
            <Panel
              title="Create fix task"
              description="Send this issue to the fix queue with its acceptance criteria frozen."
            >
              <form onSubmit={handleCreateTask} className="space-y-3.5">
                <Field label="Title" htmlFor="ft-title">
                  <Input
                    id="ft-title"
                    value={taskTitle}
                    onChange={(e) => setCustomTaskTitle(e.target.value)}
                    placeholder={f.title}
                  />
                </Field>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Owner" htmlFor="ft-owner" hint="Optional">
                    <Input
                      id="ft-owner"
                      value={taskOwner}
                      onChange={(e) => setTaskOwner(e.target.value)}
                      placeholder="Who will fix it"
                    />
                  </Field>
                  <div>
                    <p className="text-sm font-medium text-fg">Priority</p>
                    <p className="mt-1.5 flex h-10 items-center gap-2 rounded-lg border border-line-subtle bg-surface-secondary px-3 text-sm text-fg-2" title="Set by the rule's severity and certainty">
                      <SeverityBadge severity={f.priority.severity} priority={f.priority.level} />
                    </p>
                  </div>
                </div>

                <Field label="Notes" htmlFor="ft-notes" hint="Optional">
                  <Textarea
                    id="ft-notes"
                    value={taskNotes}
                    onChange={(e) => setTaskNotes(e.target.value)}
                    placeholder="Context for whoever fixes this, such as the template or CMS field involved"
                    className="min-h-20"
                  />
                </Field>

                <div className="rounded-lg border border-line-subtle bg-surface-secondary p-3 text-[13px]">
                  <p className="mb-1.5 font-semibold text-fg">Acceptance criteria ({f.acceptanceCriteria.length})</p>
                  <ul className="space-y-1 text-fg-2">
                    {f.acceptanceCriteria.map((c) => (
                      <li key={c.id} className="flex gap-2"><CircleCheck className="mt-0.5 size-3.5 shrink-0 text-fg-3" aria-hidden />{c.description}</li>
                    ))}
                  </ul>
                </div>

                {taskError && (
                  <Notice tone="error">{taskError}</Notice>
                )}

                <Button type="submit" variant="primary" loading={taskBusy} className="h-10 w-full">
                  Create fix task
                </Button>
              </form>
            </Panel>
          )}

          <Panel
            title="Verification history"
            description="Re-fetches and tests against the frozen acceptance criteria."
          >
            {attempts.length === 0 ? (
              <p className="text-[13px] text-fg-3">
                {activeTask
                  ? "No verification re-checks have been performed on this task yet."
                  : "Create a fix task to verify the change against a live re-fetch."}
              </p>
            ) : (
              <ul className="divide-y divide-line-subtle">
                {attempts.map((a) => (
                  <li key={a.id} className="py-2.5 first:pt-0 last:pb-0">
                    <div className="flex items-center justify-between gap-2">
                      <VerificationBadge status={a.item?.outcome === "resolved" ? "passing" : a.item?.outcome === "still_failing" ? "failing" : "inconclusive"} />
                      <Link href={`${base}/tasks/${a.taskId}`} className="text-[11px] text-fg-3 hover:text-fg">
                        {fmtDateTime(a.at)}
                      </Link>
                    </div>
                    <p className="mt-1 text-xs text-fg-2">{a.item?.reason ?? a.reason}</p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {data.snapshot && (
            <Panel title="Page snapshot at detection">
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-fg-3">Status code</dt>
                <dd className="font-mono text-fg">{data.snapshot.status ?? "—"}</dd>
                <dt className="text-fg-3">Word count</dt>
                <dd className="tabular text-fg">{data.snapshot.summary.wordCount ?? 0} words</dd>
                <dt className="text-fg-3">Indexable</dt>
                <dd className="text-fg">{data.snapshot.summary.noindex ? "No (noindex)" : "Yes"}</dd>
              </dl>
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}

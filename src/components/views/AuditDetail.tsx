"use client";
import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { Ban, Braces, CircleCheck, Download, FileText, GitCompareArrows, ListChecks, Search, SearchX, Square, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeKind } from "@/lib/audit/compare";
import { failureText } from "@/lib/audit/failure";
import { RULE_CATEGORIES, type AuditFinding, type RuleCategory, type Severity } from "@/lib/audit/types";
import { applyFilter, filterToParams, parseFilter, type FindingFilter, type FindingSort } from "@/lib/filters";
import type { AuditPhase, SnapshotOutcome } from "@/lib/model";
import { CHANGE_LABELS, SEVERITIES, type AuditDetail, type AuditSummary } from "@/lib/views";
import { CreateTaskModal, FindingBody } from "../FindingPanel";
import { SeverityCountsInline } from "../domain";
import { DeleteAuditDialog } from "./Audits";
import { OverviewScreen } from "../v2/screens/OverviewScreen";
import { analysing, AuditProgressView } from "./AuditProgress";
import { api, useApi } from "../lib/api";
import { prefetchAuditSection } from "../v2/AuditFrame";
import { fmtDateTime, fmtDuration, plural, shortUrl } from "../lib/format";
import { Drawer, useToast } from "../overlays";
import { useWs } from "../shell/context";
import {
  AuditStatusBadge,
  Button,
  ChangeBadge,
  CertaintyBadge,
  EmptyState,
  ErrorState,
  ExternalUrl,
  Input,
  LinkButton,
  Mono,
  Notice,
  PageHeader,
  PageSkeleton,
  Panel,
  SampleTag,
  Select,
  SeverityBadge,
  StatStrip,
  WorkflowBadge,
  btn,
  cx,
} from "../ui";

const PHASES: { id: AuditPhase; label: string }[] = [
  { id: "robots", label: "robots.txt" },
  { id: "sitemap", label: "Sitemap" },
  { id: "pages", label: "Pages" },
  { id: "links", label: "Link checks" },
  { id: "finalize", label: "Analysis" },
];

const OUTCOME: Record<SnapshotOutcome, { label: string; tone: string }> = {
  inspected: { label: "Inspected", tone: "text-ok" },
  http_error: { label: "HTTP error", tone: "text-sev-high" },
  non_html: { label: "Not HTML", tone: "text-fg-2" },
  fetch_failed: { label: "Fetch failed", tone: "text-sev-high" },
  robots_blocked: { label: "Blocked by robots.txt", tone: "text-sev-medium" },
  redirect_duplicate: { label: "Redirect (duplicate)", tone: "text-fg-2" },
  external_redirect: { label: "Redirects off-site", tone: "text-fg-2" },
};

// ---------- progress (drives the step loop) ----------

function Progress({ initial, onDone }: { initial: AuditSummary; onDone: () => void }) {
  const { apiBase } = useWs();
  const toast = useToast();
  const [audit, setAudit] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const tick = async () => {
      if (!alive.current) return;
      if (document.hidden) {
        timer = setTimeout(tick, 1500);
        return;
      }
      try {
        const r = await api<{ audit: AuditSummary; busy: boolean }>(`${apiBase}/audits/${initial.id}/step`, { method: "POST" });
        if (!alive.current) return;
        failures = 0;
        setError(null);
        setAudit(r.audit);
        if (r.audit.status !== "running") return onDone();
        timer = setTimeout(tick, r.busy ? 1500 : 150);
      } catch (e) {
        failures++;
        setError((e as Error).message);
        // Back off; the audit's state is saved after every step, so nothing is lost.
        if (failures < 6) timer = setTimeout(tick, 2000 * failures);
      }
    };
    void tick();
    return () => {
      alive.current = false;
      clearTimeout(timer);
    };
  }, [apiBase, initial.id, onDone]);

  const cancel = async () => {
    setCancelling(true);
    try {
      await api(`${apiBase}/audits/${initial.id}/cancel`, { method: "POST" });
      toast({ tone: "info", title: "Audit cancelled", detail: "Results collected so far are kept and marked partial." });
      onDone();
    } catch (e) {
      toast({ tone: "error", title: "Could not cancel", detail: (e as Error).message });
      setCancelling(false);
    }
  };

  const p = audit.progress;
  const phaseIdx = PHASES.findIndex((x) => x.id === audit.phase);
  const pct = p.planned ? Math.min(100, Math.round((p.done / p.planned) * 100)) : 0;
  return (
    <Panel
      title="Audit in progress"
      description={initial.stale ? "This audit was interrupted. It resumed when you opened this page." : "Keep this page open; the audit advances in short steps."}
      actions={
        <div className="flex items-center gap-2">
          <LinkButton href={`/live/audits/${initial.id}/progress`} size="sm" variant="ghost">
            Full progress view
          </LinkButton>
          <Button size="sm" variant="danger" icon={Square} loading={cancelling} onClick={cancel}>
            Cancel
          </Button>
        </div>
      }
    >
      <ol className="mb-5 grid grid-cols-5 gap-2" aria-label="Phases">
        {PHASES.map((ph, i) => (
          <li key={ph.id} className="min-w-0">
            <span className={cx("block h-1 rounded-full", i < phaseIdx ? "bg-accent" : i === phaseIdx ? "bg-accent/60 [animation:ss-pulse_1.6s_ease-in-out_infinite]" : "bg-elevated")} />
            <span className={cx("mt-2 block truncate text-xs", i <= phaseIdx ? "text-fg" : "text-fg-3")}>
              {ph.label}
              {i === phaseIdx ? <span className="sr-only"> (current)</span> : null}
            </span>
          </li>
        ))}
      </ol>
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-fg">
          <span className="font-semibold tabular">{p.done}</span>
          <span className="text-fg-2"> of {plural(p.planned, "page")} processed</span>
        </span>
        <span className="tabular text-fg-3">{pct}%</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-elevated" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Pages processed">
        <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${pct}%` }} />
      </div>
      <dl className="mt-5 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
        {[
          ["Inspected", p.inspected, "text-ok"],
          ["Failed", p.failed, p.failed ? "text-sev-high" : "text-fg"],
          ["Skipped", p.skipped, "text-fg"],
          ["Links checked", p.linksChecked, "text-fg"],
        ].map(([l, v, c]) => (
          <div key={l as string}>
            <dt className="text-xs text-fg-3">{l}</dt>
            <dd className={cx("mt-0.5 text-lg font-semibold tabular", c as string)}>{v}</dd>
          </div>
        ))}
      </dl>
      {error ? <div className="mt-4"><Notice tone="warn" title="A step failed; retrying">{error}</Notice></div> : null}
    </Panel>
  );
}

// ---------- results ----------

const SORTS: { value: FindingSort; label: string }[] = [
  { value: "priority", label: "Priority" },
  { value: "severity", label: "Severity" },
  { value: "rule", label: "Rule" },
  { value: "url", label: "URL" },
];

function FindingsTable({ d }: { d: AuditDetail }) {
  const { base, apiBase } = useWs();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const filter = useMemo(() => parseFilter(new URLSearchParams(sp.toString())), [sp]);
  const sort = (sp.get("sort") as FindingSort | null) ?? "priority";
  const open = sp.get("finding");
  const [q, setQ] = useState(filter.q ?? "");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState(false);

  const push = useCallback(
    (f: FindingFilter, s: FindingSort = sort, extra?: Record<string, string | null>) => {
      const p = filterToParams(f, s);
      const tab = sp.get("tab");
      if (tab) p.set("tab", tab);
      for (const [k, v] of Object.entries(extra ?? {})) if (v) p.set(k, v);
      router.replace(`${pathname}${p.size ? `?${p}` : ""}`, { scroll: false });
    },
    [pathname, router, sort, sp],
  );

  // Debounced free-text search, kept in the URL so filtered views and exports are shareable.
  // It edits the URL as it is when the timer fires, so it can never restore filters cleared meanwhile.
  useEffect(() => {
    const t = setTimeout(() => {
      const p = new URLSearchParams(window.location.search);
      if ((p.get("q") ?? "") === q) return;
      if (q) p.set("q", q);
      else p.delete("q");
      router.replace(`${pathname}${p.size ? `?${p}` : ""}`, { scroll: false });
    }, 250);
    return () => clearTimeout(t);
  }, [q, pathname, router]);

  const rows = useMemo(() => applyFilter(d.findings, filter, d.changes, sort), [d, filter, sort]);
  const rules = useMemo(() => [...new Set(d.findings.map((f) => f.ruleCode))].sort(), [d.findings]);
  const urls = useMemo(() => [...new Set(d.findings.map((f) => f.pageUrl))].sort(), [d.findings]);
  const changeKinds = useMemo(() => (d.changes ? ([...new Set(Object.values(d.changes))] as ChangeKind[]) : []), [d.changes]);
  const current = open ? d.findings.find((f) => f.fingerprint === open) : null;
  const active = !!(filter.severity?.length || filter.category?.length || filter.rule || filter.change?.length || filter.q || filter.url);

  const toggleSev = (s: Severity) => {
    const cur = filter.severity ?? [];
    push({ ...filter, severity: cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s] });
  };
  const openFinding = (fp: string | null) => {
    const p = new URLSearchParams(sp.toString());
    if (fp) p.set("finding", fp);
    else p.delete("finding");
    router.replace(`${pathname}?${p}`, { scroll: false });
  };
  const exportQs = filterToParams(filter, sort).toString();
  const selectable = rows.filter((f) => !d.tasksByFingerprint[f.fingerprint]);
  const allSelected = selectable.length > 0 && selectable.every((f) => selected.has(f.fingerprint));

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="relative w-full min-w-0 sm:w-64 sm:shrink-0">
          <span className="sr-only">Search findings</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-3" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, rule, URL, value…" className="h-9 pl-8 text-[13px]" />
        </label>
        <div className="contents">
          <div className="inline-flex rounded-[10px] border border-line bg-surface p-0.5" role="group" aria-label="Severity">
            {SEVERITIES.map((s) => {
              const on = filter.severity?.includes(s);
              return (
                <button key={s} type="button" aria-pressed={!!on} onClick={() => toggleSev(s)} className={cx("h-8 rounded-[6px] px-2.5 text-[13px] capitalize transition-colors", on ? "bg-elevated text-fg shadow-[0_0_0_1px_var(--line)]" : "text-fg-2 hover:text-fg")}>
                  {s}
                </button>
              );
            })}
          </div>
          <Select aria-label="Category" value={filter.category?.[0] ?? ""} onChange={(e) => push({ ...filter, category: e.target.value ? [e.target.value as RuleCategory] : undefined })} className="h-9 w-auto text-[13px]">
            <option value="">All categories</option>
            {RULE_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </Select>
          <Select aria-label="Rule" value={filter.rule ?? ""} onChange={(e) => push({ ...filter, rule: e.target.value || undefined })} className="h-9 w-auto max-w-52 text-[13px]">
            <option value="">All rules</option>
            {rules.map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>
          {changeKinds.length ? (
            <Select aria-label="Change since previous audit" value={filter.change?.[0] ?? ""} onChange={(e) => push({ ...filter, change: e.target.value ? [e.target.value as ChangeKind] : undefined })} className="h-9 w-auto text-[13px]">
              <option value="">Any change</option>
              {changeKinds.map((c) => <option key={c} value={c}>{CHANGE_LABELS[c]}</option>)}
            </Select>
          ) : null}
          <Select aria-label="URL" value={filter.url ?? ""} onChange={(e) => push({ ...filter, url: e.target.value || undefined })} className="h-9 w-auto max-w-52 text-[13px]">
            <option value="">All URLs</option>
            {urls.map((u) => <option key={u} value={u}>{shortUrl(u)}</option>)}
          </Select>
          <Select aria-label="Sort by" value={sort} onChange={(e) => push(filter, e.target.value as FindingSort)} className="h-9 w-auto text-[13px]">
            {SORTS.map((s) => <option key={s.value} value={s.value}>Sort: {s.label}</option>)}
          </Select>
          {active ? <Button size="sm" variant="ghost" icon={X} onClick={() => { setQ(""); push({}); }}>Clear</Button> : null}
        </div>
      </div>

      <div className="mb-2 flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-fg-3">
        <span>
          {rows.length === d.findings.length ? plural(rows.length, "finding") : `${rows.length} of ${plural(d.findings.length, "finding")}`}
        </span>
        {selected.size ? (
          <span className="flex items-center gap-2">
            <span className="text-fg">{selected.size} selected</span>
            <Button size="sm" variant="primary" icon={ListChecks} onClick={() => setBulk(true)} disabled={selected.size > 25}>
              Create task
            </Button>
            {selected.size > 25 ? <span className="text-sev-medium">A task can cover at most 25 findings.</span> : null}
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Deselect</Button>
          </span>
        ) : null}
        <span className="ml-auto flex gap-1">
          <a className={btn("ghost", "sm")} href={`${apiBase}/audits/${d.audit.id}/export?format=csv${exportQs ? `&${exportQs}` : ""}`} download>
            <Download aria-hidden /> CSV
          </a>
          <a className={btn("ghost", "sm")} href={`${apiBase}/audits/${d.audit.id}/export?format=json${exportQs ? `&${exportQs}` : ""}`} download>
            <Braces aria-hidden /> JSON
          </a>
        </span>
      </div>

      <Panel flush>
        {d.findings.length === 0 ? (
          <EmptyState icon={CircleCheck} title="No findings">
            Every selected check passed on the {plural(d.audit.progress.inspected, "page")} that were inspected. Pages that could not be inspected are listed under Pages.
          </EmptyState>
        ) : rows.length === 0 ? (
          <EmptyState icon={SearchX} title="No findings match" action={<Button onClick={() => { setQ(""); push({}); }}>Clear filters</Button>} />
        ) : (
          <>
            <table className="hidden w-full table-fixed text-sm lg:table">
              <thead>
                <tr className="border-b border-line-subtle text-left text-xs text-fg-3">
                  <th className="w-10 px-4 py-2.5">
                    <input type="checkbox" className="size-4 cursor-pointer accent-[var(--accent)]" aria-label="Select all without a task" checked={allSelected} onChange={(e) => setSelected(e.target.checked ? new Set(selectable.map((f) => f.fingerprint)) : new Set())} />
                  </th>
                  <th className="w-[124px] px-2 py-2.5 font-medium">Priority</th>
                  <th className="px-4 py-2.5 font-medium">Finding</th>
                  <th className="w-[26%] px-4 py-2.5 font-medium">URL</th>
                  {d.changes ? <th className="w-[120px] px-4 py-2.5 font-medium">Change</th> : null}
                  <th className="w-[132px] px-4 py-2.5 font-medium">Task</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-subtle">
                {rows.map((f) => {
                  const t = d.tasksByFingerprint[f.fingerprint];
                  return (
                    <tr key={f.fingerprint} className={cx("cursor-pointer transition-colors hover:bg-elevated/50", open === f.fingerprint && "bg-elevated/70")} onClick={() => openFinding(f.fingerprint)}>
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          className="size-4 cursor-pointer accent-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
                          aria-label={`Select ${f.title}`}
                          disabled={!!t}
                          title={t ? "Already in a task" : undefined}
                          checked={selected.has(f.fingerprint)}
                          onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(f.fingerprint); else n.delete(f.fingerprint); return n; })}
                        />
                      </td>
                      <td className="px-2 py-3"><SeverityBadge severity={f.priority.severity} priority={f.priority.level} /></td>
                      <td className="px-4 py-3">
                        <button type="button" className="block w-full truncate text-left text-fg hover:text-accent-ink" onClick={(e) => { e.stopPropagation(); openFinding(f.fingerprint); }}>
                          {f.title}
                        </button>
                        <span className="mt-0.5 flex min-w-0 items-center gap-2">
                          <Mono className="shrink-0 text-fg-3">{f.ruleCode}</Mono>
                          {f.certainty !== "verified" ? <CertaintyBadge certainty={f.certainty} /> : null}
                        </span>
                      </td>
                      <td className="px-4 py-3"><Mono className="block truncate text-fg-2" >{f.scope.kind === "page" ? shortUrl(f.pageUrl) : f.evidence.urls?.length ? plural(f.evidence.urls.length, "URL") : "Site-wide"}</Mono></td>
                      {d.changes ? <td className="px-4 py-3">{d.changes[f.fingerprint] ? <ChangeBadge kind={d.changes[f.fingerprint]} /> : null}</td> : null}
                      <td className="px-4 py-3">{t ? <Link href={`${base}/tasks/${t.id}`} onClick={(e) => e.stopPropagation()}><WorkflowBadge status={t.workflowStatus} /></Link> : <span className="text-[13px] text-fg-3">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <ul className="divide-y divide-line-subtle lg:hidden">
              {rows.map((f) => {
                const t = d.tasksByFingerprint[f.fingerprint];
                return (
                  <li key={f.fingerprint}>
                    <button type="button" className="block w-full px-4 py-3 text-left" onClick={() => openFinding(f.fingerprint)}>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <SeverityBadge severity={f.priority.severity} priority={f.priority.level} />
                        {d.changes?.[f.fingerprint] ? <ChangeBadge kind={d.changes[f.fingerprint]} /> : null}
                        {t ? <WorkflowBadge status={t.workflowStatus} /> : null}
                      </span>
                      <span className="mt-2 block text-sm text-fg">{f.title}</span>
                      <Mono className="mt-0.5 block truncate text-fg-3">{f.scope.kind === "page" ? shortUrl(f.pageUrl) : f.ruleCode}</Mono>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Panel>

      <Drawer open={!!current} onClose={() => openFinding(null)} title={current ? `${current.ruleCode}` : ""}>
        {current ? <FindingBody f={current} change={d.changes?.[current.fingerprint]} task={d.tasksByFingerprint[current.fingerprint]} auditId={d.audit.id} siteId={d.site.id} /> : null}
      </Drawer>
      {bulk ? <CreateTaskModal auditId={d.audit.id} findings={d.findings.filter((f) => selected.has(f.fingerprint))} onClose={() => setBulk(false)} /> : null}
    </>
  );
}

function PagesTable({ d }: { d: AuditDetail }) {
  const [outcome, setOutcome] = useState("");
  const rows = outcome ? d.pages.filter((p) => (outcome === "problem" ? p.outcome !== "inspected" : p.outcome === outcome)) : d.pages;
  const outcomes = [...new Set(d.pages.map((p) => p.outcome))];
  const findingsByUrl = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of d.findings) m.set(f.pageUrl, (m.get(f.pageUrl) ?? 0) + 1);
    return m;
  }, [d.findings]);
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select aria-label="Outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)} className="h-8 w-auto text-[13px]">
          <option value="">All outcomes</option>
          <option value="problem">Not inspected</option>
          {outcomes.map((o) => <option key={o} value={o}>{OUTCOME[o].label}</option>)}
        </Select>
        <span className="ml-auto text-[13px] text-fg-3">{plural(rows.length, "URL")}</span>
      </div>
      <Panel flush>
        {rows.length === 0 ? (
          <EmptyState compact icon={FileText} title={d.pages.length ? "No URLs with this outcome" : "No pages were fetched"} />
        ) : (
          <>
            <table className="hidden w-full table-fixed text-sm lg:table">
              <thead>
                <tr className="border-b border-line-subtle text-left text-xs text-fg-3">
                  <th className="w-[30%] px-4 py-2.5 font-medium">URL</th>
                  <th className="w-[150px] px-4 py-2.5 font-medium">Outcome</th>
                  <th className="w-16 px-4 py-2.5 text-right font-medium">HTTP</th>
                  <th className="px-4 py-2.5 font-medium">Title</th>
                  <th className="w-20 px-4 py-2.5 text-right font-medium">Words</th>
                  <th className="w-20 px-4 py-2.5 text-right font-medium">Findings</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-subtle">
                {rows.map((p) => (
                  <tr key={p.url} className="align-top">
                    <td className="px-4 py-2.5">
                      <ExternalUrl url={p.url} className="max-w-full font-mono text-[12.5px] text-fg">{shortUrl(p.url)}</ExternalUrl>
                      {p.redirectChain.length ? <span className="block truncate font-mono text-xs text-fg-3">→ {shortUrl(p.finalUrl)} ({plural(p.redirectChain.length, "hop")})</span> : null}
                      <span className="block text-xs text-fg-3">via {p.via}{p.depth ? `, depth ${p.depth}` : ""}</span>
                    </td>
                    <td className={cx("px-4 py-2.5 text-[13px]", OUTCOME[p.outcome].tone)}>
                      {OUTCOME[p.outcome].label}
                      {p.error ? <span className="block text-xs text-fg-3">{p.error.message}</span> : null}
                      {p.truncated ? <span className="block text-xs text-sev-medium">Truncated at 2 MB</span> : null}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-[12.5px] text-fg-2">{p.status ?? "—"}</td>
                    <td className="px-4 py-2.5 text-[13px] text-fg-2"><span className="line-clamp-2">{p.summary.title ?? <span className="text-fg-3">—</span>}</span></td>
                    <td className="px-4 py-2.5 text-right tabular text-[13px] text-fg-2">{p.summary.wordCount ?? "—"}</td>
                    <td className="px-4 py-2.5 text-right tabular text-[13px] text-fg">{findingsByUrl.get(p.finalUrl) ?? findingsByUrl.get(p.url) ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="divide-y divide-line-subtle lg:hidden">
              {rows.map((p) => (
                <li key={p.url} className="px-4 py-3">
                  <Mono className="evidence block text-fg">{shortUrl(p.url)}</Mono>
                  <p className="mt-1 text-[13px]">
                    <span className={OUTCOME[p.outcome].tone}>{OUTCOME[p.outcome].label}</span>
                    <span className="text-fg-3"> · HTTP {p.status ?? "—"}{p.summary.wordCount !== null ? ` · ${p.summary.wordCount} words` : ""}</span>
                  </p>
                  {p.error ? <p className="mt-0.5 text-xs text-fg-3">{p.error.message}</p> : null}
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>
    </>
  );
}

function CrawlFiles({ d }: { d: AuditDetail }) {
  const r = d.robots;
  const s = d.sitemap;
  const broken = d.linkChecks.filter((c) => c.status === null || c.status >= 400 || c.redirectCount > 0);
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <Panel title="robots.txt" description={r ? `${r.outcome === "ok" ? "Parsed" : r.outcome === "missing" ? "Not found (everything allowed)" : "Unreachable (crawl treated as disallowed)"} · HTTP ${r.status ?? "—"}` : "Not fetched"}>
        {r ? (
          <>
            {r.error ? <p className="mb-3 text-[13px] text-sev-high">{r.error.message}</p> : null}
            {r.sitemaps.length ? <p className="mb-3 text-[13px] text-fg-2">Declares {plural(r.sitemaps.length, "sitemap")}: {r.sitemaps.map((u) => <Mono key={u} className="mr-2 text-fg">{shortUrl(u)}</Mono>)}</p> : null}
            <pre className="evidence max-h-72 overflow-y-auto rounded-md border border-line-subtle bg-bg p-3 font-mono text-[12.5px] text-fg-2">{r.body || "(empty)"}</pre>
          </>
        ) : (
          <p className="text-sm text-fg-3">{d.audit.status === "running" ? "robots.txt has not been read yet." : "robots.txt was not read for this audit, so robots rules were not applied or checked."}</p>
        )}
      </Panel>
      <Panel title="Sitemap" description={s ? `${s.kind ?? "unknown"} · ${plural(s.urlCount, "URL")} · found via ${s.via}` : d.audit.config.mode === "sitemap" ? "Not retrieved" : "Not used by this audit"}>
        {s ? (
          <div className="flex flex-col gap-3 text-sm">
            <p><Mono className="evidence text-fg">{s.url}</Mono> <span className="text-fg-3">· HTTP {s.status ?? "—"}</span></p>
            {s.error ? <p className="text-[13px] text-sev-high">{s.error.message}</p> : null}
            {s.errors.length ? (
              <ul className="list-disc pl-5 text-[13px] text-sev-medium marker:text-fg-3">{s.errors.map((e, i) => <li key={i} className="evidence">{e}</li>)}</ul>
            ) : <p className="text-[13px] text-ok">Well-formed XML.</p>}
            {s.children.length ? (
              <ul className="divide-y divide-line-subtle rounded-md border border-line-subtle">
                {s.children.map((c) => <li key={c.url} className="flex justify-between gap-3 px-3 py-2 text-[13px]"><Mono className="truncate text-fg">{shortUrl(c.url)}</Mono><span className="shrink-0 text-fg-3">HTTP {c.status ?? "—"} · {c.urlCount} URLs</span></li>)}
              </ul>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-fg-3">Sitemap checks run when the audit reads the sitemap.</p>
        )}
      </Panel>
      <Panel className="xl:col-span-2" title="Link and image status checks" description={`${plural(d.linkChecks.length, "uncrawled target")} checked · ${broken.length} broken, redirected or unreachable`} flush>
        {d.linkChecks.length === 0 ? (
          <EmptyState compact icon={Ban} title="No status checks">{d.audit.config.checkLinks ? "Every internal target was crawled as a page, or none were found." : "Link checks were switched off for this audit."}</EmptyState>
        ) : (
          <ul className="max-h-96 divide-y divide-line-subtle overflow-y-auto">
            {[...broken, ...d.linkChecks.filter((c) => !broken.includes(c))].map((c) => (
              <li key={c.url} className="flex flex-col gap-0.5 px-4 py-2 text-[13px] sm:flex-row sm:items-center sm:gap-3">
                <Mono className="evidence min-w-0 flex-1 text-fg">{shortUrl(c.url)}</Mono>
                <span className="text-fg-3">{c.kind}</span>
                <span className={cx("w-36 sm:text-right", c.status === null || c.status >= 400 ? "text-sev-high" : c.redirectCount ? "text-sev-medium" : "text-fg-2")}>
                  {c.error ? c.error.code : `HTTP ${c.status}`}{c.redirectCount ? ` · ${plural(c.redirectCount, "redirect")}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

const TABS = [
  { id: "findings", label: "Findings" },
  { id: "pages", label: "Pages" },
  { id: "crawl", label: "Crawl files & links" },
] as const;

export function AuditDetailView() {
  const { auditId } = useParams<{ auditId: string }>();
  const { ws, base, apiBase, sites } = useWs();
  const sp = useSearchParams();
  const pathname = usePathname();
  const { data, error, loading, reload } = useApi<AuditDetail>(`${apiBase}/audits/${auditId}`);
  // A finished v2 audit renders the overview screen: start its requests alongside the detail.
  useEffect(() => prefetchAuditSection(`${apiBase}/audits/${auditId}`, "overview"), [apiBase, auditId]);
  const tab = (sp.get("tab") as (typeof TABS)[number]["id"] | null) ?? "findings";
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const onDone = useCallback(() => {
    void reload();
    void sites.reload();
  }, [reload, sites]);

  const crumbs = [{ label: "Audits", href: `${base}/audits` }, { label: data ? `${data.site.name} · ${fmtDateTime(data.audit.startedAt)}` : "Audit" }];
  if (error) return (<><PageHeader title="Audit" crumbs={crumbs} /><ErrorState error={error} onRetry={reload} /></>);
  if (loading && !data) return <PageSkeleton />;
  if (!data) return null;
  const a = data.audit;
  const running = a.status === "running";
  const counts = a.findingCounts ?? { high: 0, medium: 0, low: 0 };
  const changeCounts = data.changes ? Object.values(data.changes).reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {}) : null;

  // A crawler v2 audit still crawling or running its checks: the live monitor, then the overview.
  if (a.crawler && (running || analysing(a))) return <AuditProgressView onFinished={onDone} />;
  // A finished crawler v2 audit: the v2 overview (health, issue groups, coverage), with this audit's delete action.
  if (a.crawler && !running) {
    const notices = [
      a.crawler.startRedirect ? <Notice key="r" tone="info" title="The start URL redirected">Started at {a.crawler.startRedirect.from}, redirected to {a.crawler.startRedirect.to}: the crawl covers {new URL(a.crawler.startRedirect.to).host}.</Notice> : null,
      a.status === "completed_empty" ? <Notice key="e" tone="warn" title="Nothing was analysed">{a.emptyReason ?? "No HTML page was fetched."}</Notice> : null,
      a.status === "failed" ? <Notice key="f" tone="error" title="The crawl failed"><FailureMessage error={a.error} fallback="Unknown error." /> Results collected before the failure are shown below and were not used to resolve any issue.</Notice> : null,
      a.coverage.length ? (
        <Notice key="c" tone="warn" title={a.status === "partial" || a.status === "cancelled" ? "Partial audit: some of the site was not examined" : "Coverage notes"}>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 marker:text-fg-3">{a.coverage.map((c, i) => <li key={i}>{c.message}</li>)}</ul>
        </Notice>
      ) : null,
    ].filter(Boolean);
    return (
      <>
        <OverviewScreen
          notices={notices.length ? <div className="mb-6 flex flex-col gap-3">{notices}</div> : null}
          actions={
            <>
              <LinkButton href={`${base}/reports/${a.id}`} icon={FileText}>Report</LinkButton>
              <Button variant="danger" icon={Trash2} onClick={() => setDeleting(true)}>Delete</Button>
              <LinkButton href={`${base}/audits/new?site=${data.site.id}`} variant="primary">Re-run</LinkButton>
            </>
          }
        />
        <DeleteAuditDialog audit={deleting ? a : null} onClose={() => setDeleting(false)} onDeleted={() => router.push(`${base}/audits`)} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title={data.site.name}
        meta={
          <>
            <AuditStatusBadge status={a.status} stale={a.stale} />
            {ws === "sample" ? <SampleTag /> : null}
            <span className="text-[13px] text-fg-3">
              Started {fmtDateTime(a.startedAt)}
              {a.finishedAt ? ` · took ${fmtDuration(a.startedAt, a.finishedAt)}` : ""}
            </span>
          </>
        }
        actions={
          !running ? (
            <>
              <LinkButton href={`${base}/reports/${a.id}`} icon={FileText}>Report</LinkButton>
              {data.previous ? <LinkButton href={`${base}/audits/${a.id}/compare`} icon={GitCompareArrows}>Compare</LinkButton> : null}
              <Button variant="danger" icon={Trash2} onClick={() => setDeleting(true)}>Delete</Button>
              <LinkButton href={`${base}/audits/new?site=${data.site.id}`} variant="primary">Re-run</LinkButton>
            </>
          ) : undefined
        }
      />

      {running ? (
        <div className="mb-6">
          <Progress initial={a} onDone={onDone} />
        </div>
      ) : null}

      {a.status === "failed" ? <div className="mb-6"><Notice tone="error" title="The audit failed"><FailureMessage error={a.error} fallback="Unknown error." /> Results collected before the failure are shown below and were not used to resolve any issue.</Notice></div> : null}
      {!running && a.coverage.length ? (
        <div className="mb-6">
          <Notice tone="warn" title={a.status === "partial" || a.status === "cancelled" ? "Partial audit: some of the site was not examined" : "Coverage notes"}>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 marker:text-fg-3">{a.coverage.map((c, i) => <li key={i}>{c.message}</li>)}</ul>
            <p className="mt-1.5">Findings on pages that were not re-examined are reported as “not re-checked”, never as resolved.</p>
          </Notice>
        </div>
      ) : null}

      {!running ? (
        <>
          <StatStrip
            items={[
              { label: "Findings", value: data.findings.length, hint: <SeverityCountsInline counts={counts} /> },
              { label: "Pages inspected", value: a.progress.inspected, hint: `${a.progress.failed} failed · ${a.progress.skipped} skipped · ${plural(a.progress.linksChecked, "link")} checked` },
              data.previous && changeCounts
                ? { label: "New since previous", value: (changeCounts.new ?? 0) + (changeCounts.regression ?? 0), hint: `${changeCounts.regression ?? 0} regressions · ${(changeCounts.persistent ?? 0) + (changeCounts.changed ?? 0)} persistent` }
                : { label: "New since previous", value: "—", hint: "First audit of this site" },
              data.gone ? { label: "No longer found", value: data.gone.resolved, hint: data.gone.notRechecked ? `+${data.gone.notRechecked} not re-checked (inconclusive)` : data.gone.resolved ? "Resolved: scope was fully re-examined" : "Nothing from the previous audit disappeared" } : { label: "No longer found", value: "—", hint: "Needs a previous audit" },
            ]}
          />

          <details className="group mt-4 rounded-[10px] border border-line-subtle bg-surface/60 text-sm">
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-2.5 text-[13px] text-fg-2 hover:text-fg">
              What this audit examined
              <span className="text-fg-3 group-open:rotate-180 transition-transform" aria-hidden>▾</span>
            </summary>
            <ul className="grid gap-1 border-t border-line-subtle px-4 py-3 text-[13px] text-fg-2 sm:grid-cols-2">
              {data.configLines.map((l) => <li key={l}>· {l}</li>)}
              <li>· Categories: {a.config.categories.length === RULE_CATEGORIES.length ? "all" : a.config.categories.join(", ")}</li>
              <li>· Thin-content threshold {a.ruleConfig.thinContentWords} words; multiple h1 {a.ruleConfig.multipleH1}</li>
            </ul>
          </details>

          <nav className="mb-5 mt-6 flex gap-1 overflow-x-auto border-b border-line-subtle" aria-label="Audit sections">
            {TABS.map((t) => {
              const p = new URLSearchParams(sp.toString());
              p.delete("finding");
              if (t.id === "findings") p.delete("tab");
              else p.set("tab", t.id);
              const n = t.id === "findings" ? data.findings.length : t.id === "pages" ? data.pages.length : data.linkChecks.length;
              return (
                <Link key={t.id} href={`${pathname}${p.size ? `?${p}` : ""}`} scroll={false} aria-current={tab === t.id ? "page" : undefined} className={cx("-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 pb-2.5 pt-1 text-sm transition-colors", tab === t.id ? "border-accent text-fg" : "border-transparent text-fg-2 hover:text-fg")}>
                  {t.label}
                  <span className="rounded bg-elevated px-1.5 text-xs tabular text-fg-3">{n}</span>
                </Link>
              );
            })}
          </nav>
          {tab === "pages" ? <PagesTable d={data} /> : tab === "crawl" ? <CrawlFiles d={data} /> : <FindingsTable d={data} />}
        </>
      ) : null}
      <DeleteAuditDialog audit={deleting ? a : null} onClose={() => setDeleting(false)} onDeleted={() => router.push(`${base}/audits`)} />
    </>
  );
}

export type { AuditFinding };

/** A failure's message, labelled with its code when it is one the user can act on (e.g. scope_rule_invalid). */
function FailureMessage({ error, fallback }: { error?: { code: string; message: string }; fallback: string }) {
  const { label, message } = failureText(error, fallback);
  return (
    <>
      {label ? <Mono className="mr-1.5 text-fg-2">{label}</Mono> : null}
      {message}
    </>
  );
}

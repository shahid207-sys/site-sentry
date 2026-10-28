"use client";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Braces, Download, FileText, GitCompareArrows, ListChecks, Printer, ScanSearch } from "lucide-react";
import { useMemo } from "react";
import type { AuditFinding } from "@/lib/audit/types";
import { WORKFLOW_STATUSES } from "@/lib/model";
import { CHANGE_LABELS, type AuditDetail, type AuditSummary, type TaskRow } from "@/lib/views";
import { SeverityCountsInline } from "../domain";
import { useApi } from "../lib/api";
import { fmtDate, fmtDateTime, plural, shortUrl } from "../lib/format";
import { useWs } from "../shell/context";
import { AuditStatusBadge, Breadcrumbs, Button, type Crumb, EmptyState, ErrorState, LinkButton, Mono, Notice, PageHeader, PageSkeleton, Panel, SampleTag, Select, SeverityBadge, btn } from "../ui";

// ---------- index ----------

export function ReportsView() {
  const { base, apiBase, sites } = useWs();
  const sp = useSearchParams();
  const router = useRouter();
  const site = sp.get("site") ?? sites.data?.[0]?.site.id ?? "";
  const audits = useApi<AuditSummary[]>(site ? `${apiBase}/audits?site=${site}` : null);
  const finished = (audits.data ?? []).filter((a) => a.status !== "running" && a.status !== "failed");
  const auditId = sp.get("audit") && finished.some((a) => a.id === sp.get("audit")) ? sp.get("audit")! : finished[0]?.id ?? "";
  const audit = finished.find((a) => a.id === auditId);
  const hasPrevious = audit ? finished.some((a) => a.startedAt < audit.startedAt) : false;
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(sp.toString());
    p.set(k, v);
    if (k === "site") p.delete("audit");
    router.replace(`${base}/reports?${p}`, { scroll: false });
  };

  const header = <PageHeader crumbs={[{ label: "Reports" }]} title="Reports" description="Client-facing and developer-facing deliverables generated from stored audits. Every report uses the same data you see in the app, and sample data is labelled." />;
  if (sites.error) return (<>{header}<ErrorState error={sites.error} onRetry={sites.reload} /></>);
  if ((sites.loading && !sites.data) || (audits.loading && !audits.data)) return <PageSkeleton rows={3} />;
  if (!sites.data?.length) return (<>{header}<Panel><EmptyState icon={FileText} title="Nothing to report yet">Add a site and run an audit first.</EmptyState></Panel></>);

  const items = audit
    ? [
        { icon: FileText, title: "Audit report", body: "Print-ready summary for a client or stakeholder: scope, coverage, findings by priority with evidence and recommendations. Save as PDF from the print dialog.", action: <LinkButton href={`${base}/reports/${audit.id}`} icon={Printer}>Open report</LinkButton> },
        { icon: ListChecks, title: "Developer handoff", body: "The site's active fix tasks, each with observed evidence, expected behaviour, remediation and acceptance criteria to check off.", action: <LinkButton href={`${base}/reports/handoff?site=${site}`} icon={Printer}>Open handoff</LinkButton> },
        { icon: GitCompareArrows, title: "Comparison report", body: hasPrevious ? "What changed since the previous audit: regressions, new, changed, resolved and not re-checked findings." : "Needs a previous finished audit of this site.", action: hasPrevious ? <LinkButton href={`${base}/audits/${audit.id}/compare`} icon={GitCompareArrows}>Open comparison</LinkButton> : <Button disabled icon={GitCompareArrows}>Open comparison</Button> },
        {
          icon: Download,
          title: "Data exports",
          body: "All findings of this audit. To export a filtered subset, filter the results table and use its CSV/JSON buttons. CSV cells are protected against spreadsheet formula injection.",
          action: (
            <span className="flex gap-2">
              <a className={btn("secondary")} href={`${apiBase}/audits/${audit.id}/export?format=csv`} download><Download aria-hidden /> CSV</a>
              <a className={btn("secondary")} href={`${apiBase}/audits/${audit.id}/export?format=json`} download><Braces aria-hidden /> JSON</a>
            </span>
          ),
        },
      ]
    : [];

  return (
    <>
      {header}
      <div className="mb-6 flex flex-col gap-2 sm:flex-row">
        <Select aria-label="Site" value={site} onChange={(e) => set("site", e.target.value)} className="sm:w-64">
          {sites.data.map((s) => <option key={s.site.id} value={s.site.id}>{s.site.name}</option>)}
        </Select>
        <Select aria-label="Audit" value={auditId} onChange={(e) => set("audit", e.target.value)} className="sm:w-80" disabled={!finished.length}>
          {finished.length ? finished.map((a) => <option key={a.id} value={a.id}>{fmtDateTime(a.startedAt)} · {a.status} · {plural(a.progress.inspected, "page")}</option>) : <option>No finished audits</option>}
        </Select>
      </div>
      {audits.error ? <ErrorState error={audits.error} onRetry={audits.reload} /> : !audit ? (
        <Panel><EmptyState icon={ScanSearch} title="No finished audits for this site" action={<LinkButton href={`${base}/audits/new?site=${site}`} variant="primary">Run an audit</LinkButton>} /></Panel>
      ) : (
        <div className="grid gap-px overflow-hidden rounded-[10px] border border-line bg-line-subtle md:grid-cols-2">
          {items.map((it) => {
            const Icon = it.icon;
            return (
              <section key={it.title} className="flex flex-col gap-3 bg-surface p-5">
                <div className="flex items-center gap-2.5">
                  <Icon className="size-4 text-fg-3" aria-hidden />
                  <h2 className="text-sm font-semibold text-fg">{it.title}</h2>
                </div>
                <p className="flex-1 text-[13px] text-fg-2">{it.body}</p>
                <div>{it.action}</div>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

// ---------- printable audit report ----------

function ReportShell({ children, crumbs, title }: { children: React.ReactNode; crumbs: Crumb[]; title: string }) {
  return (
    <div className="mx-auto max-w-[860px]">
      <div className="no-print mb-6 flex flex-wrap items-center justify-between gap-2">
        <Breadcrumbs crumbs={crumbs} className="min-w-0" />
        <Button variant="primary" icon={Printer} onClick={() => window.print()}>Print or save as PDF</Button>
      </div>
      <article aria-label={title} className="rounded-[10px] border border-line bg-surface px-5 py-8 sm:px-10 print:border-0 print:p-0">{children}</article>
    </div>
  );
}

function FindingBlock({ f, change }: { f: AuditFinding; change?: string }) {
  return (
    <section className="print-break border-t border-line-subtle py-5 first:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={f.priority.severity} priority={f.priority.level} />
        <Mono className="text-fg-3">{f.ruleCode}</Mono>
        {change ? <span className="text-xs text-fg-3">· {change}</span> : null}
        {f.certainty !== "verified" ? <span className="text-xs text-fg-3">· {f.certainty === "heuristic" ? "heuristic" : "needs review"}</span> : null}
      </div>
      <h3 className="mt-2 text-[15px] font-semibold text-fg">{f.title}</h3>
      <p className="mt-0.5 font-mono text-[12.5px] text-fg-2 evidence">{f.scope.kind === "page" ? f.pageUrl : f.evidence.urls?.length ? `${plural(f.evidence.urls.length, "URL")}: ${f.evidence.urls.slice(0, 5).map((u) => shortUrl(u.url)).join(", ")}${f.evidence.urls.length > 5 ? "…" : ""}` : "Site-wide"}</p>
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-[110px_1fr]">
        <dt className="text-fg-3">Observed</dt><dd className="evidence text-fg">{f.observed}</dd>
        <dt className="text-fg-3">Expected</dt><dd className="evidence text-fg">{f.expected}</dd>
        <dt className="text-fg-3">Why</dt><dd className="text-fg-2">{f.why}</dd>
        <dt className="text-fg-3">Recommended</dt><dd className="text-fg-2">{f.recommendations.join(" ")}</dd>
        <dt className="text-fg-3">Done when</dt><dd className="text-fg-2">{f.acceptanceCriteria.map((c) => c.description).join("; ")}</dd>
      </dl>
    </section>
  );
}

export function AuditReportView() {
  const { auditId } = useParams<{ auditId: string }>();
  const { ws, base, apiBase } = useWs();
  const { data, error, loading, reload } = useApi<AuditDetail>(`${apiBase}/audits/${auditId}`);
  const groups = useMemo(() => {
    const g: Record<number, AuditFinding[]> = {};
    for (const f of data?.findings ?? []) (g[f.priority.level] ??= []).push(f);
    return g;
  }, [data]);
  const crumbs = [{ label: "Reports", href: `${base}/reports${data ? `?site=${data.site.id}&audit=${data.audit.id}` : ""}` }, ...(data ? [{ label: data.site.name }] : []), { label: "Audit report" }];
  if (error) return (<><PageHeader title="Audit report" crumbs={crumbs} /><ErrorState error={error} onRetry={reload} /></>);
  if (loading && !data) return <PageSkeleton rows={6} />;
  if (!data) return null;
  const a = data.audit;
  if (a.status === "running") return (<><PageHeader title="Audit report" crumbs={crumbs} /><Notice tone="info" title="This audit is still running">Open the report when it has finished.</Notice></>);
  const notInspected = data.pages.filter((p) => p.outcome !== "inspected");
  const counts = a.findingCounts ?? { high: 0, medium: 0, low: 0 };

  return (
    <ReportShell crumbs={crumbs} title="Audit report">
      <header className="border-b border-line pb-6">
        <p className="text-xs font-medium uppercase tracking-wider text-accent-ink">SiteSentry · Technical SEO audit</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-fg">{data.site.name}</h1>
        <p className="mt-1 font-mono text-[13px] text-fg-2">{data.site.origin}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <AuditStatusBadge status={a.status} />
          {ws === "sample" ? <SampleTag /> : null}
          <span className="text-[13px] text-fg-3">Audited {fmtDateTime(a.startedAt)} · report generated {fmtDate(new Date().toISOString())}</span>
        </div>
        {ws === "sample" ? <p className="mt-3 text-[13px] text-sample">Sample data: a fictional website. These results are illustrative and do not describe a real site.</p> : null}
      </header>

      <section className="print-break border-b border-line py-6">
        <h2 className="text-sm font-semibold text-fg">Summary</h2>
        <div className="mt-3 grid gap-4 text-sm sm:grid-cols-3">
          <div><p className="text-fg-3 text-[13px]">Findings</p><p className="mt-0.5 text-xl font-semibold tabular text-fg">{data.findings.length}</p><SeverityCountsInline counts={counts} /></div>
          <div><p className="text-fg-3 text-[13px]">Pages inspected</p><p className="mt-0.5 text-xl font-semibold tabular text-fg">{a.progress.inspected}</p><p className="text-[13px] text-fg-3">{a.progress.failed} failed · {a.progress.skipped} skipped</p></div>
          <div><p className="text-fg-3 text-[13px]">Since previous audit</p>{data.changes ? <p className="mt-0.5 text-[13px] text-fg-2">{Object.entries(Object.values(data.changes).reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {})).map(([k, n]) => `${n} ${CHANGE_LABELS[k as keyof typeof CHANGE_LABELS].toLowerCase()}`).join(" · ")}{data.gone?.resolved ? ` · ${data.gone.resolved} resolved` : ""}</p> : <p className="mt-0.5 text-[13px] text-fg-3">First audit of this site</p>}</div>
        </div>
        <h3 className="mt-6 text-[13px] font-semibold text-fg">Scope</h3>
        <ul className="mt-1.5 text-[13px] text-fg-2">{data.configLines.map((l) => <li key={l}>· {l}</li>)}</ul>
        {a.coverage.length ? (
          <>
            <h3 className="mt-4 text-[13px] font-semibold text-fg">Coverage limits</h3>
            <ul className="mt-1.5 text-[13px] text-sev-medium">{a.coverage.map((c, i) => <li key={i}>· {c.message}</li>)}</ul>
          </>
        ) : null}
        <p className="mt-4 text-xs text-fg-3">Priority combines severity, whether the page is on the site&apos;s important-URL list, how many URLs are affected, and certainty. Heuristic observations (e.g. word counts) are labelled and never presented as ranking factors.</p>
      </section>

      {data.findings.length === 0 ? <p className="py-6 text-sm text-fg-2">No findings: every selected check passed on the inspected pages.</p> : null}
      {[1, 2, 3, 4].filter((l) => groups[l]?.length).map((l) => (
        <section key={l} className="py-6">
          <h2 className="text-sm font-semibold text-fg">Priority {l} <span className="font-normal text-fg-3">· {plural(groups[l].length, "finding")}</span></h2>
          <div className="mt-2">{groups[l].map((f) => <FindingBlock key={f.fingerprint} f={f} change={data.changes?.[f.fingerprint] ? CHANGE_LABELS[data.changes[f.fingerprint]] : undefined} />)}</div>
        </section>
      ))}

      {notInspected.length ? (
        <section className="print-break border-t border-line py-6">
          <h2 className="text-sm font-semibold text-fg">URLs not inspected ({notInspected.length})</h2>
          <ul className="mt-2 text-[13px]">{notInspected.map((p) => <li key={p.url} className="flex justify-between gap-4 border-b border-line-subtle py-1.5"><Mono className="evidence text-fg">{shortUrl(p.url)}</Mono><span className="shrink-0 text-fg-3">{p.error?.message ?? p.outcome.replace(/_/g, " ")}{p.status ? ` (HTTP ${p.status})` : ""}</span></li>)}</ul>
        </section>
      ) : null}
    </ReportShell>
  );
}

// ---------- developer handoff ----------

export function HandoffReportView() {
  const { ws, base, apiBase, sites } = useWs();
  const sp = useSearchParams();
  const site = sp.get("site");
  const { data, error, loading, reload } = useApi<TaskRow[]>(`${apiBase}/tasks`);
  const tasks = (data ?? []).filter((t) => (!site || t.siteId === site) && t.workflowStatus !== "resolved" && t.workflowStatus !== "wont_fix");
  const siteRow = sites.data?.find((s) => s.site.id === site);
  const crumbs = [{ label: "Reports", href: `${base}/reports${site ? `?site=${site}` : ""}` }, ...(siteRow ? [{ label: siteRow.site.name }] : []), { label: "Developer handoff" }];
  if (error) return (<><PageHeader title="Developer handoff" crumbs={crumbs} /><ErrorState error={error} onRetry={reload} /></>);
  if (loading && !data) return <PageSkeleton rows={6} />;
  return (
    <ReportShell crumbs={crumbs} title="Developer handoff">
      <header className="border-b border-line pb-6">
        <p className="text-xs font-medium uppercase tracking-wider text-accent-ink">SiteSentry · Developer handoff</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-fg">{siteRow?.site.name ?? "All sites"}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {ws === "sample" ? <SampleTag /> : null}
          <span className="text-[13px] text-fg-3">{plural(tasks.length, "open task")} · generated {fmtDate(new Date().toISOString())}</span>
        </div>
        <p className="mt-3 text-[13px] text-fg-2">Each task lists what was measured, what is expected, and the acceptance criteria SiteSentry will re-check after deployment. Recommendations are proposals; confirm them against how the site is built.</p>
      </header>
      {tasks.length === 0 ? <p className="py-6 text-sm text-fg-2">No open tasks for this site.</p> : null}
      {tasks.map((t, n) => (
        <section key={t.id} className="print-break border-b border-line py-6 last:border-0">
          <p className="font-mono text-xs text-fg-3">Task {n + 1} of {tasks.length}</p>
          <h2 className="mt-1 text-base font-semibold text-fg">{t.title}</h2>
          <p className="mt-1 text-[13px] text-fg-2">
            Status: {WORKFLOW_STATUSES.find((w) => w.id === t.workflowStatus)?.label} · Owner: {t.owner ?? "unassigned"} · Last verification: {t.verificationStatus.replace("_", " ")}
          </p>
          {t.notes ? <p className="mt-2 whitespace-pre-wrap text-[13px] text-fg">{t.notes}</p> : null}
          {t.items.map((i) => <FindingBlock key={i.fingerprint} f={i.finding} />)}
          {t.manualChecks.length ? (
            <ul className="mt-1 text-[13px] text-fg-2">{t.manualChecks.map((c) => <li key={c.id}>{c.done ? "☑" : "☐"} {c.text}</li>)}</ul>
          ) : null}
        </section>
      ))}
    </ReportShell>
  );
}

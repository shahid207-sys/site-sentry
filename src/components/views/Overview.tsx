"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, BadgeCheck, CircleAlert, CircleCheck, FileSearch, FileText, FlaskConical, Globe, ListChecks, Play, Plus, RefreshCw, ScanSearch, Settings2, TriangleAlert } from "lucide-react";
import { HEALTH_FORMULA, HEALTH_LABEL, HEALTH_NOTE, healthBand } from "@/lib/audit/health";
import type { ActionItem, AuditSummary, IssueGroupRow, OverviewData, SeverityCounts, SinceLast, SiteRow } from "@/lib/views";
import { AddSiteForm, SeverityCountsInline } from "../domain";
import { useApi } from "../lib/api";
import { fmtAgo, fmtDateTime, hostOf, plural, shortUrl } from "../lib/format";
import { useWs } from "../shell/context";
import { AuditStatusBadge, Donut, EmptyState, ErrorState, HealthBar, IconTile, LinkButton, Mono, Notice, PageHeader, PageSkeleton, Panel, SeverityBadge, StatStrip, cx } from "../ui";

const ACTION_ICON = { resume: Play, verify: RefreshCw, fix: CircleAlert, configure: Settings2 } as const;
const ACTION_LABEL = { resume: "Resume", verify: "Verify", fix: "Fix", configure: "Set up" } as const;
const KIND_LABEL = { defect: "Defect", warning: "Warning", opportunity: "Improvement", observation: "Needs review" } as const;
const PRIORITY_ROWS = 8;

const QUICK = [
  { href: "/audits/new", icon: Plus, tone: "accent", title: "New audit", detail: "Scan a URL, list or sitemap" },
  { href: "/issues", icon: CircleAlert, tone: "high", title: "Review issues", detail: "Grouped by check" },
  { href: "/tasks", icon: ListChecks, tone: "info", title: "Fix queue", detail: "Track and verify fixes" },
  { href: "/reports", icon: FileText, tone: "ok", title: "Reports", detail: "Handoffs and exports" },
] as const;

function QuickActions({ base }: { base: string }) {
  return (
    <Panel title="Quick actions">
      <div className="grid grid-cols-2 gap-3">
        {QUICK.map((q) => (
          <Link
            key={q.href}
            href={`${base}${q.href}`}
            className="group flex flex-col gap-3 rounded-xl border border-line bg-surface p-3.5 transition-[border-color,box-shadow,background-color] hover:border-line-strong hover:bg-surface-secondary hover:shadow-card"
          >
            <IconTile icon={q.icon} tone={q.tone} size="sm" />
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-fg group-hover:text-accent-ink">{q.title}</span>
              <span className="mt-0.5 block text-xs text-fg-3">{q.detail}</span>
            </span>
          </Link>
        ))}
      </div>
    </Panel>
  );
}

const SEV_ROWS = [
  { key: "high", label: "High", color: "var(--chart-high)" },
  { key: "medium", label: "Medium", color: "var(--chart-medium)" },
  { key: "low", label: "Low", color: "var(--chart-low)" },
] as const;

function SeverityDistribution({ open, base }: { open: SeverityCounts; base: string }) {
  const total = open.high + open.medium + open.low;
  return (
    <Panel title="Issues by severity" description="Open instances, one per check per page." actions={<LinkButton href={`${base}/issues`} size="sm" variant="ghost">View all</LinkButton>}>
      {total === 0 ? (
        <p className="flex items-center gap-1.5 text-sm font-medium text-ok">
          <CircleCheck className="size-4" aria-hidden /> No open issues.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-6">
          <Donut
            segments={SEV_ROWS.map((r) => ({ value: open[r.key], color: r.color }))}
            label={`${total} open issue instances: ${open.high} high, ${open.medium} medium, ${open.low} low`}
            center={
              <>
                <span className="text-2xl font-semibold leading-none tabular text-fg">{total}</span>
                <span className="mt-1 text-[11px] text-fg-3">open</span>
              </>
            }
          />
          <ul className="min-w-[150px] flex-1 space-y-2.5 text-sm">
            {SEV_ROWS.map((r) => (
              <li key={r.key}>
                <Link href={`${base}/issues?severity=${r.key}`} className="flex items-center gap-2.5 rounded-lg px-1.5 py-1 hover:bg-hover">
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: r.color }} aria-hidden />
                  <span className="flex-1 text-fg-2">{r.label}</span>
                  <span className="font-semibold tabular text-fg">{open[r.key]}</span>
                  <span className="w-10 text-right text-xs tabular text-fg-3">{Math.round((open[r.key] / total) * 100)}%</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

function SiteHealth({ s }: { s: SiteRow }) {
  if (s.health === null) return <span className="text-[13px] text-fg-3">Not audited</span>;
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap" title={`${HEALTH_LABEL[healthBand(s.health)]}. ${HEALTH_FORMULA}. ${HEALTH_NOTE}`}>
      <HealthBar score={s.health} />
    </span>
  );
}

function useGreeting() {
  // Computed after mount: the server doesn't know the viewer's local time.
  const [g, setG] = useState<string | null>(null);
  useEffect(() => {
    const h = new Date().getHours();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- needs the client clock
    setG(h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening");
  }, []);
  return g;
}

function ActionRow({ a }: { a: ActionItem }) {
  const Icon = ACTION_ICON[a.kind];
  return (
    <li>
      <Link href={a.href} className="group flex items-center gap-3 px-5 py-3 transition-colors hover:bg-surface-secondary">
        <span
          className={cx(
            "hidden size-8 shrink-0 place-items-center rounded-lg border sm:grid",
            a.kind === "verify" ? "border-accent/30 bg-accent-soft text-accent-ink" : a.kind === "resume" ? "border-info/30 bg-info-soft text-info" : "border-line bg-elevated text-fg-2",
          )}
        >
          <Icon className="size-4" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-sm text-fg sm:line-clamp-1">{a.title}</span>
          <span className="mt-0.5 block truncate text-[13px] text-fg-3">
            {a.siteName} · {a.detail}
          </span>
        </span>
        <span className="text-xs text-fg-3">{ACTION_LABEL[a.kind]}</span>
        <ArrowRight className="hidden size-4 shrink-0 text-fg-3 transition-transform group-hover:translate-x-0.5 group-hover:text-fg sm:block" aria-hidden />
      </Link>
    </li>
  );
}

function groupHref(base: string, g: IssueGroupRow) {
  return g.fingerprint ? `${base}/issues/${encodeURIComponent(g.fingerprint)}?site=${g.siteId}` : `${base}/issues?site=${g.siteId}&rule=${encodeURIComponent(g.ruleCode)}`;
}

function GroupRow({ g, base, showSite }: { g: IssueGroupRow; base: string; showSite: boolean }) {
  return (
    <li>
      <Link href={groupHref(base, g)} className="group flex items-start gap-3 px-5 py-3.5 transition-colors hover:bg-surface-secondary sm:items-center">
        <span className="w-[112px] shrink-0 pt-0.5 sm:pt-0">
          <SeverityBadge severity={g.severity} priority={g.priority} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-fg group-hover:text-accent-ink">{g.title}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[13px] text-fg-3">
            {showSite ? <span>{g.siteName}</span> : null}
            {showSite ? <span aria-hidden>·</span> : null}
            <span className="font-medium text-fg-2">{g.pages === 1 ? (g.samplePages[0] ? shortUrl(g.samplePages[0]) : "1 page") : `${g.pages} affected pages`}</span>
            <span aria-hidden>·</span>
            <span>{KIND_LABEL[g.kind]}</span>
          </span>
        </span>
        <span className="hidden shrink-0 text-right text-xs text-fg-3 sm:block">
          {g.withActiveTask ? <span className="text-info">{g.withActiveTask === g.instances ? "In fix queue" : `${g.withActiveTask} of ${g.instances} in fix queue`}</span> : "No task yet"}
        </span>
        <ArrowRight className="mt-0.5 hidden size-4 shrink-0 text-fg-3 transition-transform group-hover:translate-x-0.5 group-hover:text-fg sm:mt-0 sm:block" aria-hidden />
      </Link>
    </li>
  );
}

function PriorityWork({ data, base }: { data: OverviewData; base: string }) {
  const groups = data.groups;
  const showSite = data.totals.sites > 1;
  const highOpen = data.totals.open.high;
  return (
    <Panel
      title="Priority work"
      description="Open issues grouped by check, most urgent first. One row can cover many pages."
      flush
      actions={<LinkButton href={`${base}/issues`} size="sm" variant="ghost">All issues</LinkButton>}
    >
      {groups.length === 0 ? (
        <EmptyState compact icon={CircleCheck} title="No open issues">
          No audit currently reports a problem. Issues show up here after an audit finds something, and leave only when a later audit re-checks them.
        </EmptyState>
      ) : (
        <>
          {highOpen === 0 ? (
            <div className="border-b border-line-subtle px-5 py-3">
              <p className="flex items-start gap-2 text-[13px] text-fg-2">
                <CircleCheck className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden />
                <span>
                  <span className="font-medium text-fg">No high-severity issues are open.</span> What remains is medium or low severity: worth scheduling, not urgent.
                </span>
              </p>
            </div>
          ) : null}
          <ul className="divide-y divide-line-subtle">
            {groups.slice(0, PRIORITY_ROWS).map((g) => (
              <GroupRow key={`${g.siteId}:${g.ruleCode}`} g={g} base={base} showSite={showSite} />
            ))}
          </ul>
          {groups.length > PRIORITY_ROWS ? (
            <p className="border-t border-line-subtle px-5 py-3 text-[13px] text-fg-3">
              {plural(groups.length - PRIORITY_ROWS, "more issue type")} ·{" "}
              <Link href={`${base}/issues`} className="text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg">
                see all
              </Link>
            </p>
          ) : null}
        </>
      )}
    </Panel>
  );
}

function SinceLastPanel({ s }: { s: SinceLast | null }) {
  return (
    <Panel title="Since the previous audit" description={s ? `Latest vs previous finished audit, ${plural(s.comparedSites, "site")}.` : undefined}>
      {!s ? (
        <p className="text-[13px] text-fg-3">Needs two finished audits of the same site. Run another audit after your next deployment to see what changed.</p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
            {(
              [
                ["Regressions", s.regression, "Appeared where the previous audit checked and found nothing", s.regression ? "text-sev-high" : "text-fg"],
                ["Resolved", s.resolved, "Re-checked and no longer detected", s.resolved ? "text-ok" : "text-fg"],
                ["First detected", s.firstDetected, "The previous audit didn't check these pages or checks. Not a change.", "text-fg"],
                ["Not re-checked", s.notRechecked, "Outside the latest audit's scope. Status unknown, not fixed.", s.notRechecked ? "text-sev-medium" : "text-fg"],
              ] as const
            ).map(([label, n, hint, tone]) => (
              <div key={label}>
                <dt className="text-[13px] text-fg-2" title={hint}>{label}</dt>
                <dd className={cx("text-xl font-semibold tabular", tone)}>{n}</dd>
                <dd className="text-xs leading-snug text-fg-3">{hint}</dd>
              </div>
            ))}
          </dl>
          {s.narrowerBaselineSites.length ? (
            <div className="mt-4">
              <Notice tone="warn" title="Previous audit was narrower">
                The previous audit of {s.narrowerBaselineSites.join(", ")} checked fewer pages or categories than the latest one, so most findings are first detections, not new problems.
              </Notice>
            </div>
          ) : null}
        </>
      )}
    </Panel>
  );
}

function auditNote(a: AuditSummary) {
  const parts = [plural(a.progress.inspected, "page") + " inspected"];
  if (a.progress.failed) parts.push(`${a.progress.failed} failed`);
  if (a.status === "partial") parts.push(plural(a.coverage.length, "coverage limit"));
  return parts.join(" · ");
}

function RecentAudits({ audits, base }: { audits: AuditSummary[]; base: string }) {
  return (
    <Panel title="Recent audit activity" flush actions={<LinkButton href={`${base}/audits`} size="sm" variant="ghost">History</LinkButton>}>
      {audits.length ? (
        <ul className="divide-y divide-line-subtle">
          {audits.slice(0, 5).map((a) => (
            <li key={a.id}>
              <Link href={`${base}/audits/${a.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 hover:bg-surface-secondary">
                <AuditStatusBadge status={a.status} stale={a.stale} />
                <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{a.siteName}</span>
                <span className="text-xs text-fg-3" title={fmtDateTime(a.startedAt)}>
                  {fmtAgo(a.startedAt)}
                </span>
                <span className={cx("basis-full text-xs", a.progress.failed || a.status === "failed" ? "text-sev-high" : "text-fg-3")}>{auditNote(a)}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState compact icon={ScanSearch} title="No audits yet" />
      )}
    </Panel>
  );
}

function Onboarding() {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <Panel title="Add your first site" description="SiteSentry audits public pages, tracks each issue to a fix, and re-checks the live site to prove it.">
        <AddSiteForm autoFocus />
        <ol className="mt-6 grid gap-4 border-t border-line-subtle pt-5 text-sm sm:grid-cols-3">
          {[
            ["Audit", "Crawl one URL, a list, or the sitemap. Each finding carries its evidence."],
            ["Fix", "Turn findings into tasks with owners and frozen acceptance criteria."],
            ["Verify", "Re-fetch the page and judge it against those criteria. No guessing."],
          ].map(([t, d], i) => (
            <li key={t}>
              <span className="font-mono text-xs text-accent-ink">0{i + 1}</span>
              <p className="mt-1 font-medium text-fg">{t}</p>
              <p className="mt-0.5 text-[13px] text-fg-3">{d}</p>
            </li>
          ))}
        </ol>
      </Panel>
      <Panel title="Or explore the sample workspace">
        <p className="text-sm text-fg-2">Two fictional sites with four audits, six fix tasks, verification results and a regression, all produced by the real engine from bundled fixtures.</p>
        <LinkButton href="/sample" icon={FlaskConical} className="mt-4">
          Open sample workspace
        </LinkButton>
      </Panel>
    </div>
  );
}

function SiteHealthTable({ data, base }: { data: OverviewData; base: string }) {
  return (
    <Panel
      title="Site health overview"
      description="Health is a SiteSentry triage score from open issue types, not a search-engine metric."
      flush
      actions={<LinkButton href={`${base}/sites`} size="sm" variant="ghost">All sites</LinkButton>}
    >
      {/* Table on desktop, stacked rows on phones. */}
      <table className="hidden w-full text-sm xl:table">
        <thead>
          <tr className="border-b border-line-subtle text-left text-xs text-fg-3">
            <th className="px-5 py-3 font-medium">Website</th>
            <th className="px-4 py-3 font-medium">Health score</th>
            <th className="px-4 py-3 font-medium">Open issues</th>
            <th className="px-4 py-3 font-medium">Last audit</th>
            <th className="w-px px-5 py-3"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line-subtle">
          {data.sites.map((s) => {
            const a = s.runningAudit ?? s.lastAudit;
            return (
              <tr key={s.site.id} className="transition-colors hover:bg-surface-secondary">
                <td className="px-5 py-3.5">
                  <span className="flex items-center gap-3">
                    <IconTile icon={Globe} tone="neutral" size="sm" />
                    <span className="min-w-0">
                      <Link href={`${base}/sites/${s.site.id}`} className="block truncate font-semibold text-fg hover:text-accent-ink">
                        {s.site.name}
                      </Link>
                      <Mono className="block truncate text-xs text-fg-3">{hostOf(s.site.origin)}</Mono>
                    </span>
                  </span>
                </td>
                <td className="px-4 py-3.5"><SiteHealth s={s} /></td>
                <td className="px-4 py-3.5">
                  <Link href={`${base}/issues?site=${s.site.id}`} className="inline-flex min-w-max rounded-md hover:opacity-80" aria-label={`${s.openTotal} open issues on ${s.site.name}`}>
                    <SeverityCountsInline counts={s.open} compact />
                  </Link>
                </td>
                <td className="px-4 py-3.5">
                  {a ? (
                    <Link href={`${base}/audits/${a.id}`} className="inline-flex items-center gap-2">
                      <AuditStatusBadge status={a.status} stale={a.stale} />
                      <span className="whitespace-nowrap text-[13px] text-fg-2" title={fmtDateTime(a.startedAt)}>{fmtAgo(a.startedAt)}</span>
                    </Link>
                  ) : (
                    <span className="text-[13px] text-fg-3">Never audited</span>
                  )}
                </td>
                <td className="px-5 py-3.5 text-right">
                  <span className="flex items-center justify-end gap-1">
                                        <LinkButton href={`${base}/sites/${s.site.id}`} size="sm">View</LinkButton>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <ul className="divide-y divide-line-subtle xl:hidden">
        {data.sites.map((s) => {
          const a = s.runningAudit ?? s.lastAudit;
          return (
            <li key={s.site.id}>
              <Link href={`${base}/sites/${s.site.id}`} className="block px-5 py-3.5 hover:bg-surface-secondary">
                <span className="flex items-center justify-between gap-3">
                  <span className="truncate font-semibold text-fg">{s.site.name}</span>
                  <SiteHealth s={s} />
                </span>
                <span className="mt-1.5 flex items-center justify-between gap-3">
                  <SeverityCountsInline counts={s.open} compact />
                  {a ? <AuditStatusBadge status={a.status} stale={a.stale} /> : <span className="text-xs text-fg-3">Never audited</span>}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

export function OverviewView() {
  const { ws, apiBase, base } = useWs();
  const { data, error, loading, reload } = useApi<OverviewData>(`${apiBase}/overview`);
  const greeting = useGreeting();

  const header = (
    <PageHeader
      crumbs={[{ label: "Overview" }]}
      title="SEO operations overview"
      description={
        data && data.totals.sites
          ? `${greeting ? `${greeting}. ` : ""}Here is what needs attention across ${plural(data.totals.sites, "site")} and what changed since the previous audit.`
          : "Find the issue. Understand the evidence. Ship the fix. Verify the result."
      }
    />
  );

  if (error) return (<>{header}<ErrorState error={error} onRetry={reload} /></>);
  if (loading && !data) return (<>{header}<PageSkeleton /></>);
  if (!data) return null;
  if (data.totals.sites === 0) {
    return (
      <>
        {header}
        {ws === "live" ? <Onboarding /> : <Panel><EmptyState icon={FlaskConical} title="The sample workspace is empty">Reset it from Settings to restore the bundled examples.</EmptyState></Panel>}
      </>
    );
  }

  const t = data.totals;
  const sl = t.sinceLast;
  return (
    <>
      {header}
      <StatStrip
        items={[
          { label: "Sites", value: t.sites, hint: plural(t.auditsFinished, "finished audit"), href: `${base}/sites`, icon: Globe, tone: "accent" },
          { label: "Pages inspected", value: t.pagesInspected, hint: "By each site's latest audit", icon: FileSearch, tone: "info" },
          {
            label: "Open issue types",
            value: t.openGroups,
            hint: sl ? (
              <>
                <span className={sl.regression ? "font-medium text-sev-high" : undefined}>{plural(sl.regression, "regression")}</span> since previous audit
              </>
            ) : (
              plural(t.openTotal, "instance") + " across pages"
            ),
            href: `${base}/issues`,
            icon: CircleAlert,
            tone: "high",
          },
          {
            label: "Fixes verified",
            value: t.verifiedTasks,
            hint: sl ? (
              <>
                <span className={sl.resolved ? "font-medium text-ok" : undefined}>{sl.resolved} resolved</span> since previous audit
              </>
            ) : (
              `${t.resolvedTotal} issues resolved`
            ),
            href: `${base}/tasks`,
            icon: BadgeCheck,
            tone: "ok",
          },
        ]}
      />

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <SiteHealthTable data={data} base={base} />
        <SeverityDistribution open={t.open} base={base} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <PriorityWork data={data} base={base} />
        <div className="flex flex-col gap-6">
          <Panel title="Next actions" description="Audits to resume, fixes to verify, sites to set up." flush actions={<LinkButton href={`${base}/tasks`} size="sm" variant="ghost">Fix queue</LinkButton>}>
            {data.actions.length ? (
              <ul className="divide-y divide-line-subtle">
                {data.actions.map((a, i) => (
                  <ActionRow key={i} a={a} />
                ))}
              </ul>
            ) : (
              <EmptyState compact icon={ListChecks} title="Nothing waiting">
                No audit is running and no fix is ready to verify. Pick an issue from Priority work to start a task.
              </EmptyState>
            )}
          </Panel>
          <SinceLastPanel s={sl} />
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <RecentAudits audits={data.recentAudits} base={base} />
        <QuickActions base={base} />
      </div>
      {sl?.regression ? (
        <p className="mt-4 flex items-center gap-1.5 text-[13px] text-sev-high">
          <TriangleAlert className="size-4" aria-hidden />
          {plural(sl.regression, "regression")} since the previous audit. Regressed issues are marked in Issues.
        </p>
      ) : null}
    </>
  );
}

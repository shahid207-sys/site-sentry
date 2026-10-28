"use client";
// The public sample audit. Everything shown comes from getSampleShowcase(): the bundled sample
// workspace, produced by the real engine. Nothing here is hand-written audit data.
import { useId, useState } from "react";
import { ArrowRight, BadgeCheck, CircleAlert, CircleCheck, CircleDashed, Download, FileText, FlaskConical, LayoutDashboard, ListChecks, Lightbulb, TriangleAlert, type LucideIcon } from "lucide-react";
import { HEALTH_FORMULA, HEALTH_LABEL, HEALTH_NOTE } from "@/lib/audit/health";
import { RULE_CATEGORIES, type Severity } from "@/lib/audit/types";
import type { SampleShowcase, ShowcaseIssue } from "@/lib/sample/showcase";
import { HeroAuditForm } from "../marketing/HeroAuditForm";
import { Button, CertaintyBadge, cx, IconTile, LinkButton, Mono, ScoreRing, SeverityBadge, type Tone } from "../ui";

type Tab = "overview" | "issues" | "pages" | "recommendations";
const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "issues", label: "Issues", icon: CircleAlert },
  { id: "pages", label: "Pages", icon: FileText },
  { id: "recommendations", label: "Recommendations", icon: Lightbulb },
];
const SEV_TONE: Record<Severity, Tone> = { high: "high", medium: "medium", low: "low" };
const SEV_ICON: Record<Severity, LucideIcon> = { high: CircleAlert, medium: TriangleAlert, low: CircleDashed };
const SEV_NAME: Record<Severity, string> = { high: "High severity", medium: "Medium severity", low: "Low severity" };
const CATEGORY = Object.fromEntries(RULE_CATEGORIES.map((c) => [c.id, c.label])) as Record<string, string>;

const path = (url: string, origin: string) => (url.startsWith(origin) ? url.slice(origin.length) || "/" : url);

export function PublicSampleAudit({ data, auditedLabel }: { data: SampleShowcase; auditedLabel: string }) {
  const [tab, setTab] = useState<Tab>("overview");
  const [selected, setSelected] = useState(data.issues[0]?.ruleCode ?? "");
  const [sevFilter, setSevFilter] = useState<Severity | "all">("all");
  const tabsId = useId();
  const issue = data.issues.find((i) => i.ruleCode === selected) ?? data.issues[0];
  const pick = (code: string) => {
    setSelected(code);
    setTab("issues");
  };

  const download = () => {
    const blob = new Blob([JSON.stringify({ note: "SiteSentry sample audit: fictional site, deterministic engine output.", ...data }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "sitesentry-sample-audit.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="bg-bg">
      {/* Header */}
      <section aria-labelledby="sample-heading" className="hero-glow border-b border-line">
        <div className="mx-auto max-w-6xl px-4 pb-10 pt-12 sm:px-6 sm:pt-16">
          <p className="inline-flex items-center gap-1.5 rounded-full bg-sample-soft px-3 py-1 text-xs font-medium text-sample">
            <FlaskConical className="size-3.5" aria-hidden />
            Sample data · fictional site
          </p>
          <h1 id="sample-heading" className="mt-4 max-w-3xl text-[2rem] font-semibold leading-[1.1] tracking-[-0.03em] text-fg sm:text-[2.75rem]">
            Explore a full audit of a sample store
          </h1>
          <p className="mt-3 max-w-2xl text-base leading-relaxed text-fg-2 sm:text-lg">
            {data.siteName} is a fictional shop bundled with SiteSentry. This is the engine&apos;s real output for its latest audit on {auditedLabel}: {data.pagesInspected} pages inspected, every finding with its evidence.
          </p>
          <div className="mt-7 max-w-2xl">
            <p className="mb-2 text-sm font-medium text-fg">Ready for your own site?</p>
            <HeroAuditForm compact />
          </div>
        </div>
      </section>

      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 px-4 py-8 sm:px-6 lg:grid-cols-[220px_minmax(0,1fr)] lg:py-10">
        {/* Sub navigation */}
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <div role="tablist" aria-label="Sample audit sections" aria-orientation="vertical" className="flex gap-1 overflow-x-auto rounded-2xl border border-line bg-surface p-1.5 shadow-card lg:flex-col">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`${tabsId}-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls={`${tabsId}-panel`}
                onClick={() => setTab(t.id)}
                className={cx(
                  "flex h-10 shrink-0 items-center gap-2.5 whitespace-nowrap rounded-[10px] px-3 text-sm transition-colors",
                  tab === t.id ? "bg-accent-soft font-semibold text-accent-ink" : "font-medium text-fg-2 hover:bg-hover hover:text-fg",
                )}
              >
                <t.icon className="size-4 shrink-0" aria-hidden />
                {t.label}
                {t.id === "issues" ? <span className="ml-auto rounded-full bg-elevated px-1.5 text-xs tabular text-fg-2">{data.issues.length}</span> : null}
              </button>
            ))}
          </div>
          <div className="mt-3 hidden flex-col gap-2 lg:flex">
            <Button onClick={download} icon={Download} className="w-full">
              Download JSON
            </Button>
            <LinkButton href={`/sample/reports/${data.auditId}`} icon={FileText} className="w-full">
              Open full report
            </LinkButton>
          </div>
        </aside>

        <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${tab}`} className="min-w-0">
          {tab === "overview" ? <OverviewTab data={data} onPick={pick} /> : null}
          {tab === "issues" && issue ? (
            <IssuesTab data={data} issue={issue} selected={issue.ruleCode} onSelect={setSelected} sev={sevFilter} onSev={setSevFilter} />
          ) : null}
          {tab === "pages" ? <PagesTab data={data} /> : null}
          {tab === "recommendations" ? <RecommendationsTab data={data} onPick={pick} /> : null}

          <div className="mt-6 flex flex-wrap gap-2 lg:hidden">
            <Button onClick={download} icon={Download}>Download JSON</Button>
            <LinkButton href={`/sample/reports/${data.auditId}`} icon={FileText}>Open full report</LinkButton>
          </div>

          <div className="mt-8 flex flex-col gap-4 rounded-2xl border border-line bg-surface p-6 shadow-card sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-base font-semibold text-fg">Go deeper in the sample workspace</h2>
              <p className="mt-1 text-sm text-fg-2">Fix tasks, verification results, a regression and an audit comparison, all from the same fictional sites.</p>
            </div>
            <LinkButton href="/sample" variant="primary" className="shrink-0">
              Open the sample workspace
              <ArrowRight className="size-4" aria-hidden />
            </LinkButton>
          </div>
        </div>
      </div>
    </div>
  );
}

function Card({ title, children, actions, className }: { title?: string; children: React.ReactNode; actions?: React.ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-2xl border border-line bg-surface shadow-card", className)} aria-label={title}>
      {title ? (
        <div className="flex items-center justify-between gap-3 px-5 pb-1 pt-4">
          <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
          {actions}
        </div>
      ) : null}
      <div className="px-5 pb-5 pt-3">{children}</div>
    </section>
  );
}

function OverviewTab({ data, onPick }: { data: SampleShowcase; onPick: (code: string) => void }) {
  const tiles: { label: string; value: number; icon: LucideIcon; tone: Tone; hint: string }[] = [
    { label: "High", value: data.openTypes.high, icon: CircleAlert, tone: "high", hint: "issue types" },
    { label: "Medium", value: data.openTypes.medium, icon: TriangleAlert, tone: "medium", hint: "issue types" },
    { label: "Low", value: data.openTypes.low, icon: CircleDashed, tone: "low", hint: "issue types" },
    { label: "Passed", value: data.passedChecks, icon: BadgeCheck, tone: "ok", hint: "checks with nothing open" },
  ];
  return (
    <div className="space-y-6">
      <div className="grid gap-6 xl:grid-cols-[300px_minmax(0,1fr)]">
        <Card title="Site health">
          <div className="flex flex-col items-center text-center">
            <ScoreRing score={data.health} size={148} stroke={12} label="Site health" sublabel={HEALTH_LABEL[data.band]} />
            <p className="mt-4 text-[13px] leading-relaxed text-fg-3" title={HEALTH_FORMULA}>
              {HEALTH_NOTE}
            </p>
            {data.history.length > 1 ? (
              <p className="mt-3 rounded-full bg-ok-soft px-3 py-1 text-xs font-medium text-ok">
                Up from {data.history[0].health} on the first audit
              </p>
            ) : null}
          </div>
        </Card>
        <div className="grid grid-cols-2 gap-4 self-start">
          {tiles.map((t) => (
            <div key={t.label} className="rounded-2xl border border-line bg-surface p-5 shadow-card">
              <div className="flex items-start justify-between gap-2">
                <p className="text-[13px] font-medium text-fg-2">{t.label}</p>
                <IconTile icon={t.icon} tone={t.tone} size="sm" />
              </div>
              <p className="mt-2 text-[28px] font-semibold leading-none tabular text-fg">{t.value}</p>
              <p className="mt-2 text-xs text-fg-3">{t.hint}</p>
            </div>
          ))}
          <p className="col-span-2 text-[13px] text-fg-3">
            {data.instances.high + data.instances.medium + data.instances.low} open instances across {data.pagesInspected} pages.
            {data.sinceLast ? ` Since the previous audit: ${data.sinceLast.resolved} resolved, ${data.sinceLast.regression} regressed.` : ""}
          </p>
        </div>
      </div>

      <Card title="Top issues" actions={<span className="text-xs text-fg-3">Most urgent first</span>}>
        <ul className="-mx-2 divide-y divide-line-subtle">
          {data.issues.slice(0, 6).map((i) => (
            <li key={i.ruleCode}>
              <button type="button" onClick={() => onPick(i.ruleCode)} className="group flex w-full items-center gap-3 rounded-lg px-2 py-3 text-left hover:bg-surface-secondary">
                <IconTile icon={SEV_ICON[i.severity]} tone={SEV_TONE[i.severity]} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-fg group-hover:text-accent-ink">{i.title}</span>
                  <span className="mt-0.5 block text-xs text-fg-3">{CATEGORY[i.category] ?? i.category}</span>
                </span>
                <span className="hidden text-xs tabular text-fg-2 sm:block">{i.pages.length === 1 ? "1 page" : `${i.pages.length} pages`}</span>
                <SeverityBadge severity={i.severity} />
                <ArrowRight className="size-4 shrink-0 text-fg-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function IssuesTab({ data, issue, selected, onSelect, sev, onSev }: { data: SampleShowcase; issue: ShowcaseIssue; selected: string; onSelect: (c: string) => void; sev: Severity | "all"; onSev: (s: Severity | "all") => void }) {
  const list = data.issues.filter((i) => sev === "all" || i.severity === sev);
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <Card title={`${data.issues.length} issue types`}>
        <div role="group" aria-label="Filter by severity" className="mb-3 flex flex-wrap gap-1.5">
          {(["all", "high", "medium", "low"] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={sev === s}
              onClick={() => onSev(s)}
              className={cx("h-8 rounded-full border px-3 text-[13px] font-medium capitalize transition-colors", sev === s ? "border-accent/40 bg-accent-soft text-accent-ink" : "border-line text-fg-2 hover:bg-hover")}
            >
              {s === "all" ? "All" : s}
            </button>
          ))}
        </div>
        <ul className="-mx-2 space-y-1">
          {list.map((i) => (
            <li key={i.ruleCode}>
              <button
                type="button"
                aria-pressed={selected === i.ruleCode}
                onClick={() => onSelect(i.ruleCode)}
                className={cx("flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors", selected === i.ruleCode ? "bg-accent-softer ring-1 ring-accent/30" : "hover:bg-surface-secondary")}
              >
                <span className="mt-0.5"><SeverityBadge severity={i.severity} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-fg">{i.title}</span>
                  <span className="mt-0.5 block text-xs text-fg-3">
                    {i.pages.length === 1 ? path(i.pages[0], data.origin) : `${i.pages.length} pages`} · {CATEGORY[i.category] ?? i.category}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Card>

      <section aria-labelledby="issue-preview" className="self-start rounded-2xl border border-line bg-surface shadow-card">
        <div className="border-b border-line-subtle px-5 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={issue.severity} priority={issue.priority} />
            <CertaintyBadge certainty={issue.certainty} />
            <Mono className="text-fg-3">{issue.ruleCode}</Mono>
          </div>
          <h2 id="issue-preview" className="mt-2.5 text-lg font-semibold tracking-[-0.01em] text-fg">{issue.title}</h2>
          <p className="mt-1 text-xs text-fg-3">{SEV_NAME[issue.severity]} · {issue.pages.map((p) => path(p, data.origin)).join(", ")}</p>
        </div>
        <div className="space-y-5 px-5 py-5">
          <div>
            <h3 className="text-[13px] font-semibold text-fg">What&apos;s wrong</h3>
            <p className="mt-1 text-sm leading-relaxed text-fg-2">{issue.why}</p>
            <dl className="mt-3 grid gap-2 rounded-xl border border-line-subtle bg-surface-secondary p-3 text-[13px]">
              <div className="flex gap-2"><dt className="w-[72px] shrink-0 text-fg-3">Observed</dt><dd className="evidence min-w-0 text-fg">{issue.observed}</dd></div>
              <div className="flex gap-2"><dt className="w-[72px] shrink-0 text-fg-3">Expected</dt><dd className="evidence min-w-0 text-fg">{issue.expected}</dd></div>
            </dl>
          </div>
          {issue.snippet ? (
            <div>
              <h3 className="text-[13px] font-semibold text-fg">Example from the page</h3>
              <pre className="evidence mt-2 max-h-48 overflow-auto rounded-xl bg-[#111827] p-3.5 font-mono text-[12.5px] leading-relaxed text-[#e5e7eb]">{issue.snippet}</pre>
            </div>
          ) : null}
          {issue.recommendations.length ? (
            <div>
              <h3 className="text-[13px] font-semibold text-fg">How to fix</h3>
              <ul className="mt-2 space-y-1.5 text-sm text-fg-2">
                {issue.recommendations.map((r) => (
                  <li key={r} className="flex gap-2"><ArrowRight className="mt-0.5 size-4 shrink-0 text-accent-ink" aria-hidden />{r}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div>
            <h3 className="text-[13px] font-semibold text-fg">Acceptance criteria</h3>
            <p className="mt-0.5 text-xs text-fg-3">A fix task freezes these; a re-check of the live page must pass every one.</p>
            <ul className="mt-2 space-y-1.5 text-sm text-fg-2">
              {issue.criteria.map((c) => (
                <li key={c} className="flex gap-2"><CircleCheck className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden />{c}</li>
              ))}
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}

function PagesTab({ data }: { data: SampleShowcase }) {
  return (
    <Card title={`${data.pages.length} pages fetched`}>
      <div className="-mx-5 overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-line-subtle text-left text-xs text-fg-3">
              <th className="px-5 py-2.5 font-medium">Page</th>
              <th className="px-3 py-2.5 font-medium">Status</th>
              <th className="px-3 py-2.5 font-medium">Title</th>
              <th className="px-5 py-2.5 text-right font-medium">Open issues</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-subtle">
            {data.pages.map((p) => (
              <tr key={p.url}>
                <td className="px-5 py-3"><Mono className="text-fg">{path(p.url, data.origin)}</Mono></td>
                <td className="px-3 py-3">
                  <span className={cx("rounded-full px-2 py-0.5 text-xs font-medium tabular", p.status && p.status < 300 ? "bg-ok-soft text-ok" : p.status && p.status < 400 ? "bg-info-soft text-info" : "bg-sev-high-soft text-sev-high")}>
                    {p.status ?? p.outcome}
                  </span>
                </td>
                <td className="max-w-[260px] truncate px-3 py-3 text-fg-2" title={p.title ?? undefined}>{p.title ?? <span className="text-fg-3">No title</span>}</td>
                <td className="px-5 py-3 text-right font-semibold tabular text-fg">{p.openIssues}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function RecommendationsTab({ data, onPick }: { data: SampleShowcase; onPick: (code: string) => void }) {
  return (
    <Card title="Recommended order of work" actions={<ListChecks className="size-4 text-fg-3" aria-hidden />}>
      <ol className="space-y-3">
        {data.issues.map((i, n) => (
          <li key={i.ruleCode} className="flex gap-3 rounded-xl border border-line-subtle p-3.5">
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-semibold tabular text-accent-ink">{n + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => onPick(i.ruleCode)} className="text-left text-sm font-semibold text-fg hover:text-accent-ink">
                  {i.title}
                </button>
                <SeverityBadge severity={i.severity} priority={i.priority} />
              </div>
              {i.recommendations[0] ? <p className="mt-1 text-[13px] leading-relaxed text-fg-2">{i.recommendations[0]}</p> : null}
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

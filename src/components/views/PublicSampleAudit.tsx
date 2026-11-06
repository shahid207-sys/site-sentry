"use client";
// The public sample audit. Everything shown comes from getSampleShowcase(): two real crawler v2 audits of the
// bundled fixture shop (scripts/sample-v2.ts). Nothing here is hand-written audit data.
import { useId, useState } from "react";
import { ArrowRight, BadgeCheck, CircleCheck, Download, ExternalLink, GitCompareArrows, LayoutDashboard, Lightbulb, ListChecks, ListTree, type LucideIcon } from "lucide-react";
import type { GroupChange } from "@/lib/results/queries";
import type { Priority } from "@/lib/results/priority";
import { RULE_TITLES } from "@/lib/rules/titles";
import { samplePath, type SampleShowcase, type ShowcaseGroup } from "@/lib/sample/showcase";
import { HeroAuditForm } from "../marketing/HeroAuditForm";
import { categoryLabel, IssueStateBadge, PRIORITIES, PriorityBadge, priorityLabel, priorityText } from "../v2/badges";
import { Button, cx, LinkButton, Mono, ScoreRing } from "../ui";

type Tab = "overview" | "issues" | "changes" | "recommendations";
const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "issues", label: "Issues", icon: ListTree },
  { id: "changes", label: "Since last audit", icon: GitCompareArrows },
  { id: "recommendations", label: "Recommendations", icon: Lightbulb },
];
const CHANGE_ORDER: GroupChange[] = ["new", "regressed", "resolved", "not_rechecked", "persistent"];
const CHANGE_NOTE: Record<GroupChange, string> = {
  new: "Found for the first time",
  regressed: "Fixed before, found again",
  resolved: "Re-checked and no longer found",
  not_rechecked: "Not re-examined by this audit",
  persistent: "Still open from the previous audit",
};
const pages = (n: number) => (n === 1 ? "1 page" : `${n.toLocaleString("en-GB")} pages`);
const title = (ruleId: string) => RULE_TITLES[ruleId] ?? ruleId;

export function PublicSampleAudit({ data, auditedLabel }: { data: SampleShowcase; auditedLabel: string }) {
  const [tab, setTab] = useState<Tab>("overview");
  const [selected, setSelected] = useState(data.groups[0]?.ruleId ?? "");
  const [filter, setFilter] = useState<Priority | "all">("all");
  const tabsId = useId();
  const group = data.groups.find((g) => g.ruleId === selected) ?? data.groups[0];
  const pick = (ruleId: string) => {
    setSelected(ruleId);
    setTab("issues");
  };

  const download = () => {
    const blob = new Blob([JSON.stringify({ note: "SiteSentry sample audit: fictional site, real crawler v2 engine output.", ...data }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "sitesentry-sample-audit.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="bg-bg">
      <section aria-labelledby="sample-heading" className="hero-glow border-b border-line">
        <div className="mx-auto max-w-6xl px-4 pb-10 pt-12 sm:px-6 sm:pt-16">
          <p className="inline-flex items-center gap-1.5 rounded-full bg-sample-soft px-3 py-1 text-xs font-medium text-sample">
            <BadgeCheck className="size-3.5" aria-hidden />
            Sample data · fictional site
          </p>
          <h1 id="sample-heading" className="mt-4 max-w-3xl text-[2rem] font-semibold leading-[1.1] tracking-[-0.03em] text-fg sm:text-[2.75rem]">
            Explore a full audit of a sample store
          </h1>
          <p className="mt-3 max-w-2xl text-base leading-relaxed text-fg-2 sm:text-lg">
            {data.siteName} is a fictional shop bundled with SiteSentry. This is the engine&apos;s real output for a Standard audit on {auditedLabel}: {data.pagesInspected} pages crawled, {data.rulesRan} checks run, every issue grouped with its evidence.
          </p>
          <div className="mt-7 max-w-2xl">
            <p className="mb-2 text-sm font-medium text-fg">Ready for your own site?</p>
            <HeroAuditForm compact />
          </div>
        </div>
      </section>

      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 px-4 py-8 sm:px-6 lg:grid-cols-[220px_minmax(0,1fr)] lg:py-10">
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
                {t.id === "issues" ? <span className="ml-auto rounded-full bg-elevated px-1.5 text-xs tabular text-fg-2">{data.groups.length}</span> : null}
              </button>
            ))}
          </div>
          <div className="mt-3 hidden lg:block">
            <Button onClick={download} icon={Download} className="w-full">
              Download JSON
            </Button>
          </div>
        </aside>

        <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${tab}`} className="min-w-0">
          {tab === "overview" ? <OverviewTab data={data} onPick={pick} /> : null}
          {tab === "issues" && group ? <IssuesTab data={data} group={group} onSelect={setSelected} filter={filter} onFilter={setFilter} /> : null}
          {tab === "changes" ? <ChangesTab data={data} onPick={pick} /> : null}
          {tab === "recommendations" ? <RecommendationsTab data={data} onPick={pick} /> : null}

          <div className="mt-6 lg:hidden">
            <Button onClick={download} icon={Download}>Download JSON</Button>
          </div>

          <div className="mt-8 flex flex-col gap-4 rounded-2xl border border-line bg-surface p-6 shadow-card sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-base font-semibold text-fg">Go deeper in the sample workspace</h2>
              <p className="mt-1 text-sm text-fg-2">Fix tasks, verification results, a regression and an audit comparison, all from fictional sites.</p>
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

function GroupRow({ g, onPick }: { g: ShowcaseGroup; onPick: (ruleId: string) => void }) {
  return (
    <button type="button" onClick={() => onPick(g.ruleId)} className="group flex w-full items-center gap-3 rounded-lg px-2 py-3 text-left hover:bg-surface-secondary">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-fg group-hover:text-accent-ink">{g.title}</span>
        <span className="mt-0.5 block text-xs text-fg-3">
          {categoryLabel(g.category)} · <Mono className="text-[11.5px]">{g.ruleId}</Mono>
        </span>
      </span>
      <span className="hidden text-xs tabular text-fg-2 sm:block">{pages(g.affectedUrls)}</span>
      <PriorityBadge priority={g.priority} score={g.score} />
      <ArrowRight className="size-4 shrink-0 text-fg-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
    </button>
  );
}

function OverviewTab({ data, onPick }: { data: SampleShowcase; onPick: (ruleId: string) => void }) {
  const first = data.history[0];
  const shown = PRIORITIES.filter((p) => p !== "critical" || data.priorities.critical > 0);
  return (
    <div className="space-y-6">
      <div className="grid gap-6 xl:grid-cols-[300px_minmax(0,1fr)]">
        <Card title="Site health">
          <div className="flex flex-col items-center text-center">
            {data.health === null ? <p className="text-sm text-fg-2">No score</p> : <ScoreRing score={data.health} size={148} stroke={12} label="Site health" sublabel="of 100" />}
            <p className="mt-4 text-[13px] leading-relaxed text-fg-3">Each category scores its checks; categories are weighted into one number. A triage indicator, not a search-engine metric.</p>
            {first && data.history.length > 1 && data.health !== null ? (
              <p className="mt-3 rounded-full bg-ok-soft px-3 py-1 text-xs font-medium text-ok">Up from {first.health} on the previous audit</p>
            ) : null}
          </div>
        </Card>
        <div className="grid grid-cols-2 gap-4 self-start sm:grid-cols-3">
          {shown.map((p) => (
            <div key={p} className="rounded-2xl border border-line bg-surface p-5 shadow-card">
              <PriorityBadge priority={p} />
              <p className={cx("mt-3 text-[28px] font-semibold leading-none tabular", data.priorities[p] ? priorityText(p) : "text-fg")}>{data.priorities[p]}</p>
              <p className="mt-2 text-xs text-fg-3">issue groups</p>
            </div>
          ))}
          <div className="rounded-2xl border border-line bg-surface p-5 shadow-card">
            <p className="text-[13px] font-medium text-fg-2">Coverage</p>
            <p className="mt-3 text-[28px] font-semibold leading-none tabular text-fg">{data.coveragePercent}%</p>
            <p className="mt-2 text-xs text-fg-3">
              {data.pagesInspected} of {data.budget ?? "∞"} page budget
            </p>
          </div>
          <p className="col-span-2 text-[13px] text-fg-3 sm:col-span-3">
            One group per check: a template bug on 300 pages is one item to fix, not 300.
            {data.comparison ? ` Since the previous audit: ${data.comparison.totals.resolved} resolved, ${data.comparison.totals.new} new.` : ""}
          </p>
        </div>
      </div>

      <Card title="Top issues" actions={<span className="text-xs text-fg-3">Highest priority first</span>}>
        <ul className="-mx-2 divide-y divide-line-subtle">
          {data.groups.slice(0, 6).map((g) => (
            <li key={g.ruleId}>
              <GroupRow g={g} onPick={onPick} />
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function IssuesTab({ data, group, onSelect, filter, onFilter }: { data: SampleShowcase; group: ShowcaseGroup; onSelect: (ruleId: string) => void; filter: Priority | "all"; onFilter: (p: Priority | "all") => void }) {
  const list = data.groups.filter((g) => filter === "all" || g.priority === filter);
  const filters = (["all", ...PRIORITIES] as const).filter((p) => p === "all" || data.priorities[p] > 0);
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <Card title={`${data.groups.length} issue groups`}>
        <div role="group" aria-label="Filter by priority" className="mb-3 flex flex-wrap gap-1.5">
          {filters.map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={filter === p}
              onClick={() => onFilter(p)}
              className={cx("h-8 rounded-full border px-3 text-[13px] font-medium transition-colors", filter === p ? "border-accent/40 bg-accent-soft text-accent-ink" : "border-line text-fg-2 hover:bg-hover")}
            >
              {p === "all" ? "All" : priorityLabel(p)}
            </button>
          ))}
        </div>
        <ul className="-mx-2 space-y-1">
          {list.map((g) => (
            <li key={g.ruleId}>
              <button
                type="button"
                aria-pressed={group.ruleId === g.ruleId}
                onClick={() => onSelect(g.ruleId)}
                className={cx("flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors", group.ruleId === g.ruleId ? "bg-accent-softer ring-1 ring-accent/30" : "hover:bg-surface-secondary")}
              >
                <span className="mt-0.5"><PriorityBadge priority={g.priority} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-fg">{g.title}</span>
                  <span className="mt-0.5 block text-xs text-fg-3">
                    {g.affectedUrls === 1 ? samplePath(g.urls[0]?.url ?? "", data.origin) : pages(g.affectedUrls)} · {categoryLabel(g.category)}
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
            <PriorityBadge priority={group.priority} score={group.score} />
            <Mono className="text-fg-3">{group.ruleId}</Mono>
            <span className="text-xs text-fg-3">{categoryLabel(group.category)}</span>
          </div>
          <h2 id="issue-preview" className="mt-2.5 text-lg font-semibold tracking-[-0.01em] text-fg">{group.title}</h2>
          <p className="mt-1 text-xs text-fg-3">
            {pages(group.affectedUrls)}
            {group.templateCount > 0 ? ` · ${group.templateCount === 1 ? "1 template" : `${group.templateCount} templates`}` : ""} · confidence: {group.confidence}
          </p>
        </div>
        <div className="space-y-5 px-5 py-5">
          <div>
            <h3 className="text-[13px] font-semibold text-fg">Why it matters</h3>
            <p className="mt-1 text-sm leading-relaxed text-fg-2">{group.why}</p>
          </div>
          {group.evidence.length ? (
            <div>
              <h3 className="text-[13px] font-semibold text-fg">Evidence</h3>
              <ul className="mt-2 space-y-2">
                {group.evidence.slice(0, 3).map((e) => (
                  <li key={e.url} className="rounded-xl border border-line-subtle bg-surface-secondary p-3 text-[13px]">
                    <Mono className="block truncate text-fg-3">{samplePath(e.url, data.origin)}</Mono>
                    <p className="evidence mt-1 text-fg">{e.message}</p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div>
            <h3 className="text-[13px] font-semibold text-fg">How to fix</h3>
            <p className="mt-1 flex gap-2 text-sm leading-relaxed text-fg-2">
              <ArrowRight className="mt-0.5 size-4 shrink-0 text-accent-ink" aria-hidden />
              {group.fix}
            </p>
            {group.docs ? (
              <a href={group.docs} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-[13px] font-medium text-accent-ink hover:underline">
                Documentation
                <ExternalLink className="size-3.5" aria-hidden />
              </a>
            ) : null}
          </div>
          <div>
            <h3 className="text-[13px] font-semibold text-fg">Acceptance criterion</h3>
            <p className="mt-0.5 text-xs text-fg-3">{group.verifiable ? "A fix verification re-crawls the affected pages and checks this." : "Checked again on the next audit."}</p>
            <p className="mt-2 flex gap-2 text-sm text-fg-2">
              <CircleCheck className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden />
              {group.acceptance}
            </p>
          </div>
          <div>
            <h3 className="text-[13px] font-semibold text-fg">Affected pages</h3>
            <ul className="mt-2 divide-y divide-line-subtle rounded-xl border border-line-subtle">
              {group.urls.slice(0, 8).map((u) => (
                <li key={u.url} className="flex items-center justify-between gap-3 px-3 py-2">
                  <Mono className="min-w-0 truncate text-fg">{samplePath(u.url, data.origin)}</Mono>
                  {u.state === "new" || u.state === "persistent" || u.state === "regressed" || u.state === "not_rechecked" || u.state === "inconclusive" ? <IssueStateBadge state={u.state} /> : null}
                </li>
              ))}
            </ul>
            {group.affectedUrls > 8 ? <p className="mt-2 text-xs text-fg-3">and {(group.affectedUrls - 8).toLocaleString("en-GB")} more</p> : null}
          </div>
        </div>
      </section>
    </div>
  );
}

function ChangesTab({ data, onPick }: { data: SampleShowcase; onPick: (ruleId: string) => void }) {
  const c = data.comparison;
  if (!c) return <Card title="Since last audit"><p className="text-sm text-fg-2">This is the site&apos;s first audit.</p></Card>;
  const open = new Set(data.groups.map((g) => g.ruleId));
  const h = data.history;
  const days = h.length > 1 ? Math.round((Date.parse(h[h.length - 1].at) - Date.parse(h[h.length - 2].at)) / 86_400_000) : null;
  return (
    <Card title="Since the previous audit" actions={days ? <span className="text-xs text-fg-3">{days} days earlier</span> : null}>
      <div className="space-y-5">
        {CHANGE_ORDER.filter((ch) => c.totals[ch] > 0).map((ch) => (
          <div key={ch}>
            <div className="flex items-center gap-2">
              {ch === "resolved" ? <CircleCheck className="size-4 text-ok" aria-hidden /> : null}
              <h3 className="text-[13px] font-semibold text-fg">
                {ch === "not_rechecked" ? "Not re-checked" : ch[0].toUpperCase() + ch.slice(1)} · {c.totals[ch]}
              </h3>
              <span className="text-xs text-fg-3">{CHANGE_NOTE[ch]}</span>
            </div>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {c.groups
                .filter((g) => g.change === ch)
                .map((g) =>
                  open.has(g.ruleId) ? (
                    <li key={g.ruleId}>
                      <button type="button" onClick={() => onPick(g.ruleId)} className="rounded-full border border-line px-3 py-1 text-[13px] text-fg hover:bg-hover">
                        {title(g.ruleId)}
                      </button>
                    </li>
                  ) : (
                    <li key={g.ruleId} className="rounded-full border border-line-subtle bg-surface-secondary px-3 py-1 text-[13px] text-fg-2">
                      {title(g.ruleId)}
                    </li>
                  ),
                )}
            </ul>
          </div>
        ))}
      </div>
    </Card>
  );
}

function RecommendationsTab({ data, onPick }: { data: SampleShowcase; onPick: (ruleId: string) => void }) {
  return (
    <Card title="Recommended order of work" actions={<ListChecks className="size-4 text-fg-3" aria-hidden />}>
      <ol className="space-y-3">
        {data.groups.map((g, n) => (
          <li key={g.ruleId} className="flex gap-3 rounded-xl border border-line-subtle p-3.5">
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-semibold tabular text-accent-ink">{n + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => onPick(g.ruleId)} className="text-left text-sm font-semibold text-fg hover:text-accent-ink">
                  {g.title}
                </button>
                <PriorityBadge priority={g.priority} score={g.score} />
                <span className="text-xs text-fg-3">{pages(g.affectedUrls)}</span>
              </div>
              <p className="mt-1 text-[13px] leading-relaxed text-fg-2">{g.fix}</p>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

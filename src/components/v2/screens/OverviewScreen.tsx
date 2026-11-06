"use client";
// Screen 4, the audit Overview (SPEC "Core screens": the 10-second answer): health score and what it is made of,
// coverage funnel and what was not crawled, the top issue groups by priority, category scorecards and the change
// since the previous audit. Every number comes from the API (the overview in AuditFrame, /groups, /compare/groups);
// nothing animates, so a number never moves while it is being read. Charts are plain CSS bars.
import Link from "next/link";
import { useParams } from "next/navigation";
import type { ReactNode } from "react";
import { ArrowRight, CircleCheck, GitCompareArrows, Hourglass, RefreshCw } from "lucide-react";
import type { Comparison, CrawlOverview, IssueGroupRow } from "@/lib/results/queries";
import type { Priority } from "@/lib/results/priority";
import { AuditFrame, useAudit } from "../AuditFrame";
import { categoryLabel, PRIORITIES, PriorityBadge, PriorityIcon, priorityLabel, priorityText, stateLabel, urlStateLabel } from "../badges";
import { ruleTitle } from "../hooks";
import { AiPanel } from "../AiPanel";
import { useApi, type Resource } from "../../lib/api";
import { fmtDateTime, plural } from "../../lib/format";
import { Button, EmptyState, ErrorState, LinkButton, Mono, Notice, Panel, ScoreRing, Skeleton, StatStrip, cx, scoreColor } from "../../ui";
import { changeRows, coverageGaps, decomposition, funnel, noIssuesCopy, type CategoryPart } from "./overview/model";

/** `actions` replaces the header's default actions; `notices` are shown above the overview (e.g. a start redirect). */
export function OverviewScreen({ actions, notices }: { actions?: ReactNode; notices?: ReactNode }) {
  const { auditId } = useParams<{ auditId: string }>();
  return (
    <AuditFrame auditId={auditId} actions={actions}>
      {notices}
      <Overview />
    </AuditFrame>
  );
}

function Overview() {
  const { overview } = useAudit();
  // Before analysis completes the health score, groups and comparison do not exist yet (or would undercount).
  return overview.analysed ? <AnalysedOverview /> : <NotAnalysed />;
}

function NotAnalysed() {
  const { overview: o, auditBase, reload } = useAudit();
  return (
    <Panel>
      <EmptyState
        icon={Hourglass}
        title="Analysis has not finished"
        action={
          <>
            <LinkButton href={`${auditBase}/progress`}>Crawl progress</LinkButton>
            <Button icon={RefreshCw} onClick={reload}>
              Check again
            </Button>
          </>
        }
      >
        The crawl is {o.status}. The health score, issue groups and changes since the last audit appear once its analysis completes; numbers shown before
        then would be wrong.
      </EmptyState>
    </Panel>
  );
}

const OPEN = ["new", "persistent", "regressed", "not_rechecked"] as const;

function AnalysedOverview() {
  const { overview: o, auditApi, auditBase } = useAudit();
  const groups = useApi<IssueGroupRow[]>(`${auditApi}/groups`);
  const compare = useApi<Comparison>(`${auditApi}/compare/groups`);
  const open = OPEN.reduce((n, s) => n + (o.states[s] ?? 0), 0);

  return (
    <div className="flex flex-col gap-6">
      <CoverageBanner v={o.verdict} />
      <StatStrip
        items={[
          { label: "Issue groups", value: o.issueGroups.toLocaleString("en-GB"), hint: `${plural(o.rulesRan, "rule")} ran`, href: `${auditBase}/issues` },
          { label: "Open findings", value: open.toLocaleString("en-GB"), hint: "New, persistent, regressed or not re-checked", href: `${auditBase}/issues?state=open&view=flat` },
          { label: "Resolved", value: o.states.resolved.toLocaleString("en-GB"), hint: o.verifiedResolved ? `${plural(o.verifiedResolved, "fix", "fixes")} verified by a re-crawl` : "Re-checked and no longer found" },
          { label: "Coverage", value: o.coverage.percent === null ? "—" : `${o.coverage.percent}%`, hint: "Of in-scope URLs crawled" },
        ]}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <HealthPanel o={o} />
        <CoveragePanel o={o} indexable={groups.data?.[0]?.indexablePages ?? null} />
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <TopGroups o={o} groups={groups} />
        <ChangePanel compare={compare} />
      </div>
      <Scorecards o={o} groups={groups.data} />
      <AiPanel />
    </div>
  );
}

// ---------- complete or partial ----------

/** The audit's coverage verdict, in the crawl's own terms: every reason names its count. */
function CoverageBanner({ v }: { v: CrawlOverview["verdict"] }) {
  if (v.verdict === "running") return null;
  const lines = [...v.reasons.map((r) => r.message), ...v.notes];
  const complete = v.verdict === "complete";
  return (
    <Notice tone={complete ? "ok" : "warn"} title={complete ? "Complete" : "Partial"}>
      {complete ? <p>Every in-scope URL reached a final state, and no budget cut applied.</p> : null}
      {lines.length ? <ul className="mt-1 list-disc space-y-0.5 pl-5 marker:text-fg-3">{lines.map((l) => <li key={l}>{l}</li>)}</ul> : null}
    </Notice>
  );
}

// ---------- health ----------

function HealthPanel({ o }: { o: CrawlOverview }) {
  const h = o.health;
  const parts = h ? decomposition(h) : [];
  return (
    <Panel title="Health score" description="Weighted mean of the category scores over the rules that ran">
      {h?.partialCoverage ? (
        <div className="mb-4">
          <Notice tone="warn" title="Partial coverage">
            {h.coveragePercent === null ? "No in-scope URL was crawled" : `Only ${h.coveragePercent}% of in-scope URLs were crawled`}, so this score describes the pages that were crawled, not
            the whole site.
          </Notice>
        </div>
      ) : null}
      {!h ? (
        <p className="text-sm text-fg-2">This audit has no stored health score.</p>
      ) : h.score === null ? (
        <p className="text-sm text-fg-2">No score: no rule ran in this audit, so there is nothing to score.</p>
      ) : (
        <>
          <div className="mb-5 flex items-center gap-5">
            <ScoreRing score={h.score} label="Health score" sublabel="of 100" />
            <p className="text-[13px] text-fg-2">
              Each category gives <span className="font-medium text-fg">weight × score ÷ total weight</span> points; together they make the score. Points are rounded to one decimal.
            </p>
          </div>
          <Decomposition parts={parts} />
        </>
      )}
    </Panel>
  );
}

function Decomposition({ parts }: { parts: CategoryPart[] }) {
  return (
    <table className="w-full text-[13px]">
      <caption className="sr-only">Health score by category</caption>
      <thead>
        <tr className="text-left text-xs text-fg-3">
          <th scope="col" className="pb-2 font-medium">Category</th>
          <th scope="col" className="pb-2 font-medium">Score</th>
          <th scope="col" className="pb-2 text-right font-medium">Weight</th>
          <th scope="col" className="pb-2 text-right font-medium">Points</th>
        </tr>
      </thead>
      <tbody>
        {parts.map((p) => (
          <tr key={p.category} className="border-t border-line-subtle">
            <th scope="row" className="py-2 pr-3 text-left font-medium text-fg">
              {categoryLabel(p.category)}
              <span className="block text-xs font-normal text-fg-3">{plural(p.rulesRan, "rule")}</span>
            </th>
            <td className="py-2 pr-3">
              <span className="flex items-center gap-2">
                <span className="w-9 tabular text-fg">{p.score}</span>
                <span className="h-1.5 w-full max-w-28 overflow-hidden rounded-full bg-elevated" aria-hidden>
                  <span className="block h-full rounded-full" style={{ width: `${p.score}%`, background: scoreColor(p.score) }} />
                </span>
              </span>
            </td>
            <td className="py-2 text-right tabular text-fg-2">{p.weight}</td>
            <td className="py-2 text-right tabular text-fg">
              {p.points.toFixed(1)} <span className="text-fg-3">/ {p.maxPoints.toFixed(1)}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------- coverage ----------

function CoveragePanel({ o, indexable }: { o: CrawlOverview; indexable: number | null }) {
  const steps = funnel(o.coverage, indexable);
  const gaps = coverageGaps(o.coverage);
  return (
    <Panel
      title="Coverage"
      description={o.coverage.percent === null ? "Nothing in scope was found" : `${o.coverage.percent}% of in-scope URLs were requested and answered`}
    >
      <ol className="flex flex-col gap-3">
        {steps.map((s) => (
          <li key={s.id}>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-[13px]">
              <span className="min-w-0">
                <span className="font-medium text-fg">{s.label}</span>
                <span className="ml-2 text-xs text-fg-3 max-sm:hidden">{s.hint}</span>
              </span>
              <span className="shrink-0 tabular text-fg">
                {s.value.toLocaleString("en-GB")}
                {s.ofPrevious !== null ? <span className="ml-1.5 text-xs text-fg-3">{s.ofPrevious}% of previous</span> : null}
              </span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-elevated" aria-hidden>
              <div className="h-full rounded-full bg-info" style={{ width: `${s.ofTotal ?? 0}%` }} />
            </div>
          </li>
        ))}
      </ol>
      {indexable === null ? <p className="mt-3 text-xs text-fg-3">The indexable count is recorded with issue groups; it shows once the groups load (and is absent when the audit has none).</p> : null}
      {gaps.length ? (
        <div className="mt-5">
          <h3 className="mb-2 text-[13px] font-medium text-fg">Not crawled, largest first</h3>
          <ul className="divide-y divide-line-subtle rounded-lg border border-line">
            {gaps.map((g) => (
              <li key={g.state} className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]">
                <span className="min-w-0">
                  <span className="text-fg">{urlStateLabel(g.state)}</span>
                  <span className="ml-2 text-xs text-fg-3">{g.kind === "excluded" ? "ruled out, not counted against coverage" : "in scope but not answered"}</span>
                </span>
                <span className="shrink-0 tabular text-fg">{g.n.toLocaleString("en-GB")}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Panel>
  );
}

// ---------- top groups ----------

function TopGroups({ o, groups }: { o: CrawlOverview; groups: Resource<IssueGroupRow[]> }) {
  const { auditBase } = useAudit();
  const top = groups.data?.slice(0, 5) ?? [];
  return (
    <Panel
      title="Fix first"
      description="The five issue groups with the highest priority (impact × reach × confidence)"
      actions={o.issueGroups ? <LinkButton href={`${auditBase}/issues`} size="sm" variant="ghost" icon={ArrowRight}>All {o.issueGroups.toLocaleString("en-GB")} groups</LinkButton> : undefined}
    >
      <PriorityCounts priorities={o.priorities} />
      {groups.error ? (
        <ErrorState error={groups.error} onRetry={groups.reload} />
      ) : !groups.data ? (
        <div className="flex flex-col gap-2" role="status" aria-label="Loading issue groups">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : !top.length ? (
        <EmptyState icon={CircleCheck} title={noIssuesCopy(o).title} compact>
          {noIssuesCopy(o).body}
        </EmptyState>
      ) : (
        <ol className="divide-y divide-line-subtle rounded-lg border border-line">
          {top.map((g) => (
            <li key={g.ruleId}>
              <Link href={`${auditBase}/issues?rule=${encodeURIComponent(g.ruleId)}&expand=${encodeURIComponent(g.ruleId)}`} className="flex items-center gap-3 px-3 py-2.5 hover:bg-hover">
                <span className="w-[88px] shrink-0">
                  <PriorityBadge priority={g.priority} score={g.score} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-fg">{ruleTitle(g.ruleId)}</span>
                  <span className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-fg-3">
                    <Mono>{g.ruleId}</Mono>
                    <span aria-hidden>·</span>
                    <span>{categoryLabel(g.category)}</span>
                  </span>
                </span>
                <span className="shrink-0 text-right text-[13px] tabular text-fg-2">
                  {plural(g.affectedUrls, "URL")}
                  <span className="block text-xs text-fg-3">{plural(g.templateCount, "template")}</span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

function PriorityCounts({ priorities }: { priorities: Record<Priority, number> }) {
  return (
    <ul className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-[13px]" aria-label="Issue groups per priority">
      {PRIORITIES.map((p) => (
        <li key={p} className="inline-flex items-center gap-1.5">
          <PriorityIcon priority={p} />
          <span className="text-fg-2">{priorityLabel(p)}</span>
          <span className={cx("font-semibold tabular", priorities[p] ? priorityText(p) : "text-fg-3")}>{priorities[p]}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------- change vs last audit ----------

function delta(a: number | null | undefined, b: number | null | undefined) {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  const d = Math.round((b - a) * 10) / 10;
  return d > 0 ? `+${d}` : `${d}`;
}

function ChangePanel({ compare }: { compare: Resource<Comparison> }) {
  const { auditBase } = useAudit();
  const c = compare.data;
  const first = compare.error?.status === 404 && compare.error.code === "NOT_FOUND";
  return (
    <Panel
      title="Change since the last audit"
      description={c ? `Compared with the audit of ${fmtDateTime(c.base.createdAt)}` : "Issue groups per change"}
      actions={c ? <LinkButton href={`${auditBase}/compare`} size="sm" variant="ghost" icon={GitCompareArrows}>Compare</LinkButton> : undefined}
    >
      {first ? (
        <EmptyState icon={GitCompareArrows} title="First audit of this site" compact>
          There is no earlier analysed audit of this site to compare with. The next audit will show what was fixed and what is new.
        </EmptyState>
      ) : compare.error ? (
        <ErrorState error={compare.error} onRetry={compare.reload} />
      ) : !c ? (
        <div className="flex flex-col gap-2" role="status" aria-label="Loading the comparison">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      ) : (
        <>
          {c.scopeMismatch ? (
            <div className="mb-4 flex flex-col gap-2">
              {c.warnings.map((w) => (
                <Notice key={w} tone="warn">
                  {w}
                </Notice>
              ))}
            </div>
          ) : null}
          <dl className="mb-4 grid grid-cols-2 gap-3 text-[13px]">
            <div>
              <dt className="text-fg-3">Health</dt>
              <dd className="tabular text-fg">
                {c.base.health?.score ?? "—"} → {c.head.health?.score ?? "—"}
                {delta(c.base.health?.score, c.head.health?.score) ? <span className="ml-1.5 text-fg-2">({delta(c.base.health?.score, c.head.health?.score)})</span> : null}
              </dd>
            </div>
            <div>
              <dt className="text-fg-3">Coverage</dt>
              <dd className="tabular text-fg">
                {c.base.coverage.percent ?? "—"}% → {c.head.coverage.percent ?? "—"}%
              </dd>
            </div>
          </dl>
          <ul className="divide-y divide-line-subtle rounded-lg border border-line" aria-label="Issue groups per change">
            {changeRows(c.totals).map(({ change, n }) => (
              <li key={change} className="flex items-center justify-between px-3 py-2 text-[13px]">
                <span className="text-fg">{stateLabel(change)}</span>
                <span className={cx("tabular", n ? "font-semibold text-fg" : "text-fg-3")}>{plural(n, "group")}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

// ---------- category scorecards ----------

function Scorecards({ o, groups }: { o: CrawlOverview; groups: IssueGroupRow[] | null }) {
  const { auditBase } = useAudit();
  const parts = o.health ? decomposition(o.health) : [];
  if (!parts.length) return null;
  const byCategory = new Map<string, IssueGroupRow[]>();
  for (const g of groups ?? []) byCategory.set(g.category, [...(byCategory.get(g.category) ?? []), g]);
  return (
    <Panel title="Categories" description="Score, rules that ran and open issue groups per category">
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {parts.map((p) => {
          const gs = byCategory.get(p.category) ?? [];
          const worst = gs[0]?.priority;
          return (
            <li key={p.category}>
              <Link href={`${auditBase}/issues?category=${encodeURIComponent(p.category)}`} className="block h-full rounded-xl border border-line p-4 transition-colors hover:border-line-strong hover:bg-hover">
                <span className="flex items-start justify-between gap-2">
                  <span className="text-[13px] font-medium text-fg-2">{categoryLabel(p.category)}</span>
                  {worst ? <PriorityBadge priority={worst} /> : null}
                </span>
                <span className="mt-2 flex items-baseline gap-1.5">
                  <span className="text-2xl font-semibold tabular text-fg">{p.score}</span>
                  <span className="text-xs text-fg-3">/ 100</span>
                </span>
                <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-elevated" aria-hidden>
                  <span className="block h-full rounded-full" style={{ width: `${p.score}%`, background: scoreColor(p.score) }} />
                </span>
                <span className="mt-2 block text-xs text-fg-3">
                  {plural(p.rulesRan, "rule")} ran · {groups ? plural(gs.length, "issue group") : "groups loading"}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

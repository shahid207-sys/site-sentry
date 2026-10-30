"use client";
// Compare (SPEC screen 10, "what changed since last time"): this audit against an earlier analysed audit of the same
// site (default: the previous one). Before / after figures of the two overviews, then every issue group with how it
// changed (new, regressed, persistent, not re-checked, resolved) and its fingerprints per change. Every number comes
// from /compare/groups; the base audit, change filter and sort are in the query string.
import Link from "next/link";
import { ArrowDown, ArrowUp, GitCompareArrows, Minus } from "lucide-react";
import { useMemo } from "react";
import type { Comparison, GroupChange } from "@/lib/results/queries";
import type { AuditSummary } from "@/lib/views";
import { ApiError, useApi } from "../../lib/api";
import { fmtDateTime, plural } from "../../lib/format";
import { useWs } from "../../shell/context";
import { EmptyState, ErrorState, Field, Mono, Panel, Select, Skeleton, cx } from "../../ui";
import { AuditFrame, useAudit } from "../AuditFrame";
import { IssueStateBadge, stateLabel } from "../badges";
import { ruleTitle, useQueryState } from "../hooks";
import { formatSort, parseSort, sortRows, VirtualTable, type Column } from "../VirtualTable";
import { beforeAfter, CHANGE_ORDER, COUNT_COLUMNS, compareSortKey, comparableAudits, defaultOrder, filterByChange, issuesHref, parseChange, totalFingerprints, trend } from "./compare/model";

export function CompareScreen({ auditId }: { auditId: string }) {
  return (
    <AuditFrame auditId={auditId} title="Compare">
      <Compare />
    </AuditFrame>
  );
}

function Compare() {
  const { auditId, auditApi, auditBase, overview } = useAudit();
  const { apiBase } = useWs();
  const { get, set } = useQueryState();
  const baseParam = get("base");
  const change = parseChange(get("change"));
  const sortParam = get("sort");
  const sort = useMemo(() => parseSort(sortParam), [sortParam]);
  const audits = useApi<AuditSummary[]>(`${apiBase}/audits?site=${encodeURIComponent(overview.project)}`);
  const cmp = useApi<Comparison>(overview.analysed ? `${auditApi}/compare/groups${baseParam ? `?base=${encodeURIComponent(baseParam)}` : ""}` : null);
  const candidates = useMemo(() => comparableAudits(audits.data ?? [], auditId), [audits.data, auditId]);

  const rows = useMemo(() => {
    const g = filterByChange(cmp.data?.groups ?? [], change);
    return sort ? sortRows(g, sort, (r, id) => compareSortKey(r, id, ruleTitle)) : defaultOrder(g);
  }, [cmp.data, change, sort]);

  if (!overview.analysed) return <EmptyState icon={GitCompareArrows} title="Analysis has not finished">The comparison is available once this audit&apos;s checks have finished.</EmptyState>;
  if (cmp.error) {
    if ((cmp.error as ApiError).code === "NOT_FOUND")
      return (
        <Panel>
          <EmptyState icon={GitCompareArrows} title="Nothing to compare with yet">
            {cmp.error.message} Run another audit of this site, then compare.
          </EmptyState>
        </Panel>
      );
    return <ErrorState error={cmp.error} onRetry={cmp.reload} />;
  }
  if (!cmp.data) return <Skeleton className="h-64 w-full" />;
  const c = cmp.data;

  const columns: Column<(typeof rows)[number]>[] = [
    { id: "rule", header: "Issue group", width: "minmax(240px, 2fr)", sortable: true, cell: (g) => <Link href={issuesHref(auditBase, g)} className="truncate text-fg hover:underline">{ruleTitle(g.ruleId)} <Mono className="text-fg-3">{g.ruleId}</Mono></Link> },
    { id: "change", header: "Change", width: "150px", sortable: true, cell: (g) => <IssueStateBadge state={g.change} /> },
    ...COUNT_COLUMNS.map((k) => ({ id: k, header: stateLabel(k), width: "110px", align: "right" as const, sortable: true, cell: (g: (typeof rows)[number]) => <span className={cx("tabular", !g.counts[k] && "text-fg-3")}>{(g.counts[k] ?? 0).toLocaleString("en-GB")}</span> })),
    { id: "total", header: "Total", width: "90px", align: "right", sortable: true, cell: (g) => <span className="tabular">{totalFingerprints(g).toLocaleString("en-GB")}</span> },
  ];

  return (
    <div className="flex flex-col gap-6">
      <Panel
        title="Audits compared"
        description={`${fmtDateTime(c.base.createdAt)} → ${fmtDateTime(c.head.createdAt)}. Only findings both audits could check are judged resolved or regressed.`}
      >
        <Field label="Compare with" htmlFor="cmp-base" hint={candidates.length ? undefined : "No other analysed audit of this site started before this one."}>
          <Select id="cmp-base" value={baseParam ?? ""} onChange={(e) => set({ base: e.target.value || null, change: null })} className="max-w-md">
            <option value="">Previous analysed audit</option>
            {candidates.map((a) => <option key={a.id} value={a.id}>{fmtDateTime(a.startedAt)}</option>)}
          </Select>
        </Field>
        <dl className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {beforeAfter(c.base, c.head).map((r) => {
            const t = trend(r);
            const Icon = t === "same" || t === null ? Minus : (r.delta ?? 0) > 0 ? ArrowUp : ArrowDown;
            const fmt = (n: number | null) => (n === null ? "—" : `${n.toLocaleString("en-GB", { maximumFractionDigits: 1 })}${r.unit ?? ""}`);
            return (
              <div key={r.id} className="rounded-lg border border-line-subtle p-3">
                <dt className="text-xs text-fg-2">{r.label}</dt>
                <dd className="mt-1 text-lg font-semibold tabular text-fg">{fmt(r.before)} → {fmt(r.after)}</dd>
                <dd className={cx("mt-0.5 flex items-center gap-1 text-xs", t === "better" ? "text-ok" : t === "worse" ? "text-sev-high" : "text-fg-3")}>
                  <Icon className="size-3.5" aria-hidden />
                  {t === null ? "Unknown" : t === "same" ? "No change" : `${r.delta! > 0 ? "+" : ""}${fmt(r.delta)} (${t})`}
                </dd>
              </div>
            );
          })}
        </dl>
      </Panel>

      <Panel title="Issue groups" description={`${plural(c.groups.length, "group")} in either audit.`}>
        <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter by change">
          <ChangeChip label="All" n={c.groups.length} active={change === null} onClick={() => set({ change: null })} />
          {CHANGE_ORDER.map((k: GroupChange) => (
            <ChangeChip key={k} label={stateLabel(k)} n={c.totals[k] ?? 0} active={change === k} onClick={() => set({ change: k })} />
          ))}
        </div>
        <VirtualTable
          rows={rows}
          columns={columns}
          rowKey={(g) => g.ruleId}
          label="Issue groups compared"
          sort={sort}
          onSort={(id) => {
            // Ascending → descending → off (the default order).
            const cur = sort && sort.id === id ? sort : null;
            set({ sort: formatSort(!cur ? { id, dir: "asc" } : cur.dir === "asc" ? { id, dir: "desc" } : null) });
          }}
          height="min(60dvh, 640px)"
          empty={<EmptyState compact icon={GitCompareArrows} title="No group with this change" />}
        />
      </Panel>
    </div>
  );
}

function ChangeChip({ label, n, active, onClick }: { label: string; n: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx("inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px]", active ? "border-accent bg-accent-softer font-medium text-fg" : "border-line text-fg-2 hover:text-fg")}
    >
      {label} <span className="tabular text-fg-3">{n.toLocaleString("en-GB")}</span>
    </button>
  );
}

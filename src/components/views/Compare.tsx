"use client";

import { useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowRight, ChevronDown, ChevronRight, CircleCheck, CircleQuestionMark, Clock, GitCompareArrows, Printer, TriangleAlert } from "lucide-react";
import type { ChangeKind, ComparisonEntry } from "@/lib/audit/compare";
import { type ComparisonData } from "@/lib/views";
import { useApi } from "../lib/api";
import { fmtDateTime, plural, shortUrl } from "../lib/format";
import { Modal } from "../overlays";
import { useWs } from "../shell/context";
import { Button, ChangeBadge, EmptyState, ErrorState, LinkButton, PageHeader, PageSkeleton, Panel, SampleTag, Select, SeverityBadge, StatStrip, cx } from "../ui";

const HELP: Record<ChangeKind, string> = {
  regression: "Not found before on a scope the earlier audit fully checked, and found now.",
  new: "First detection, on a page or check the earlier audit did not cover.",
  changed: "Still present, but the observed value is different.",
  resolved: "Gone, and the later audit re-examined everything the finding depends on.",
  not_rechecked: "Missing from the later audit only because its scope was not re-examined. Not counted as fixed.",
  persistent: "Still present with the same observed value.",
};
const GROUP_TITLE: Record<ChangeKind, string> = {
  regression: "Regressions",
  new: "New issues",
  changed: "Changed",
  persistent: "Still present",
  resolved: "Resolved",
  not_rechecked: "Not re-checked",
};
const ORDER: ChangeKind[] = ["regression", "new", "changed", "resolved", "not_rechecked", "persistent"];
/** Long groups collapse to this many rows on screen; print always shows every row. */
const COLLAPSED = 5;

function observedPair(e: ComparisonEntry) {
  const before = e.base?.observed ?? "Not reported";
  const after = e.head?.observed ?? (e.kind === "resolved" ? "No longer found" : "Not re-checked");
  return { before, after };
}

function ChangeGroup({ kind, entries, onOpen }: { kind: ChangeKind; entries: ComparisonEntry[]; onOpen: (e: ComparisonEntry) => void }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = entries.length > COLLAPSED + 1;
  return (
    <Panel
      id={`change-${kind}`}
      className="print-break"
      flush
      title={
        <span className="flex items-center gap-2">
          {GROUP_TITLE[kind]}
          <span className="rounded-full bg-elevated px-2 py-0.5 text-xs font-semibold tabular text-fg-2">{entries.length}</span>
        </span>
      }
      description={HELP[kind]}
      actions={<ChangeBadge kind={kind} />}
    >
      <ul className="divide-y divide-line-subtle">
        {entries.map((e, i) => {
          const f = (e.head ?? e.base)!;
          const { before, after } = observedPair(e);
          const hidden = collapsible && !expanded && i >= COLLAPSED;
          return (
            <li key={e.fingerprint} className={cx(hidden ? "hidden print:block" : "block")}>
              <button
                type="button"
                onClick={() => onOpen(e)}
                className="grid w-full gap-x-6 gap-y-2 px-5 py-3.5 text-left transition-colors hover:bg-hover md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_auto] md:items-center"
              >
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2">
                    <SeverityBadge severity={f.priority.severity} priority={f.priority.level} />
                    <span className="text-sm font-semibold text-fg">{f.title}</span>
                  </span>
                  <span className="mt-1 block truncate font-mono text-xs text-fg-3">{shortUrl(f.pageUrl)}</span>
                </span>
                <span className="flex min-w-0 items-center gap-2 font-mono text-xs">
                  <span className="min-w-0 flex-1 truncate rounded-md bg-surface-secondary px-2 py-1 text-fg-2" title={before}>{before}</span>
                  <ArrowRight className="size-3.5 shrink-0 text-fg-3" aria-hidden />
                  <span className={cx("min-w-0 flex-1 truncate rounded-md px-2 py-1", e.kind === "resolved" ? "bg-ok-soft text-ok" : "bg-surface-secondary text-fg")} title={after}>{after}</span>
                </span>
                <ChevronRight className="hidden size-4 text-fg-3 md:block no-print" aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
      {collapsible ? (
        <div className="no-print border-t border-line-subtle px-5 py-2.5">
          <Button variant="ghost" size="sm" icon={ChevronDown} onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
            {expanded ? "Show fewer" : `Show all ${entries.length}`}
          </Button>
        </div>
      ) : null}
    </Panel>
  );
}

export function CompareView({ printMode }: { printMode?: boolean }) {
  const params = useParams<{ auditId: string; baselineId?: string }>();
  const auditId = params.auditId;
  const sp = useSearchParams();
  const router = useRouter();
  const { ws, base, apiBase } = useWs();

  const baseId = params.baselineId ?? sp.get("base");
  const { data, error, loading, reload } = useApi<ComparisonData>(`${apiBase}/audits/${auditId}/compare${baseId ? `?base=${baseId}` : ""}`);

  const [selectedEntry, setSelectedEntry] = useState<ComparisonEntry | null>(null);
  const [selectedBaseline, setSelectedBaseline] = useState<string>("");

  const crumbs = [
    { label: "Audits", href: `${base}/audits` },
    ...(data ? [{ label: data.site.name, href: `${base}/audits/${data.head.id}` }] : []),
    { label: "Comparison" },
  ];

  if (error) return (<><PageHeader title="Comparison" crumbs={crumbs} /><ErrorState error={error} onRetry={reload} /></>);
  if (loading && !data) return <PageSkeleton />;
  if (!data) return null;

  const { comparison: c } = data;
  const activeBaseId = selectedBaseline || data.base.id;
  const others = data.candidates.filter((x) => x.id !== data.head.id);
  const byKind = (k: ChangeKind) => c.entries.filter((e) => e.kind === k);

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={printMode ? undefined : crumbs}
        title={`What changed on ${data.site.name}`}
        description={`${fmtDateTime(data.base.startedAt)} → ${fmtDateTime(data.head.startedAt)}. Only findings both audits could check are judged as fixed or regressed.`}
        meta={ws === "sample" ? <SampleTag /> : undefined}
        actions={
          printMode ? undefined : (
            <div className="no-print flex flex-wrap items-center gap-2">
              <LinkButton href={`${base}/audits/${data.head.id}`} variant="ghost" icon={ArrowLeft}>
                Back to audit
              </LinkButton>
              <Button icon={Printer} onClick={() => window.print()}>
                Print
              </Button>
            </div>
          )
        }
      />

      {!printMode && others.length > 1 ? (
        <Panel className="no-print">
          <form
            className="flex flex-col gap-3 md:flex-row md:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              if (activeBaseId !== data.base.id) router.push(`${base}/audits/${auditId}/compare/${activeBaseId}`);
            }}
          >
            <label className="min-w-0 flex-1">
              <span className="mb-1.5 block text-sm font-medium text-fg">Earlier audit</span>
              <Select value={activeBaseId} onChange={(e) => setSelectedBaseline(e.target.value)} className="h-10 w-full">
                {others.map((x) => (
                  <option key={x.id} value={x.id}>
                    {fmtDateTime(x.startedAt)} · {x.status}
                  </option>
                ))}
              </Select>
            </label>
            <ArrowRight className="mb-3 hidden size-4 shrink-0 text-fg-3 md:block" aria-hidden />
            <div className="min-w-0 flex-1">
              <span className="mb-1.5 block text-sm font-medium text-fg">Later audit</span>
              <p className="flex h-10 items-center rounded-[10px] border border-line-subtle bg-surface-secondary px-3 text-sm text-fg-2">
                {fmtDateTime(data.head.startedAt)} · {data.head.status}
              </p>
            </div>
            <Button type="submit" variant="primary" className="h-10" disabled={activeBaseId === data.base.id}>
              Compare
            </Button>
          </form>
        </Panel>
      ) : null}

      <StatStrip
        items={[
          { label: "Resolved", value: c.counts.resolved, hint: "Re-checked and gone", icon: CircleCheck, tone: "ok" },
          { label: "Regressions and new", value: c.counts.regression + c.counts.new, hint: `${c.counts.regression} regressed · ${c.counts.new} new`, icon: TriangleAlert, tone: "high" },
          { label: "Still present", value: c.counts.persistent + c.counts.changed, hint: `${c.counts.changed} with a changed value`, icon: Clock, tone: "neutral" },
          { label: "Not re-checked", value: c.counts.not_rechecked, hint: "Not counted as fixed", icon: CircleQuestionMark, tone: "medium" },
        ]}
      />

      {c.lostCoverage.length > 0 || c.newCoverage.length > 0 ? (
        <Panel title="Coverage differences" description="Pages inspected by only one of the two audits can't be judged as fixed or regressed.">
          <div className="grid gap-4 text-[13px] md:grid-cols-2">
            {[
              [`Only in the earlier audit (${c.lostCoverage.length})`, c.lostCoverage],
              [`Only in the later audit (${c.newCoverage.length})`, c.newCoverage],
            ].map(([label, urls]) => (
              <div key={label as string}>
                <p className="mb-1 font-medium text-fg-2">{label as string}</p>
                {(urls as string[]).length ? (
                  <ul className="space-y-0.5 font-mono text-xs text-fg-2">
                    {(urls as string[]).map((u) => (
                      <li key={u} className="truncate">{shortUrl(u)}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-fg-3">None</p>
                )}
              </div>
            ))}
          </div>
        </Panel>
      ) : null}

      {c.entries.length === 0 ? (
        <Panel>
          <EmptyState icon={GitCompareArrows} title="Neither audit reported any findings" />
        </Panel>
      ) : (
        ORDER.filter((k) => c.counts[k] > 0).map((k) => <ChangeGroup key={k} kind={k} entries={byKind(k)} onOpen={setSelectedEntry} />)
      )}

      {selectedEntry ? (
        <Modal
          open
          onClose={() => setSelectedEntry(null)}
          title={(selectedEntry.head ?? selectedEntry.base)!.title}
          description={shortUrl((selectedEntry.head ?? selectedEntry.base)!.pageUrl)}
          footer={
            <div className="flex w-full flex-wrap items-center justify-between gap-2">
              <LinkButton href={`${base}/issues/${encodeURIComponent(selectedEntry.fingerprint)}?site=${data.site.id}`}>Open issue history</LinkButton>
              <Button variant="primary" onClick={() => setSelectedEntry(null)}>
                Close
              </Button>
            </div>
          }
        >
          <div className="space-y-4 text-[13px]">
            <div className="flex flex-wrap items-center gap-2">
              <ChangeBadge kind={selectedEntry.kind} />
              <span className="text-fg-2">{HELP[selectedEntry.kind]}</span>
            </div>
            {selectedEntry.note ? <p className="text-fg-2">{selectedEntry.note}</p> : null}
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                ["Earlier audit", data.base.startedAt, observedPair(selectedEntry).before],
                ["Later audit", data.head.startedAt, observedPair(selectedEntry).after],
              ].map(([label, at, value]) => (
                <div key={label} className="rounded-xl border border-line-subtle bg-surface-secondary p-3">
                  <p className="font-semibold text-fg">{label}</p>
                  <p className="text-xs text-fg-3">{fmtDateTime(at)}</p>
                  <p className="mt-2 break-all font-mono text-xs text-fg-2">{value}</p>
                </div>
              ))}
            </div>
            <div>
              <p className="mb-1.5 font-semibold text-fg">Acceptance criteria</p>
              <ul className="space-y-1">
                {(selectedEntry.head ?? selectedEntry.base)!.acceptanceCriteria.map((crit) => (
                  <li key={crit.id} className="flex items-start gap-2 text-fg-2">
                    <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-fg-3" aria-hidden />
                    {crit.description}
                  </li>
                ))}
              </ul>
            </div>
            <p className="rounded-xl bg-surface-secondary p-3 text-fg-2">
              {selectedEntry.kind === "resolved"
                ? "The later audit re-checked this and no longer found it. Any fix task for it can be closed once verified."
                : selectedEntry.kind === "regression"
                  ? "This came back after a clean check. Look at recent deploys to the page or its template."
                  : selectedEntry.kind === "not_rechecked"
                    ? "Run an audit that covers this page to find out whether it is fixed."
                    : "Still open. Create or update a fix task from the issue page."}
            </p>
          </div>
        </Modal>
      ) : null}
      <p className="hidden text-xs text-fg-3 print:block">{plural(c.entries.length, "finding")} compared.</p>
    </div>
  );
}

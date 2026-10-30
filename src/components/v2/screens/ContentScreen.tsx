"use client";
// Content (SPEC screen 9, "find thin and duplicate content"): missing titles, descriptions and H1s over the content
// pages (/urls), the word-count distribution with the thin-content threshold as a bucket edge, the thin pages (CNT-005's
// own findings, so this list agrees with the Issues screen) and the exact and near-duplicate clusters (/structure).
// Every figure comes from the API; the duplicate kind tab is in the query string.
import Link from "next/link";
import { useParams } from "next/navigation";
import { Copy, FileText } from "lucide-react";
import { useMemo } from "react";
import type { IssueRow, UrlRow } from "@/lib/results/explore";
import type { AuditStructure } from "@/lib/server/results";
import { useApi } from "../../lib/api";
import { hostOf, plural, shortUrl } from "../../lib/format";
import { EmptyState, ErrorState, Panel, Segmented, Skeleton, StatStrip } from "../../ui";
import { AuditFrame, useAudit } from "../AuditFrame";
import { IssueStateBadge } from "../badges";
import { useQueryState, useRules } from "../hooks";
import { inspectHref } from "../links";
import { useWs } from "../../shell/context";
import { Histogram } from "./architecture/Histogram";
import { DUPLICATE_KINDS, groupDuplicates, metaGaps, pagesIn, parseDuplicateKind, thinPages, thinThreshold, wordBuckets, type DuplicateKind } from "./content/model";
import { AuditDataNotice } from "./InspectScreen";

const NO_URLS: UrlRow[] = [];
const NO_ISSUES: IssueRow[] = [];
const THIN_RULE = "CNT-005";
const MAX_LISTED = 100;

export function ContentScreen() {
  const { auditId } = useParams<{ auditId: string }>();
  return (
    <AuditFrame auditId={auditId}>
      <Content />
    </AuditFrame>
  );
}

function LoadingRows({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-2" role="status" aria-label={label}>
      {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-8 w-full" />)}
    </div>
  );
}

function Content() {
  const { auditApi, auditBase, overview } = useAudit();
  const { apiBase } = useWs();
  const urls = useApi<UrlRow[]>(`${auditApi}/urls`);
  const structure = useApi<AuditStructure>(`${auditApi}/structure`);
  const thin = useApi<IssueRow[]>(`${auditApi}/issues?rule=${THIN_RULE}`);
  const catalog = useRules(apiBase);
  const siteHost = hostOf(overview.siteOrigin);
  const all = urls.data ?? NO_URLS;
  const thinRows = thin.data ?? NO_ISSUES;

  const gaps = useMemo(() => metaGaps(all), [all]);
  const threshold = useMemo(() => thinThreshold(thinRows.map((r) => r.message), catalog?.get(THIN_RULE)?.acceptance), [thinRows, catalog]);
  const buckets = useMemo(() => wordBuckets(all, threshold), [all, threshold]);
  const thinList = useMemo(() => thinPages(thinRows, all), [thinRows, all]);
  const dups = useMemo(() => groupDuplicates(structure.data?.duplicates ?? []), [structure.data]);
  const pathOf = (u: string) => (hostOf(u) === siteHost ? shortUrl(u) : u);
  const known = (v: number) => (urls.data ? v.toLocaleString("en-GB") : "—");

  return (
    <div className="flex flex-col gap-6">
      <AuditDataNotice />
      <StatStrip
        items={[
          { label: "Content pages", value: known(gaps.pages), hint: "HTML pages answered 200 with a snapshot" },
          { label: "Missing title", value: known(gaps.noTitle + gaps.emptyTitle), hint: urls.data ? `${gaps.noTitle} without a <title>, ${gaps.emptyTitle} empty` : undefined },
          { label: "Missing description", value: known(gaps.noDescription), hint: "No non-empty meta description" },
          { label: "Missing H1", value: known(gaps.noH1), hint: "No <h1> element" },
        ]}
      />

      <Panel title="Words per page" description={threshold !== null ? `Bars under ${threshold} words are below the thin-content threshold (${THIN_RULE}).` : "The thin-content threshold is shown once CNT-005 has run."}>
        {urls.error ? (
          <ErrorState error={urls.error} onRetry={urls.reload} />
        ) : !urls.data ? (
          <LoadingRows label="Loading word counts" />
        ) : gaps.pages === 0 ? (
          <EmptyState compact icon={FileText} title="No content page was read" />
        ) : (
          <Histogram
            title="Content pages per word count"
            xLabel="Words"
            unit="pages"
            series={[
              { id: "thin", name: "Under the threshold", color: "var(--sev-medium)" },
              { id: "ok", name: "At or above the threshold", color: "var(--info)" },
            ]}
            bars={buckets.map((b) => ({ key: b.label, label: b.label, longLabel: `${b.label} words`, values: { thin: b.thin ? b.pages : 0, ok: b.thin ? 0 : b.pages } }))}
          />
        )}
      </Panel>

      <Panel
        title="Thin pages"
        description={`Open ${THIN_RULE} findings, fewest words first.`}
        actions={thinList.length ? <Link className="text-[13px] font-medium text-accent-ink hover:underline" href={`${auditBase}/issues?rule=${THIN_RULE}&expand=${THIN_RULE}`}>Open in Issues</Link> : undefined}
      >
        {thin.error ? (
          <ErrorState error={thin.error} onRetry={thin.reload} />
        ) : !thin.data || !urls.data ? (
          <LoadingRows label="Loading thin pages" />
        ) : thinList.length === 0 ? (
          <EmptyState compact icon={FileText} title="No thin page is open" />
        ) : (
          <table className="w-full text-left text-[13px]">
            <caption className="sr-only">Thin pages</caption>
            <thead className="text-xs text-fg-2">
              <tr className="border-b border-line">
                <th scope="col" className="py-2 pr-3 font-medium">Page</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Words</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Inbound links</th>
                <th scope="col" className="py-2 font-medium">State</th>
              </tr>
            </thead>
            <tbody>
              {thinList.slice(0, MAX_LISTED).map((p) => (
                <tr key={p.url} className="border-b border-line-subtle last:border-0">
                  <td className="max-w-0 py-2 pr-3">
                    <Link href={inspectHref(auditBase, p.url)} className="block truncate font-mono text-fg hover:underline" title={p.url}>{pathOf(p.url)}</Link>
                    {p.title ? <span className="block truncate text-xs text-fg-3">{p.title}</span> : null}
                  </td>
                  <td className="py-2 pr-3 text-right tabular">{p.wordCount?.toLocaleString("en-GB") ?? "—"}</td>
                  <td className="py-2 pr-3 text-right tabular">{p.inbound?.toLocaleString("en-GB") ?? "—"}</td>
                  <td className="py-2"><IssueStateBadge state={p.state} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {thinList.length > MAX_LISTED ? <p className="mt-3 text-xs text-fg-3">Showing {MAX_LISTED} of {thinList.length}; the Issues screen lists them all.</p> : null}
      </Panel>

      <DuplicatesPanel structure={structure} dups={dups} pathOf={pathOf} auditBase={auditBase} />
    </div>
  );
}

function DuplicatesPanel({ structure, dups, pathOf, auditBase }: { structure: ReturnType<typeof useApi<AuditStructure>>; dups: ReturnType<typeof groupDuplicates>; pathOf: (u: string) => string; auditBase: string }) {
  const { get, set } = useQueryState();
  const kind: DuplicateKind = parseDuplicateKind(get("dup")) ?? "title";
  const meta = DUPLICATE_KINDS.find((k) => k.id === kind)!;
  const clusters = dups[kind];
  return (
    <Panel title="Duplicates" description="Pages that share a title, a description or their content (exact), and near-duplicate clusters.">
      <Segmented
        label="Duplicate kind"
        value={kind}
        onChange={(v) => set({ dup: v === "title" ? null : v })}
        options={DUPLICATE_KINDS.map((k) => ({ value: k.id, label: `${k.label} (${dups[k.id].length})` }))}
      />
      <div className="mt-4">
        {structure.error ? (
          <ErrorState error={structure.error} onRetry={structure.reload} />
        ) : !structure.data ? (
          <LoadingRows label="Loading duplicates" />
        ) : clusters.length === 0 ? (
          <EmptyState compact icon={Copy} title={`No ${meta.label.toLowerCase()} cluster`} />
        ) : (
          <>
            <p className="mb-3 text-[13px] text-fg-2">
              {plural(clusters.length, "cluster")} · {plural(pagesIn(clusters), "page")} ·{" "}
              <Link className="font-medium text-accent-ink hover:underline" href={`${auditBase}/issues?rule=${meta.ruleId}&expand=${meta.ruleId}`}>{meta.ruleId} in Issues</Link>
            </p>
            <ul className="flex flex-col gap-3">
              {clusters.slice(0, MAX_LISTED).map((c) => (
                <li key={`${c.ruleId}:${c.key}`} className="rounded-lg border border-line-subtle p-3">
                  <p className="mb-1.5 text-xs text-fg-3">
                    {meta.keyLabel}: <span className="break-all text-fg-2">{c.key || "(empty)"}</span> · {plural(c.urls.length, "page")}
                  </p>
                  <ul className="flex flex-col gap-0.5">
                    {c.urls.map((u) => (
                      <li key={u} className="truncate">
                        <Link href={inspectHref(auditBase, u)} className="font-mono text-[13px] text-fg hover:underline" title={u}>{pathOf(u)}</Link>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            {clusters.length > MAX_LISTED ? <p className="mt-3 text-xs text-fg-3">Showing {MAX_LISTED} of {clusters.length} clusters.</p> : null}
          </>
        )}
      </div>
    </Panel>
  );
}

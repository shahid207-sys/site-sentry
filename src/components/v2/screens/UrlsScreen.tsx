"use client";
// URL explorer (SPEC screen 6, "power table"): every URL of the crawl in a virtualised table, with column presets,
// toggleable columns, text or regex filters, per-state quick filters, sorting and CSV export. Every filter, the
// sort, the visible columns and the drawer's subject are in the query string (SPEC "Global patterns"), so a view is
// shareable and back-button safe. Opening a row shows PageSummary in a drawer, so the table context is never lost.
import { useParams } from "next/navigation";
import { Columns3, Download, FilterX, Table2 } from "lucide-react";
import { useId, useMemo, type ReactNode } from "react";
import type { UrlRow } from "@/lib/results/explore";
import { useApi } from "../../lib/api";
import { hostOf, shortUrl } from "../../lib/format";
import { Drawer, useToast } from "../../overlays";
import { Button, EmptyState, ErrorState, Input, Select, Skeleton, cx } from "../../ui";
import { AuditFrame, useAudit } from "../AuditFrame";
import { urlStateLabel } from "../badges";
import { useQueryState, useQueryText } from "../hooks";
import { DensityToggle, VirtualTable, formatSort, parseSort, sortRows, type Column } from "../VirtualTable";
import { AuditDataNotice, PageSummary } from "./InspectScreen";
import { COLUMN_IDS, COLUMN_LABEL, DEFAULT_COLS, PRESETS, PRESET_IDS, formatCols, parseCols, presetOf, sortKey, type ColumnId } from "./urls/columns";
import { urlRowsCsv } from "./urls/csv";
import { READ_STATES, STATUS_CLASSES, STATUS_CLASS_LABEL, applyFilters, parseUrlFilter, templateCounts, yesNo, type StatusClass } from "./urls/filter";

const FILTER_KEYS = ["q", "state", "status", "noindex", "issues", "template"] as const;
const NO_ROWS: UrlRow[] = [];

const dash = <span className="text-fg-3">—</span>;
const num = (v: number | null) => (v === null ? dash : v.toLocaleString("en-GB"));
/** Truncated text with the full value on hover (the cell already truncates; screen readers get the whole text). */
const text = (v: string | null, mono = false) => (v ? <span title={v} className={cx(mono && "font-mono text-[12.5px]")}>{v}</span> : dash);

/** Width, alignment and cell of every toggleable column. */
const CELLS: Record<ColumnId, Omit<Column<UrlRow>, "id" | "header" | "sortable">> = {
  state: { width: "160px", cell: (r) => <span title={r.reason ?? undefined}>{urlStateLabel(r.state)}</span> },
  status: { width: "76px", align: "right", cell: (r) => num(r.status) },
  // noindex is only known for pages the crawler read; "—" elsewhere, never a misleading "No".
  noindex: { width: "92px", cell: (r) => (READ_STATES.has(r.state) ? (r.noindex ? <span className="font-medium text-fg">noindex</span> : "No") : dash) },
  canonical: { width: "minmax(220px, 1fr)", cell: (r) => text(r.canonical, true) },
  redirectTarget: { width: "minmax(220px, 1fr)", cell: (r) => text(r.redirectTarget, true) },
  depth: { width: "76px", align: "right", cell: (r) => num(r.depth) },
  reason: { width: "minmax(240px, 1.2fr)", cell: (r) => text(r.reason) },
  title: { width: "minmax(240px, 1.5fr)", cell: (r) => text(r.title) },
  h1: { width: "minmax(200px, 1fr)", cell: (r) => text(r.h1) },
  description: { width: "minmax(260px, 1.5fr)", cell: (r) => text(r.description) },
  wordCount: { width: "88px", align: "right", cell: (r) => num(r.wordCount) },
  templateId: { width: "128px", cell: (r) => text(r.templateId, true) },
  inbound: { width: "104px", align: "right", cell: (r) => num(r.inbound) },
  linkDepth: { width: "92px", align: "right", cell: (r) => num(r.linkDepth) },
  pagerank: { width: "100px", align: "right", cell: (r) => (r.pagerank === null ? dash : r.pagerank.toPrecision(3)) },
  discoveredVia: { width: "150px", cell: (r) => (r.discoveredVia.length ? text(r.discoveredVia.join(", ")) : dash) },
  elapsedMs: { width: "92px", align: "right", cell: (r) => num(r.elapsedMs) },
  bytes: { width: "100px", align: "right", cell: (r) => num(r.bytes) },
  contentType: { width: "170px", cell: (r) => text(r.contentType, true) },
  openIssues: { width: "104px", align: "right", cell: (r) => (r.openIssues ? <span className="font-medium text-fg">{r.openIssues.toLocaleString("en-GB")}</span> : <span className="text-fg-3">0</span>) },
};

export function UrlsScreen() {
  const { auditId } = useParams<{ auditId: string }>();
  return (
    <AuditFrame auditId={auditId}>
      <Explorer />
    </AuditFrame>
  );
}

function Explorer() {
  const { auditApi, overview } = useAudit();
  const { get, set } = useQueryState();
  const urls = useApi<UrlRow[]>(`${auditApi}/urls`);
  const toast = useToast();
  const [q, setQ] = useQueryText("q");

  const qParam = get("q") ?? "";
  const stateF = get("state");
  const rawStatus = get("status");
  const statusF = STATUS_CLASSES.includes(rawStatus as StatusClass) ? (rawStatus as StatusClass) : null;
  const noindexF = yesNo(get("noindex"));
  const issuesF = yesNo(get("issues"));
  const templateF = get("template");
  const sortParam = get("sort");
  const colsParam = get("cols");
  const openUrl = get("open");

  const all = urls.data ?? NO_ROWS;
  const matcher = useMemo(() => parseUrlFilter(qParam), [qParam]);
  const { rows: filtered, stateCounts } = useMemo(
    () => applyFilters(all, { match: matcher.test, state: stateF, status: statusF, noindex: noindexF, issues: issuesF, template: templateF }),
    [all, matcher, stateF, statusF, noindexF, issuesF, templateF],
  );
  const sort = useMemo(() => parseSort(sortParam), [sortParam]);
  const rows = useMemo(() => sortRows(filtered, sort, sortKey), [filtered, sort]);
  const templates = useMemo(() => templateCounts(all), [all]);
  const cols = parseCols(colsParam);
  const preset = colsParam ? presetOf(cols) : "default";
  const siteHost = hostOf(overview.siteOrigin);

  const columns = useMemo<Column<UrlRow>[]>(
    () => [
      {
        id: "url",
        header: COLUMN_LABEL.url,
        width: "minmax(320px, 2fr)",
        sortable: true,
        // Same-site URLs as a path; other hosts (out of scope, redirects away) in full.
        cell: (r) => (
          <span title={r.url} className="font-mono text-[12.5px] text-fg">
            {hostOf(r.url) === siteHost ? shortUrl(r.url) : r.url}
          </span>
        ),
      },
      ...parseCols(colsParam).map((id) => ({ id, header: COLUMN_LABEL[id], sortable: true, ...CELLS[id] })),
    ],
    [colsParam, siteHost],
  );

  const filtering = FILTER_KEYS.some((k) => !!get(k));
  const clearFilters = () => set(Object.fromEntries(FILTER_KEYS.map((k) => [k, null])));
  const onSort = (id: string) => {
    const next = !sort || sort.id !== id ? { id, dir: "asc" as const } : sort.dir === "asc" ? { id, dir: "desc" as const } : null;
    set({ sort: formatSort(next) });
  };
  const setCols = (next: Iterable<ColumnId>) => set({ cols: formatCols(next) });
  const toggleCol = (id: ColumnId) => setCols(cols.includes(id) ? cols.filter((c) => c !== id) : [...cols, id]);

  const exportCsv = () => {
    const blob = new Blob([urlRowsCsv(rows)], { type: "text/csv;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `urls-${siteHost.replace(/[^a-z0-9.-]/gi, "_")}-${overview.createdAt.slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
    toast({ tone: "ok", title: `Exported ${rows.length.toLocaleString("en-GB")} URLs`, detail: "Every column, in the table's current filter and sort." });
  };

  if (urls.error) return <ErrorState error={urls.error} onRetry={urls.reload} />;
  if (!urls.data) return <ExplorerSkeleton />;
  if (all.length === 0)
    return (
      <>
        <AuditDataNotice />
        <div className="rounded-2xl border border-line bg-surface">
          <EmptyState icon={Table2} title="This audit has no URLs yet">
            No URL has been recorded, not even the start URL. If the crawl has finished, check its status on the overview and re-run it.
          </EmptyState>
        </div>
      </>
    );

  const total = stateCounts.reduce((n, [, c]) => n + c, 0);
  return (
    <>
      <AuditDataNotice />
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <div className="flex min-w-[min(100%,280px)] flex-[2] flex-col gap-1">
          <label htmlFor="url-filter" className="text-xs font-medium text-fg-2">
            Filter URLs <span className="font-normal text-fg-3">· text, or re: for a regular expression</span>
          </label>
          <Input
            id="url-filter"
            data-filter-input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="/blog/   or   re:/p/\d+$"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={matcher.error ? true : undefined}
            aria-describedby={matcher.error ? "url-filter-error" : undefined}
            className="h-9 font-mono text-[13px]"
          />
        </div>
        <SelectField label="Status" value={statusF ?? ""} onChange={(v) => set({ status: v })}>
          <option value="">Any status</option>
          {STATUS_CLASSES.map((c) => (
            <option key={c} value={c}>
              {STATUS_CLASS_LABEL[c]}
            </option>
          ))}
        </SelectField>
        <SelectField label="noindex" value={noindexF ?? ""} onChange={(v) => set({ noindex: v })}>
          <option value="">Any</option>
          <option value="yes">noindex</option>
          <option value="no">Not noindex (read pages)</option>
        </SelectField>
        <SelectField label="Open issues" value={issuesF ?? ""} onChange={(v) => set({ issues: v })}>
          <option value="">Any</option>
          <option value="yes">With open issues</option>
          <option value="no">Without open issues</option>
        </SelectField>
        <SelectField label="Template" value={templateF ?? ""} onChange={(v) => set({ template: v })}>
          <option value="">Any template</option>
          {templateF && !templates.some(([t]) => t === templateF) ? <option value={templateF}>{templateF} (0)</option> : null}
          {templates.map(([t, n]) => (
            <option key={t} value={t}>
              {t.length > 16 ? `${t.slice(0, 16)}…` : t} ({n.toLocaleString("en-GB")})
            </option>
          ))}
        </SelectField>
        {filtering ? (
          <Button variant="ghost" size="sm" icon={FilterX} onClick={clearFilters}>
            Clear filters
          </Button>
        ) : null}
      </div>
      {matcher.error ? (
        <p id="url-filter-error" role="alert" className="mb-3 text-xs text-sev-high">
          {matcher.error} The URL filter is ignored until it is fixed.
        </p>
      ) : null}

      <div role="group" aria-label="Filter by URL state" className="mb-3 flex flex-wrap gap-1.5">
        <StateChip label="All states" count={total} pressed={!stateF} onClick={() => set({ state: null })} />
        {stateCounts.map(([s, n]) => (
          <StateChip key={s} label={urlStateLabel(s)} count={n} pressed={stateF === s} onClick={() => set({ state: stateF === s ? null : s })} />
        ))}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Column preset" className="inline-flex max-w-full overflow-x-auto rounded-[10px] border border-line bg-elevated p-1">
          {(["default", ...PRESET_IDS] as const).map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={preset === p}
              onClick={() => setCols(p === "default" ? DEFAULT_COLS : PRESETS[p].cols)}
              className={cx("h-7 shrink-0 whitespace-nowrap rounded-lg px-2.5 text-[13px] font-medium transition-colors", preset === p ? "bg-surface text-fg shadow-[0_1px_3px_rgb(16_24_40/0.1)]" : "text-fg-2 hover:text-fg")}
            >
              {p === "default" ? "Default" : PRESETS[p].label}
            </button>
          ))}
        </div>
        <ColumnPicker cols={cols} onToggle={toggleCol} />
        <DensityToggle />
        <Button size="sm" icon={Download} onClick={exportCsv} disabled={!rows.length}>
          Export CSV
        </Button>
        <p className="ml-auto text-[13px] text-fg-3" aria-live="polite">
          {rows.length === all.length ? `${all.length.toLocaleString("en-GB")} URLs` : `${rows.length.toLocaleString("en-GB")} of ${all.length.toLocaleString("en-GB")} URLs`}
        </p>
      </div>

      <VirtualTable
        rows={rows}
        columns={columns}
        rowKey={(r) => r.url}
        label="URLs of this audit"
        onOpen={(r) => set({ open: r.url }, { push: true })}
        sort={sort}
        onSort={onSort}
        activeKey={openUrl}
        empty={
          <EmptyState compact icon={FilterX} title="No URLs match these filters" action={<Button icon={FilterX} onClick={clearFilters}>Clear filters</Button>}>
            {all.length.toLocaleString("en-GB")} URLs in this audit; none pass every filter.
          </EmptyState>
        }
      />
      <p className="mt-2 text-xs text-fg-3">
        <kbd className="font-mono">j</kbd>/<kbd className="font-mono">k</kbd> move · <kbd className="font-mono">Enter</kbd> opens the URL in a side panel · <kbd className="font-mono">/</kbd> focuses the filter
      </p>

      <Drawer open={!!openUrl} onClose={() => set({ open: null }, { push: true })} title={openUrl ? (hostOf(openUrl) === siteHost ? shortUrl(openUrl) : openUrl) : "URL"}>
        {openUrl ? <PageSummary key={openUrl} url={openUrl} /> : null}
      </Drawer>
    </>
  );
}

function SelectField({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: ReactNode }) {
  const id = useId();
  return (
    <div className="flex min-w-[140px] flex-1 flex-col gap-1 sm:flex-none">
      <label htmlFor={id} className="text-xs font-medium text-fg-2">
        {label}
      </label>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="h-9 text-[13px] sm:w-44">
        {children}
      </Select>
    </div>
  );
}

function StateChip({ label, count, pressed, onClick }: { label: string; count: number; pressed: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cx(
        "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors",
        pressed ? "border-accent-ink bg-accent-soft font-medium text-accent-ink" : "border-line bg-surface text-fg-2 hover:border-line-strong hover:text-fg",
      )}
    >
      {label}
      <span className="tabular text-xs opacity-80">{count.toLocaleString("en-GB")}</span>
    </button>
  );
}

/** Column visibility in a native disclosure (keyboard and screen-reader support without a menu library). */
function ColumnPicker({ cols, onToggle }: { cols: ColumnId[]; onToggle: (id: ColumnId) => void }) {
  return (
    <details className="relative">
      <summary className="inline-flex h-9 cursor-pointer list-none items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-fg-2 hover:border-line-strong hover:text-fg [&::-webkit-details-marker]:hidden">
        <Columns3 className="size-4" aria-hidden />
        Columns <span className="tabular text-fg-3">({cols.length + 1})</span>
      </summary>
      <fieldset className="absolute left-0 z-20 mt-1 max-h-[60vh] w-64 overflow-y-auto rounded-xl border border-line bg-elevated p-3 shadow-pop">
        <legend className="sr-only">Visible columns</legend>
        <p className="mb-2 text-xs text-fg-3">The URL column is always shown.</p>
        <ul className="space-y-1.5">
          {COLUMN_IDS.map((id) => {
            const on = cols.includes(id);
            return (
              <li key={id}>
                <label className="flex cursor-pointer items-center gap-2 text-[13px] text-fg">
                  <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={on} disabled={on && cols.length === 1} onChange={() => onToggle(id)} />
                  {COLUMN_LABEL[id]}
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
    </details>
  );
}

function ExplorerSkeleton() {
  return (
    <div role="status" aria-label="Loading URLs">
      <div className="mb-3 flex flex-wrap gap-2">
        <Skeleton className="h-9 min-w-[240px] flex-[2]" />
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-9 w-40" />
        ))}
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-8 w-28 rounded-full" />
        ))}
      </div>
      <div className="rounded-xl border border-line bg-surface">
        {Array.from({ length: 12 }, (_, i) => (
          <div key={i} className="flex items-center gap-4 border-b border-line-subtle px-3 py-3 last:border-0">
            <Skeleton className="h-4 flex-[2]" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-12" />
            <Skeleton className="hidden h-4 flex-1 md:block" />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}

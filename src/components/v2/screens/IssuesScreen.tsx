"use client";
// Screen 5, the Issues explorer (SPEC "Core screens": decide what to fix). Default view: issue groups by rule from
// /groups (small, first paint), each expandable to its URLs (/issues?rule=). Flat view (view=flat): every fingerprint
// of the audit (/issues, up to ~50k rows) in a virtualised table, filtered in the browser. Every filter, sort, grouping,
// expanded group and the drawer's subject live in the query string; selection and bulk triage do not.
import { useParams } from "next/navigation";
import { ChevronRight, CircleCheck, FilterX, Hourglass, ListFilter, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { IssueRow } from "@/lib/results/explore";
import type { IssueGroupRow } from "@/lib/results/queries";
import type { BoardCard } from "@/lib/results/triage";
import type { AuditTriage } from "@/lib/server/results";
import { AuditFrame, useAudit } from "../AuditFrame";
import { categoryLabel, IssueStateBadge, ISSUE_STATES, PRIORITIES, PriorityBadge, priorityLabel, stateLabel } from "../badges";
import { ruleTitle, useHotkeys, useQueryState, useQueryText, useRules } from "../hooks";
import { DensityToggle, formatSort, parseSort, sortRows, VirtualTable, type Column } from "../VirtualTable";
import { api, useApi } from "../../lib/api";
import { plural, shortUrl } from "../../lib/format";
import { Drawer, Modal, useToast } from "../../overlays";
import { useWs } from "../../shell/context";
import { Button, EmptyState, ErrorState, Input, LinkButton, Mono, Notice, Panel, Segmented, Select, Skeleton, Textarea, cx } from "../../ui";
import {
  assignBatches,
  chunk,
  filterGroups,
  filterIssues,
  groupTemplateOptions,
  hasFilters,
  indexRows,
  issueSortKey,
  parseSubject,
  rowMarker,
  ruleFacts,
  stateSummary,
  templateOptions,
  textMatcher,
  triageIndex,
  type IssueFilters,
  type TriageBatch,
} from "./issues/filter";
import { noIssuesCopy } from "./overview/model";
import { COLUMN_LABEL, FindingDrawer, GroupDrawer, TriageMarker, useEnsure, type TriageActions } from "./issues/IssueDrawer";
import { useRuleRows, type RuleRows } from "./issues/useRuleRows";

export function IssuesScreen() {
  const { auditId } = useParams<{ auditId: string }>();
  return (
    <AuditFrame auditId={auditId}>
      <Issues />
    </AuditFrame>
  );
}

function Issues() {
  const { overview: o, auditBase, reload } = useAudit();
  if (!o.analysed)
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
          The crawl is {o.status}. Issues are listed once its analysis completes; a list shown before then would be incomplete.
        </EmptyState>
      </Panel>
    );
  return <Explorer />;
}

type View = "grouped" | "flat";
type Dialog = { kind: "ignore" | "assign"; subjects: string[] } | null;
const FLAT_LABEL = "All issues";
/** Inside a group the text filter is empty, so the text index is never read. */
const EMPTY_INDEX = { raw: [], lower: [] };
const FILTER_KEYS = ["state", "priority", "category", "template", "rule"] as const;

function Explorer() {
  const { auditApi, overview } = useAudit();
  const { apiBase } = useWs();
  const toast = useToast();
  const { get, set } = useQueryState();
  const [text, setText] = useQueryText("q");
  const view: View = get("view") === "flat" ? "flat" : "grouped";
  // Filter selects apply at once and reach the URL right after (like the text filter), so a change over 50,000 rows
  // is not held up by a router navigation.
  const [stateQ, setStateQ] = useQueryText("state", 0);
  const [priorityQ, setPriorityQ] = useQueryText("priority", 0);
  const [categoryQ, setCategoryQ] = useQueryText("category", 0);
  const [templateQ, setTemplateQ] = useQueryText("template", 0);
  const state = stateQ || null;
  const priority = priorityQ || null;
  const category = categoryQ || null;
  const template = templateQ || null;
  const rule = get("rule");
  const sortParam = get("sort");
  const openParam = get("open");
  const openRule = get("orule");
  const expandParam = get("expand");
  const filters: IssueFilters = useMemo(() => ({ text, state, priority, category, template, rule }), [text, state, priority, category, template, rule]);
  const sort = useMemo(() => parseSort(sortParam), [sortParam]);
  const subject = parseSubject(openParam);
  const expanded = useMemo(() => new Set((expandParam ?? "").split(",").filter(Boolean)), [expandParam]);

  const catalog = useRules(apiBase);
  const groups = useApi<IssueGroupRow[]>(`${auditApi}/groups`);
  const triage = useApi<AuditTriage>(`${auditApi}/triage`);
  // The full list only when the flat view is chosen, or a deep-linked row has no rule hint to fetch a small list by.
  const needFull = view === "flat" || (subject?.kind === "fp" && !openRule);
  const flat = useApi<IssueRow[]>(needFull ? `${auditApi}/issues` : null);
  const ruleRows = useRuleRows(auditApi);
  const ruleCache = ruleRows.cache;
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);

  const facts = useMemo(() => ruleFacts(groups.data ?? [], catalog), [groups.data, catalog]);
  const triageIdx = useMemo(() => triageIndex(triage.data?.entries), [triage.data]);
  const boardIdx = useMemo(() => new Map((triage.data?.board ?? []).map((b) => [b.ruleId, b])), [triage.data]);
  const groupIdx = useMemo(() => new Map((groups.data ?? []).map((g) => [g.ruleId, g])), [groups.data]);

  // Flat view: index once per load, filter on the immediate (not yet debounced) text, then sort.
  const index = useMemo(() => indexRows(flat.data ?? []), [flat.data]);
  const filteredRows = useMemo(() => filterIssues(flat.data ?? [], index, filters, facts), [flat.data, index, filters, facts]);
  const rows = useMemo(() => sortRows(filteredRows, sort, (r, id) => issueSortKey(r, id, facts)), [filteredRows, sort, facts]);
  // Grouped view.
  const shownGroups = useMemo(() => filterGroups(groups.data ?? [], filters, ruleTitle), [groups.data, filters]);
  const matcher = useMemo(() => textMatcher(text), [text]);

  // Phase 4 gate instrumentation: filter input change → filtered rows committed (performance.measure "ss-filter").
  // `filters` is a dependency too, so a change that leaves the rows unchanged still closes its mark.
  const visible = view === "flat" ? rows : shownGroups;
  useLayoutEffect(() => {
    if (typeof performance === "undefined" || !performance.getEntriesByName("ss-filter-start", "mark").length) return;
    performance.measure("ss-filter", "ss-filter-start");
    performance.clearMarks("ss-filter-start");
  }, [visible, filters]);
  const onText = (v: string) => {
    performance.mark("ss-filter-start");
    setText(v);
  };
  const onSelect = (setter: (v: string) => void, v: string) => {
    performance.mark("ss-filter-start");
    setter(v);
  };

  // ---------- drawer ----------
  const openSubject = useCallback((s: string, ruleHint?: string) => set({ open: s, orule: ruleHint ?? null }), [set]);
  const closeDrawer = useCallback(() => set({ open: null, orule: null }), [set]);
  useEnsure(ruleRows.load, subject?.kind === "fp" ? openRule : null);
  // The row behind an fp drawer: from its rule's small list when the link carries the rule, else the full list.
  const fpId = subject?.kind === "fp" ? subject.id : null;
  const drawerRow = fpId ? ((openRule ? ruleCache[openRule]?.rows?.find((r) => r.fingerprint === fpId) : undefined) ?? flat.data?.find((r) => r.fingerprint === fpId)) : undefined;
  const drawerRowState = openRule ? ruleCache[openRule] : undefined;
  const drawerLoading = openRule ? !drawerRowState?.rows && !drawerRowState?.error : flat.loading || (!flat.data && !flat.error);
  const drawerError = openRule ? (drawerRowState?.error ?? null) : flat.error;

  // ---------- triage ----------
  const post = useCallback(
    async (batches: TriageBatch[], assignee: string | null | undefined, done: string) => {
      const total = batches.reduce((n, b) => n + b.subjects.length, 0);
      let saved = 0;
      setBusy(true);
      try {
        for (const b of batches) {
          await api(`${auditApi}/triage`, { method: "POST", body: { subjects: b.subjects, status: b.status, note: b.note ?? null, ...(assignee === undefined ? {} : { assignee }) } });
          saved += b.subjects.length;
        }
        toast({ tone: "ok", title: done, detail: `${plural(total, "issue")} updated. Issue states do not change until a crawl re-checks them.` });
        setSelected(new Set());
      } catch (e) {
        toast({ tone: "error", title: "Triage not saved", detail: `${saved ? `${saved.toLocaleString("en-GB")} of ${total.toLocaleString("en-GB")} saved before the error. ` : ""}${(e as Error).message}` });
      } finally {
        setBusy(false);
        void triage.reload();
      }
    },
    [auditApi, toast, triage],
  );
  const actions: TriageActions = useMemo(
    () => ({
      busy,
      fixed: (subjects) => void post(chunk(subjects).map((s): TriageBatch => ({ subjects: s, status: "fixed" })), undefined, "Marked fixed"),
      clear: (subjects) => void post(chunk(subjects).map((s): TriageBatch => ({ subjects: s, status: "todo" })), undefined, "Marks cleared"),
      ignore: (subjects) => setDialog({ kind: "ignore", subjects }),
      assign: (subjects) => setDialog({ kind: "assign", subjects }),
      group: async (ruleId, status, assignee) => post([{ subjects: [`rule:${ruleId}`], status }], assignee, "Fix board updated"),
    }),
    [busy, post, setDialog],
  );
  const toggle = useCallback(
    (key: string) =>
      setSelected((s) => {
        const n = new Set(s);
        if (n.has(key)) n.delete(key);
        else n.add(key);
        return n;
      }),
    [],
  );

  // ---------- keyboard: j / k / x / Enter come from the flat table; f and e here ----------
  const [cursorAt, setCursorAt] = useState<IssueRow | undefined>(undefined);
  const cursorRow = () => cursorAt;
  const focusedRule = () => (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-rule]")?.dataset.rule;
  const moveGroup = (d: number) => {
    const els = [...document.querySelectorAll<HTMLElement>("[data-group-row]")];
    if (!els.length) return;
    const at = els.indexOf(document.activeElement as HTMLElement);
    els[at === -1 ? 0 : Math.max(0, Math.min(els.length - 1, at + d))]?.focus();
  };
  useHotkeys({
    f: () => {
      if (selected.size) return actions.fixed([...selected]);
      const r = view === "flat" ? cursorRow() : undefined;
      if (r) actions.fixed([`fp:${r.fingerprint}`]);
    },
    e: () => {
      if (view === "flat") {
        const r = cursorRow();
        if (r) openSubject(`fp:${r.fingerprint}`, r.ruleId);
      } else {
        const id = focusedRule();
        if (id) openSubject(`rule:${id}`);
      }
    },
    ...(view === "grouped" ? { j: () => moveGroup(1), k: () => moveGroup(-1) } : {}),
  });

  // ---------- filters ----------
  const filtered = hasFilters(filters);
  const clearFilters = () => set(Object.fromEntries([...FILTER_KEYS, "q"].map((k) => [k, null])));
  const categories = useMemo(() => {
    const s = new Set<string>((groups.data ?? []).map((g) => g.category));
    if (catalog) for (const r of catalog.values()) s.add(r.category);
    return [...s].sort((a, b) => categoryLabel(a).localeCompare(categoryLabel(b)));
  }, [groups.data, catalog]);
  const templates = useMemo(() => (view === "flat" ? templateOptions(flat.data ?? []) : groupTemplateOptions(groups.data ?? [])), [view, flat.data, groups.data]);
  const totalGroups = groups.data?.length ?? 0;
  const totalRows = flat.data?.length ?? 0;
  const notSettled = overview.states.not_rechecked + overview.states.inconclusive;

  return (
    <div className="flex flex-col gap-4">
      {notSettled ? <PartialNotice notRechecked={overview.states.not_rechecked} inconclusive={overview.states.inconclusive} /> : null}

      <div className="flex flex-wrap items-center gap-2" role="search" aria-label="Filter issues">
        <div className="relative min-w-[240px] flex-1">
          <ListFilter className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-3" aria-hidden />
          <Input
            data-filter-input
            aria-label={view === "flat" ? "Filter by URL or rule id; start with re: for a regular expression" : "Filter by rule id or title; start with re: for a regular expression"}
            aria-describedby={matcher.error ? "issue-filter-error" : undefined}
            aria-invalid={matcher.error ? true : undefined}
            placeholder={view === "flat" ? "Filter by URL or rule id (re: for regex)  /" : "Filter by rule id or title (re: for regex)  /"}
            value={text}
            onChange={(e) => onText(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select aria-label="State" className="w-auto" value={state ?? ""} onChange={(e) => onSelect(setStateQ, e.target.value)}>
          <option value="">All states</option>
          <option value="open">Open (new, persistent, regressed, not re-checked)</option>
          {ISSUE_STATES.map((s) => (
            <option key={s} value={s}>
              {stateLabel(s)}
            </option>
          ))}
        </Select>
        <Select aria-label="Priority" className="w-auto" value={priority ?? ""} onChange={(e) => onSelect(setPriorityQ, e.target.value)}>
          <option value="">All priorities</option>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {priorityLabel(p)}
            </option>
          ))}
          {view === "flat" ? <option value="none">No open group</option> : null}
        </Select>
        <Select aria-label="Category" className="w-auto" value={category ?? ""} onChange={(e) => onSelect(setCategoryQ, e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {categoryLabel(c)}
            </option>
          ))}
        </Select>
        <Select aria-label="Template" className="w-auto max-w-56" value={template ?? ""} onChange={(e) => onSelect(setTemplateQ, e.target.value)}>
          <option value="">All templates</option>
          {view === "flat" ? <option value="none">No template</option> : null}
          {template && template !== "none" && !templates.some((t) => t.id === template) ? <option value={template}>{template}</option> : null}
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.id.length > 28 ? `${t.id.slice(0, 27)}…` : t.id} ({t.count.toLocaleString("en-GB")})
            </option>
          ))}
        </Select>
        <Segmented<View> label="View" value={view} onChange={(v) => set({ view: v === "flat" ? "flat" : null }, { push: true })} options={[{ value: "grouped", label: "By rule" }, { value: "flat", label: "All URLs" }]} />
        {view === "flat" ? <DensityToggle /> : null}
      </div>
      {matcher.error ? (
        <p id="issue-filter-error" className="-mt-2 text-xs text-sev-high">
          {matcher.error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <p data-testid="issue-count" className="text-fg-2" aria-live="polite">
          {view === "flat" ? (
            flat.data ? (
              <>
                <span className="font-semibold tabular text-fg">{rows.length.toLocaleString("en-GB")}</span> of <span className="tabular">{totalRows.toLocaleString("en-GB")}</span> issues
              </>
            ) : (
              "Loading issues…"
            )
          ) : groups.data ? (
            <>
              <span className="font-semibold tabular text-fg">{shownGroups.length.toLocaleString("en-GB")}</span> of <span className="tabular">{totalGroups.toLocaleString("en-GB")}</span> issue groups
            </>
          ) : (
            "Loading issue groups…"
          )}
        </p>
        {rule ? (
          <button type="button" onClick={() => set({ rule: null })} className="inline-flex h-7 items-center gap-1 rounded-full border border-line bg-surface px-2.5 text-xs text-fg hover:border-line-strong" aria-label={`Remove the rule filter ${rule}`}>
            Rule <Mono>{rule}</Mono>
            <X className="size-3.5" aria-hidden />
          </button>
        ) : null}
        {filtered ? (
          <Button size="sm" variant="ghost" icon={FilterX} onClick={clearFilters}>
            Clear filters
          </Button>
        ) : null}
        {view === "flat" && rows.length ? (
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(rows.map((r) => `fp:${r.fingerprint}`)))}>
            Select all {rows.length.toLocaleString("en-GB")} shown
          </Button>
        ) : null}
        {triage.error ? (
          <span className="text-xs text-sev-high">
            Triage marks could not load: {triage.error.message}{" "}
            <button type="button" className="underline" onClick={() => void triage.reload()}>
              Retry
            </button>
          </span>
        ) : null}
      </div>

      {selected.size ? <BulkBar count={selected.size} actions={actions} subjects={[...selected]} onClear={() => setSelected(new Set())} /> : null}

      {view === "grouped" ? (
        groups.error ? (
          <ErrorState error={groups.error} onRetry={groups.reload} />
        ) : !groups.data ? (
          <ListSkeleton />
        ) : !totalGroups ? (
          <Panel>
            <EmptyState icon={CircleCheck} title={noIssuesCopy(overview).title}>
              {noIssuesCopy(overview).body}
              {overview.states.resolved ? ` ${plural(overview.states.resolved, "earlier finding")} resolved; see them under All URLs.` : ""}
            </EmptyState>
          </Panel>
        ) : !shownGroups.length ? (
          <NoMatch onClear={clearFilters} />
        ) : (
          <ul className="overflow-hidden rounded-xl border border-line bg-surface" aria-label="Issue groups">
            {shownGroups.map((g) => (
              <GroupItem
                key={g.ruleId}
                group={g}
                expanded={expanded.has(g.ruleId)}
                onExpand={() => {
                  const next = new Set(expanded);
                  if (next.has(g.ruleId)) next.delete(g.ruleId);
                  else next.add(g.ruleId);
                  set({ expand: [...next].join(",") });
                }}
                onOpen={() => openSubject(`rule:${g.ruleId}`)}
                marker={boardIdx.get(g.ruleId)}
                rules={ruleRows}
                filters={filters}
                triageIdx={triageIdx}
                selected={selected}
                onToggle={toggle}
                onOpenRow={(r) => openSubject(`fp:${r.fingerprint}`, r.ruleId)}
                activeKey={openParam}
              />
            ))}
          </ul>
        )
      ) : flat.error ? (
        <ErrorState error={flat.error} onRetry={flat.reload} />
      ) : !flat.data ? (
        <ListSkeleton />
      ) : !totalRows ? (
        <Panel>
          <EmptyState icon={CircleCheck} title={noIssuesCopy(overview).title}>
            {noIssuesCopy(overview).body}
          </EmptyState>
        </Panel>
      ) : (
        <VirtualTable
          rows={rows}
          columns={flatColumns(facts, triageIdx)}
          rowKey={(r) => `fp:${r.fingerprint}`}
          label={FLAT_LABEL}
          onCursorChange={setCursorAt}
          onOpen={(r) => openSubject(`fp:${r.fingerprint}`, r.ruleId)}
          selected={selected}
          onToggleSelect={toggle}
          sort={sort}
          onSort={(id) => {
            // Ascending → descending → off.
            const cur = sort && sort.id === id ? sort : null;
            set({ sort: formatSort(!cur ? { id, dir: "asc" } : cur.dir === "asc" ? { id, dir: "desc" } : null) });
          }}
          activeKey={openParam}
          empty={<NoMatch onClear={clearFilters} bare />}
        />
      )}

      <Drawer open={!!subject} onClose={closeDrawer} title={subject?.kind === "rule" ? `${subject.id} · ${ruleTitle(subject.id)}` : "Issue evidence"}>
        {subject?.kind === "rule" ? (
          <GroupDrawer
            ruleId={subject.id}
            group={groupIdx.get(subject.id)}
            groupsLoading={!groups.data && !groups.error}
            catalog={catalog}
            board={boardIdx.get(subject.id)}
            entry={triageIdx.get(`rule:${subject.id}`)}
            actions={actions}
            onShowUrls={() => set({ view: "flat", rule: subject.id, open: null, orule: null }, { push: true })}
          />
        ) : subject?.kind === "fp" ? (
          <FindingDrawer
            fingerprint={subject.id}
            row={drawerRow}
            rowLoading={drawerLoading}
            rowError={drawerError}
            catalog={catalog}
            entry={triageIdx.get(`fp:${subject.id}`)}
            actions={actions}
            onOpenRule={(id) => openSubject(`rule:${id}`)}
          />
        ) : null}
      </Drawer>

      <IgnoreDialog
        dialog={dialog?.kind === "ignore" ? dialog : null}
        busy={busy}
        onClose={() => setDialog(null)}
        onSubmit={(subjects, reason) => {
          setDialog(null);
          void post(chunk(subjects).map((s): TriageBatch => ({ subjects: s, status: "ignored", note: reason })), undefined, "Ignored");
        }}
      />
      <AssignDialog
        dialog={dialog?.kind === "assign" ? dialog : null}
        busy={busy}
        onClose={() => setDialog(null)}
        onSubmit={(subjects, who) => {
          setDialog(null);
          void post(assignBatches(subjects, triageIdx), who, who ? `Assigned to ${who}` : "Assignee cleared");
        }}
      />
    </div>
  );
}

// ---------- flat table ----------

function flatColumns(facts: ReturnType<typeof ruleFacts>, triageIdx: ReturnType<typeof triageIndex>): Column<IssueRow>[] {
  return [
    {
      id: "priority",
      header: "Priority",
      width: "112px",
      sortable: true,
      cell: (r) => {
        const p = facts.get(r.ruleId)?.priority;
        return p ? (
          <PriorityBadge priority={p} />
        ) : (
          <span className="text-fg-3" title="No open issue group for this rule in this audit">
            —<span className="sr-only">No open group</span>
          </span>
        );
      },
    },
    {
      id: "rule",
      header: "Rule",
      width: "minmax(200px, 1fr)",
      sortable: true,
      cell: (r) => (
        <span className="flex min-w-0 items-baseline gap-2" title={ruleTitle(r.ruleId)}>
          <Mono className="shrink-0 text-fg-2">{r.ruleId}</Mono>
          <span className="truncate text-fg">{ruleTitle(r.ruleId)}</span>
        </span>
      ),
    },
    { id: "url", header: "URL", width: "minmax(240px, 1.4fr)", sortable: true, cell: (r) => <Mono className="text-fg">{shortUrl(r.url)}</Mono> },
    { id: "state", header: "State", width: "150px", sortable: true, cell: (r) => <IssueStateBadge state={r.state} verified={r.verified} /> },
    { id: "template", header: "Template", width: "140px", sortable: true, cell: (r) => (r.templateId ? <Mono className="text-fg-2">{r.templateId}</Mono> : <span className="text-fg-3">—</span>) },
    {
      id: "triage",
      header: "Triage",
      width: "minmax(140px, 0.6fr)",
      cell: (r) => {
        const e = triageIdx.get(`fp:${r.fingerprint}`);
        const m = rowMarker(e);
        return m || e?.assignee ? (
          <span className="flex min-w-0 items-center gap-1.5">
            {m ? <TriageMarker text={m} /> : null}
            {e?.assignee ? <span className="truncate text-xs text-fg-3">{e.assignee}</span> : null}
          </span>
        ) : null;
      },
    },
  ];
}

// ---------- grouped list ----------

function GroupItem({
  group: g,
  expanded,
  onExpand,
  onOpen,
  marker,
  rules,
  filters,
  triageIdx,
  selected,
  onToggle,
  onOpenRow,
  activeKey,
}: {
  group: IssueGroupRow;
  expanded: boolean;
  onExpand: () => void;
  onOpen: () => void;
  marker: BoardCard | undefined;
  rules: ReturnType<typeof useRuleRows>;
  filters: IssueFilters;
  triageIdx: ReturnType<typeof triageIndex>;
  selected: Set<string>;
  onToggle: (key: string) => void;
  onOpenRow: (r: IssueRow) => void;
  activeKey: string | null;
}) {
  const title = ruleTitle(g.ruleId);
  const panelId = `group-${g.ruleId}`;
  const states = stateSummary(g.states);
  const showMarker = marker && (marker.column !== "todo" || marker.assignee);
  return (
    <li className="border-b border-line-subtle last:border-0" data-rule={g.ruleId}>
      <div className={cx("flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 sm:flex-nowrap", activeKey === `rule:${g.ruleId}` && "bg-accent-softer")}>
        <button
          type="button"
          data-group-row
          onClick={onExpand}
          aria-expanded={expanded}
          aria-controls={expanded ? panelId : undefined}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left"
        >
          <ChevronRight className={cx("size-4 shrink-0 text-fg-3 transition-transform", expanded && "rotate-90")} aria-hidden />
          <span className="w-[92px] shrink-0">
            <PriorityBadge priority={g.priority} score={g.score} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-fg">{title}</span>
            <span className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-fg-3">
              <Mono>{g.ruleId}</Mono>
              <span aria-hidden>·</span>
              <span>{categoryLabel(g.category)}</span>
              {states.length ? (
                <>
                  <span aria-hidden>·</span>
                  <span>{states.map((s) => `${s.n.toLocaleString("en-GB")} ${stateLabel(s.state).toLowerCase()}`).join(" · ")}</span>
                </>
              ) : null}
            </span>
          </span>
        </button>
        {showMarker ? <TriageMarker text={`${COLUMN_LABEL[marker.column]}${marker.assignee ? ` · ${marker.assignee}` : ""}`} /> : null}
        <button
          type="button"
          onClick={onOpen}
          className="inline-flex h-7 shrink-0 items-center rounded-full border border-line bg-surface-secondary px-2.5 text-xs font-medium text-fg-2 tabular hover:border-line-strong hover:text-fg"
          title="Open the rule: why, fix, template split, verify"
        >
          {plural(g.affectedUrls, "URL")} · {plural(g.templateCount, "template")}
        </button>
        <Button size="sm" variant="ghost" onClick={onOpen} aria-label={`Details of ${g.ruleId}: ${title}`}>
          Details
        </Button>
      </div>
      {expanded ? (
        <div id={panelId} className="border-t border-line-subtle bg-bg px-3 py-3 sm:pl-10">
          <GroupRows ruleId={g.ruleId} rules={rules} filters={filters} triageIdx={triageIdx} selected={selected} onToggle={onToggle} onOpenRow={onOpenRow} activeKey={activeKey} />
        </div>
      ) : null}
    </li>
  );
}

function GroupRows({
  ruleId,
  rules,
  filters,
  triageIdx,
  selected,
  onToggle,
  onOpenRow,
  activeKey,
}: {
  ruleId: string;
  rules: ReturnType<typeof useRuleRows>;
  filters: IssueFilters;
  triageIdx: ReturnType<typeof triageIndex>;
  selected: Set<string>;
  onToggle: (key: string) => void;
  onOpenRow: (r: IssueRow) => void;
  activeKey: string | null;
}) {
  const { load, retry, cache } = rules;
  useEffect(() => load(ruleId), [load, ruleId]);
  const entry: RuleRows | undefined = cache[ruleId];
  // Inside a group only the state and template filters apply (the text filter matched the rule itself).
  const sub = useMemo(() => ({ text: "", state: filters.state, template: filters.template, priority: null, category: null, rule: null }), [filters.state, filters.template]);
  const shown = useMemo(() => (entry?.rows ? filterIssues(entry.rows, EMPTY_INDEX, sub, new Map()) : []), [entry, sub]);
  const columns = useMemo<Column<IssueRow>[]>(
    () => [
      { id: "url", header: "URL", width: "minmax(220px, 1.2fr)", cell: (r) => <Mono className="text-fg">{shortUrl(r.url)}</Mono> },
      { id: "state", header: "State", width: "150px", cell: (r) => <IssueStateBadge state={r.state} verified={r.verified} /> },
      { id: "message", header: "Message", width: "minmax(200px, 1fr)", cell: (r) => <span className="text-fg-2" title={r.message ?? undefined}>{r.message ?? "—"}</span> },
      {
        id: "triage",
        header: "Triage",
        width: "minmax(120px, 0.5fr)",
        cell: (r) => {
          const m = rowMarker(triageIdx.get(`fp:${r.fingerprint}`));
          return m ? <TriageMarker text={m} /> : null;
        },
      },
    ],
    [triageIdx],
  );
  if (entry?.error) return <ErrorState error={entry.error} onRetry={() => retry(ruleId)} />;
  if (!entry?.rows)
    return (
      <div role="status" aria-label={`Loading the URLs of ${ruleId}`} className="flex flex-col gap-2">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    );
  return (
    <>
      {shown.length !== entry.rows.length ? (
        <p className="mb-2 text-xs text-fg-3">
          {shown.length.toLocaleString("en-GB")} of {plural(entry.rows.length, "finding")} match the state and template filters.
        </p>
      ) : null}
      <VirtualTable
        rows={shown}
        columns={columns}
        rowKey={(r) => `fp:${r.fingerprint}`}
        label={`URLs of ${ruleId}`}
        keyboard={false}
        onOpen={onOpenRow}
        selected={selected}
        onToggleSelect={onToggle}
        height="420px"
        activeKey={activeKey}
        empty={<p className="text-center text-[13px] text-fg-2">No finding of this rule matches the state and template filters.</p>}
      />
    </>
  );
}

// ---------- states, bulk bar, dialogs ----------

function PartialNotice({ notRechecked, inconclusive }: { notRechecked: number; inconclusive: number }) {
  return (
    <Notice title="Some findings are not settled">
      <ul className="mt-1 list-disc space-y-0.5 pl-4">
        {notRechecked ? (
          <li>
            <span className="font-medium text-fg">Not re-checked ({notRechecked.toLocaleString("en-GB")}):</span> an earlier audit found these, and this audit did not look at them again
            (the page was not crawled this time, or the rule did not run). They may or may not be fixed, so they stay open.
          </li>
        ) : null}
        {inconclusive ? (
          <li>
            <span className="font-medium text-fg">Inconclusive ({inconclusive.toLocaleString("en-GB")}):</span> the check looked but could not decide either way. They are not counted as
            issues or as fixed.
          </li>
        ) : null}
      </ul>
    </Notice>
  );
}

function NoMatch({ onClear, bare }: { onClear: () => void; bare?: boolean }) {
  const body = (
    <EmptyState icon={FilterX} title="No issues match these filters" compact action={<Button icon={FilterX} onClick={onClear}>Clear filters</Button>}>
      Try a broader filter, or clear them to see every issue.
    </EmptyState>
  );
  return bare ? body : <Panel>{body}</Panel>;
}

function ListSkeleton() {
  return (
    <div role="status" aria-label="Loading issues" className="overflow-hidden rounded-xl border border-line bg-surface">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex items-center gap-4 border-b border-line-subtle px-4 py-3.5 last:border-0">
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="hidden h-4 w-28 sm:block" />
        </div>
      ))}
    </div>
  );
}

function BulkBar({ count, subjects, actions, onClear }: { count: number; subjects: string[]; actions: TriageActions; onClear: () => void }) {
  return (
    <div className="sticky top-2 z-20 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-elevated px-3 py-2 shadow-raised" role="region" aria-label="Bulk actions">
      <span className="text-[13px] font-medium text-fg">{plural(count, "issue")} selected</span>
      <span className="flex-1" />
      <Button size="sm" variant="primary" loading={actions.busy} onClick={() => actions.fixed(subjects)}>
        Mark fixed
      </Button>
      <Button size="sm" disabled={actions.busy} onClick={() => actions.ignore(subjects)}>
        Ignore…
      </Button>
      <Button size="sm" disabled={actions.busy} onClick={() => actions.assign(subjects)}>
        Assign…
      </Button>
      <Button size="sm" variant="ghost" disabled={actions.busy} onClick={() => actions.clear(subjects)}>
        Clear marks
      </Button>
      <Button size="sm" variant="ghost" icon={X} onClick={onClear}>
        Deselect
      </Button>
    </div>
  );
}

function IgnoreDialog({ dialog, busy, onClose, onSubmit }: { dialog: { subjects: string[] } | null; busy: boolean; onClose: () => void; onSubmit: (subjects: string[], reason: string) => void }) {
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const missing = !reason.trim();
  const close = () => {
    setReason("");
    setTouched(false);
    onClose();
  };
  return (
    <Modal
      open={!!dialog}
      onClose={close}
      title={`Ignore ${dialog ? plural(dialog.subjects.length, "issue") : "issues"}`}
      description="Ignoring is your team's call and is logged with its reason. The issue's state and the counts do not change."
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => {
              setTouched(true);
              if (missing || !dialog) return;
              onSubmit(dialog.subjects, reason.trim());
              setReason("");
              setTouched(false);
            }}
          >
            Ignore
          </Button>
        </>
      }
    >
      <label htmlFor="ignore-reason" className="mb-1.5 block text-[13px] font-medium text-fg">
        Reason (required)
      </label>
      <Textarea
        id="ignore-reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={2000}
        required
        aria-invalid={touched && missing ? true : undefined}
        aria-describedby={touched && missing ? "ignore-reason-error" : undefined}
        placeholder="e.g. Staging-only page, intentionally noindex"
      />
      {touched && missing ? (
        <p id="ignore-reason-error" role="alert" className="mt-1.5 text-xs text-sev-high">
          Say why these issues are ignored.
        </p>
      ) : null}
    </Modal>
  );
}

function AssignDialog({ dialog, busy, onClose, onSubmit }: { dialog: { subjects: string[] } | null; busy: boolean; onClose: () => void; onSubmit: (subjects: string[], who: string | null) => void }) {
  const [who, setWho] = useState("");
  const close = () => {
    setWho("");
    onClose();
  };
  return (
    <Modal
      open={!!dialog}
      onClose={close}
      title={`Assign ${dialog ? plural(dialog.subjects.length, "issue") : "issues"}`}
      description="Leave empty to clear the assignee. Marks (fixed, ignored) are kept."
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => {
              if (!dialog) return;
              onSubmit(dialog.subjects, who.trim() || null);
              setWho("");
            }}
          >
            Assign
          </Button>
        </>
      }
    >
      <label htmlFor="assign-who" className="mb-1.5 block text-[13px] font-medium text-fg">
        Assignee
      </label>
      <Input id="assign-who" value={who} onChange={(e) => setWho(e.target.value)} maxLength={120} placeholder="Name or team" />
    </Modal>
  );
}

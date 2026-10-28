"use client";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, Copy, ListChecks, Plus, RefreshCw, Search, SearchX, Trash, UserRound, X } from "lucide-react";
import { useMemo, useState } from "react";
import { TRANSITIONS, WORKFLOW_STATUSES, type FixTask, type ManualCheck, type WorkflowStatus } from "@/lib/model";
import type { TaskRow } from "@/lib/views";
import { CriteriaList, FactsTable, Snippets, taskBrief } from "../domain";
import { api, useApi } from "../lib/api";
import { fmtAgo, fmtDateTime, plural, shortUrl } from "../lib/format";
import { ConfirmDialog, Modal, useCopy, useToast } from "../overlays";
import { useWs } from "../shell/context";
import {
  Button,
  EmptyState,
  ErrorState,
  ExternalUrl,
  Field,
  Input,
  Notice,
  PageHeader,
  PageSkeleton,
  Panel,
  SampleTag,
  Segmented,
  Select,
  SeverityBadge,
  Textarea,
  VerificationBadge,
  WorkflowBadge,
  cx,
} from "../ui";

const label = (s: WorkflowStatus) => WORKFLOW_STATUSES.find((w) => w.id === s)!.label;
type View = "active" | "ready" | "closed" | "all";
const inView = (t: FixTask, v: View) =>
  v === "all" ? true : v === "ready" ? t.workflowStatus === "ready_to_verify" : v === "closed" ? t.workflowStatus === "resolved" || t.workflowStatus === "wont_fix" : t.workflowStatus !== "resolved" && t.workflowStatus !== "wont_fix";
const SEV_RANK = { high: 0, medium: 1, low: 2 } as const;
const topPriority = (t: FixTask) => Math.min(...t.items.map((i) => i.finding.priority.level));

/** Asks for the reason before moving to Won't fix; other moves apply immediately. */
function WontFixModal({ count, onClose, onConfirm, busy }: { count: number; onClose: () => void; onConfirm: (reason: string) => void; busy: boolean }) {
  const [reason, setReason] = useState("");
  return (
    <Modal
      open
      onClose={onClose}
      title={count === 1 ? "Won't fix this task?" : `Won't fix ${count} tasks?`}
      description="Record why. The reason stays in the task history and on reports."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!reason.trim()} onClick={() => onConfirm(reason.trim())}>Mark won&apos;t fix</Button></>}
    >
      <Field label="Reason" htmlFor="wf-reason">
        <Textarea id="wf-reason" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus placeholder="e.g. Intentional: this page is a short navigation hub." />
      </Field>
    </Modal>
  );
}

export function TasksView() {
  const { base, apiBase, sites } = useWs();
  const sp = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<TaskRow[]>(`${apiBase}/tasks`);
  const view = (sp.get("view") as View | null) ?? "active";
  const site = sp.get("site") ?? "";
  const owner = sp.get("owner") ?? "";
  const sort = sp.get("sort") ?? "updated";
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [wontFix, setWontFix] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [assignee, setAssignee] = useState("");

  const set = (k: string, v: string) => {
    const p = new URLSearchParams(sp.toString());
    if (v && !(k === "view" && v === "active") && !(k === "sort" && v === "updated")) p.set(k, v);
    else p.delete(k);
    setSelected(new Set());
    router.replace(`${base}/tasks${p.size ? `?${p}` : ""}`, { scroll: false });
  };

  const all = useMemo(() => data ?? [], [data]);
  const owners = useMemo(() => [...new Set(all.map((t) => t.owner).filter(Boolean) as string[])].sort(), [all]);
  const counts = useMemo(() => ({ active: all.filter((t) => inView(t, "active")).length, ready: all.filter((t) => inView(t, "ready")).length, closed: all.filter((t) => inView(t, "closed")).length, all: all.length }), [all]);
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    const list = all.filter(
      (x) =>
        inView(x, view) &&
        (!site || x.siteId === site) &&
        (!owner || (owner === "__none" ? !x.owner : x.owner === owner)) &&
        (!t || `${x.title} ${x.owner ?? ""} ${x.notes} ${x.items.map((i) => i.finding.pageUrl).join(" ")}`.toLowerCase().includes(t)),
    );
    const order = WORKFLOW_STATUSES.map((w) => w.id);
    return list.sort((a, b) =>
      sort === "priority"
        ? topPriority(a) - topPriority(b) || SEV_RANK[a.items[0].finding.priority.severity] - SEV_RANK[b.items[0].finding.priority.severity]
        : sort === "status"
          ? order.indexOf(a.workflowStatus) - order.indexOf(b.workflowStatus)
          : b.updatedAt.localeCompare(a.updatedAt),
    );
  }, [all, view, site, owner, q, sort]);

  // Bulk moves are only offered when every selected task allows them.
  const sel = rows.filter((t) => selected.has(t.id));
  const commonMoves = sel.length ? WORKFLOW_STATUSES.map((w) => w.id).filter((s) => sel.every((t) => TRANSITIONS[t.workflowStatus].includes(s))) : [];

  const runBulk = async (patch: { workflowStatus?: WorkflowStatus; owner?: string | null; wontFixReason?: string }) => {
    setBulkBusy(true);
    try {
      const r = await api<{ updated: string[]; failed: { id: string; message: string }[] }>(`${apiBase}/tasks/bulk`, { method: "POST", body: { ids: [...selected], patch } });
      toast({ tone: r.failed.length ? "error" : "ok", title: `${plural(r.updated.length, "task")} updated`, detail: r.failed.length ? `${r.failed.length} not changed: ${r.failed[0].message}` : undefined });
      setSelected(new Set());
      setWontFix(false);
      setAssigning(false);
      await reload();
    } catch (e) {
      toast({ tone: "error", title: "Bulk update failed", detail: (e as Error).message });
    } finally {
      setBulkBusy(false);
    }
  };

  const header = <PageHeader crumbs={[{ label: "Fix Queue" }]} title="Fix Queue" description="Workflow status is set by people. Verification status changes only when SiteSentry re-checks the site, so “done” never pretends to be “fixed”." />;
  if (error) return (<>{header}<ErrorState error={error} onRetry={reload} /></>);
  if (loading && !data) return <PageSkeleton />;

  return (
    <>
      {header}
      {all.length ? (<>
      <div className="mb-3 flex flex-col gap-2 xl:flex-row xl:items-center">
        <div className="overflow-x-auto">
          <Segmented<View>
            label="Queue view"
            value={view}
            onChange={(v) => set("view", v)}
            options={[
              { value: "active", label: <>Active <span className="ml-1 tabular text-fg-3">{counts.active}</span></> },
              { value: "ready", label: <>Ready to verify <span className="ml-1 tabular text-fg-3">{counts.ready}</span></> },
              { value: "closed", label: <>Closed <span className="ml-1 tabular text-fg-3">{counts.closed}</span></> },
              { value: "all", label: <>All <span className="ml-1 tabular text-fg-3">{counts.all}</span></> },
            ]}
          />
        </div>
        <label className="relative min-w-0 flex-1 xl:max-w-64">
          <span className="sr-only">Search tasks</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-3" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tasks…" className="h-8 pl-8 text-[13px]" />
        </label>
        <div className="flex flex-wrap gap-2">
          <Select aria-label="Site" value={site} onChange={(e) => set("site", e.target.value)} className="h-8 w-auto text-[13px]">
            <option value="">All sites</option>
            {(sites.data ?? []).map((s) => <option key={s.site.id} value={s.site.id}>{s.site.name}</option>)}
          </Select>
          <Select aria-label="Owner" value={owner} onChange={(e) => set("owner", e.target.value)} className="h-8 w-auto text-[13px]">
            <option value="">Any owner</option>
            <option value="__none">Unassigned</option>
            {owners.map((o) => <option key={o} value={o}>{o}</option>)}
          </Select>
          <Select aria-label="Sort" value={sort} onChange={(e) => set("sort", e.target.value)} className="h-8 w-auto text-[13px]">
            <option value="updated">Sort: Recently updated</option>
            <option value="priority">Sort: Priority</option>
            <option value="status">Sort: Workflow stage</option>
          </Select>
        </div>
      </div>

      <div className="mb-2 flex min-h-8 flex-wrap items-center gap-2 text-[13px] text-fg-3">
        {sel.length ? (
          <>
            <span className="text-fg">{sel.length} selected</span>
            <Select
              aria-label="Move selected to"
              value=""
              disabled={bulkBusy || !commonMoves.length}
              onChange={(e) => {
                const s = e.target.value as WorkflowStatus;
                if (s === "wont_fix") setWontFix(true);
                else if (s) void runBulk({ workflowStatus: s });
              }}
              className="h-8 w-auto text-[13px]"
            >
              <option value="">{commonMoves.length ? "Move to…" : "No common move"}</option>
              {commonMoves.map((s) => <option key={s} value={s}>{label(s)}</option>)}
            </Select>
            <Button size="sm" icon={UserRound} onClick={() => setAssigning(true)} disabled={bulkBusy}>Assign</Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Deselect</Button>
          </>
        ) : (
          <span>{plural(rows.length, "task")}</span>
        )}
      </div>
      </>) : null}

      <Panel flush>
        {rows.length === 0 ? (
          all.length === 0 ? (
            <EmptyState icon={ListChecks} title="No tasks yet" action={<Link href={`${base}/issues`} className="text-sm text-accent-ink hover:underline">Browse open issues</Link>}>
              Create a task from any finding. It freezes the evidence and the acceptance criteria the fix will be verified against.
            </EmptyState>
          ) : (
            <EmptyState icon={SearchX} title={view === "ready" ? "Nothing is ready to verify" : "No tasks match"}>
              {view === "ready" ? "Move a task to Ready to verify once the fix is deployed." : undefined}
            </EmptyState>
          )
        ) : (
          <>
            <table className="hidden w-full table-fixed text-sm lg:table">
              <thead>
                <tr className="border-b border-line-subtle text-left text-xs text-fg-3">
                  <th className="w-10 px-4 py-2.5">
                    <input type="checkbox" className="size-4 cursor-pointer accent-[var(--accent)]" aria-label="Select all" checked={rows.every((t) => selected.has(t.id))} onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((t) => t.id)) : new Set())} />
                  </th>
                  <th className="px-2 py-2.5 font-medium">Task</th>
                  <th className="w-[140px] px-4 py-2.5 font-medium">Workflow</th>
                  <th className="w-[140px] px-4 py-2.5 font-medium">Verification</th>
                  <th className="w-[150px] px-4 py-2.5 font-medium">Owner</th>
                  <th className="w-[110px] px-4 py-2.5 text-right font-medium">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-subtle">
                {rows.map((t) => (
                  <tr key={t.id} className={cx("cursor-pointer hover:bg-elevated/50", selected.has(t.id) && "bg-elevated/40")} onClick={() => router.push(`${base}/tasks/${t.id}`)}>
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" className="size-4 cursor-pointer accent-[var(--accent)]" aria-label={`Select ${t.title}`} checked={selected.has(t.id)} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(t.id); else n.delete(t.id); return n; })} />
                    </td>
                    <td className="px-2 py-3">
                      <Link href={`${base}/tasks/${t.id}`} onClick={(e) => e.stopPropagation()} className="block truncate text-fg hover:text-accent-ink">{t.title}</Link>
                      <span className="mt-0.5 flex items-center gap-2 text-xs text-fg-3">
                        <SeverityBadge severity={t.items[0].finding.priority.severity} priority={topPriority(t)} />
                        <span className="truncate">{t.siteName} · {plural(t.items.length, "finding")}</span>
                      </span>
                    </td>
                    <td className="px-4 py-3"><WorkflowBadge status={t.workflowStatus} /></td>
                    <td className="px-4 py-3"><VerificationBadge status={t.verificationStatus} /></td>
                    <td className="truncate px-4 py-3 text-[13px] text-fg-2">{t.owner ?? <span className="text-fg-3">Unassigned</span>}</td>
                    <td className="px-4 py-3 text-right text-[13px] text-fg-3" title={fmtDateTime(t.updatedAt)}>{fmtAgo(t.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="divide-y divide-line-subtle lg:hidden">
              {rows.map((t) => (
                <li key={t.id} className="flex items-start gap-3 px-4 py-3">
                  <input type="checkbox" className="mt-1 size-4 shrink-0 accent-[var(--accent)]" aria-label={`Select ${t.title}`} checked={selected.has(t.id)} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(t.id); else n.delete(t.id); return n; })} />
                  <Link href={`${base}/tasks/${t.id}`} className="min-w-0 flex-1">
                    <span className="block text-sm text-fg">{t.title}</span>
                    <span className="mt-1.5 flex flex-wrap gap-1.5"><WorkflowBadge status={t.workflowStatus} /><VerificationBadge status={t.verificationStatus} /></span>
                    <span className="mt-1.5 block truncate text-xs text-fg-3">{t.siteName} · {t.owner ?? "Unassigned"} · {fmtAgo(t.updatedAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>

      {wontFix ? <WontFixModal count={sel.length} busy={bulkBusy} onClose={() => setWontFix(false)} onConfirm={(r) => runBulk({ workflowStatus: "wont_fix", wontFixReason: r })} /> : null}
      {assigning ? (
        <Modal open onClose={() => setAssigning(false)} title={`Assign ${plural(sel.length, "task")}`} footer={<><Button variant="ghost" onClick={() => runBulk({ owner: null })} disabled={bulkBusy}>Unassign</Button><Button variant="primary" loading={bulkBusy} disabled={!assignee.trim()} onClick={() => runBulk({ owner: assignee.trim() })}>Assign</Button></>}>
          <Field label="Owner" htmlFor="bulk-owner" hint={owners.length ? `Existing: ${owners.join(", ")}` : undefined}>
            <Input id="bulk-owner" list="owner-list" value={assignee} onChange={(e) => setAssignee(e.target.value)} autoFocus maxLength={100} />
            <datalist id="owner-list">{owners.map((o) => <option key={o} value={o} />)}</datalist>
          </Field>
        </Modal>
      ) : null}
    </>
  );
}

// ---------- detail ----------

const EVENT_LABEL: Record<FixTask["history"][number]["kind"], string> = {
  created: "Created",
  status: "Status",
  owner: "Owner",
  edited: "Edited",
  verified: "Verified",
  reopened: "Reopened",
  regression: "Regression",
};

export function TaskDetailView() {
  const { taskId } = useParams<{ taskId: string }>();
  const { ws, base, apiBase } = useWs();
  const router = useRouter();
  const toast = useToast();
  const copy = useCopy();
  const { data, error, loading, reload, setData } = useApi<TaskRow>(`${apiBase}/tasks/${taskId}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [wontFix, setWontFix] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notes, setNotes] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [newCheck, setNewCheck] = useState("");

  const crumbs = [{ label: "Fix Queue", href: `${base}/tasks` }, { label: data?.title ?? "Task" }];
  if (error) return (<><PageHeader title="Task" crumbs={crumbs} /><ErrorState error={error} onRetry={reload} /></>);
  if (loading && !data) return <PageSkeleton rows={4} />;
  if (!data) return null;
  const t = data;

  const patch = async (body: Record<string, unknown>, what: string, key = what) => {
    setBusy(key);
    try {
      const next = await api<TaskRow>(`${apiBase}/tasks/${t.id}`, { method: "PATCH", body });
      setData(next);
      toast({ tone: "ok", title: what });
      return true;
    } catch (e) {
      toast({ tone: "error", title: "Not saved", detail: (e as Error).message });
      return false;
    } finally {
      setBusy(null);
    }
  };
  const move = (s: WorkflowStatus) => (s === "wont_fix" ? setWontFix(true) : patch({ workflowStatus: s }, `Moved to ${label(s)}`, `move-${s}`));
  const verify = async () => {
    setBusy("verify");
    try {
      const next = await api<TaskRow>(`${apiBase}/tasks/${t.id}/verify`, { method: "POST" });
      setData(next);
      const v = next.verifications.at(-1)!;
      toast({ tone: v.outcome === "passing" ? "ok" : v.outcome === "failing" ? "error" : "info", title: v.outcome === "passing" ? "Verified: all criteria pass" : v.outcome === "failing" ? "Still failing" : "Verification inconclusive", detail: v.reason });
    } catch (e) {
      toast({ tone: "error", title: "Verification could not run", detail: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    setBusy("delete");
    try {
      await api(`${apiBase}/tasks/${t.id}`, { method: "DELETE" });
      toast({ tone: "ok", title: "Task deleted", detail: "The findings remain in their audits and can be tracked again." });
      router.push(`${base}/tasks`);
    } catch (e) {
      toast({ tone: "error", title: "Could not delete", detail: (e as Error).message });
      setBusy(null);
    }
  };
  const saveChecks = (checks: ManualCheck[]) => patch({ manualChecks: checks }, "Checklist saved", "checks");
  const lastV = t.verifications.at(-1);
  const brief = [`# ${t.title}`, `Site: ${t.siteName} (${t.siteOrigin}) · Owner: ${t.owner ?? "unassigned"} · Status: ${label(t.workflowStatus)}`, t.notes ? `\n${t.notes}` : "", ...t.items.map((i) => "\n" + taskBrief(i.finding, { sample: ws === "sample" }))].join("\n");
  const order: WorkflowStatus[] = WORKFLOW_STATUSES.map((w) => w.id).filter((s) => s !== "wont_fix");
  const stage = order.indexOf(t.workflowStatus);

  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title={t.title}
        meta={
          <>
            <WorkflowBadge status={t.workflowStatus} />
            <VerificationBadge status={t.verificationStatus} />
            {ws === "sample" ? <SampleTag /> : null}
            <Link href={`${base}/sites/${t.siteId}`} className="text-[13px] text-fg-3 hover:text-fg">{t.siteName}</Link>
            <span className="text-[13px] text-fg-3">· updated {fmtAgo(t.updatedAt)}</span>
          </>
        }
        actions={
          <>
            <Button icon={Copy} onClick={() => copy(brief, "Developer brief copied as Markdown")}>Copy brief</Button>
            <Button variant={t.workflowStatus === "ready_to_verify" ? "primary" : "secondary"} icon={RefreshCw} loading={busy === "verify"} onClick={verify}>Verify now</Button>
          </>
        }
      />

      {t.workflowStatus === "resolved" && t.verificationStatus !== "passing" ? (
        <div className="mb-6"><Notice tone="warn" title="Resolved without a passing verification">The task was closed by hand. Run Verify now to prove the fix on the live page.</Notice></div>
      ) : null}
      {t.workflowStatus === "wont_fix" && t.wontFixReason ? <div className="mb-6"><Notice tone="info" title="Won't fix">{t.wontFixReason}</Notice></div> : null}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-6">
          <Panel title="Workflow">
            <p className="mb-2 text-[13px] text-fg-2 lg:hidden">{t.workflowStatus === "wont_fix" ? "Closed as won't fix" : `Stage ${stage + 1} of ${order.length}: ${label(t.workflowStatus)}`}</p>
            <ol className="mb-5 grid grid-cols-5 gap-2" aria-label="Workflow stage">
              {order.map((s, i) => (
                <li key={s} className="min-w-0">
                  <span className={cx("block h-1 rounded-full", t.workflowStatus === "wont_fix" ? "bg-elevated" : i <= stage ? "bg-accent" : "bg-elevated")} />
                  <span className={cx("mt-2 hidden truncate text-xs lg:block", i === stage ? "font-medium text-fg" : "text-fg-3")} aria-current={i === stage ? "step" : undefined}>{label(s)}</span>
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] text-fg-3">Move to</span>
              {TRANSITIONS[t.workflowStatus].map((s) => (
                <Button key={s} size="sm" variant={s === "ready_to_verify" || (s === "resolved" && t.verificationStatus === "passing") ? "primary" : "secondary"} loading={busy === `move-${s}`} onClick={() => move(s)} icon={s === "wont_fix" ? undefined : ArrowRight}>
                  {label(s)}
                </Button>
              ))}
            </div>
            {t.workflowStatus === "ready_to_verify" ? <p className="mt-3 text-[13px] text-fg-2">The fix is deployed? Run <strong className="font-medium text-fg">Verify now</strong>. A passing check is the evidence for moving to Resolved.</p> : null}
          </Panel>

          <Panel title={`Findings (${t.items.length})`} description="Frozen at task creation: original evidence and acceptance criteria. Verification judges the live page against these." flush>
            <ul className="divide-y divide-line-subtle">
              {t.items.map((item) => {
                const f = item.finding;
                const lastItem = lastV?.items.find((x) => x.fingerprint === item.fingerprint);
                return (
                  <li key={item.fingerprint} className="flex flex-col gap-4 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <SeverityBadge severity={f.priority.severity} priority={f.priority.level} />
                          {item.lastOutcome ? <VerificationBadge status={item.lastOutcome === "resolved" ? "passing" : item.lastOutcome === "still_failing" ? "failing" : "inconclusive"} /> : <VerificationBadge status="unverified" />}
                        </span>
                        <Link href={`${base}/issues/${encodeURIComponent(item.fingerprint)}?site=${t.siteId}`} className="mt-2 block text-sm font-medium text-fg hover:text-accent-ink">{f.title}</Link>
                        <ExternalUrl url={f.pageUrl} className="max-w-full font-mono text-[12.5px] text-fg-3" />
                      </div>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div><p className="text-xs text-fg-3">Originally observed</p><p className="evidence mt-0.5 text-[13px] text-fg">{f.observed}</p></div>
                      <div><p className="text-xs text-fg-3">Expected</p><p className="evidence mt-0.5 text-[13px] text-fg">{f.expected}</p></div>
                    </div>
                    <div>
                      <p className="mb-2 text-xs text-fg-3">Acceptance criteria{lastItem ? ` · last checked ${fmtAgo(lastV!.at)}` : ""}</p>
                      <CriteriaList criteria={f.acceptanceCriteria} results={lastItem?.criteria} />
                      {lastItem && lastItem.outcome === "inconclusive" ? <p className="mt-2 text-[13px] text-sev-medium">{lastItem.reason}</p> : null}
                    </div>
                    <details className="group text-[13px]">
                      <summary className="cursor-pointer text-fg-2 hover:text-fg">Original evidence</summary>
                      <div className="mt-3 flex flex-col gap-3">
                        <p className="text-xs text-fg-3">Captured {fmtDateTime(item.originalObservation.capturedAt)} · HTTP {item.originalObservation.httpStatus} · {shortUrl(item.originalObservation.finalUrl)}</p>
                        <Snippets snippets={item.originalObservation.snippets} />
                        <FactsTable facts={item.originalObservation.facts} />
                      </div>
                    </details>
                  </li>
                );
              })}
            </ul>
          </Panel>

          <Panel title="Verification history" flush>
            {t.verifications.length === 0 ? (
              <EmptyState compact icon={RefreshCw} title="Not verified yet">Verify re-fetches each affected URL and checks the frozen criteria. It never changes the workflow status, except to reopen a resolved task that fails.</EmptyState>
            ) : (
              <ul className="divide-y divide-line-subtle">
                {[...t.verifications].reverse().map((v) => (
                  <li key={v.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <VerificationBadge status={v.outcome} />
                      <span className="text-xs text-fg-3">{fmtDateTime(v.at)}</span>
                    </div>
                    <p className="mt-1.5 text-[13px] text-fg-2">{v.reason}</p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="flex flex-col gap-6">
          <Panel title="Details">
            <div className="flex flex-col gap-4">
              <Field label="Title" htmlFor="t-title">
                <div className="flex gap-2">
                  <Input id="t-title" value={title ?? t.title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
                  {title !== null && title !== t.title ? <Button size="md" loading={busy === "title"} onClick={async () => (await patch({ title }, "Title saved", "title")) && setTitle(null)}>Save</Button> : null}
                </div>
              </Field>
              <Field label="Owner" htmlFor="t-owner">
                <div className="flex gap-2">
                  <Input id="t-owner" value={owner ?? t.owner ?? ""} onChange={(e) => setOwner(e.target.value)} placeholder="Unassigned" maxLength={100} />
                  {owner !== null && owner !== (t.owner ?? "") ? <Button loading={busy === "owner"} onClick={async () => (await patch({ owner: owner || null }, "Owner saved", "owner")) && setOwner(null)}>Save</Button> : null}
                </div>
              </Field>
              <Field label="Notes" htmlFor="t-notes">
                <Textarea id="t-notes" value={notes ?? t.notes} onChange={(e) => setNotes(e.target.value)} placeholder="Implementation notes, links, decisions…" />
              </Field>
              {notes !== null && notes !== t.notes ? <div className="-mt-2 flex justify-end gap-2"><Button size="sm" variant="ghost" onClick={() => setNotes(null)}>Discard</Button><Button size="sm" variant="primary" loading={busy === "notes"} onClick={async () => (await patch({ notes }, "Notes saved", "notes")) && setNotes(null)}>Save notes</Button></div> : null}
            </div>
          </Panel>

          <Panel title="Manual checklist" description="Your own steps. Not machine-verified; the acceptance criteria are.">
            <ul className="flex flex-col gap-2">
              {t.manualChecks.map((c) => (
                <li key={c.id} className="group flex items-start gap-2.5">
                  <input type="checkbox" className="mt-0.5 size-4 shrink-0 cursor-pointer accent-[var(--accent)]" checked={c.done} aria-label={c.text} onChange={(e) => saveChecks(t.manualChecks.map((x) => (x.id === c.id ? { ...x, done: e.target.checked } : x)))} />
                  <span className={cx("min-w-0 flex-1 text-sm", c.done ? "text-fg-3 line-through" : "text-fg")}>{c.text}</span>
                  <button type="button" className="rounded p-0.5 text-fg-3 opacity-60 hover:text-sev-high group-hover:opacity-100" aria-label={`Remove “${c.text}”`} onClick={() => saveChecks(t.manualChecks.filter((x) => x.id !== c.id))}><X className="size-3.5" /></button>
                </li>
              ))}
            </ul>
            <form
              className="mt-3 flex gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!newCheck.trim()) return;
                if (await saveChecks([...t.manualChecks, { id: Math.random().toString(36).slice(2, 10), text: newCheck.trim(), done: false }])) setNewCheck("");
              }}
            >
              <Input value={newCheck} onChange={(e) => setNewCheck(e.target.value)} placeholder="Add a step, e.g. Clear CDN cache" aria-label="New checklist item" className="h-8 text-[13px]" maxLength={500} />
              <Button size="sm" type="submit" icon={Plus} loading={busy === "checks"} disabled={!newCheck.trim()}>Add</Button>
            </form>
          </Panel>

          <Panel title="Activity">
            <ol className="flex flex-col gap-3">
              {[...t.history].reverse().map((h, i) => (
                <li key={i} className="text-[13px]">
                  <span className="flex items-center justify-between gap-2">
                    <span className={cx("font-medium", h.kind === "regression" ? "text-sev-high" : "text-fg")}>{EVENT_LABEL[h.kind]}{h.from || h.to ? <span className="font-normal text-fg-2"> {h.from ? `${h.from.replace(/_/g, " ")} → ` : ""}{h.to?.replace(/_/g, " ")}</span> : null}</span>
                    <span className="shrink-0 text-xs text-fg-3">{fmtDateTime(h.at)}</span>
                  </span>
                  {h.note ? <span className="mt-0.5 block text-fg-3">{h.note}</span> : null}
                </li>
              ))}
            </ol>
          </Panel>

          <Button variant="danger" icon={Trash} onClick={() => setConfirmDelete(true)} className="self-start">Delete task</Button>
        </div>
      </div>

      {wontFix ? <WontFixModal count={1} busy={busy === "move-wont_fix"} onClose={() => setWontFix(false)} onConfirm={async (r) => { if (await patch({ workflowStatus: "wont_fix", wontFixReason: r }, "Marked won't fix", "move-wont_fix")) setWontFix(false); }} /> : null}
      <ConfirmDialog open={confirmDelete} onClose={() => setConfirmDelete(false)} onConfirm={remove} busy={busy === "delete"} danger title="Delete this task?" confirmLabel="Delete task" description="Its notes, checklist and verification history are removed. The findings stay in their audits." />
    </>
  );
}

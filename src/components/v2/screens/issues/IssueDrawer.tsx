"use client";
// The Issues explorer's right-side drawer (SPEC "Global patterns": opening an issue never loses the table context).
// A group (rule:<id>) shows the rule's why / fix / acceptance, priority inputs, template split, verification and the
// group's board column; a row (fp:<fingerprint>) shows the finding's message, evidence and history across audits,
// read from the URL's page record. Triage here is a person's call and is shown apart from the issue state.
import Link from "next/link";
import { Braces, Copy, Download, ExternalLink, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import type { IssueRow, PageDetail } from "@/lib/results/explore";
import type { IssueGroupRow, VerificationResult } from "@/lib/results/queries";
import type { BoardCard, TriageEntry } from "@/lib/results/triage";
import type { StartedVerification } from "@/lib/results/verify";
import type { CatalogRule } from "@/lib/server/results";
import { useAudit } from "../../AuditFrame";
import { categoryLabel, IssueStateBadge, PriorityBadge, stateLabel } from "../../badges";
import { ruleTitle } from "../../hooks";
import { api, useApi, type Resource } from "../../../lib/api";
import { fmtDateTime, plural } from "../../../lib/format";
import { useCopy, useToast } from "../../../overlays";
import { btn, Button, DefList, ErrorState, ExternalUrl, Input, Mono, Notice, Select, Skeleton, cx } from "../../../ui";
import { rowMarker, stateSummary } from "./filter";

/** Triage actions the screen performs (POST /triage, then refresh); the drawer only asks. */
export interface TriageActions {
  fixed: (subjects: string[]) => void;
  ignore: (subjects: string[]) => void;
  clear: (subjects: string[]) => void;
  assign: (subjects: string[]) => void;
  /** Move an issue group between board columns, with its assignee. */
  group: (ruleId: string, status: "todo" | "in_progress" | "ready", assignee: string | null) => Promise<void>;
  busy: boolean;
}

export const COLUMN_LABEL: Record<BoardCard["column"], string> = { todo: "To do", in_progress: "In progress", ready: "Ready to verify", verified: "Verified" };

function Section({ title, children, id }: { title: string; children: React.ReactNode; id?: string }) {
  return (
    <section id={id} className="mb-6">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-3">{title}</h3>
      {children}
    </section>
  );
}

/** Why it matters, how to fix it and when it counts as fixed, from the rule catalog. */
export function RuleExplain({ ruleId, catalog }: { ruleId: string; catalog: Map<string, CatalogRule> | null }) {
  if (!catalog)
    return (
      <div role="status" aria-label="Loading the rule's explanation" className="mb-6 flex flex-col gap-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  const r = catalog.get(ruleId);
  if (!r) return <p className="mb-6 text-sm text-fg-2">{ruleId} is not in this version&apos;s rule catalog, so there is no explanation to show.</p>;
  return (
    <>
      <Section title="Why it matters">
        <p className="text-sm leading-relaxed text-fg">{r.why}</p>
      </Section>
      <Section title="How to fix it">
        <p className="text-sm leading-relaxed text-fg">{r.fix}</p>
      </Section>
      <Section title="Counts as fixed when">
        <p className="text-sm leading-relaxed text-fg">{r.acceptance}</p>
        {r.docs ? (
          <p className="mt-2 text-[13px]">
            <ExternalUrl url={r.docs}>Documentation</ExternalUrl>
          </p>
        ) : null}
      </Section>
    </>
  );
}

// ---------- group ----------

export function GroupDrawer({
  ruleId,
  group,
  groupsLoading,
  catalog,
  board,
  entry,
  actions,
  onShowUrls,
}: {
  ruleId: string;
  group: IssueGroupRow | undefined;
  groupsLoading: boolean;
  catalog: Map<string, CatalogRule> | null;
  board: BoardCard | undefined;
  entry: TriageEntry | undefined;
  actions: TriageActions;
  onShowUrls: () => void;
}) {
  const { auditApi } = useAudit();
  const enc = encodeURIComponent(ruleId);
  const verification = useApi<VerificationResult | { verification: null }>(`${auditApi}/groups/${enc}/verify`);
  return (
    <div>
      <div className="mb-5">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {group ? <PriorityBadge priority={group.priority} score={group.score} /> : null}
          <Mono className="text-fg-2">{ruleId}</Mono>
          {group ? <span className="text-[13px] text-fg-3">{categoryLabel(group.category)}</span> : null}
        </div>
        <h2 className="text-lg font-semibold text-fg">{ruleTitle(ruleId)}</h2>
      </div>

      <div className="mb-6 flex flex-wrap gap-2">
        <VerifyButton ruleId={ruleId} onStarted={() => void verification.reload()} />
        <a href={`${auditApi}/groups/${enc}/csv`} download className={btn("secondary", "sm")}>
          <Download aria-hidden />
          Export CSV
        </a>
        <Button size="sm" variant="ghost" icon={ExternalLink} onClick={onShowUrls}>
          Show its URLs
        </Button>
      </div>

      {groupsLoading ? (
        <Skeleton className="mb-6 h-24 w-full" />
      ) : group ? (
        <>
          <Section title="Affected">
            <DefList
              items={[
                { label: "URLs", value: <span className="tabular">{group.affectedUrls.toLocaleString("en-GB")}</span> },
                ...(group.inconclusiveUrls ? [{ label: "Inconclusive URLs", value: <span className="tabular">{group.inconclusiveUrls.toLocaleString("en-GB")}</span> }] : []),
                {
                  label: "Priority score",
                  value: (
                    <span className="text-[13px] tabular">
                      {group.score} = impact {group.impact} × reach {group.reach} ({group.affectedPages.toLocaleString("en-GB")} of {group.indexablePages.toLocaleString("en-GB")} indexable pages) × confidence{" "}
                      {group.confidenceWeight} ({group.confidence})
                    </span>
                  ),
                },
                {
                  label: "States",
                  value: (
                    <span className="flex flex-wrap gap-1.5">
                      {stateSummary(group.states).map((s) => (
                        <span key={s.state} className="inline-flex items-center gap-1">
                          <IssueStateBadge state={s.state} />
                          <span className="text-[13px] tabular text-fg-2">{s.n.toLocaleString("en-GB")}</span>
                        </span>
                      ))}
                    </span>
                  ),
                },
              ]}
            />
          </Section>
          {group.templates.length ? (
            <Section title={`By template (${plural(group.templateCount, "template")})`}>
              <ul className="divide-y divide-line-subtle rounded-lg border border-line">
                {group.templates.map((t) => (
                  <li key={t.templateId} className="px-3 py-2">
                    <div className="flex items-center justify-between gap-3 text-[13px]">
                      <Mono className="truncate text-fg">{t.templateId}</Mono>
                      <span className="shrink-0 tabular text-fg-2">{plural(t.affectedUrls, "URL")}</span>
                    </div>
                    {t.sampleUrls.length ? (
                      <ul className="mt-1 flex flex-col gap-0.5 text-xs text-fg-2">
                        {t.sampleUrls.slice(0, 3).map((u) => (
                          <li key={u} className="min-w-0">
                            <ExternalUrl url={u} className="max-w-full font-mono" />
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
        </>
      ) : (
        <div className="mb-6">
          <Notice title="No URL is affected in this audit">This rule has no open issue group here; earlier findings of it may be resolved. Its explanation is below.</Notice>
        </div>
      )}

      <RuleExplain ruleId={ruleId} catalog={catalog} />

      <Section title="Fix board">
        <GroupTriage key={`${ruleId}:${entry?.updatedAt ?? "none"}`} ruleId={ruleId} board={board} entry={entry} actions={actions} />
      </Section>

      <Section title="Latest fix verification">
        <Verification v={verification} />
      </Section>
    </div>
  );
}

function GroupTriage({ ruleId, board, entry, actions }: { ruleId: string; board: BoardCard | undefined; entry: TriageEntry | undefined; actions: TriageActions }) {
  const initial = entry && ["todo", "in_progress", "ready"].includes(entry.status) ? (entry.status as "todo" | "in_progress" | "ready") : "todo";
  const [status, setStatus] = useState(initial);
  const [assignee, setAssignee] = useState(entry?.assignee ?? "");
  const dirty = status !== initial || assignee.trim() !== (entry?.assignee ?? "");
  return (
    <div className="flex flex-col gap-3">
      {board?.column === "verified" ? (
        <Notice tone="ok" title="Verified">
          A fix verification resolved this group&apos;s findings ({plural(board.verified, "finding")}). Verified is earned by a re-crawl, never set by hand.
        </Notice>
      ) : null}
      <p className="text-xs text-fg-3">Where the group sits on the Fix board. A column is a plan, not a result: issue states and counts do not change.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-[13px] font-medium text-fg">
          Column
          <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="todo">To do</option>
            <option value="in_progress">In progress</option>
            <option value="ready">Ready to verify</option>
          </Select>
        </label>
        <label className="flex flex-col gap-1.5 text-[13px] font-medium text-fg">
          Assignee
          <Input value={assignee} onChange={(e) => setAssignee(e.target.value)} placeholder="Nobody" maxLength={120} />
        </label>
      </div>
      <div>
        <Button size="sm" variant="primary" disabled={!dirty} loading={actions.busy} onClick={() => void actions.group(ruleId, status, assignee.trim() || null)}>
          Save
        </Button>
      </div>
    </div>
  );
}

function VerifyButton({ ruleId, onStarted }: { ruleId: string; onStarted: () => void }) {
  const { auditApi } = useAudit();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const verify = async () => {
    setBusy(true);
    try {
      const v = await api<StartedVerification>(`${auditApi}/groups/${encodeURIComponent(ruleId)}/verify`, { method: "POST" });
      toast({ tone: "ok", title: "Verification started", detail: `Re-crawling ${plural(v.urls.length, "URL")} to re-check ${plural(v.fingerprints, "finding")}. Its result appears under "Latest fix verification" (Refresh to update).` });
      onStarted();
    } catch (e) {
      toast({ tone: "error", title: "Could not start the verification", detail: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" variant="primary" icon={ShieldCheck} loading={busy} onClick={verify}>
      Verify fix
    </Button>
  );
}

function Verification({ v }: { v: Resource<VerificationResult | { verification: null }> }) {
  if (v.error) return <ErrorState error={v.error} onRetry={v.reload} />;
  if (!v.data) return <Skeleton className="h-10 w-full" />;
  const r = "verifyCrawlId" in v.data ? v.data : null;
  return (
    <div className="flex flex-col gap-2 text-[13px]">
      {r ? (
        <>
          <p className="text-fg">
            Started {fmtDateTime(r.createdAt)} · crawl {r.status}
            {r.analysed ? "" : " · results pending"} · {plural(r.targets, "finding")} re-checked
          </p>
          {r.analysed ? (
            <span className="flex flex-wrap gap-1.5">
              {stateSummary(r.states).map((s) => (
                <span key={s.state} className="inline-flex items-center gap-1">
                  <IssueStateBadge state={s.state} />
                  <span className="tabular text-fg-2">{s.n.toLocaleString("en-GB")}</span>
                </span>
              ))}
            </span>
          ) : null}
        </>
      ) : (
        <p className="text-fg-2">This group has not been verified yet. Verify re-crawls only its URLs and updates their states.</p>
      )}
      <div>
        <Button size="sm" variant="ghost" icon={RefreshCw} onClick={v.reload} loading={v.loading}>
          Refresh
        </Button>
      </div>
    </div>
  );
}

// ---------- one finding ----------

export function FindingDrawer({
  fingerprint,
  row,
  rowLoading,
  rowError,
  catalog,
  entry,
  actions,
  onOpenRule,
}: {
  fingerprint: string;
  row: IssueRow | undefined;
  rowLoading: boolean;
  rowError: Error | null;
  catalog: Map<string, CatalogRule> | null;
  entry: TriageEntry | undefined;
  actions: TriageActions;
  onOpenRule: (ruleId: string) => void;
}) {
  if (rowError) return <ErrorState error={rowError} />;
  if (!row && rowLoading)
    return (
      <div role="status" aria-label="Loading the issue" className="flex flex-col gap-3">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  if (!row) return <Notice tone="warn" title="Issue not found">This audit has no finding with fingerprint {fingerprint}. The link may come from another audit.</Notice>;
  const subject = `fp:${row.fingerprint}`;
  const marker = rowMarker(entry);
  return (
    <div>
      <div className="mb-5">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <IssueStateBadge state={row.state} verified={row.verified} />
          {marker ? <TriageMarker text={marker} /> : null}
          {entry?.assignee ? <span className="text-[13px] text-fg-2">Assigned to {entry.assignee}</span> : null}
        </div>
        <button type="button" onClick={() => onOpenRule(row.ruleId)} className="text-left text-lg font-semibold text-fg hover:text-accent-ink">
          {ruleTitle(row.ruleId)} <Mono className="text-fg-3">{row.ruleId}</Mono>
        </button>
        <p className="mt-1 text-[13px] text-fg-2">
          <ExternalUrl url={row.url} className="max-w-full font-mono" />
        </p>
        {row.templateId ? <p className="mt-1 text-xs text-fg-3">Template <Mono>{row.templateId}</Mono></p> : null}
      </div>

      <div className="mb-6 flex flex-wrap gap-2">
        <Button size="sm" variant="primary" onClick={() => actions.fixed([subject])} loading={actions.busy}>
          Mark fixed
        </Button>
        <Button size="sm" onClick={() => actions.ignore([subject])} disabled={actions.busy}>
          Ignore…
        </Button>
        <Button size="sm" onClick={() => actions.assign([subject])} disabled={actions.busy}>
          Assign…
        </Button>
        {entry && entry.status !== "todo" ? (
          <Button size="sm" variant="ghost" onClick={() => actions.clear([subject])} disabled={actions.busy}>
            Clear mark
          </Button>
        ) : null}
      </div>
      {marker ? <p className="-mt-4 mb-6 text-xs text-fg-3">A mark is your team&apos;s call: the issue stays {stateLabel(row.state).toLowerCase()} until a crawl re-checks it.</p> : null}

      <Evidence row={row} />
      <RuleExplain ruleId={row.ruleId} catalog={catalog} />
    </div>
  );
}

export function TriageMarker({ text }: { text: string }) {
  return (
    <span className="inline-flex h-6 max-w-full items-center gap-1 truncate rounded-full border border-dashed border-line-strong px-2 text-xs font-medium text-fg-2" title={`${text} (triage, not a crawl result)`}>
      {text}
    </span>
  );
}

function Evidence({ row }: { row: IssueRow }) {
  const { auditApi, auditBase, overview } = useAudit();
  const copy = useCopy();
  const page = useApi<PageDetail>(`${auditApi}/page?url=${encodeURIComponent(row.url)}`);
  const issue = page.data?.issues.find((i) => i.fingerprint === row.fingerprint);
  const noPage = page.error?.status === 404;
  const message = issue?.message ?? row.message;

  return (
    <>
      <Section title="What was found" id="evidence">
        {message ? <p className="text-sm text-fg">{message}</p> : <p className="text-sm text-fg-2">{row.outcome === null ? "This audit did not observe it again, so it has no message of its own." : "No message stored."}</p>}
      </Section>
      {noPage ? (
        <div className="mb-6">
          <Notice title="No page record">
            {row.outcome === null || row.state === "not_rechecked"
              ? "This audit did not crawl this URL (the finding was carried over from an earlier audit), so there is no page record, evidence or history for it here."
              : "This finding is not about a crawled page (for example a resource or a site-wide check), so there is no stored evidence or history to show for it here."}
          </Notice>
        </div>
      ) : page.error ? (
        <div className="mb-6">
          <ErrorState error={page.error} onRetry={page.reload} />
        </div>
      ) : !page.data ? (
        <div className="mb-6 flex flex-col gap-2" role="status" aria-label="Loading the evidence">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : (
        <>
          <Section title="Evidence">
            {issue?.evidence ? (
              <div className="relative">
                <pre className="max-h-80 overflow-auto rounded-lg bg-code-bg p-3 pr-12 font-mono text-[12.5px] leading-relaxed text-code-fg">
                  <code>{JSON.stringify(issue.evidence, null, 2)}</code>
                </pre>
                <button
                  type="button"
                  onClick={() => void copy(JSON.stringify(issue.evidence, null, 2), "Evidence copied")}
                  className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md bg-surface/10 px-2 py-1 text-xs text-code-fg hover:bg-surface/20"
                  aria-label="Copy evidence"
                >
                  <Copy className="size-3.5" aria-hidden />
                  Copy
                </button>
              </div>
            ) : (
              <p className="flex items-center gap-2 text-sm text-fg-2">
                <Braces className="size-4" aria-hidden />
                {issue ? "No evidence stored for this finding." : "This URL's page record does not list the finding (it may have been carried over from an earlier audit)."}
              </p>
            )}
          </Section>
          <p className="-mt-3 mb-6 text-[13px]">
            <Link href={`${auditBase}/inspect?url=${encodeURIComponent(row.url)}`} prefetch={false} className="text-accent-ink hover:underline">
              Open this URL in the page inspector
            </Link>
          </p>
          <Section title="History across audits">
            {issue?.history.length ? (
              <ol className="divide-y divide-line-subtle rounded-lg border border-line">
                {issue.history.map((h) => (
                  <li key={h.crawlId} className={cx("flex items-center justify-between gap-3 px-3 py-2 text-[13px]", h.crawlId === overview.crawlId && "bg-accent-softer")}>
                    <span className="text-fg">
                      {fmtDateTime(h.createdAt)}
                      {h.crawlId === overview.crawlId ? <span className="ml-2 text-xs text-fg-3">this audit</span> : null}
                    </span>
                    <IssueStateBadge state={h.state} />
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-fg-2">No earlier audit of this site saw it.</p>
            )}
          </Section>
        </>
      )}
    </>
  );
}

/** Rows of one rule in a drawer that was deep-linked without them (fetches the small per-rule list). */
export function useEnsure(load: (rule: string) => void, rule: string | null) {
  useEffect(() => {
    if (rule) load(rule);
  }, [load, rule]);
}

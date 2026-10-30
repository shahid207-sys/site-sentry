"use client";
// Fix board (docs/SPEC.md screen 9): one card per issue group, in To do, In progress, Ready to verify or Verified.
// The first three are triage (stored in issue_triage, logged in triage_events); Verified is earned only when a fix
// verification re-crawl resolved the group and nothing in it is open, so no control can move a card there by hand.
// Cards move with a select and buttons (keyboard and screen-reader friendly) rather than drag and drop only.
import { useParams } from "next/navigation";
import Link from "next/link";
import { History, LoaderCircle, ShieldCheck, UserRound } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { IssueGroupRow, VerificationResult } from "@/lib/results/queries";
import type { BoardCard, BoardColumn, TriageEntry, TriageEvent } from "@/lib/results/triage";
import type { StartedVerification } from "@/lib/results/verify";
import { api, ApiError, useApi } from "../../lib/api";
import { fmtDateTime, plural } from "../../lib/format";
import { Modal, useToast } from "../../overlays";
import { Button, EmptyState, ErrorState, Field, Input, Mono, PageSkeleton, Select, cx } from "../../ui";
import { AuditFrame, useAudit } from "../AuditFrame";
import { PriorityBadge, PRIORITIES } from "../badges";
import { ruleTitle } from "../hooks";

const COLUMNS: { id: BoardColumn; label: string; hint: string }[] = [
  { id: "todo", label: "To do", hint: "Not started" },
  { id: "in_progress", label: "In progress", hint: "Someone is fixing it" },
  { id: "ready", label: "Ready to verify", hint: "Fixed on the site; run Verify fix" },
  { id: "verified", label: "Verified", hint: "A re-crawl confirmed every issue is gone" },
];
const MOVABLE = COLUMNS.filter((c) => c.id !== "verified");

interface TriageData {
  entries: TriageEntry[];
  board: BoardCard[];
}

export function BoardScreen() {
  const { auditId } = useParams<{ auditId: string }>();
  return (
    <AuditFrame auditId={auditId}>
      <Board />
    </AuditFrame>
  );
}

function Board() {
  const { auditApi, auditBase, reload: reloadAudit } = useAudit();
  const triage = useApi<TriageData>(`${auditApi}/triage`);
  const groups = useApi<IssueGroupRow[]>(`${auditApi}/groups`);
  const toast = useToast();
  const [assigning, setAssigning] = useState<BoardCard | null>(null);
  const [history, setHistory] = useState<string | null>(null);

  const byRule = useMemo(() => new Map((groups.data ?? []).map((g) => [g.ruleId, g])), [groups.data]);
  const columns = useMemo(() => {
    const rank = (c: BoardCard) => {
      const g = byRule.get(c.ruleId);
      return g ? PRIORITIES.indexOf(g.priority) * 1000 - g.score : 99_999;
    };
    const out = new Map<BoardColumn, BoardCard[]>(COLUMNS.map((c) => [c.id, []]));
    for (const c of triage.data?.board ?? []) out.get(c.column)!.push(c);
    for (const list of out.values()) list.sort((a, b) => rank(a) - rank(b) || a.ruleId.localeCompare(b.ruleId));
    return out;
  }, [triage.data, byRule]);

  if (triage.error) return <ErrorState error={triage.error} onRetry={triage.reload} />;
  if (!triage.data) return <PageSkeleton rows={4} />;

  const move = async (card: BoardCard, status: BoardColumn, assignee = card.assignee) => {
    try {
      await api(`${auditApi}/triage`, { method: "POST", body: { subjects: [`rule:${card.ruleId}`], status, assignee } });
      triage.reload();
    } catch (e) {
      toast({ tone: "error", title: "Could not update the card", detail: (e as Error).message });
    }
  };

  if (!triage.data.board.length)
    return (
      <EmptyState icon={ShieldCheck} title="No issue groups to fix">
        This audit found no open issue group. The board fills when an audit reports issues.
      </EmptyState>
    );

  return (
    <>
      <p className="mb-4 text-[13px] text-fg-2">
        Columns are your team&rsquo;s triage and change no counts. A card reaches Verified only when <strong className="font-medium text-fg">Verify fix</strong> re-crawls the group&rsquo;s URLs and none of its issues is left.
      </p>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {COLUMNS.map((col) => {
          const cards = columns.get(col.id)!;
          return (
            <section key={col.id} aria-labelledby={`col-${col.id}`} className="flex min-w-0 flex-col rounded-xl border border-line bg-surface-secondary">
              <header className="flex items-baseline justify-between gap-2 border-b border-line-subtle px-3.5 py-2.5">
                <h2 id={`col-${col.id}`} className="text-sm font-semibold text-fg">
                  {col.label} <span className="tabular font-normal text-fg-3">{cards.length}</span>
                </h2>
                <span className="truncate text-xs text-fg-3">{col.hint}</span>
              </header>
              <ol className="flex flex-col gap-2.5 p-2.5" aria-label={`${col.label}: ${plural(cards.length, "issue group")}`}>
                {cards.length === 0 ? <li className="px-1.5 py-4 text-center text-xs text-fg-3">Nothing here</li> : null}
                {cards.map((card) => (
                  <Card
                    key={card.ruleId}
                    card={card}
                    group={byRule.get(card.ruleId)}
                    issuesHref={`${auditBase}/issues?rule=${encodeURIComponent(card.ruleId)}`}
                    onMove={(s) => move(card, s)}
                    onAssign={() => setAssigning(card)}
                    onHistory={() => setHistory(card.ruleId)}
                    onVerified={() => {
                      triage.reload();
                      groups.reload();
                      reloadAudit();
                    }}
                  />
                ))}
              </ol>
            </section>
          );
        })}
      </div>
      <AssignDialog
        card={assigning}
        onClose={() => setAssigning(null)}
        onSave={async (c, who) => {
          // A Verified card keeps its stored triage column; only the assignee changes.
          const stored = triage.data?.entries.find((e) => e.subject === `rule:${c.ruleId}`)?.status;
          await move(c, c.column === "verified" ? ((stored as BoardColumn | undefined) ?? "todo") : c.column, who);
          setAssigning(null);
        }}
      />
      <HistoryDialog ruleId={history} onClose={() => setHistory(null)} />
    </>
  );
}

function Card({ card, group, issuesHref, onMove, onAssign, onHistory, onVerified }: { card: BoardCard; group?: IssueGroupRow; issuesHref: string; onMove: (s: BoardColumn) => void; onAssign: () => void; onHistory: () => void; onVerified: () => void }) {
  const verified = card.column === "verified";
  return (
    <li className="rounded-lg border border-line bg-surface p-3 shadow-xs" data-testid={`card-${card.ruleId}`} data-column={card.column}>
      <div className="flex flex-wrap items-center gap-1.5">
        {group ? <PriorityBadge priority={group.priority} score={group.score} /> : null}
        <Mono className="text-fg-3">{card.ruleId}</Mono>
      </div>
      <Link href={issuesHref} className="mt-1.5 block text-sm font-medium text-fg hover:underline">
        {ruleTitle(card.ruleId)}
      </Link>
      <p className="mt-1 text-xs text-fg-2">
        {card.open ? `${plural(card.open, "open issue")}` : "No open issue"}
        {card.verified ? ` · ${card.verified} resolved by verification` : ""}
      </p>
      <p className="mt-1 flex items-center gap-1 text-xs text-fg-2">
        <UserRound className="size-3.5 text-fg-3" aria-hidden />
        {card.assignee ?? <span className="text-fg-3">Unassigned</span>}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {!verified ? (
          <Select aria-label={`Move ${card.ruleId}`} value={card.column} onChange={(e) => onMove(e.target.value as BoardColumn)} className="h-8 w-auto py-0 text-xs">
            {MOVABLE.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </Select>
        ) : null}
        <Button size="sm" variant="ghost" icon={UserRound} onClick={onAssign} aria-label={`Assign ${card.ruleId}`}>Assign</Button>
        <Button size="sm" variant="ghost" icon={History} onClick={onHistory} aria-label={`History of ${card.ruleId}`}>History</Button>
      </div>
      {!verified && card.open > 0 ? <Verify ruleId={card.ruleId} onDone={onVerified} /> : null}
    </li>
  );
}

/** Starts a fix verification (a re-crawl of the group's URLs) and follows it until it is analysed. */
function Verify({ ruleId, onDone }: { ruleId: string; onDone: () => void }) {
  const { auditApi } = useAudit();
  const toast = useToast();
  const [running, setRunning] = useState<StartedVerification | null>(null);
  const [busy, setBusy] = useState(false);
  const url = `${auditApi}/groups/${encodeURIComponent(ruleId)}/verify`;
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });

  useEffect(() => {
    if (!running) return;
    let stop = false;
    let t: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const v = await api<VerificationResult | { verification: null }>(url);
        if (stop) return;
        if ("verifyCrawlId" in v && v.verifyCrawlId === running.verifyCrawlId && (v.analysed || v.status === "failed" || v.status === "cancelled")) {
          setRunning(null);
          const resolved = v.states.resolved ?? 0;
          toast({
            tone: v.analysed ? (resolved === v.targets ? "ok" : "info") : "error",
            title: v.analysed ? `Verification of ${ruleId}: ${resolved} of ${v.targets} resolved` : `Verification of ${ruleId} ${v.status}`,
            detail: v.analysed ? (resolved === v.targets ? "Every issue of the group is gone." : "Issues still present stay open.") : "Nothing was changed. Try again.",
          });
          done.current();
          return;
        }
      } catch {
        // A failed poll is retried; the verification itself runs in the worker.
      }
      t = setTimeout(poll, 1500);
    };
    t = setTimeout(poll, 1000);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [running, url, ruleId, toast]);

  const start = async () => {
    setBusy(true);
    try {
      setRunning(await api<StartedVerification>(url, { method: "POST" }));
    } catch (e) {
      toast({ tone: "error", title: "Could not start the verification", detail: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  if (running)
    return (
      <p className="mt-2.5 flex items-center gap-1.5 text-xs text-accent-ink" role="status">
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
        Re-crawling {plural(running.urls.length, "URL")}…
      </p>
    );
  return (
    <Button size="sm" variant="secondary" icon={ShieldCheck} loading={busy} onClick={start} className="mt-2.5 w-full" aria-label={`Verify fix for ${ruleId}`}>
      Verify fix
    </Button>
  );
}

function AssignDialog({ card, onClose, onSave }: { card: BoardCard | null; onClose: () => void; onSave: (c: BoardCard, who: string | null) => Promise<void> }) {
  const [who, setWho] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  // Start from the card's assignee each time the dialog opens for a card.
  if (card && open !== card.ruleId) {
    setOpen(card.ruleId);
    setWho(card.assignee ?? "");
  }
  if (!card && open !== null) setOpen(null);
  return (
    <Modal
      open={!!card}
      onClose={onClose}
      title={card ? `Assign ${card.ruleId}` : "Assign"}
      description={card ? ruleTitle(card.ruleId) : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              if (!card) return;
              setBusy(true);
              await onSave(card, who.trim() || null);
              setBusy(false);
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <Field label="Assignee" htmlFor="as-who" hint="A name or team. Leave empty to unassign.">
        <Input id="as-who" value={who} maxLength={120} onChange={(e) => setWho(e.target.value)} />
      </Field>
    </Modal>
  );
}

const COLUMN_LABEL: Record<string, string> = { todo: "To do", in_progress: "In progress", ready: "Ready to verify", fixed: "Marked fixed", ignored: "Ignored" };

function HistoryDialog({ ruleId, onClose }: { ruleId: string | null; onClose: () => void }) {
  const { auditApi } = useAudit();
  const log = useApi<TriageEvent[]>(ruleId ? `${auditApi}/triage/log?subject=${encodeURIComponent(`rule:${ruleId}`)}` : null);
  return (
    <Modal open={!!ruleId} onClose={onClose} title={ruleId ? `History of ${ruleId}` : "History"} description="Every triage change, newest first.">
      {log.error ? (
        <ErrorState error={log.error} onRetry={log.reload} />
      ) : !log.data ? (
        <PageSkeleton rows={2} />
      ) : log.data.length === 0 ? (
        <p className="text-sm text-fg-2">No changes yet: the card is in To do by default.</p>
      ) : (
        <ol className="flex flex-col gap-3 text-[13px]">
          {log.data.map((e, i) => (
            <li key={i} className={cx("border-l-2 pl-3", i === 0 ? "border-accent" : "border-line")}>
              <p className="text-fg">
                {e.before ? `${COLUMN_LABEL[e.before.status] ?? e.before.status} → ` : ""}
                {COLUMN_LABEL[e.after.status] ?? e.after.status}
                {e.after.assignee !== (e.before?.assignee ?? null) ? ` · assignee ${e.after.assignee ?? "removed"}` : ""}
              </p>
              <p className="text-xs text-fg-3">{e.actor} · {fmtDateTime(e.at)}</p>
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}

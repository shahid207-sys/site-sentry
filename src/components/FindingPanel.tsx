"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Copy, ListChecks, Plus } from "lucide-react";
import { useState } from "react";
import type { ChangeKind } from "@/lib/audit/compare";
import type { AuditFinding } from "@/lib/audit/types";
import type { FixTask } from "@/lib/model";
import { AffectedUrls, CriteriaList, FactsTable, FindingExplanation, Snippets, taskBrief } from "./domain";
import { api, ApiError } from "./lib/api";
import { plural } from "./lib/format";
import { Modal, useCopy, useToast } from "./overlays";
import { useWs } from "./shell/context";
import { Button, CertaintyBadge, ChangeBadge, ExternalUrl, Field, Input, KindBadge, Mono, Notice, SeverityBadge, Textarea, WorkflowBadge } from "./ui";

export function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="print-break">
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <h3 className="text-[13px] font-semibold text-fg">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Full evidence view of one finding. Used in the results drawer and on the issue page. */
export function FindingBody({ f, change, task, auditId, siteId, showIssueLink = true }: { f: AuditFinding; change?: ChangeKind; task?: { id: string; title: string; workflowStatus: FixTask["workflowStatus"] } | null; auditId: string; siteId: string; showIssueLink?: boolean }) {
  const { base, ws } = useWs();
  const copy = useCopy();
  const [creating, setCreating] = useState(false);
  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="flex flex-wrap items-center gap-1.5">
          <SeverityBadge severity={f.priority.severity} priority={f.priority.level} />
          <CertaintyBadge certainty={f.certainty} />
          <KindBadge kind={f.kind} />
          {change ? <ChangeBadge kind={change} /> : null}
        </div>
        {/* On the issue page the title is already the page heading. */}
        {showIssueLink ? <h2 className="mt-3 text-lg font-semibold leading-snug text-fg">{f.title}</h2> : null}
        <p className={showIssueLink ? "mt-1 text-sm text-fg-2" : "mt-3 text-sm text-fg-2"}>{f.message}</p>
        <dl className="mt-3 grid gap-x-4 gap-y-1 text-[13px] sm:grid-cols-[auto_1fr]">
          <dt className="text-fg-3">Rule</dt>
          <dd><Mono className="text-fg-2">{f.ruleCode}</Mono></dd>
          <dt className="text-fg-3">URL</dt>
          <dd className="min-w-0"><ExternalUrl url={f.pageUrl} className="max-w-full font-mono text-[12.5px] text-fg-2" /></dd>
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          {task ? (
            <Link href={`${base}/tasks/${task.id}`} className="inline-flex h-9 items-center gap-2 rounded-md border border-line bg-elevated px-3 text-sm text-fg hover:bg-hover">
              <ListChecks className="size-4 text-fg-3" aria-hidden />
              Task <WorkflowBadge status={task.workflowStatus} />
            </Link>
          ) : (
            <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>Create fix task</Button>
          )}
          <Button icon={Copy} onClick={() => copy(taskBrief(f, { sample: ws === "sample" }), "Developer brief copied as Markdown")}>Copy brief</Button>
          {showIssueLink ? (
            <Link href={`${base}/issues/${encodeURIComponent(f.fingerprint)}?site=${siteId}`} className="inline-flex h-9 items-center gap-1.5 px-2 text-sm text-fg-2 hover:text-fg">
              Issue history <ArrowRight className="size-4" aria-hidden />
            </Link>
          ) : null}
        </div>
      </div>

      <FindingExplanation f={f} />

      {f.evidence.urls?.length ? <Section title={`Affected URLs (${f.evidence.urls.length})`}><AffectedUrls f={f} /></Section> : null}
      {f.evidence.snippets.length ? <Section title="Evidence"><Snippets snippets={f.evidence.snippets} /></Section> : null}
      {Object.keys(f.evidence.facts).length ? <Section title="Measured facts"><FactsTable facts={f.evidence.facts} /></Section> : null}

      <Section title="Acceptance criteria" aside={<span className="text-xs text-fg-3">{f.verify === "reaudit" ? "Verified by a new audit" : "Checked by re-fetching"}</span>}>
        <CriteriaList criteria={f.acceptanceCriteria} />
      </Section>

      <Section title="Why this priority">
        <ul className="flex flex-col gap-1 text-[13px] text-fg-2">
          {f.priority.reasons.map((r, i) => <li key={i} className="font-mono text-[12.5px]">{r}</li>)}
          <li className="mt-1 text-fg-3">Score {f.priority.score} → P{f.priority.level}. P1 ≥ 4, P2 ≥ 3, P3 ≥ 1.5. Severity overrides live in Settings.</li>
        </ul>
      </Section>

      {creating ? <CreateTaskModal auditId={auditId} findings={[f]} onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

export function CreateTaskModal({ auditId, findings, onClose, onCreated }: { auditId: string; findings: AuditFinding[]; onClose: () => void; onCreated?: (t: FixTask) => void }) {
  const { apiBase, base } = useWs();
  const toast = useToast();
  const router = useRouter();
  const one = findings[0];
  const sameRule = new Set(findings.map((f) => f.ruleCode)).size === 1;
  const [title, setTitle] = useState(findings.length === 1 ? one.title : sameRule ? `${one.title} on ${findings.length} pages` : `${findings.length} issues to fix`);
  const [owner, setOwner] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ message: string; taskId?: string } | null>(null);

  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ task: FixTask; skipped: { fingerprint: string; taskId: string }[] }>(`${apiBase}/tasks`, {
        method: "POST",
        body: { auditId, fingerprints: findings.map((f) => f.fingerprint), title, owner: owner || null, notes },
      });
      toast({ tone: "ok", title: "Fix task created", detail: r.skipped.length ? `${plural(r.skipped.length, "finding")} already had an open task and were skipped.` : `${plural(r.task.items.length, "finding")} with frozen acceptance criteria.` });
      onCreated?.(r.task);
      router.push(`${base}/tasks/${r.task.id}`);
    } catch (e) {
      const ae = e as ApiError;
      setErr({ message: ae.message, taskId: ae.details?.taskId as string | undefined });
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      wide
      title="Create fix task"
      description={`${plural(findings.length, "finding")}. The evidence and acceptance criteria are copied from the stored audit and frozen, so verification later judges the fix against exactly what was found.`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={create}>Create task</Button></>}
    >
      <div className="flex flex-col gap-4">
        <Field label="Title" htmlFor="ct-title"><Input id="ct-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></Field>
        <Field label="Owner" htmlFor="ct-owner" hint="Optional. A name, e.g. “Priya (web dev)”."><Input id="ct-owner" value={owner} onChange={(e) => setOwner(e.target.value)} maxLength={100} /></Field>
        <Field label="Notes" htmlFor="ct-notes"><Textarea id="ct-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Context for whoever picks this up" /></Field>
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-fg">Findings</p>
          <ul className="max-h-40 divide-y divide-line-subtle overflow-y-auto rounded-md border border-line-subtle">
            {findings.map((f) => (
              <li key={f.fingerprint} className="flex items-center gap-2 px-3 py-2 text-[13px]">
                <SeverityBadge severity={f.priority.severity} />
                <span className="min-w-0 flex-1 truncate text-fg">{f.title}</span>
              </li>
            ))}
          </ul>
        </div>
        {err ? (
          <Notice tone="error" action={err.taskId ? <Link href={`${base}/tasks/${err.taskId}`} className="text-sm text-fg underline underline-offset-4">Open task</Link> : undefined}>
            {err.message}
          </Notice>
        ) : null}
      </div>
    </Modal>
  );
}

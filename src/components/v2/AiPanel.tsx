"use client";
// The audit's AI analysis on the overview (docs/SPEC.md "AI analysis"). Opt-in per project; every item shows its
// citations, because only cited items survive the grounding validator. Nothing here is a rule's finding.
import { useState } from "react";
import type { Citation, StoredAiAnalysis } from "@/lib/ai/schema";
import { api, useApi } from "../lib/api";
import { Button, Mono, Notice, Panel } from "../ui";
import { useAudit } from "./AuditFrame";

const LABEL = "AI analysis";

function Cites({ items }: { items: Citation[] }) {
  return (
    <p className="mt-0.5 text-[12px] text-fg-3">
      Source:{" "}
      {items.map((c, i) => (
        <span key={i}>
          {i ? "; " : ""}
          {c.findingId ? <Mono>{c.findingId}</Mono> : <><Mono>{c.url}</Mono>: &ldquo;{c.quote}&rdquo;</>}
        </span>
      ))}
    </p>
  );
}

function Points({ title, items }: { title: string; items: { text: string; citations: Citation[] }[] }) {
  if (!items.length) return null;
  return (
    <div>
      <h4 className="text-[13px] font-medium text-fg-1">{title}</h4>
      <ul className="mt-1 list-disc space-y-1.5 pl-5 text-sm text-fg-2 marker:text-fg-3">
        {items.map((x, i) => (
          <li key={i}>
            {x.text}
            <Cites items={x.citations} />
          </li>
        ))}
      </ul>
    </div>
  );
}

const STATUS: Partial<Record<StoredAiAnalysis["status"], { tone: "info" | "warn"; title: string; text: string }>> = {
  queued: { tone: "info", title: "Queued", text: "The analysis worker will run this after its current job." },
  not_configured: { tone: "warn", title: "Not configured", text: "The AI provider's API key is not set on the workers, so nothing was sent." },
  over_budget: { tone: "warn", title: "Over the input cap", text: "Even the smallest input is over AI_MAX_INPUT_TOKENS, so nothing was sent." },
  failed: { tone: "warn", title: "Failed", text: "The analysis did not finish." },
};

export function AiPanel() {
  const { auditApi } = useAudit();
  const res = useApi<{ enabled: boolean; ai: StoredAiAnalysis | null }>(`${auditApi}/ai`);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!res.data) return null;
  const { enabled, ai } = res.data;
  if (!enabled && !ai) return null;
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api(`${auditApi}/ai`, { method: "POST" });
      res.reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const a = ai?.status === "done" ? ai.analysis : null;
  const note = ai ? STATUS[ai.status] : null;
  const canRun = enabled && ai?.status !== "done" && ai?.status !== "queued";
  return (
    <Panel title={LABEL} description="Written by a language model from this audit's stored data. Every item cites a finding or a quote from the page." actions={canRun ? <Button variant="secondary" loading={busy} onClick={run}>Run AI analysis</Button> : undefined}>
      <div className="flex flex-col gap-4">
        {note ? <Notice tone={note.tone} title={note.title}>{ai?.detail ?? note.text}</Notice> : null}
        {err ? <p className="text-[13px] text-sev-high" role="alert">{err}</p> : null}
        {!ai && !err ? <p className="text-sm text-fg-2">Not run for this audit yet.</p> : null}
        {a ? (
          <>
            <Points title="Strengths" items={a.executiveSummary.strengths} />
            <Points title="Weaknesses" items={a.executiveSummary.weaknesses} />
            <Points title="Quality" items={a.qualityIssues.map((q) => ({ text: `${q.issue} Fix: ${q.fix}`, citations: q.citations }))} />
            <Points title="Strategy" items={a.strategy} />
            <Points title="This week" items={a.actionPlan.thisWeek} />
            <Points title="This quarter" items={a.actionPlan.thisQuarter} />
            {a.rewrites.length ? (
              <div>
                <h4 className="text-[13px] font-medium text-fg-1">Rewrites</h4>
                <div className="mt-1 flex flex-col gap-3 text-sm text-fg-2">
                  {a.rewrites.map((r, i) => (
                    <div key={i}>
                      <Mono>{r.url}</Mono>
                      <p className="mt-0.5">Title ({r.titleChars} characters): {r.title}</p>
                      <p>Description ({r.descriptionChars} characters): {r.description}</p>
                      <p>H1: {r.h1}</p>
                      <Cites items={r.citations} />
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {ai?.dropped ? <p className="text-[12px] text-fg-3">The validator removed {ai.dropped.items} uncited or unsupported {ai.dropped.items === 1 ? "item" : "items"} and {ai.dropped.citations} invalid {ai.dropped.citations === 1 ? "citation" : "citations"}.</p> : null}
          </>
        ) : null}
      </div>
    </Panel>
  );
}

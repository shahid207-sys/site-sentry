"use client";

import { useState } from "react";
import type { TrackedFinding, VerificationOutcome } from "@/lib/audit/types";
import { fixTaskToMarkdown } from "@/lib/tasks/fix-task";
import { FactsTable } from "./FactsTable";
import { SeverityBadge } from "./SeverityBadge";

const OUTCOME: Record<VerificationOutcome, { label: string; className: string }> = {
  resolved: { label: "Resolved", className: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200" },
  still_failing: { label: "Still failing", className: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200" },
  inconclusive: { label: "Inconclusive", className: "bg-slate-200 text-slate-900 dark:bg-slate-800 dark:text-slate-200" },
};

const Pill = ({ className, children }: { className: string; children: React.ReactNode }) => (
  <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${className}`}>{children}</span>
);

export function TrackedFindingList({
  tracked,
  busyId,
  onVerify,
}: {
  tracked: TrackedFinding[];
  busyId: string | null;
  onVerify: (id: string) => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  if (tracked.length === 0) return null;

  async function copy(t: TrackedFinding) {
    try {
      await navigator.clipboard.writeText(fixTaskToMarkdown(t));
      setCopied(t.id);
      setTimeout(() => setCopied((c) => (c === t.id ? null : c)), 1500);
    } catch {
      setCopied(null);
    }
  }

  return (
    <section className="mt-10">
      <h2 className="text-sm font-semibold">Fix tasks</h2>
      <p className="text-xs text-muted">Saved on the server in .data/store.json. Status changes only through a deterministic re-scan.</p>
      <ul className="mt-3 space-y-3">
        {tracked.map((t) => {
          const last = t.attempts.at(-1);
          return (
            <li key={t.id} className="rounded-lg border border-line bg-surface">
              <div className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <Pill className={t.status === "resolved" ? OUTCOME.resolved.className : "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200"}>
                  {t.status === "resolved" ? "Resolved" : "Open"}
                </Pill>
                <SeverityBadge severity={t.finding.severity} />
                <div className="min-w-0 flex-1">
                  <p>
                    {t.finding.title}
                    {t.source === "sample" && <span className="ml-2 text-xs font-semibold text-amber-700 dark:text-amber-300">SAMPLE</span>}
                  </p>
                  <p className="truncate font-mono text-xs text-muted">
                    {t.finding.ruleCode} · {t.finding.pageUrl}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onVerify(t.id)}
                  disabled={busyId === t.id}
                  className="rounded bg-accent px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                >
                  {busyId === t.id ? "Re-scanning…" : "Re-scan"}
                </button>
                <button type="button" onClick={() => copy(t)} className="rounded border border-line px-2 py-1 text-xs">
                  {copied === t.id ? "Copied" : "Copy as Markdown"}
                </button>
              </div>

              <details className="border-t border-line px-4 py-3 text-sm">
                <summary className="cursor-pointer text-xs text-muted">
                  History: {t.attempts.length} verification attempt{t.attempts.length === 1 ? "" : "s"}
                  {last && <> · last {OUTCOME[last.outcome].label.toLowerCase()}</>}
                </summary>

                <ol className="mt-3 space-y-4 border-l border-line pl-4">
                  <li>
                    <p className="text-xs font-semibold">
                      Original observation · {new Date(t.originalObservation.capturedAt).toLocaleString()}
                    </p>
                    <p className="mt-1">{t.finding.observed}</p>
                    <FactsTable facts={t.originalObservation.facts} />
                  </li>
                  {t.attempts.map((a, i) => (
                    <li key={a.id}>
                      <p className="flex flex-wrap items-center gap-2 text-xs font-semibold">
                        Attempt {i + 1} · {new Date(a.at).toLocaleString()} <Pill className={OUTCOME[a.outcome].className}>{OUTCOME[a.outcome].label}</Pill>
                      </p>
                      <p className="mt-1">{a.reason}</p>
                      {a.criteria.length > 0 && (
                        <ul className="mt-1 space-y-0.5 text-xs">
                          {a.criteria.map((c) => (
                            <li key={c.id} className="flex gap-2">
                              <span aria-hidden className="w-4 shrink-0 text-center">{c.passed ? "✓" : "✗"}</span>
                              <span>
                                {c.description} <span className="text-muted">— saw {c.actual}</span>
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {a.observation && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-xs text-muted">Observed facts</summary>
                          <FactsTable facts={a.observation.facts} />
                        </details>
                      )}
                    </li>
                  ))}
                </ol>
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

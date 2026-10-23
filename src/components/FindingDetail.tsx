import type { AuditSource, Finding, TrackedFinding } from "@/lib/audit/types";
import { FactsTable } from "./FactsTable";
import { SeverityBadge } from "./SeverityBadge";

const Label = ({ children }: { children: React.ReactNode }) => (
  <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted">{children}</h3>
);

export function FindingDetail({
  finding,
  source,
  tracked,
  busy,
  onTrack,
  onVerify,
}: {
  finding: Finding;
  source: AuditSource;
  tracked: TrackedFinding | undefined;
  busy: boolean;
  onTrack: () => void;
  onVerify: () => void;
}) {
  const last = tracked?.attempts.at(-1);

  return (
    <article className="rounded-lg border border-line bg-surface p-5">
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={finding.severity} />
        <code className="text-xs text-muted">{finding.ruleCode}</code>
        {source === "sample" && <span className="text-xs font-semibold text-amber-700 dark:text-amber-300">SAMPLE</span>}
      </div>
      <h2 className="mt-2 text-lg font-semibold">{finding.title}</h2>
      <p className="mt-1 text-sm">{finding.message}</p>
      <p className="mt-2 break-all font-mono text-xs text-muted">{finding.pageUrl}</p>

      <Label>Evidence</Label>
      <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted">Observed</dt>
        <dd className="break-words">{finding.observed}</dd>
        <dt className="text-muted">Expected</dt>
        <dd className="break-words">{finding.expected}</dd>
      </dl>
      {finding.evidence.snippets.length > 0 && (
        <pre className="mt-3 overflow-x-auto rounded-md bg-code p-3 font-mono text-xs leading-5">
          {finding.evidence.snippets.join("\n")}
        </pre>
      )}
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-xs text-muted">Observed facts</summary>
        <FactsTable facts={finding.evidence.facts} />
      </details>

      <Label>Recommended fix</Label>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
        {finding.recommendations.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>

      <Label>Acceptance criteria</Label>
      <p className="mt-1 text-xs text-muted">Re-scan marks this resolved only when all of these pass.</p>
      <ul className="mt-1 space-y-1 text-sm">
        {finding.acceptanceCriteria.map((c) => {
          const result = last?.criteria.find((r) => r.id === c.id);
          return (
            <li key={c.id} className="flex gap-2">
              <span aria-hidden className="w-4 shrink-0 text-center">
                {result ? (result.passed ? "✓" : "✗") : "○"}
              </span>
              <span>{c.description}</span>
            </li>
          );
        })}
      </ul>

      <NextAction tracked={tracked} busy={busy} onTrack={onTrack} onVerify={onVerify} />
    </article>
  );
}

/** The single, state-dependent action that ends the panel. */
function NextAction({
  tracked,
  busy,
  onTrack,
  onVerify,
}: {
  tracked: TrackedFinding | undefined;
  busy: boolean;
  onTrack: () => void;
  onVerify: () => void;
}) {
  const last = tracked?.attempts.at(-1);
  const box = "mt-6 rounded-lg border p-4";
  const button = "mt-3 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50";

  if (!tracked) {
    return (
      <div className={`${box} border-accent/40 bg-accent/5`}>
        <p className="text-sm font-semibold">Next step: create a fix task</p>
        <p className="mt-1 text-sm text-muted">
          This saves the evidence above as the baseline and locks in the acceptance criteria the fix will be checked against.
        </p>
        <button type="button" onClick={onTrack} disabled={busy} className={`${button} bg-accent text-white`}>
          {busy ? "Creating…" : "Create fix task"}
        </button>
      </div>
    );
  }

  if (tracked.status === "resolved") {
    return (
      <div className={`${box} border-emerald-400 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-950`}>
        <p className="text-sm font-semibold text-emerald-900 dark:text-emerald-200">
          Resolved, verified by re-scan on {new Date(tracked.resolvedAt!).toLocaleString()}
        </p>
        {last?.outcome === "inconclusive" && (
          <p className="mt-1 text-sm">The latest re-check was inconclusive: {last.reason}</p>
        )}
        <button type="button" onClick={onVerify} disabled={busy} className={`${button} border border-line`}>
          {busy ? "Re-scanning…" : "Re-check for regressions"}
        </button>
      </div>
    );
  }

  return (
    <div className={`${box} border-accent/40 bg-accent/5`}>
      <p className="text-sm font-semibold">Next step: deploy the fix, then re-scan</p>
      <p className="mt-1 text-sm text-muted">
        Re-scan fetches the page again and checks it against the {tracked.finding.acceptanceCriteria.length} acceptance
        criteria above. The original observation is kept for comparison.
      </p>
      {last && (
        <p className="mt-2 text-sm">
          Last attempt: <strong>{last.outcome.replace("_", " ")}</strong>. {last.reason}
        </p>
      )}
      <button type="button" onClick={onVerify} disabled={busy} className={`${button} bg-accent text-white`}>
        {busy ? "Re-scanning…" : "Re-scan to verify"}
      </button>
    </div>
  );
}

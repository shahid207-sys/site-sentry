import type { Finding } from "@/lib/audit/types";
import { SeverityBadge } from "./SeverityBadge";

export function FindingDetail({
  finding,
  hasTask,
  onCreateTask,
}: {
  finding: Finding;
  hasTask: boolean;
  onCreateTask: () => void;
}) {
  return (
    <article className="rounded-lg border border-line bg-surface p-5">
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={finding.severity} />
        <code className="text-xs text-muted">{finding.ruleId}</code>
      </div>
      <h2 className="mt-2 text-lg font-semibold">{finding.title}</h2>
      <p className="mt-1 text-sm">{finding.message}</p>

      <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted">Evidence</h3>
      <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted">Observed</dt>
        <dd className="break-words">{finding.evidence.observed}</dd>
        <dt className="text-muted">Expected</dt>
        <dd>{finding.evidence.expected}</dd>
      </dl>
      {finding.evidence.snippets.length > 0 && (
        <pre className="mt-3 overflow-x-auto rounded-md bg-code p-3 font-mono text-xs leading-5">
          {finding.evidence.snippets.join("\n")}
        </pre>
      )}

      <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted">Recommended fix</h3>
      <p className="mt-1 text-sm">{finding.recommendation}</p>

      <button
        type="button"
        onClick={onCreateTask}
        disabled={hasTask}
        className="mt-5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {hasTask ? "Fix task created" : "Create fix task"}
      </button>
    </article>
  );
}

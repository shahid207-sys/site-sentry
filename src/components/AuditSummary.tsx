import type { AuditResult } from "@/lib/audit/types";

export function AuditSummary({ audit, onEditExpectations }: { audit: AuditResult; onEditExpectations: () => void }) {
  const failed = audit.rules.filter((r) => r.status === "fail").length;
  const needsConfig = audit.rules.filter((r) => r.status === "needs_config").length;
  const exp = audit.expectations;

  return (
    <section className="rounded-lg border border-line bg-surface p-4">
      {audit.source === "sample" ? (
        <div className="mb-3 rounded-md border border-amber-400 bg-amber-100 px-3 py-2 text-sm font-semibold text-amber-950 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-100">
          SAMPLE DATA: this is not a live scan. Results come from a bundled demo page run through the same rules.
        </div>
      ) : (
        <span className="mb-3 inline-block rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
          LIVE SCAN
        </span>
      )}

      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted">Requested</dt>
        <dd className="break-all font-mono text-xs leading-5">{audit.requestedUrl}</dd>
        {audit.finalUrl !== audit.requestedUrl && (
          <>
            <dt className="text-muted">Final URL</dt>
            <dd className="break-all font-mono text-xs leading-5">{audit.finalUrl}</dd>
          </>
        )}
        {audit.redirectChain.length > 0 && (
          <>
            <dt className="text-muted">Redirects</dt>
            <dd className="font-mono text-xs leading-5">
              {audit.redirectChain.map((h) => (
                <div key={h.url} className="break-all">
                  {h.status} {h.url}
                </div>
              ))}
            </dd>
          </>
        )}
        <dt className="text-muted">HTTP status</dt>
        <dd>{audit.httpStatus}</dd>
        <dt className="text-muted">HTML size</dt>
        <dd>
          {(audit.bytes / 1024).toFixed(1)} KB
          {audit.truncated && <span className="ml-2 text-amber-700 dark:text-amber-300">(truncated at 2 MB; head checks still valid)</span>}
        </dd>
        <dt className="text-muted">Fetched</dt>
        <dd>{new Date(audit.fetchedAt).toLocaleString()}</dd>
        <dt className="text-muted">Checks</dt>
        <dd>
          {audit.rules.length} run, {failed} with findings{needsConfig > 0 && `, ${needsConfig} need configuration`}
        </dd>
        <dt className="text-muted">Expectations</dt>
        <dd>
          canonical {exp.canonicalUrl ? <code className="break-all text-xs">{exp.canonicalUrl}</code> : <em>not set</em>}, indexability{" "}
          {exp.indexability ? <code className="text-xs">{exp.indexability}</code> : <em>not set</em>}{" "}
          <button type="button" onClick={onEditExpectations} className="ml-1 text-xs font-medium text-accent underline">
            Edit
          </button>
        </dd>
      </dl>
    </section>
  );
}

"use client";

import { useState } from "react";
import type { AuditResult, PageExpectations } from "@/lib/audit/types";
import { ApiRequestError } from "./api";

/** Collects the owner's intent for this page. Rules that depend on intent never guess it. */
export function ExpectationsPanel({ audit, onSave }: { audit: AuditResult; onSave: (exp: PageExpectations) => Promise<void> }) {
  const canonical = audit.rules.find((r) => r.ruleId === "canonical");
  const robots = audit.rules.find((r) => r.ruleId === "indexability");
  const [canonicalUrl, setCanonicalUrl] = useState(audit.expectations.canonicalUrl ?? "");
  const [indexability, setIndexability] = useState<"" | "index" | "noindex">(audit.expectations.indexability ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="rounded-lg border border-line bg-surface p-5"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        setError(null);
        try {
          await onSave({ canonicalUrl: canonicalUrl.trim() || undefined, indexability: indexability || undefined });
        } catch (err) {
          setError(err instanceof ApiRequestError ? err.message : "Could not save expectations.");
        } finally {
          setSaving(false);
        }
      }}
    >
      <h2 className="text-lg font-semibold">Configure expectations</h2>
      <p className="mt-1 text-sm text-muted">
        Canonical and indexability checks depend on what you intend for this page. Site Sentry won&apos;t guess. Tell
        it, and it will re-run the audit.
      </p>
      <p className="mt-2 break-all font-mono text-xs text-muted">{audit.finalUrl}</p>

      <label className="mt-5 block text-sm font-medium" htmlFor="exp-canonical">
        Expected canonical URL
      </label>
      <p className="text-xs text-muted">
        Currently observed: {canonical?.facts.canonicalResolved ? String(canonical.facts.canonicalResolved) : "no canonical link"}
      </p>
      <input
        id="exp-canonical"
        type="url"
        placeholder={audit.finalUrl}
        value={canonicalUrl}
        onChange={(e) => setCanonicalUrl(e.target.value)}
        className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm"
      />

      <fieldset className="mt-5">
        <legend className="text-sm font-medium">Intended indexability</legend>
        <p className="text-xs text-muted">
          Currently observed: meta robots {robots?.facts.metaRobots ? `"${robots.facts.metaRobots}"` : "none"}, X-Robots-Tag{" "}
          {robots?.facts.xRobotsTag ? `"${robots.facts.xRobotsTag}"` : "none"}
        </p>
        <div className="mt-2 flex flex-wrap gap-4 text-sm">
          {([
            ["", "Not configured"],
            ["index", "Should be indexed"],
            ["noindex", "Should NOT be indexed"],
          ] as const).map(([value, label]) => (
            <label key={value} className="flex items-center gap-2">
              <input type="radio" name="indexability" value={value} checked={indexability === value} onChange={() => setIndexability(value)} />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      {error && <p role="alert" className="mt-4 text-sm text-red-700 dark:text-red-300">{error}</p>}

      <button type="submit" disabled={saving} className="mt-6 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
        {saving ? "Saving…" : "Save and re-run audit"}
      </button>
    </form>
  );
}

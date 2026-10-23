"use client";

import { useEffect, useState } from "react";
import type { AuditResult, Finding, PageExpectations, TrackedFinding } from "@/lib/audit/types";
import type { SampleState } from "@/lib/sample/sample-page";
import { api, ApiRequestError, type ApiError } from "./api";
import { AuditForm } from "./AuditForm";
import { AuditSummary } from "./AuditSummary";
import { ExpectationsPanel } from "./ExpectationsPanel";
import { FindingDetail } from "./FindingDetail";
import { RuleList, type Selection } from "./RuleList";
import { SampleControls } from "./SampleControls";
import { TrackedFindingList } from "./TrackedFindingList";

const asApiError = (e: unknown): ApiError =>
  e instanceof ApiRequestError ? e.error : { code: "UNKNOWN", message: "Something went wrong." };

/** The open-or-latest tracked record for a finding on this audit's page. */
function trackedFor(tracked: TrackedFinding[], audit: AuditResult, f: Finding) {
  const matches = tracked.filter(
    (t) => t.source === audit.source && t.finding.pageUrl === f.pageUrl && t.finding.ruleCode === f.ruleCode,
  );
  return matches.find((t) => t.status === "open") ?? matches[0];
}

export function Dashboard() {
  const [loading, setLoading] = useState<"live" | "sample" | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [audit, setAudit] = useState<AuditResult | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [tracked, setTracked] = useState<TrackedFinding[]>([]);
  const [busy, setBusy] = useState<string | null>(null); // id of the finding being tracked/verified
  const [sampleState, setSampleState] = useState<SampleState | null>(null);

  useEffect(() => {
    api.listFindings().then(setTracked).catch((e) => setError(asApiError(e)));
    api.getSampleState().then((r) => setSampleState(r.state)).catch(() => undefined);
  }, []);

  function upsert(t: TrackedFinding) {
    setTracked((prev) => [t, ...prev.filter((p) => p.id !== t.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }

  async function runAudit(body: { url: string } | { sample: true }, keepSelection = false) {
    setLoading("sample" in body ? "sample" : "live");
    setError(null);
    if (!keepSelection) {
      setAudit(null);
      setSelection(null);
    }
    try {
      const result = await api.audit(body);
      setAudit(result);
      if ("sample" in body) setSampleState("broken");
      const first = result.rules.flatMap((r) => r.findings)[0];
      const needsConfig = result.rules.find((r) => r.status === "needs_config");
      setSelection((prev) =>
        keepSelection && prev?.kind === "finding" && result.rules.some((r) => r.findings.some((f) => f.ruleCode === prev.ruleCode))
          ? prev
          : first
            ? { kind: "finding", ruleCode: first.ruleCode }
            : needsConfig
              ? { kind: "config" }
              : null,
      );
    } catch (e) {
      setError(asApiError(e));
    } finally {
      setLoading(null);
    }
  }

  async function track(f: Finding) {
    if (!audit) return;
    setBusy(f.ruleCode);
    try {
      upsert(await api.track(audit.id, f.ruleCode));
    } catch (e) {
      setError(asApiError(e));
    } finally {
      setBusy(null);
    }
  }

  async function verify(id: string) {
    setBusy(id);
    setError(null);
    try {
      upsert(await api.verify(id));
    } catch (e) {
      setError(asApiError(e));
    } finally {
      setBusy(null);
    }
  }

  async function saveExpectations(exp: PageExpectations) {
    if (!audit) return;
    await api.setExpectations(audit.finalUrl, exp); // errors surface in the panel
    await runAudit(audit.source === "sample" ? { sample: true } : { url: audit.finalUrl }, true);
  }

  async function changeSampleState(state: SampleState) {
    try {
      setSampleState((await api.setSampleState(state)).state);
    } catch (e) {
      setError(asApiError(e));
    }
  }

  const findings = audit?.rules.flatMap((r) => r.findings) ?? [];
  const selectedFinding =
    selection?.kind === "finding" ? findings.find((f) => f.ruleCode === selection.ruleCode) ?? null : null;
  const selectedTracked = audit && selectedFinding ? trackedFor(tracked, audit, selectedFinding) : undefined;
  const showSampleControls = audit?.source === "sample" || tracked.some((t) => t.source === "sample");

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Site Sentry</h1>
        <p className="text-sm text-muted">
          Deterministic technical SEO checks → evidence → fix task → re-scan to verify.
        </p>
      </header>

      <AuditForm loading={loading} onAudit={(url) => runAudit({ url })} onSample={() => runAudit({ sample: true })} />

      {error && (
        <div role="alert" className="mt-4 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
          <p className="font-medium">Request failed</p>
          <p className="mt-1">{error.message}</p>
          <p className="mt-1 font-mono text-xs opacity-70">{error.code}</p>
        </div>
      )}

      {loading && (
        <p className="mt-6 animate-pulse text-sm text-muted" aria-live="polite">
          {loading === "sample" ? "Running sample audit…" : "Fetching page and running checks…"}
        </p>
      )}

      {showSampleControls && sampleState && (
        <SampleControls state={sampleState} onChange={changeSampleState} />
      )}

      {audit && (
        <div className="mt-6 space-y-6">
          <AuditSummary audit={audit} onEditExpectations={() => setSelection({ kind: "config" })} />
          <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <RuleList audit={audit} selection={selection} onSelect={setSelection} />
            {selection?.kind === "config" ? (
              <ExpectationsPanel audit={audit} onSave={saveExpectations} />
            ) : selectedFinding ? (
              <FindingDetail
                finding={selectedFinding}
                source={audit.source}
                tracked={selectedTracked}
                busy={busy === selectedFinding.ruleCode || (!!selectedTracked && busy === selectedTracked.id)}
                onTrack={() => track(selectedFinding)}
                onVerify={() => selectedTracked && verify(selectedTracked.id)}
              />
            ) : (
              <div className="rounded-lg border border-line p-6 text-sm text-muted">
                {findings.length === 0 ? "No findings for the checks that could run." : "Select a finding to see its evidence."}
              </div>
            )}
          </div>
        </div>
      )}

      <TrackedFindingList tracked={tracked} busyId={busy} onVerify={verify} />
    </div>
  );
}

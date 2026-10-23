"use client";

import { useState } from "react";
import type { AuditResult, Finding } from "@/lib/audit/types";
import { createFixTask, type FixTask } from "@/lib/tasks/fix-task";
import { AuditForm } from "./AuditForm";
import { AuditSummary } from "./AuditSummary";
import { FindingDetail } from "./FindingDetail";
import { FindingList } from "./FindingList";
import { FixTaskList } from "./FixTaskList";

interface ApiError {
  code: string;
  message: string;
}

export function Dashboard() {
  const [loading, setLoading] = useState<"live" | "sample" | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [audit, setAudit] = useState<AuditResult | null>(null);
  const [selected, setSelected] = useState<Finding | null>(null);
  const [tasks, setTasks] = useState<FixTask[]>([]);

  async function run(body: { url: string } | { sample: true }) {
    setLoading("sample" in body ? "sample" : "live");
    setError(null);
    setAudit(null);
    setSelected(null);
    try {
      const res = await fetch("/api/audit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? { code: "UNKNOWN", message: `Request failed (${res.status}).` });
        return;
      }
      const result = data as AuditResult;
      setAudit(result);
      setSelected(result.rules.flatMap((r) => r.findings)[0] ?? null);
    } catch {
      setError({ code: "NETWORK", message: "Could not reach the Site Sentry server." });
    } finally {
      setLoading(null);
    }
  }

  function addTask(finding: Finding) {
    if (!audit) return;
    const task = createFixTask(audit, finding);
    setTasks((prev) => (prev.some((t) => t.id === task.id) ? prev : [task, ...prev]));
  }

  const findings = audit?.rules.flatMap((r) => r.findings) ?? [];
  const taskIds = new Set(tasks.map((t) => t.id));

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Site Sentry</h1>
        <p className="text-sm text-muted">
          Deterministic technical SEO checks with evidence, turned into fix tasks you can verify.
        </p>
      </header>

      <AuditForm
        loading={loading}
        onAudit={(url) => run({ url })}
        onSample={() => run({ sample: true })}
      />

      {error && (
        <div role="alert" className="mt-4 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
          <p className="font-medium">Audit could not run</p>
          <p className="mt-1">{error.message}</p>
          <p className="mt-1 font-mono text-xs opacity-70">{error.code}</p>
        </div>
      )}

      {loading && (
        <p className="mt-6 animate-pulse text-sm text-muted" aria-live="polite">
          {loading === "sample" ? "Running sample audit…" : "Fetching page and running checks…"}
        </p>
      )}

      {audit && (
        <div className="mt-6 space-y-6">
          <AuditSummary audit={audit} />
          <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <FindingList audit={audit} selected={selected} onSelect={setSelected} />
            {selected ? (
              <FindingDetail
                finding={selected}
                hasTask={taskIds.has(`${audit.finalUrl}::${selected.ruleId}`)}
                onCreateTask={() => addTask(selected)}
              />
            ) : (
              <div className="rounded-lg border border-line p-6 text-sm text-muted">
                {findings.length === 0 ? "All checks passed. Nothing to fix." : "Select a finding to see its evidence."}
              </div>
            )}
          </div>
        </div>
      )}

      <FixTaskList
        tasks={tasks}
        onToggle={(id) =>
          setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, status: t.status === "open" ? "done" : "open" } : t)))
        }
        onRemove={(id) => setTasks((prev) => prev.filter((t) => t.id !== id))}
      />
    </div>
  );
}

import type { AuditResult, RuleStatus } from "@/lib/audit/types";
import { SeverityBadge } from "./SeverityBadge";

export type Selection = { kind: "finding"; ruleCode: string } | { kind: "config" };

const STATUS: Record<RuleStatus, { label: (n: number) => string; className: string }> = {
  pass: { label: () => "Passed", className: "text-emerald-700 dark:text-emerald-300" },
  fail: { label: (n) => `${n} finding${n === 1 ? "" : "s"}`, className: "text-red-700 dark:text-red-300" },
  needs_config: { label: () => "Needs configuration", className: "text-amber-700 dark:text-amber-300" },
};

export function RuleList({
  audit,
  selection,
  onSelect,
}: {
  audit: AuditResult;
  selection: Selection | null;
  onSelect: (s: Selection) => void;
}) {
  return (
    <section className="space-y-4">
      {audit.rules.map((rule) => {
        const s = STATUS[rule.status];
        return (
          <div key={rule.ruleId} className="rounded-lg border border-line">
            <div className="flex items-center justify-between border-b border-line px-4 py-2">
              <h2 className="text-sm font-semibold">{rule.name}</h2>
              <span className={`text-xs font-medium ${s.className}`}>{s.label(rule.findings.length)}</span>
            </div>
            {rule.status === "needs_config" && (
              <button
                type="button"
                onClick={() => onSelect({ kind: "config" })}
                aria-current={selection?.kind === "config"}
                className={`w-full px-4 py-3 text-left text-sm hover:bg-hover ${selection?.kind === "config" ? "bg-hover" : ""}`}
              >
                This check needs your intended{" "}
                {rule.missingExpectations.map((k) => (k === "canonicalUrl" ? "canonical URL" : "indexability")).join(" and ")}.
                Site Sentry won&apos;t guess. <span className="font-medium text-accent">Configure →</span>
              </button>
            )}
            <ul>
              {rule.findings.map((f) => {
                const active = selection?.kind === "finding" && selection.ruleCode === f.ruleCode;
                return (
                  <li key={f.ruleCode}>
                    <button
                      type="button"
                      onClick={() => onSelect({ kind: "finding", ruleCode: f.ruleCode })}
                      aria-current={active}
                      className={`flex w-full items-start gap-2 px-4 py-3 text-left text-sm hover:bg-hover ${active ? "bg-hover" : ""}`}
                    >
                      <SeverityBadge severity={f.severity} />
                      <span className="flex-1">{f.title}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

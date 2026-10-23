import type { AuditResult, Finding } from "@/lib/audit/types";
import { SeverityBadge } from "./SeverityBadge";

export function FindingList({
  audit,
  selected,
  onSelect,
}: {
  audit: AuditResult;
  selected: Finding | null;
  onSelect: (f: Finding) => void;
}) {
  return (
    <section className="space-y-4">
      {audit.rules.map((rule) => (
        <div key={rule.ruleId} className="rounded-lg border border-line">
          <div className="flex items-center justify-between border-b border-line px-4 py-2">
            <h2 className="text-sm font-semibold">{rule.name}</h2>
            <span className={`text-xs font-medium ${rule.passed ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}`}>
              {rule.passed ? "Passed" : `${rule.findings.length} finding${rule.findings.length === 1 ? "" : "s"}`}
            </span>
          </div>
          <ul>
            {rule.findings.map((f) => {
              const active = selected?.ruleId === f.ruleId;
              return (
                <li key={f.ruleId}>
                  <button
                    type="button"
                    onClick={() => onSelect(f)}
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
      ))}
    </section>
  );
}

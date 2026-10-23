import type { Severity } from "@/lib/audit/types";

const STYLES: Record<Severity, string> = {
  high: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
  medium: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  low: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${STYLES[severity]}`}>
      {severity}
    </span>
  );
}

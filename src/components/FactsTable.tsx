import type { Facts } from "@/lib/audit/types";

export function FactsTable({ facts }: { facts: Facts }) {
  return (
    <dl className="mt-2 grid gap-x-4 gap-y-1 font-mono text-xs sm:grid-cols-[auto_1fr]">
      {Object.entries(facts).map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="break-all">{v === null ? "null" : JSON.stringify(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

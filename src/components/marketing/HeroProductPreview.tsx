// Homepage dashboard card. Every number is read from the bundled sample workspace, the same data the
// public sample audit shows, and the card says so.
import Link from "next/link";
import { ArrowRight, CircleAlert, CircleDashed, FlaskConical, TriangleAlert } from "lucide-react";
import { HEALTH_LABEL } from "@/lib/audit/health";
import type { Severity } from "@/lib/audit/types";
import { getSampleShowcase } from "@/lib/sample/showcase";
import { ScoreRing } from "../ui";

const SEV = {
  high: { icon: CircleAlert, tile: "bg-sev-high-soft text-sev-high", label: "High" },
  medium: { icon: TriangleAlert, tile: "bg-sev-medium-soft text-sev-medium", label: "Medium" },
  low: { icon: CircleDashed, tile: "bg-sev-low-soft text-sev-low", label: "Low" },
} as const;
const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

export async function HeroProductPreview() {
  const d = await getSampleShowcase();
  const host = new URL(d.origin).host;
  return (
    <div className="relative mx-auto w-full max-w-xl lg:max-w-none">
      <div className="pointer-events-none absolute -inset-6 rounded-[2rem] bg-[radial-gradient(closest-side,rgb(241_95_70/0.16),transparent)] blur-2xl" aria-hidden />
      <div className="relative overflow-hidden rounded-3xl border border-line bg-surface shadow-pop">
        <div className="flex items-center justify-between gap-3 border-b border-line-subtle px-5 py-3.5">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-fg">{d.siteName}</p>
            <p className="truncate font-mono text-[11.5px] text-fg-3">{host}</p>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-sample-soft px-2.5 py-1 text-[11px] font-medium text-sample">
            <FlaskConical className="size-3" aria-hidden />
            Sample data
          </span>
        </div>

        <div className="grid gap-5 p-5 sm:grid-cols-[auto_minmax(0,1fr)]">
          <div className="flex flex-col items-center justify-center rounded-2xl bg-surface-secondary px-5 py-4">
            <p className="text-xs font-medium text-fg-2">Site health</p>
            <div className="mt-2">
              <ScoreRing score={d.health} size={112} stroke={10} label="Sample site health" sublabel={HEALTH_LABEL[d.band]} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 self-center">
            {(["high", "medium", "low"] as Severity[]).map((s) => {
              const S = SEV[s];
              return (
                <div key={s} className="rounded-xl border border-line-subtle p-3">
                  <span className={`grid size-7 place-items-center rounded-lg ${S.tile}`} aria-hidden>
                    <S.icon className="size-4" />
                  </span>
                  <p className="mt-2 text-xl font-semibold leading-none tabular text-fg">{d.openTypes[s]}</p>
                  <p className="mt-1 text-[11px] text-fg-3">{S.label}</p>
                </div>
              );
            })}
            <p className="col-span-3 text-[11px] text-fg-3">Open issue types · {d.pagesInspected} pages inspected</p>
          </div>
        </div>

        <div className="border-t border-line-subtle px-5 py-4">
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-fg-3">Top issues</p>
          <ul className="mt-2 space-y-1">
            {d.issues.slice(0, 4).map((i) => {
              const S = SEV[i.severity];
              return (
                <li key={i.ruleCode} className="flex items-center gap-3 py-1.5">
                  <span className={`grid size-6 shrink-0 place-items-center rounded-md ${S.tile}`} aria-hidden>
                    <S.icon className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{i.title}</span>
                  <span className="shrink-0 text-xs tabular text-fg-3">{i.pages.length === 1 ? "1 page" : `${i.pages.length} pages`}</span>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="flex items-end justify-between gap-4 border-t border-line-subtle bg-surface-secondary px-5 py-4">
          <div>
            <p className="text-xs font-medium text-fg-2">Health by audit</p>
            <div className="mt-2 flex items-end gap-3" role="img" aria-label={`Health by audit: ${d.history.map((h) => `${DAY.format(new Date(h.at))} ${h.health}`).join(", ")}`}>
              {d.history.map((h) => (
                <div key={h.at} className="flex flex-col items-center gap-1" aria-hidden>
                  <span className="text-[11px] font-semibold tabular text-fg">{h.health}</span>
                  <span className="w-9 rounded-md bg-accent/80" style={{ height: Math.max(6, h.health * 0.7) }} />
                  <span className="text-[10.5px] text-fg-3">{DAY.format(new Date(h.at))}</span>
                </div>
              ))}
            </div>
          </div>
          <Link href="/sample-audit" className="inline-flex items-center gap-1 text-[13px] font-semibold text-accent-ink hover:underline">
            See the full audit
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        </div>
      </div>
    </div>
  );
}

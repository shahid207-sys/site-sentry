// Homepage dashboard card. Every number is read from the bundled v2 sample audit (src/lib/sample/v2-sample.json),
// the same data the public sample audit shows, and the card says so.
import Link from "next/link";
import { ArrowRight, CircleAlert, CircleDashed, FlaskConical, Info, OctagonAlert, TriangleAlert, type LucideIcon } from "lucide-react";
import type { Priority } from "@/lib/results/priority";
import { getSampleShowcase } from "@/lib/sample/showcase";
import { ScoreRing } from "../ui";

// The v2 priority tones (badges.tsx is a client module, so its helpers are not callable here).
const PRIORITY: Record<Priority, { icon: LucideIcon; tile: string; label: string }> = {
  critical: { icon: OctagonAlert, tile: "bg-p-critical-soft text-p-critical", label: "Critical" },
  high: { icon: CircleAlert, tile: "bg-p-high-soft text-p-high", label: "High" },
  medium: { icon: TriangleAlert, tile: "bg-p-medium-soft text-p-medium", label: "Medium" },
  low: { icon: CircleDashed, tile: "bg-p-low-soft text-p-low", label: "Low" },
  info: { icon: Info, tile: "bg-p-info-soft text-p-info", label: "Info" },
};
const TILES: Priority[] = ["high", "medium", "low"];
const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const pages = (n: number) => (n === 1 ? "1 page" : `${n} pages`);

export function HeroProductPreview() {
  const d = getSampleShowcase();
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
            <div className="mt-2">{d.health === null ? <p className="text-sm text-fg-3">No score</p> : <ScoreRing score={d.health} size={112} stroke={10} label="Sample site health" sublabel="of 100" />}</div>
          </div>
          <div className="grid grid-cols-3 gap-2 self-center">
            {TILES.map((p) => {
              const P = PRIORITY[p];
              return (
                <div key={p} className="rounded-xl border border-line-subtle p-3">
                  <span className={`grid size-7 place-items-center rounded-lg ${P.tile}`} aria-hidden>
                    <P.icon className="size-4" />
                  </span>
                  <p className="mt-2 text-xl font-semibold leading-none tabular text-fg">{d.priorities[p]}</p>
                  <p className="mt-1 text-[11px] text-fg-3">{P.label}</p>
                </div>
              );
            })}
            <p className="col-span-3 text-[11px] text-fg-3">
              Issue groups · {d.pagesInspected} pages crawled · {d.rulesRan} checks
            </p>
          </div>
        </div>

        <div className="border-t border-line-subtle px-5 py-4">
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-fg-3">Top issues</p>
          <ul className="mt-2 space-y-1">
            {d.groups.slice(0, 4).map((g) => {
              const P = PRIORITY[g.priority];
              return (
                <li key={g.ruleId} className="flex items-center gap-3 py-1.5">
                  <span className={`grid size-6 shrink-0 place-items-center rounded-md ${P.tile}`} role="img" aria-label={`${P.label} priority`}>
                    <P.icon className="size-3.5" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{g.title}</span>
                  <span className="shrink-0 text-xs tabular text-fg-3">{pages(g.affectedUrls)}</span>
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

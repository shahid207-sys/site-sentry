import { CircleCheck, FlaskConical, ListChecks, RefreshCw, Search } from "lucide-react";
import { buildProductPreview } from "@/lib/sample/preview";
import { CriteriaList } from "../domain";
import { CertaintyBadge, Mono, SeverityBadge } from "../ui";

function Step({ n, icon: Icon, title, children }: { n: string; icon: typeof Search; title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col bg-surface p-5 sm:p-6">
      <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-accent-ink">
        <Icon className="size-4" aria-hidden />
        {n} · {title}
      </p>
      <div className="mt-4 flex-1">{children}</div>
    </div>
  );
}

/** One real finding, rendered with the workspace's own components. Computed at build time from fixtures. */
export function ProductPreview() {
  const p = buildProductPreview();
  const f = p.finding;
  return (
    <figure className="overflow-hidden rounded-2xl border border-line bg-surface shadow-pop">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-elevated px-4 py-2.5 text-[13px]">
        <span className="flex gap-1.5" aria-hidden>
          <span className="size-2.5 rounded-full bg-line-strong" />
          <span className="size-2.5 rounded-full bg-line-strong" />
          <span className="size-2.5 rounded-full bg-line-strong" />
        </span>
        <span className="font-medium text-fg">{p.siteName}</span>
        <Mono className="block min-w-0 truncate text-fg-3">{p.pageUrl}</Mono>
        <span className="ml-auto inline-flex items-center gap-1 rounded-[5px] bg-sample-soft px-1.5 py-0.5 text-xs font-medium text-sample">
          <FlaskConical className="size-3.5" aria-hidden />
          Sample data
        </span>
      </div>
      <div className="grid gap-px bg-line lg:grid-cols-3">
        <Step n="01" icon={Search} title="Find">
          <div className="flex flex-wrap gap-1.5">
            <SeverityBadge severity={f.severity} />
            <CertaintyBadge certainty={f.certainty} />
          </div>
          <p className="mt-3 text-base font-semibold text-fg">{f.title}</p>
          <dl className="mt-3 grid gap-2 text-[13px]">
            <div>
              <dt className="text-fg-3">Observed</dt>
              <dd className="evidence text-fg">{f.observed}</dd>
            </div>
            <div>
              <dt className="text-fg-3">Expected</dt>
              <dd className="evidence text-fg-2">{f.expected}</dd>
            </div>
          </dl>
          {f.snippet ? (
            <pre className="evidence mt-3 rounded-lg border border-line bg-elevated p-2.5 font-mono text-[12px] leading-relaxed text-fg-2">{f.snippet}</pre>
          ) : null}
        </Step>
        <Step n="02" icon={ListChecks} title="Fix">
          <p className="text-[13px] text-fg-2">{f.why}</p>
          <p className="mt-4 text-xs font-semibold text-fg">Recommended action</p>
          <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[13px] text-fg-2">
            {f.recommendations.slice(0, 2).map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <p className="mt-4 text-xs font-semibold text-fg">Acceptance criteria, frozen on the task</p>
          <div className="mt-2">
            <CriteriaList criteria={f.acceptanceCriteria} />
          </div>
        </Step>
        <Step n="03" icon={RefreshCw} title="Prove">
          <p className="text-xs font-semibold text-fg">Before the fix</p>
          <div className="mt-2">
            <CriteriaList criteria={f.acceptanceCriteria} results={p.before} />
          </div>
          <p className="mt-4 text-xs font-semibold text-fg">After the fix, re-fetched</p>
          <div className="mt-2">
            <CriteriaList criteria={f.acceptanceCriteria} results={p.after} />
          </div>
          {p.after.every((c) => c.passed) ? (
            <p className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-ok-soft px-2 py-1 text-[13px] font-medium text-ok">
              <CircleCheck className="size-4" aria-hidden />
              Verification passing
            </p>
          ) : null}
        </Step>
      </div>
      <figcaption className="border-t border-line px-4 py-2.5 text-xs text-fg-3">
        Produced by SiteSentry&apos;s rule engine on a bundled fictional page, then re-checked against its fixed version. Nothing on this card is hand-written.
      </figcaption>
    </figure>
  );
}

"use client";
// The Page inspector's "Raw vs rendered" tab (SPEC screen 7): what the HTML as served says next to what the DOM says
// after JavaScript ran, the lab metrics of that load, the page's requests and axe-core's accessibility results. The
// HTML line diff is a separate chunk, loaded only when asked for. Lazy-loaded by InspectScreen.
import dynamic from "next/dynamic";
import { Accessibility, Gauge, MonitorOff, Network, Split } from "lucide-react";
import { useState } from "react";
import type { PageRenderDetail } from "@/lib/results/render";
import { useApi } from "../../../lib/api";
import { fmtDateTime, plural } from "../../../lib/format";
import { Button, DefList, EmptyState, ErrorState, Mono, Notice, Panel, Skeleton, Tag, cx } from "../../../ui";
import { fmtBytes } from "./snapshot";

const HtmlDiff = dynamic(() => import("./html-diff"), { ssr: false, loading: () => <Skeleton className="h-64 w-full rounded-xl" /> });

const REASONS: Record<NonNullable<PageRenderDetail["reason"]>, { title: string; body: string }> = {
  off: { title: "This audit did not render pages", body: "Its profile has rendering off. Run a Standard, Full-site or Custom audit with rendering to compare the HTML with what JavaScript makes of it." },
  not_html: { title: "Only HTML pages that answered 200 are rendered", body: "This URL did not return an HTML page, so the browser had nothing to render." },
  not_sampled: { title: "This page was not in the sample", body: "Sampled rendering loads one page per template (the shortest URL) plus the start URL. Checks that need the rendered page did not look at this URL; a Full-site audit with full rendering does." },
  pending: { title: "Rendering has not finished", body: "The render phase runs after the crawl. Reload when the audit has been analysed." },
  phase_failed: { title: "The render phase failed", body: "No page of this audit was rendered; checks that need the rendered page report an error." },
};

const cell = (v: string | number | null) => (v === null || v === "" ? <span className="text-fg-3">—</span> : typeof v === "number" ? v.toLocaleString("en-GB") : <span className="evidence break-words font-mono text-[12.5px]">{v}</span>);

export default function RenderedTab({ auditApi, url }: { auditApi: string; url: string }) {
  const r = useApi<PageRenderDetail>(`${auditApi}/page/render?url=${encodeURIComponent(url)}`);
  const [showDiff, setShowDiff] = useState(false);
  if (r.error) return <ErrorState error={r.error} onRetry={r.reload} />;
  if (!r.data) return <Skeleton className="h-72 w-full rounded-2xl" />;
  const d = r.data;

  if (!d.render) {
    const why = REASONS[d.reason ?? "off"];
    return (
      <Panel>
        <EmptyState compact icon={MonitorOff} title={why.title}>
          {why.body}
          {d.reason === "phase_failed" && d.phase?.error ? (
            <span className="mt-1 block">
              Error: <Mono className="evidence">{d.phase.error}</Mono>
            </span>
          ) : null}
        </EmptyState>
      </Panel>
    );
  }
  const x = d.render;
  const m = x.metrics;
  const changed = (d.compare ?? []).filter((c) => c.raw !== c.rendered).length;

  return (
    <div className="grid grid-cols-1 gap-6">
      {x.status !== "rendered" ? (
        <Notice tone="warn" title={x.status === "timeout" ? "The page did not finish loading in time" : "The page could not be rendered"}>
          {x.error ?? "No error was recorded."} Checks that need the rendered page did not run on it.
        </Notice>
      ) : null}

      {d.compare ? (
        <Panel title="Before and after JavaScript" description={changed ? `${plural(changed, "field")} change when scripts run` : "Scripts change none of these fields"} flush>
          <table className="w-full table-fixed text-sm">
            <caption className="sr-only">The HTML as served compared with the rendered DOM</caption>
            <thead>
              <tr className="border-b border-line-subtle text-left text-xs text-fg-3">
                <th scope="col" className="w-[24%] px-4 py-2.5 font-medium">Field</th>
                <th scope="col" className="px-4 py-2.5 font-medium">HTML as served</th>
                <th scope="col" className="px-4 py-2.5 font-medium">After JavaScript</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-subtle">
              {d.compare.map((c) => {
                const diff = c.raw !== c.rendered;
                return (
                  <tr key={c.field} className={cx("align-top", diff && "bg-sev-medium-soft")}>
                    <th scope="row" className="px-4 py-2 text-left font-normal text-fg-2">
                      {c.field}
                      {diff ? <span className="sr-only"> (changed)</span> : null}
                    </th>
                    <td className="px-4 py-2 text-fg">{cell(c.raw)}</td>
                    <td className="px-4 py-2 text-fg">{cell(c.rendered)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>
      ) : null}

      {d.links && d.links.renderedOnlyCount > 0 ? (
        <Panel title="Links that exist only after JavaScript" description={`${plural(d.links.renderedOnlyCount, "link")} not in the HTML as served. They are reported here, not crawled.`}>
          <ul className="space-y-1 pb-4 text-[13px]">
            {d.links.renderedOnly.map((l) => (
              <li key={l}>
                <Mono className="evidence break-all">{l}</Mono>
              </li>
            ))}
            {d.links.renderedOnlyCount > d.links.renderedOnly.length ? <li className="text-fg-3">and {d.links.renderedOnlyCount - d.links.renderedOnly.length} more</li> : null}
          </ul>
        </Panel>
      ) : null}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Panel title="Lab metrics" description="One load in headless Chromium, 412 × 915 viewport, no CPU or network throttling. Lab data, not field data (CrUX).">
          {m ? (
            <DefList
              className="pb-4"
              items={[
                { label: "Source", value: <Tag>Lab</Tag> },
                { label: "Largest Contentful Paint", value: m.lcpMs === null ? "Not recorded" : `${m.lcpMs.toLocaleString("en-GB")} ms` },
                { label: "LCP element", value: m.lcpElement ? <Mono className="evidence break-all">{[m.lcpElement.tag, m.lcpElement.selector, m.lcpElement.url, m.lcpElement.loading ? `loading="${m.lcpElement.loading}"` : null].filter(Boolean).join(" · ")}</Mono> : "—" },
                { label: "Cumulative Layout Shift", value: m.cls === null ? "Not recorded" : String(m.cls) },
                { label: "DOM nodes", value: m.domNodes.toLocaleString("en-GB") },
                { label: "Render time", value: `${(x.elapsedMs / 1000).toFixed(1)} s, ${fmtDateTime(x.renderedAt)}` },
              ]}
            />
          ) : (
            <EmptyState compact icon={Gauge} title="No metrics were recorded" />
          )}
        </Panel>

        <Panel title="Accessibility (axe-core)" description={x.a11y ? `axe-core ${x.a11y.version}, on the rendered page` : undefined}>
          {x.a11y ? (
            Object.keys(x.a11y.rules).length ? (
              <ul className="space-y-3 pb-4 text-[13px]">
                {Object.entries(x.a11y.rules).map(([id, v]) => (
                  <li key={id}>
                    <span className="font-medium text-fg">{id}</span> <span className="text-fg-3">· {plural(v!.count, "element")}</span>
                    <ul className="mt-1 space-y-0.5">
                      {v!.nodes.slice(0, 3).map((n, i) => (
                        <li key={i}>
                          <Mono className="evidence break-all text-fg-2">{n.selector}</Mono>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState compact icon={Accessibility} title="No violations of the checked rules" />
            )
          ) : (
            <EmptyState compact icon={Accessibility} title="axe-core did not run on this page" />
          )}
        </Panel>
      </div>

      <Panel
        title="Requests"
        description={
          x.requestTotals
            ? `${x.requestTotals.count} requests: ${x.requestTotals.fulfilled} loaded, ${x.requestTotals.blocked} blocked, ${x.requestTotals.failed} failed${x.requestTotals.count > x.requestTotals.logged ? ` · first ${x.requestTotals.logged} listed` : ""}`
            : undefined
        }
        flush
      >
        {x.requests.length ? (
          <div className="max-h-96 overflow-auto">
            <table className="w-full table-fixed text-sm">
              <caption className="sr-only">Requests the page made while rendering</caption>
              <thead>
                <tr className="border-b border-line-subtle text-left text-xs text-fg-3">
                  <th scope="col" className="px-4 py-2.5 font-medium">URL</th>
                  <th scope="col" className="w-24 px-4 py-2.5 font-medium">Type</th>
                  <th scope="col" className="w-36 px-4 py-2.5 font-medium">Outcome</th>
                  <th scope="col" className="w-24 px-4 py-2.5 text-right font-medium">Size</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-subtle">
                {x.requests.map((q, i) => (
                  <tr key={i} className="align-top">
                    <td className="px-4 py-1.5">
                      <span className="evidence block truncate font-mono text-[12px]" title={q.url}>
                        {q.url}
                      </span>
                    </td>
                    <td className="px-4 py-1.5 text-fg-2">{q.type}</td>
                    <td className="px-4 py-1.5 text-fg-2">{q.outcome === "fulfilled" ? `HTTP ${q.status ?? "—"}` : `${q.outcome}${q.reason ? `: ${q.reason}` : ""}`}</td>
                    <td className="px-4 py-1.5 text-right text-fg-2">{q.transferBytes !== undefined ? fmtBytes(q.transferBytes) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState compact icon={Network} title="No requests were recorded" />
        )}
      </Panel>

      {x.scriptLinks && x.scriptLinks.counts.onclick + x.scriptLinks.counts.noHref > 0 ? (
        <Panel title="Links made by JavaScript only" description="Inline onclick handlers that navigate, and <a> elements without href. Handlers added with addEventListener are not visible here.">
          <ul className="space-y-1 pb-4 text-[13px]">
            {[...x.scriptLinks.onclick, ...x.scriptLinks.noHref].map((l, i) => (
              <li key={i}>
                <Mono className="evidence break-all">{l.selector}</Mono> <span className="text-fg-3">· “{l.text}”{l.target ? ` → ${l.target}` : ""}</span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Panel title="HTML diff" description="The HTML as served against the DOM after JavaScript, one tag per line." actions={!showDiff ? <Button size="sm" icon={Split} onClick={() => setShowDiff(true)}>Compare HTML</Button> : undefined}>
        {showDiff ? <HtmlDiff auditApi={auditApi} url={url} /> : <p className="pb-4 text-[13px] text-fg-3">Loads both documents (up to 300,000 characters each) and compares them line by line.</p>}
      </Panel>
    </div>
  );
}

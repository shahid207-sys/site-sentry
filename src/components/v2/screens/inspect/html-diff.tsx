"use client";
// Line diff of a page's HTML as served against its DOM after JavaScript (inspector "Raw vs rendered" tab). Its own
// chunk: it fetches both documents and diffs them only when the user asks.
import { useMemo } from "react";
import type { PageRenderDetail } from "@/lib/results/render";
import { diffLines, htmlLines, hunks } from "@/lib/text/line-diff";
import { useApi } from "../../../lib/api";
import { plural } from "../../../lib/format";
import { ErrorState, Notice, Skeleton, cx } from "../../../ui";

/** Changed lines shown at most (with their context). */
const MAX_ROWS = 2000;

export default function HtmlDiff({ auditApi, url }: { auditApi: string; url: string }) {
  const r = useApi<PageRenderDetail>(`${auditApi}/page/render?url=${encodeURIComponent(url)}&html=1`);
  const diff = useMemo(() => {
    const h = r.data?.html;
    if (!h?.raw || !h.rendered) return null;
    return diffLines(htmlLines(h.raw), htmlLines(h.rendered));
  }, [r.data]);
  if (r.error) return <ErrorState error={r.error} onRetry={r.reload} />;
  if (!r.data) return <Skeleton className="h-64 w-full rounded-xl" />;
  const h = r.data.html;
  if (!h?.raw || !h.rendered || !diff)
    return (
      <div className="pb-4">
        <Notice tone="info" title="Both documents are needed for a diff">
          {!h?.raw ? "The HTML as served was not stored for this page." : "The rendered DOM was not stored for this page."}
        </Notice>
      </div>
    );
  if (diff.tooLarge)
    return (
      <div className="pb-4">
        <Notice tone="info" title="Too many differences for a line diff">
          {plural(diff.added, "line")} added and {plural(diff.removed, "line")} removed (at least): the page is mostly built by JavaScript.
        </Notice>
      </div>
    );
  const rows = hunks(diff.lines);
  return (
    <div className="pb-4">
      <p className="mb-2 text-[13px] text-fg-2">
        <span className="text-ok">+{diff.added}</span> added by JavaScript, <span className="text-sev-high">−{diff.removed}</span> removed
        {h.truncated ? " · compared the first 300,000 characters of each document" : ""}
      </p>
      {diff.added + diff.removed === 0 ? (
        <p className="text-[13px] text-fg-3">The rendered DOM has the same tags and text as the HTML as served.</p>
      ) : (
        <div className="evidence max-h-[70vh] overflow-auto rounded-lg border border-line-subtle font-mono text-[12px] leading-relaxed" role="region" aria-label="HTML diff" tabIndex={0}>
          {rows.slice(0, MAX_ROWS).map((l, i) =>
            l === null ? (
              <div key={i} className="bg-surface-secondary px-3 text-fg-3">
                ⋯
              </div>
            ) : (
              <div key={i} className={cx("grid grid-cols-[3.5rem_3.5rem_1rem_1fr] px-1", l.op === "add" && "bg-ok-soft", l.op === "del" && "bg-sev-high-soft")}>
                <span className="select-none pr-2 text-right text-fg-3">{l.a ?? ""}</span>
                <span className="select-none pr-2 text-right text-fg-3">{l.b ?? ""}</span>
                <span className="select-none text-fg-3" aria-label={l.op === "add" ? "added" : l.op === "del" ? "removed" : undefined}>
                  {l.op === "add" ? "+" : l.op === "del" ? "−" : " "}
                </span>
                <span className="whitespace-pre-wrap break-all text-fg">{l.text}</span>
              </div>
            ),
          )}
          {rows.length > MAX_ROWS ? <div className="px-3 py-1 text-fg-3">{rows.length - MAX_ROWS} more lines not shown</div> : null}
        </div>
      )}
    </div>
  );
}

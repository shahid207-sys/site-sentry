// One URL's render for the page inspector's "Raw vs rendered" tab (SPEC screen 7): what the HTML as served says next
// to what the DOM says after JavaScript ran, the lab metrics, the page's requests and the axe-core results. With
// `html`, both documents too (capped), for the line diff the tab loads on demand.
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import type { RenderResult } from "../render/pool";
import { renderModeOf, type RenderedExtract, type RenderMode, type RenderProgress } from "../render/run";
import { getRawHtml, type BlobStore } from "../snapshot/blob-store";
import type { CanonicalTag, HeadingEntry, RobotsSnapshot } from "../snapshot/types";

type Exec = Pick<Db, "execute">;

/** Characters of each HTML document returned for the diff. */
export const DIFF_HTML_CHARS = 300_000;

export interface CompareRow {
  field: string;
  raw: string | number | null;
  rendered: string | number | null;
}

export interface PageRenderDetail {
  /** The audit's render mode, and its render phase's progress (null when it has none). */
  mode: RenderMode;
  phase: RenderProgress | null;
  /** Why there is no render of this URL, when there is none. */
  reason: "off" | "not_html" | "not_sampled" | "pending" | "phase_failed" | null;
  render: {
    status: RenderResult["status"];
    error: string | null;
    elapsedMs: number;
    renderedAt: string;
    finalUrl: string;
    /** Lab data only (source "lab"). */
    metrics: RenderResult["metrics"];
    requests: RenderResult["requests"];
    requestTotals: RenderResult["requestTotals"] | null;
    scriptLinks: RenderResult["scriptLinks"];
    scriptNavigations: string[];
    a11y: RenderResult["a11y"];
    consoleErrors: string[];
  } | null;
  /** Raw (as served) vs rendered, field by field; null without a successful render. */
  compare: CompareRow[] | null;
  links: RenderedExtract["links"] | null;
  /** Both documents, when asked for (`html`). */
  html?: { raw: string | null; rendered: string | null; truncated: boolean };
}

const canonical = (cs: CanonicalTag[] | null | undefined) => cs?.find((c) => c.location === "head")?.resolved ?? cs?.[0]?.resolved ?? null;
const robots = (r: RobotsSnapshot | null | undefined) => {
  if (!r) return null;
  const words = [r.noindex.meta || r.noindex.header ? "noindex" : "index", r.nofollow.meta || r.nofollow.header ? "nofollow" : "follow"];
  return words.join(", ");
};
const h1 = (o: HeadingEntry[] | null | undefined) => o?.find((h) => h.level === 1)?.text ?? null;

/** The render of `url` (normalised) in crawl `crawlId`; null when the crawl has no such URL. */
export async function pageRender(db: Exec, store: BlobStore, crawlId: string, url: string, opts: { html?: boolean } = {}): Promise<PageRenderDetail | null> {
  const r = await db.execute(sql`select c.config, c.kind, c.render as phase, u.id as url_id, s.status_code, s.facts is not null as html, s.raw_html_key,
      s.canonicals, s.robots, s.titles, s.outline, s.word_count, s.images,
      (select count(distinct l->>'href')::int from jsonb_array_elements(coalesce(s.links, '[]'::jsonb)) l where l->>'via' = 'link') as raw_links,
      jsonb_array_length(coalesce(s.json_ld, '[]'::jsonb)) as raw_json_ld,
      to_jsonb(pr) as render
    from crawl_urls u join crawls c on c.id = u.crawl_id
    left join page_snapshots s on s.url_id = u.id
    left join page_renders pr on pr.url_id = u.id
    where u.crawl_id = ${crawlId}::uuid and u.normalised_url = ${url}`);
  const x = r.rows[0] as Record<string, unknown> | undefined;
  if (!x) return null;
  const mode = x.kind === "audit" ? renderModeOf(x.config as Record<string, unknown>) : "off";
  const phase = (x.phase as RenderProgress | null) ?? null;
  const row = x.render as Record<string, unknown> | null;

  let reason: PageRenderDetail["reason"] = null;
  if (!row) {
    if (mode === "off") reason = "off";
    else if (x.status_code !== 200 || !x.html) reason = "not_html";
    else if (phase?.status === "failed") reason = "phase_failed";
    else if (phase?.status !== "done") reason = "pending";
    else reason = "not_sampled";
  }

  const extract = (row?.extract as RenderedExtract | null) ?? null;
  const images = x.images as unknown[] | null;
  const compare: CompareRow[] | null =
    row?.status === "rendered" && extract
      ? [
          { field: "Title", raw: (x.titles as string[] | null)?.[0] ?? null, rendered: extract.titles[0] ?? null },
          { field: "Canonical", raw: canonical(x.canonicals as CanonicalTag[]), rendered: canonical(extract.canonicals) },
          { field: "Meta robots", raw: robots(x.robots as RobotsSnapshot), rendered: robots(extract.robots) },
          { field: "H1", raw: h1(x.outline as HeadingEntry[]), rendered: h1(extract.outline) },
          { field: "Headings", raw: (x.outline as HeadingEntry[] | null)?.length ?? 0, rendered: extract.outline.length },
          { field: "Main-content words", raw: (x.word_count as number | null) ?? 0, rendered: extract.wordCount },
          { field: "Links (<a href>)", raw: Number(x.raw_links ?? 0), rendered: extract.links.total },
          { field: "Images", raw: images?.length ?? 0, rendered: extract.images },
          { field: "JSON-LD blocks", raw: Number(x.raw_json_ld ?? 0), rendered: extract.jsonLdBlocks },
        ]
      : null;

  const out: PageRenderDetail = {
    mode,
    phase,
    reason,
    render: row
      ? {
          status: row.status as RenderResult["status"],
          error: (row.error as string | null) ?? null,
          elapsedMs: row.elapsed_ms as number,
          renderedAt: row.rendered_at as string,
          finalUrl: row.final_url as string,
          metrics: (row.metrics ?? null) as RenderResult["metrics"],
          requests: (row.requests ?? []) as RenderResult["requests"],
          requestTotals: (row.request_totals ?? null) as RenderResult["requestTotals"] | null,
          scriptLinks: (row.script_links ?? null) as RenderResult["scriptLinks"],
          scriptNavigations: (row.script_navigations ?? []) as string[],
          a11y: (row.a11y ?? null) as RenderResult["a11y"],
          consoleErrors: (row.console_errors ?? []) as string[],
        }
      : null,
    compare,
    links: extract?.links ?? null,
  };
  if (opts.html) {
    const raw = x.raw_html_key ? await getRawHtml(store, x.raw_html_key as string) : null;
    const rendered = row?.rendered_html_key ? await getRawHtml(store, row.rendered_html_key as string) : null;
    const cap = (s: string | null) => (s && s.length > DIFF_HTML_CHARS ? s.slice(0, DIFF_HTML_CHARS) : s);
    out.html = { raw: cap(raw), rendered: cap(rendered), truncated: (raw?.length ?? 0) > DIFF_HTML_CHARS || (rendered?.length ?? 0) > DIFF_HTML_CHARS };
  }
  return out;
}

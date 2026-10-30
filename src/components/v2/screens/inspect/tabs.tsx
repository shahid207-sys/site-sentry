"use client";
// The Page inspector's tab panels (SPEC screen 7): each shows one slice of what the crawl stored for the URL, read
// through readSnapshot so old or body-less snapshots render as plain explanations instead of blank tables.
import Link from "next/link";
import { Braces, Code, Copy, FileX, Heading, History, Image as ImageIcon, Link2 } from "lucide-react";
import type { ReactNode } from "react";
import type { EdgeRow, PageDetail, PageIssue, UrlRow } from "@/lib/results/explore";
import { useCopy } from "../../../overlays";
import { fmtDateTime, plural } from "../../../lib/format";
import { DefList, EmptyState, ExternalUrl, Mono, Notice, Panel, Tag, cx } from "../../../ui";
import { IssueStateBadge, urlStateLabel } from "../../badges";
import { ruleTitle } from "../../hooks";
import { inspectHref } from "../../links";
import { SNAPSHOT_CAPS, altText, fmtBytes, headTagText, stateWords, type SnapshotView } from "./snapshot";

/** Copied from src/lib/results/explore.ts (a server module): edge lists stop at this many rows; totals say how many exist. */
export const EDGE_LIMIT = 500;

/** The inspector of one URL of the audit, optionally on a given tab. */
export { inspectHref };

export function CopyButton({ text, label, what }: { text: string; label: string; what?: string }) {
  const copy = useCopy();
  return (
    <button type="button" onClick={() => void copy(text, what)} className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-fg-2 hover:border-line-strong hover:text-fg" aria-label={label}>
      <Copy className="size-3.5" aria-hidden />
      Copy
    </button>
  );
}

/** " · the crawler keeps at most N": said when a list reached the extractor's cap, so it may not be the whole page. */
const capNote = (n: number, cap: number) => (n >= cap ? ` · the crawler keeps at most ${cap.toLocaleString("en-GB")}, so the page may have more` : "");

/** A code block on the code tokens (evidence, raw JSON-LD, head tags). */
export function CodeBlock({ children, className }: { children: ReactNode; className?: string }) {
  return <pre className={cx("evidence max-h-96 overflow-auto rounded-lg bg-code-bg p-3 font-mono text-[12.5px] leading-relaxed text-code-fg", className)}>{children}</pre>;
}

const dash = <span className="text-fg-3">—</span>;
const orDash = (v: ReactNode) => (v === null || v === undefined || v === "" ? dash : v);

/**
 * Why a snapshot-based tab is empty: no snapshot at all (the URL was not read as a page), or a snapshot without an
 * extracted HTML body. Null when the tab has data to show.
 */
function missingNote({ s, row, what, needsBody = true }: { s: SnapshotView | null; row: UrlRow; what: string; needsBody?: boolean }): ReactNode {
  if (!s)
    return (
      <EmptyState compact icon={FileX} title={`No ${what}: this URL was not read as a page`}>
        {stateWords(row.state)}
        {row.reason ? <span className="mt-1 block">Crawler note: <Mono className="evidence">{row.reason}</Mono></span> : null}
      </EmptyState>
    );
  if (needsBody && !s.extracted)
    return (
      <EmptyState compact icon={FileX} title={`No ${what}: no HTML body was extracted`}>
        The response (HTTP {s.statusCode ?? "—"}, {s.contentType || "no content type"}) had no HTML body to read.
      </EmptyState>
    );
  return null;
}

// ---------- Overview ----------

export function OverviewTab({ d, s, auditBase }: { d: PageDetail; s: SnapshotView | null; auditBase: string }) {
  const r = d.url;
  const robots = s?.robots;
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      {!s ? (
        <div className="xl:col-span-2">
          <Notice tone="info" title={`${urlStateLabel(r.state)}: no page snapshot`}>
            {stateWords(r.state)}
            {r.reason ? <span className="mt-1 block">Crawler note: <Mono className="evidence text-fg">{r.reason}</Mono></span> : null}
          </Notice>
        </div>
      ) : !s.extracted ? (
        <div className="xl:col-span-2">
          <Notice tone="info" title="No HTML body was extracted">
            The crawler saved the response (HTTP {s.statusCode ?? "—"}, {s.contentType || "no content type"}) but it had no HTML body to read, so titles, headings, links
            and other page fields are empty.
          </Notice>
        </div>
      ) : null}

      <Panel title="Response">
        <DefList
          items={[
            { label: "HTTP status", value: <span className="tabular">{orDash(s?.statusCode ?? r.status)}</span> },
            ...(s ? [{ label: "Requested URL", value: s.requestedUrl ? <Mono className="evidence">{s.requestedUrl}</Mono> : dash }] : []),
            ...(s ? [{ label: "Final URL", value: s.finalUrl ? <Mono className="evidence">{s.finalUrl}</Mono> : dash }] : []),
            {
              label: "Redirect chain",
              value: s?.redirectChain.length ? (
                <ol className="space-y-1">
                  {s.redirectChain.map((h, i) => (
                    <li key={i} className="text-[13px]">
                      <span className="tabular text-fg-3">{h.status ?? "—"}</span> <Mono className="evidence">{h.url}</Mono>
                    </li>
                  ))}
                </ol>
              ) : r.redirectTarget ? (
                <span className="text-[13px]">
                  Redirects to{" "}
                  <Link href={inspectHref(auditBase, r.redirectTarget)} className="font-mono text-[12.5px] text-accent-ink hover:underline">
                    {r.redirectTarget}
                  </Link>
                </span>
              ) : (
                "None"
              ),
            },
            { label: "Content type", value: orDash(s?.contentType ?? r.contentType) },
            { label: "Bytes", value: <span className="tabular">{fmtBytes(s?.bytes ?? r.bytes)}</span> },
            ...(s ? [{ label: "Truncated", value: s.truncated ? "Yes: only the first part of the body was read" : "No" }] : []),
            {
              label: "Fetch timing",
              value: s?.timings ? `${s.timings.fetchMs ?? "—"} ms fetch · ${s.timings.extractMs ?? "—"} ms extract` : r.elapsedMs !== null ? `${r.elapsedMs} ms` : dash,
            },
            ...(s ? [{ label: "Raw HTML", value: s.blobStatus === "stored" ? "Stored" : s.blobStatus === "blob_missing" ? "Not stored (the write failed twice)" : "None (no HTML body)" }] : []),
            ...(s ? [{ label: "Fetched", value: s.fetchedAt ? fmtDateTime(s.fetchedAt) : dash }] : []),
          ]}
        />
      </Panel>

      <Panel title="Indexing">
        <DefList
          items={[
            { label: "State", value: <>{urlStateLabel(r.state)}{r.reason ? <Mono className="evidence mt-0.5 block text-fg-3">{r.reason}</Mono> : null}</> },
            {
              label: "noindex",
              value: robots ? (robots.noindex.meta || robots.noindex.header ? `Yes (${[robots.noindex.meta && "meta robots", robots.noindex.header && "X-Robots-Tag"].filter(Boolean).join(" and ")})` : "No") : "Unknown (page not read)",
            },
            ...(robots ? [{ label: "nofollow", value: robots.nofollow.meta || robots.nofollow.header ? `Yes (${[robots.nofollow.meta && "meta robots", robots.nofollow.header && "X-Robots-Tag"].filter(Boolean).join(" and ")})` : "No" }] : []),
            {
              label: "Robots directives",
              value: robots?.directives.length ? (
                <ul className="space-y-1">
                  {robots.directives.map((x, i) => (
                    <li key={i} className="text-[13px]">
                      <span className="text-fg-3">{x.source === "meta" ? `<meta name="${x.agent}">` : `X-Robots-Tag${x.agent === "*" ? "" : ` (${x.agent})`}`}:</span> <Mono>{x.directives.join(", ") || "(empty)"}</Mono>
                    </li>
                  ))}
                </ul>
              ) : s?.extracted ? (
                "None"
              ) : (
                dash
              ),
            },
            {
              label: s && s.canonicals.length > 1 ? `Canonicals (${s.canonicals.length})` : "Canonical",
              value: s?.canonicals.length ? (
                <ul className="space-y-1.5">
                  {s.canonicals.map((c, i) => (
                    <li key={i} className="text-[13px]">
                      <Mono className="evidence block">{c.resolved ?? c.href}</Mono>
                      <span className="text-xs text-fg-3">
                        in {c.location === "header" ? "the Link header" : `<${c.location}>`}
                        {c.location === "body" ? " (ignored by search engines)" : ""}
                        {c.absolute ? "" : ` · written as relative "${c.href}"`}
                        {c.resolved === null ? " · could not be resolved" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : s?.extracted ? (
                "None"
              ) : (
                dash
              ),
            },
          ]}
        />
      </Panel>

      <Panel title="Content">
        <DefList
          items={[
            { label: s && s.titles.length > 1 ? `Titles (${s.titles.length})` : "Title", value: <TextList items={s?.titles} fallback={r.title} /> },
            { label: s && s.descriptions.length > 1 ? `Descriptions (${s.descriptions.length})` : "Description", value: <TextList items={s?.descriptions} fallback={r.description} /> },
            { label: "First H1", value: orDash(r.h1) },
            { label: "Words", value: <span className="tabular">{orDash((s?.wordCount ?? r.wordCount)?.toLocaleString("en-GB"))}</span> },
            {
              label: "Language",
              value: s?.language ? (
                <span className="text-[13px]">
                  Declared {s.language.declared ? <Mono>{s.language.declared}</Mono> : "none"} · detected{" "}
                  {s.language.detected ? (
                    <>
                      <Mono>{s.language.detected}</Mono>
                      {s.language.accuracy !== null ? ` (${Math.round(s.language.accuracy * 100)}% confidence)` : ""}
                    </>
                  ) : (
                    "not enough text to judge"
                  )}
                </span>
              ) : (
                dash
              ),
            },
            { label: "Template", value: r.templateId ? <Mono className="evidence">{r.templateId}</Mono> : s?.templateFingerprint ? <Mono className="evidence">{s.templateFingerprint}</Mono> : dash },
            ...(s ? [{ label: "Content hash", value: s.contentHash ? <Mono className="evidence text-fg-2">{s.contentHash}</Mono> : dash }] : []),
          ]}
        />
      </Panel>

      <Panel title="Discovery">
        <DefList
          items={[
            { label: "Click depth", value: r.depth === null ? "Not linked from the start URL" : <span className="tabular">{r.depth}</span> },
            { label: "Link depth", value: <span className="tabular">{orDash(r.linkDepth)}</span> },
            { label: "Inbound links", value: <span className="tabular">{orDash(r.inbound?.toLocaleString("en-GB"))}</span> },
            { label: "PageRank", value: <span className="tabular">{r.pagerank === null ? dash : r.pagerank.toPrecision(3)}</span> },
            { label: "Discovered via", value: r.discoveredVia.length ? r.discoveredVia.join(", ") : dash },
            { label: "Links", value: `${plural(d.linksInTotal, "link")} in · ${plural(d.linksOutTotal, "link")} out` },
          ]}
        />
      </Panel>
    </div>
  );
}

function TextList({ items, fallback }: { items: string[] | undefined; fallback: string | null }) {
  const list = items?.length ? items : fallback ? [fallback] : [];
  if (!list.length) return <span className="text-fg-3">None</span>;
  return (
    <ul className="space-y-1">
      {list.map((t, i) => (
        <li key={i} className="evidence text-[13px]">
          {t || <span className="text-fg-3">(empty)</span>}
          <span className="ml-1.5 text-xs text-fg-3 tabular">{t.length} chars</span>
        </li>
      ))}
    </ul>
  );
}

// ---------- Headers ----------

export function HeadersTab({ s, row }: { s: SnapshotView | null; row: UrlRow }) {
  const missing = missingNote({ s, row, what: "response headers", needsBody: false });
  if (missing || !s) return <Panel>{missing}</Panel>;
  return (
    <Panel title="Response headers" description={plural(s.headers.length, "header")} flush>
      {s.headers.length === 0 ? (
        <EmptyState compact icon={Code} title="No headers were recorded" />
      ) : (
        <table className="w-full table-fixed text-sm">
          <caption className="sr-only">Response headers</caption>
          <thead>
            <tr className="border-b border-line-subtle text-left text-xs text-fg-3">
              <th scope="col" className="w-[34%] px-4 py-2.5 font-medium">Name</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Value</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-subtle">
            {s.headers.map(([k, v]) => (
              <tr key={k} className="align-top">
                <th scope="row" className="px-4 py-2 text-left font-mono text-[12.5px] font-normal text-fg-2 evidence">{k}</th>
                <td className="px-4 py-2 font-mono text-[12.5px] text-fg evidence">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

// ---------- Head tags ----------

export function HeadTagsTab({ s, row }: { s: SnapshotView | null; row: UrlRow }) {
  const missing = missingNote({ s, row, what: "head tags" });
  if (missing || !s) return <Panel>{missing}</Panel>;
  return (
    <Panel title="Head tags" description={`${plural(s.head.length, "tag")} in <head>, in document order${capNote(s.head.length, SNAPSHOT_CAPS.headTags)}`} actions={s.head.length ? <CopyButton text={s.head.map(headTagText).join("\n")} label="Copy all head tags" what="Head tags copied" /> : undefined}>
      {s.head.length === 0 ? (
        <EmptyState compact icon={Code} title="The page's <head> had no tags" />
      ) : (
        <CodeBlock className="max-h-[70vh]">
          {s.head.map((t, i) => (
            <span key={i} className="block">
              {headTagText(t)}
            </span>
          ))}
        </CodeBlock>
      )}
    </Panel>
  );
}

// ---------- Headings ----------

export function HeadingsTab({ s, row }: { s: SnapshotView | null; row: UrlRow }) {
  const missing = missingNote({ s, row, what: "headings" });
  if (missing || !s) return <Panel>{missing}</Panel>;
  const h1 = s.outline.filter((h) => h.level === 1).length;
  return (
    <Panel title="Headings outline" description={`${plural(s.outline.length, "heading")} · ${plural(h1, "H1")}${capNote(s.outline.length, SNAPSHOT_CAPS.headings)}`}>
      {s.outline.length === 0 ? (
        <EmptyState compact icon={Heading} title="The page has no H1–H6 headings" />
      ) : (
        <ol className="space-y-1" aria-label="Headings in document order">
          {s.outline.map((h, i) => (
            <li key={i} className="flex items-baseline gap-2 text-sm" style={{ paddingLeft: `${(h.level - 1) * 1.25}rem` }}>
              <span className="w-7 shrink-0 font-mono text-xs font-semibold text-fg-3" aria-label={`Level ${h.level}`}>H{h.level}</span>
              <span className={cx("evidence min-w-0", h.level === 1 ? "font-semibold text-fg" : "text-fg-2")}>{h.text || <span className="text-fg-3">(empty heading)</span>}</span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

// ---------- Links ----------

export function LinksTab({ d, auditBase }: { d: PageDetail; auditBase: string }) {
  return (
    <div className="space-y-6">
      {d.linksInTotal > EDGE_LIMIT || d.linksOutTotal > EDGE_LIMIT ? (
        <Notice tone="info">Each list shows at most {EDGE_LIMIT} links, in the order the crawler recorded them. The totals count every link.</Notice>
      ) : null}
      <p className="text-[13px] text-fg-3">Every URL opens in this inspector. A URL the audit never recorded opens a plain &ldquo;not in this audit&rdquo; note.</p>
      <EdgeTable title="Links in" description="Pages of this crawl that reference this URL" rows={d.linksIn} total={d.linksInTotal} auditBase={auditBase} />
      <EdgeTable title="Links out" description="URLs this page references" rows={d.linksOut} total={d.linksOutTotal} auditBase={auditBase} />
    </div>
  );
}

function EdgeTable({ title, description, rows, total, auditBase }: { title: string; description: string; rows: EdgeRow[]; total: number; auditBase: string }) {
  const capped = total > rows.length;
  return (
    <Panel title={`${title} (${total.toLocaleString("en-GB")})`} description={capped ? `${description}. Showing the first ${rows.length.toLocaleString("en-GB")} of ${total.toLocaleString("en-GB")}.` : description} flush>
      {rows.length === 0 ? (
        <EmptyState compact icon={Link2} title={`No ${title.toLowerCase()}`} />
      ) : (
        <div className="max-h-[60vh] overflow-auto">
          <table className="w-full min-w-[720px] table-fixed text-sm">
            <caption className="sr-only">{title}{capped ? `, first ${rows.length} of ${total}` : ""}</caption>
            <thead className="sticky top-0 bg-surface">
              <tr className="border-b border-line-subtle text-left text-xs text-fg-3">
                <th scope="col" className="w-[44%] px-4 py-2.5 font-medium">URL</th>
                <th scope="col" className="w-24 px-4 py-2.5 font-medium">Type</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Anchor</th>
                <th scope="col" className="w-24 px-4 py-2.5 font-medium">Location</th>
                <th scope="col" className="w-32 px-4 py-2.5 font-medium">rel</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-subtle">
              {rows.map((e, i) => (
                <tr key={`${e.url}-${i}`} className="align-top">
                  <td className="px-4 py-2">
                    {e.inCrawl ? (
                      <Link href={inspectHref(auditBase, e.url, "links")} className="evidence font-mono text-[12.5px] text-fg hover:text-accent-ink hover:underline" title={`Inspect ${e.url}`}>
                        {e.url}
                      </Link>
                    ) : (
                      <span className="evidence font-mono text-[12.5px] text-fg-2" title="Not a URL of this crawl, so it cannot be inspected">{e.url}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-[13px] text-fg-2">{e.via}</td>
                  <td className="evidence px-4 py-2 text-[13px] text-fg-2">{e.anchor === null ? dash : e.anchor.trim() === "" ? <span className="text-fg-3">(no text)</span> : e.anchor}</td>
                  <td className="px-4 py-2 text-[13px] text-fg-2">{orDash(e.location)}</td>
                  <td className="px-4 py-2 text-[13px] text-fg-2">
                    {e.nofollow ? <Tag>nofollow</Tag> : null}
                    {e.rel && !(e.nofollow && e.rel.trim() === "nofollow") ? <Mono className="evidence block text-fg-3">{e.rel}</Mono> : e.nofollow ? null : dash}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

// ---------- Images ----------

export function ImagesTab({ s, row }: { s: SnapshotView | null; row: UrlRow }) {
  const missing = missingNote({ s, row, what: "images" });
  if (missing || !s) return <Panel>{missing}</Panel>;
  const absent = s.images.filter((i) => altText(i.alt).kind === "absent").length;
  const empty = s.images.filter((i) => altText(i.alt).kind === "empty").length;
  return (
    <Panel title="Images" description={`${plural(s.images.length, "image")} · ${absent} without an alt attribute · ${empty} with empty alt${capNote(s.images.length, SNAPSHOT_CAPS.images)}`} flush>
      {s.images.length === 0 ? (
        <EmptyState compact icon={ImageIcon} title="The page has no <img> elements" />
      ) : (
        <div className="max-h-[70vh] overflow-auto">
          <table className="w-full min-w-[760px] table-fixed text-sm">
            <caption className="sr-only">Images on the page</caption>
            <thead className="sticky top-0 bg-surface">
              <tr className="border-b border-line-subtle text-left text-xs text-fg-3">
                <th scope="col" className="w-[38%] px-4 py-2.5 font-medium">Source</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Alt</th>
                <th scope="col" className="w-32 px-4 py-2.5 font-medium">Dimensions</th>
                <th scope="col" className="w-24 px-4 py-2.5 font-medium">Loading</th>
                <th scope="col" className="w-28 px-4 py-2.5 font-medium">Context</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-subtle">
              {s.images.map((img, i) => {
                const alt = altText(img.alt);
                return (
                  <tr key={i} className="align-top">
                    <td className="px-4 py-2">
                      {img.resolved ? <ExternalUrl url={img.resolved} className="max-w-full font-mono text-[12.5px] text-fg">{img.src}</ExternalUrl> : <Mono className="evidence text-fg">{img.src}</Mono>}
                      {img.srcset ? <span className="mt-0.5 block text-xs text-fg-3">has srcset</span> : null}
                    </td>
                    <td className={cx("evidence px-4 py-2 text-[13px]", alt.kind === "text" ? "text-fg" : alt.kind === "absent" ? "font-medium text-sev-high" : "text-fg-2")}>{alt.label}</td>
                    <td className="px-4 py-2 text-[13px] tabular text-fg-2">{img.width || img.height ? `${img.width ?? "?"} × ${img.height ?? "?"}` : <span className="text-fg-3">Not set</span>}</td>
                    <td className="px-4 py-2 text-[13px] text-fg-2">{img.loading ?? <span className="text-fg-3">default</span>}</td>
                    <td className="px-4 py-2 text-xs text-fg-3">{[img.inMain === undefined ? null : img.inMain ? "main content" : "outside main", img.linked ? "linked" : null].filter(Boolean).join(" · ") || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

// ---------- Structured data ----------

export function StructuredDataTab({ s, row }: { s: SnapshotView | null; row: UrlRow }) {
  const missing = missingNote({ s, row, what: "structured data" });
  if (missing || !s) return <Panel>{missing}</Panel>;
  if (!s.jsonLd.length)
    return (
      <Panel>
        <EmptyState compact icon={Braces} title="No JSON-LD blocks on this page">
          Only <Mono>{'<script type="application/ld+json">'}</Mono> is read; microdata and RDFa are not extracted.
        </EmptyState>
      </Panel>
    );
  return (
    <div className="space-y-4">
      {s.jsonLd.map((b, i) => (
        <Panel key={i} title={`JSON-LD block ${i + 1}${b.error ? "" : typesOf(b.parsed)}`} description={`${b.raw.length.toLocaleString("en-GB")} characters`} actions={<CopyButton text={b.raw} label={`Copy JSON-LD block ${i + 1}`} what="JSON-LD copied" />}>
          {b.error ? (
            <div className="space-y-3">
              {b.raw.length >= SNAPSHOT_CAPS.jsonLdChars ? (
                <Notice tone="warn" title="The crawler cut this block before parsing it">
                  It keeps the first {SNAPSHOT_CAPS.jsonLdChars.toLocaleString("en-GB")} characters of a JSON-LD block, so the parse error below most likely comes from
                  the cut, not from the site. Check the live page to confirm. <Mono className="evidence mt-1 block">{b.error}</Mono>
                </Notice>
              ) : (
                <Notice tone="error" title="This block is not valid JSON">
                  <Mono className="evidence">{b.error}</Mono>
                </Notice>
              )}
              <CodeBlock>{b.raw || "(empty script)"}</CodeBlock>
            </div>
          ) : (
            <div className="overflow-x-auto font-mono text-[12.5px]">
              <JsonNode name={null} value={b.parsed} depth={0} />
            </div>
          )}
        </Panel>
      ))}
    </div>
  );
}

/** " · Product, Offer": the @type values at the top of a block (or of its @graph). */
function typesOf(v: unknown): string {
  const out = new Set<string>();
  const add = (x: unknown) => {
    if (!x || typeof x !== "object") return;
    const t = (x as Record<string, unknown>)["@type"];
    for (const y of Array.isArray(t) ? t : [t]) if (typeof y === "string") out.add(y);
  };
  for (const x of Array.isArray(v) ? v : [v]) {
    add(x);
    const g = x && typeof x === "object" ? (x as Record<string, unknown>)["@graph"] : null;
    if (Array.isArray(g)) g.forEach(add);
  }
  return out.size ? ` · ${[...out].slice(0, 4).join(", ")}${out.size > 4 ? "…" : ""}` : "";
}

function JsonNode({ name, value, depth }: { name: string | null; value: unknown; depth: number }) {
  const key = name === null ? null : <span className="text-fg-2">{name}: </span>;
  if (value !== null && typeof value === "object") {
    const isArr = Array.isArray(value);
    const entries: [string, unknown][] = isArr ? (value as unknown[]).map((v, i): [string, unknown] => [String(i), v]) : Object.entries(value as Record<string, unknown>);
    const t = isArr ? null : (value as Record<string, unknown>)["@type"];
    return (
      <details open={depth < 3} className="[&>summary]:cursor-pointer">
        <summary className="rounded py-0.5 hover:bg-hover">
          {key}
          <span className="text-fg-3">{isArr ? `[${entries.length}]` : `{${entries.length}}`}</span>
          {typeof t === "string" ? <span className="ml-1.5 font-sans text-xs font-medium text-accent-ink">{t}</span> : null}
        </summary>
        <ul className="ml-2 border-l border-line-subtle pl-3">
          {entries.map(([k, v]) => (
            <li key={k}>
              <JsonNode name={k} value={v} depth={depth + 1} />
            </li>
          ))}
        </ul>
      </details>
    );
  }
  return (
    <div className="evidence py-0.5">
      {key}
      <span className={typeof value === "string" ? "text-fg" : "text-info"}>{JSON.stringify(value)}</span>
    </div>
  );
}

// ---------- Issue history ----------

export function IssuesTab({ issues, crawlId }: { issues: PageIssue[]; crawlId: string }) {
  if (!issues.length)
    return (
      <Panel>
        <EmptyState compact icon={History} title="No findings on this URL">
          No rule has reported this URL in this audit or carried an open finding over to it.
        </EmptyState>
      </Panel>
    );
  return (
    <div className="space-y-4">
      {issues.map((i) => (
        <IssueCard key={i.fingerprint} issue={i} crawlId={crawlId} />
      ))}
    </div>
  );
}

function IssueCard({ issue: i, crawlId }: { issue: PageIssue; crawlId: string }) {
  const evidence = i.evidence === null || i.evidence === undefined ? null : JSON.stringify(i.evidence, null, 2);
  const hasEvidence = evidence !== null && evidence !== "{}";
  return (
    <Panel
      title={ruleTitle(i.ruleId)}
      description={<Mono className="text-fg-3">{i.ruleId}</Mono>}
      actions={
        <>
          {i.outcome === "inconclusive" ? <Tag>Could not decide</Tag> : null}
          <IssueStateBadge state={i.state} />
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-fg">{i.message ?? <span className="text-fg-3">This audit did not observe it again, so there is no message from this audit.</span>}</p>
        {hasEvidence ? (
          <div>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-3">Evidence</h3>
              <CopyButton text={evidence} label={`Copy evidence for ${ruleTitle(i.ruleId)}`} what="Evidence copied" />
            </div>
            <CodeBlock>{evidence}</CodeBlock>
          </div>
        ) : null}
        <div>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-fg-3">History across audits</h3>
          {i.history.length ? (
            <ol className="divide-y divide-line-subtle rounded-lg border border-line-subtle">
              {i.history.map((h) => (
                <li key={h.crawlId} className={cx("flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[13px]", h.crawlId === crawlId && "bg-accent-softer")}>
                  <span className="text-fg-2">
                    Audit of {fmtDateTime(h.createdAt)}
                    {h.crawlId === crawlId ? <span className="ml-1.5 font-medium text-fg">(this audit)</span> : null}
                  </span>
                  <IssueStateBadge state={h.state} />
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-[13px] text-fg-3">No earlier audit recorded a state for it.</p>
          )}
        </div>
      </div>
    </Panel>
  );
}

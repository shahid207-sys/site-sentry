// The audit report as one self-contained HTML document (docs/SPEC.md "Reporting"): the same markup is served as the
// live report, behind share links, and printed to PDF (pdf.ts). It formats ReportData (src/lib/results/report.ts)
// and nothing else. Every number carries data-metric="…" so a check can compare the rendered value with the database.
//
// The page shows text from the crawled site (titles, URLs, evidence): everything is escaped, links are emitted for
// http(s) URLs only, and the document loads nothing (no scripts, no remote images; the logo is a data: URI).
import type { Branding } from "../model";
import type { ReportData, ReportGroup } from "../results/report";
import { INLINE_URLS, PRIORITY_PAGES } from "../results/report";
import { CATEGORY_WEIGHTS, PARTIAL_COVERAGE_BELOW, UNWEIGHTED_CATEGORIES } from "../results/health";
import { NOT_OURS, UNFETCHED } from "../results/coverage";
import { BRAND_COLOR, LOGO_DATA_URL } from "./branding";

export interface RenderOptions {
  /** Where a group's full affected-URL CSV is served, for lists over INLINE_URLS rows. */
  csvHref(ruleId: string): string;
}

/** The CSP the report is served with: inline styles, data: images, nothing else. */
export const REPORT_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const DEFAULT_COLOR = "#1f4b99";

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A number the gate compares with the database. */
const m = (key: string, value: number | string | null) => `<span data-metric="${esc(key)}">${esc(value ?? "n/a")}</span>`;

const link = (url: string) => (/^https?:\/\//i.test(url) ? `<a href="${esc(url)}" rel="nofollow noopener noreferrer">${esc(url)}</a>` : esc(url));

const fmtDate = (iso: string) => new Date(iso).toISOString().slice(0, 10);

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

const STATE_LABEL: Record<string, string> = {
  new: "new",
  persistent: "persistent",
  resolved: "resolved",
  regressed: "regressed",
  not_rechecked: "not re-checked",
  inconclusive: "inconclusive",
};

const COVERAGE_LABEL: Record<string, string> = {
  discovered: "found, not fetched yet",
  queued: "queued, not fetched yet",
  fetching: "being fetched",
  fetched: "fetched",
  analysed: "fetched and analysed",
  redirected: "redirected",
  non_html: "not HTML",
  oversized: "over the size limit",
  blocked_robots: "blocked by robots.txt",
  out_of_scope: "outside the crawl scope",
  excluded_by_rule: "excluded by a scope rule",
  cdn_managed: "CDN paths, never fetched",
  budget_exhausted: "not fetched: budget reached",
  depth_exceeded: "not fetched: beyond the depth limit",
  cancelled: "not fetched: crawl cancelled",
  interrupted: "interrupted, never re-requested",
  failed_timeout: "failed: timeout",
  failed_dns: "failed: DNS",
  failed_tls: "failed: TLS",
  failed_network: "failed: network",
};

function cover(d: ReportData, b: Branding) {
  const logo = b.logoDataUrl && LOGO_DATA_URL.test(b.logoDataUrl) ? `<img class="logo" src="${b.logoDataUrl}" alt="${esc(b.agencyName ?? "logo")}">` : "";
  return `<section class="cover">
  ${logo}
  ${b.agencyName ? `<p class="agency">${esc(b.agencyName)}</p>` : ""}
  <h1>SEO audit</h1>
  <p class="domain">${esc(new URL(d.overview.siteOrigin).host)}</p>
  <dl>
    <dt>Audit date</dt><dd>${fmtDate(d.overview.createdAt)}</dd>
    <dt>Profile</dt><dd>${esc(d.overview.profile)}</dd>
    <dt>Report generated</dt><dd>${fmtDate(d.generatedAt)}</dd>
  </dl>
</section>`;
}

function coverageSentence(d: ReportData) {
  const c = d.overview.coverage;
  const parts = [`${m("coverage.answered", c.answered)} of ${m("coverage.eligible", c.eligible)} discovered URLs inspected (${m("coverage.percent", c.percent)}%)`];
  for (const s of [...NOT_OURS, ...UNFETCHED]) if (c.states[s]) parts.push(`${m(`coverage.state.${s}`, c.states[s])} ${esc(COVERAGE_LABEL[s] ?? s)}`);
  return parts.join("; ");
}

function summary(d: ReportData) {
  const h = d.overview.health;
  const top = d.groups.slice(0, 5);
  const cmp = d.comparison;
  const changes = cmp
    ? `<p>Since the audit of ${fmtDate(cmp.base.createdAt)}: ${(["new", "regressed", "persistent", "resolved", "not_rechecked"] as const)
        .map((k) => `${m(`compare.${k}`, cmp.totals[k])} ${STATE_LABEL[k]}`)
        .join(", ")} ${plural(cmp.groups.length, "issue group")}.</p>${cmp.warnings.map((w) => `<p class="warn">${esc(w)}</p>`).join("")}`
    : `<p>This is the first analysed audit of this site: there is no earlier audit to compare with.</p>`;
  return `<section class="page">
  <h2>Executive summary</h2>
  <div class="score ${h?.partialCoverage ? "partial" : ""}">
    <div class="num">${m("health.score", h?.score ?? null)}</div>
    <div>
      <p><strong>Health score</strong> out of 100, over the ${m("rulesRan", d.overview.rulesRan)} checks that ran in ${Object.keys(h?.categories ?? {}).length} categories, weighted by category.</p>
      ${h?.partialCoverage ? `<p class="warn">Partial coverage: fewer than ${PARTIAL_COVERAGE_BELOW}% of the discovered URLs were inspected, so the score describes only part of the site.</p>` : ""}
    </div>
  </div>
  <p><strong>Coverage.</strong> ${coverageSentence(d)}.</p>
  <p><strong>Issues.</strong> ${m("issueGroups", d.overview.issueGroups)} issue groups: ${(["critical", "high", "medium", "low", "info"] as const).map((p) => `${m(`priority.${p}`, d.overview.priorities[p])} ${p}`).join(", ")}.
    ${m("states.resolved", d.overview.states.resolved)} findings resolved${d.overview.verifiedResolved ? `, ${m("verifiedResolved", d.overview.verifiedResolved)} of them confirmed by a fix verification` : ""}.</p>
  <h3>Top priorities</h3>
  ${
    top.length
      ? `<ol class="top">${top.map((g) => `<li><strong>${esc(g.title)}</strong> on ${m(`group.${g.ruleId}.affected`, g.affectedUrls)} ${plural(g.affectedUrls, "URL")} (${esc(g.priority)} priority). ${esc(g.why)}</li>`).join("")}</ol>`
      : "<p>No issue was found by the checks that ran.</p>"
  }
  <h3>Change since the last audit</h3>
  ${changes}
</section>`;
}

function limitations(d: ReportData) {
  const c = d.overview.coverage;
  const notRan = d.ruleRuns.filter((r) => r.status !== "ran");
  const res = d.crawl.resources as { external?: { found: number; planned: number; overBudget: number; budget: number }; images?: { found: number; planned: number; overBudget: number; budget: number } } | null;
  const robots = d.crawl.robots;
  return `<section class="page">
  <h2>Coverage and limitations</h2>
  <table><thead><tr><th>URL state</th><th class="n">URLs</th></tr></thead><tbody>
    ${Object.entries(c.states)
      .sort((a, b) => b[1] - a[1])
      .map(([s, n]) => `<tr><td>${esc(COVERAGE_LABEL[s] ?? s)}</td><td class="n">${m(`coverage.state.${s}`, n)}</td></tr>`)
      .join("")}
    <tr class="total"><td>Discovered</td><td class="n">${m("coverage.total", c.total)}</td></tr>
  </tbody></table>
  <ul>
    <li>Crawl status: ${esc(d.overview.status)}; ${m("crawl.fetchesCommitted", d.crawl.fetchesCommitted)} fetches${d.crawl.budget !== null ? ` of a ${esc(d.crawl.budget)}-fetch budget` : ""}${d.crawl.maxDepth !== null ? `; links followed to depth ${esc(d.crawl.maxDepth)}` : ""}.</li>
    <li>robots.txt: ${robots ? `${esc(robots.outcome ?? "not read")}${robots.status ? ` (HTTP ${esc(robots.status)})` : ""}${robots.reason ? `: ${esc(robots.reason)}` : ""}` : "not read"}.</li>
    ${res?.external ? `<li>External links: ${m("resources.external.planned", res.external.planned)} of ${m("resources.external.found", res.external.found)} checked (budget ${esc(res.external.budget)}).</li>` : ""}
    ${res?.images ? `<li>Images: ${m("resources.images.planned", res.images.planned)} of ${m("resources.images.found", res.images.found)} checked (budget ${esc(res.images.budget)}).</li>` : ""}
    <li>${m("rulesRan", d.overview.rulesRan)} checks ran; ${m("rulesNotRan", notRan.length)} did not.</li>
  </ul>
  ${
    notRan.length
      ? `<h3>Checks that did not run</h3><table><thead><tr><th>Check</th><th>Why</th></tr></thead><tbody>${notRan
          .map((r) => `<tr><td>${esc(r.ruleId)} ${esc(r.title)}</td><td>${esc(r.status === "needs_config" ? "Needs configuration" : "Error")}${r.detail ? `: ${esc(r.detail)}` : ""}</td></tr>`)
          .join("")}</tbody></table>`
      : ""
  }
  <p class="note">Finding states on this page include fixes confirmed by a fix verification; the comparison with the last audit compares the two full audits only.</p>
</section>`;
}

function evidenceBlock(g: ReportGroup) {
  if (!g.evidence.length) return "";
  return `<h4>Evidence</h4>${g.evidence
    .map((e) => {
      const json = JSON.stringify(e.evidence);
      return `<div class="ev"><p>${link(e.url)}${e.outcome === "inconclusive" ? " <em>(inconclusive)</em>" : ""}</p><p>${esc(e.message)}</p>${json !== "{}" ? `<pre>${esc(json.length > 600 ? `${json.slice(0, 600)}…` : json)}</pre>` : ""}</div>`;
    })
    .join("")}`;
}

function groupPage(g: ReportGroup) {
  const states = Object.entries(g.states)
    .filter(([, n]) => n)
    .map(([s, n]) => `${m(`group.${g.ruleId}.state.${s}`, n!)} ${esc(STATE_LABEL[s] ?? s)}`)
    .join(", ");
  return `<section class="page group" id="g-${esc(g.ruleId)}">
  <p class="eyebrow">${esc(g.priority)} priority · ${esc(g.category.replace("_", " "))} · ${esc(g.ruleId)}</p>
  <h3>${esc(g.title)}</h3>
  <p class="facts">${m(`group.${g.ruleId}.affected`, g.affectedUrls)} affected ${plural(g.affectedUrls, "URL")}${g.inconclusiveUrls ? `, ${m(`group.${g.ruleId}.inconclusive`, g.inconclusiveUrls)} inconclusive` : ""} across ${m(`group.${g.ruleId}.templates`, g.templateCount)} ${plural(g.templateCount, "template")}. States: ${states || "none"}.</p>
  <p class="facts">Priority ${m(`group.${g.ruleId}.score`, g.score)} = impact ${esc(g.impact)} × reach ${esc(g.reach)} (${esc(g.affectedPages)} of ${esc(g.indexablePages)} indexable pages) × confidence ${esc(g.confidenceWeight)} (${esc(g.confidence)}).</p>
  <h4>Why it matters</h4><p>${esc(g.why)}</p>
  <h4>Fix</h4><p>${esc(g.fix)}</p>
  <h4>Done when</h4><p>${esc(g.acceptance)}</p>
  ${g.docs ? `<p>Reference: ${link(g.docs)}</p>` : ""}
  <h4>Sample URLs</h4><ul class="urls">${g.sampleUrls.map((u) => `<li>${link(u)}</li>`).join("")}</ul>
  ${g.templates.length > 1 ? `<h4>By template</h4><table><tbody>${g.templates.map((t) => `<tr><td>${esc(t.templateId)}</td><td class="n">${esc(t.affectedUrls)}</td></tr>`).join("")}</tbody></table>` : ""}
  ${evidenceBlock(g)}
  ${g.verifiable ? "<p class=\"note\">A fix verification can re-check this group's URLs without a full audit.</p>" : ""}
</section>`;
}

function categories(d: ReportData) {
  const h = d.overview.health;
  const cats = [...Object.keys(CATEGORY_WEIGHTS), ...UNWEIGHTED_CATEGORIES].filter((c) => h?.categories[c as keyof typeof CATEGORY_WEIGHTS] || d.groups.some((g) => g.category === c));
  const maxDepthUrls = Math.max(1, ...d.depth.map((x) => x.urls));
  const clusters = d.duplicates.slice(0, 20);
  return `<section class="page">
  <h2>Categories</h2>
  ${cats
    .map((c) => {
      const ch = h?.categories[c as keyof typeof CATEGORY_WEIGHTS];
      const gs = d.groups.filter((g) => g.category === c);
      return `<h3>${esc(c.replace("_", " "))}</h3>
      <p>${ch ? `Score ${m(`health.category.${c}`, ch.score)} (weight ${esc(ch.weight)}, ${esc(ch.rulesRan)} checks ran).` : (UNWEIGHTED_CATEGORIES as readonly string[]).includes(c) ? "Not part of the health score: no weight is published for this category." : "No check of this category ran."}</p>
      ${gs.length ? `<table><thead><tr><th>Issue</th><th>Priority</th><th class="n">URLs</th></tr></thead><tbody>${gs.map((g) => `<tr><td>${esc(g.title)}</td><td>${esc(g.priority)}</td><td class="n">${m(`group.${g.ruleId}.affected`, g.affectedUrls)}</td></tr>`).join("")}</tbody></table>` : "<p>No issue found.</p>"}`;
    })
    .join("")}
  <h3>Site architecture: URLs by link depth</h3>
  <table class="bars"><tbody>${d.depth
    .map((x) => `<tr><td>${x.depth === null ? "sitemap only" : `depth ${esc(x.depth)}`}</td><td class="n">${m(`depth.${x.depth ?? "sitemap"}`, x.urls)}</td><td class="bar"><span style="width:${Math.round((100 * x.urls) / maxDepthUrls)}%"></span></td></tr>`)
    .join("")}</tbody></table>
  <h3>Duplication clusters</h3>
  ${
    clusters.length
      ? `<p>${m("duplicates.clusters", d.duplicates.length)} clusters${d.duplicates.length > clusters.length ? `; the ${clusters.length} largest are listed` : ""}.</p>${clusters
          .map((x) => `<div class="cluster"><p><strong>${esc(x.ruleId)}</strong> · ${x.urls.length} pages · ${esc(x.key.length > 120 ? `${x.key.slice(0, 120)}…` : x.key)}</p><ul class="urls">${x.urls.slice(0, 10).map((u) => `<li>${link(u)}</li>`).join("")}${x.urls.length > 10 ? `<li>and ${x.urls.length - 10} more</li>` : ""}</ul></div>`)
          .join("")}`
      : "<p>No duplicate titles, descriptions or content were found.</p>"
  }
</section>`;
}

const GLOSSARY: [string, string][] = [
  ["Issue group", "Every finding of one check in the audit, split by page template."],
  ["Priority", "Impact (1–5) × reach × confidence weight. Reach is the share of indexable pages affected, log-scaled to 0.1–1."],
  ["Coverage", "Discovered URLs answered (fetched, redirected, not HTML or over the size limit) over discovered URLs the crawl was allowed to fetch."],
  ["Health score", "0–100 per category over the checks that ran, then weighted by category. A score under partial coverage describes only the inspected part."],
  ["New / persistent / regressed", "Found for the first time / also open in the previous audit / found again after it was resolved."],
  ["Resolved", "Open before, and re-checked by this audit (or a fix verification) without the issue. A URL that was not re-checked is never resolved."],
  ["Not re-checked", "Open before, but this audit could not re-check it (not fetched, blocked, or the check did not run)."],
  ["Inconclusive", "The check could not decide (for example its probe was blocked); it neither opens nor resolves a finding."],
];

function appendix(d: ReportData, o: RenderOptions) {
  return `<section class="page">
  <h2>Appendix</h2>
  <h3>Affected URLs</h3>
  ${d.groups
    .map(
      (g) => `<h4>${esc(g.ruleId)} ${esc(g.title)} (${m(`group.${g.ruleId}.affected`, g.affectedUrls)})</h4>
      <ul class="urls">${g.urls.map((u) => `<li>${link(u.url)} <em>${esc(STATE_LABEL[u.state] ?? u.state)}</em></li>`).join("")}</ul>
      ${g.affectedUrls > INLINE_URLS ? `<p>The first ${INLINE_URLS} are listed. Full list: <a href="${esc(o.csvHref(g.ruleId))}">CSV, ${esc(g.affectedUrls)} rows</a>.</p>` : ""}`,
    )
    .join("")}
  <h3>Check versions</h3>
  <table><thead><tr><th>Check</th><th>Version</th><th>Status</th><th class="n">Evaluated</th><th class="n">Findings</th></tr></thead><tbody>
  ${d.ruleRuns.map((r) => `<tr><td>${esc(r.ruleId)} ${esc(r.title)}</td><td>${esc(r.version)}</td><td>${esc(r.status)}</td><td class="n">${esc(r.evaluated)}</td><td class="n">${esc(r.findings)}</td></tr>`).join("")}
  </tbody></table>
  <h3>Glossary</h3>
  <dl class="glossary">${GLOSSARY.map(([t, x]) => `<dt>${esc(t)}</dt><dd>${esc(x)}</dd>`).join("")}</dl>
</section>`;
}

export function renderReport(d: ReportData, o: RenderOptions): string {
  const b = d.branding;
  const color = b.brandColor && BRAND_COLOR.test(b.brandColor) ? b.brandColor : DEFAULT_COLOR;
  const host = new URL(d.overview.siteOrigin).host;
  const priority = d.groups.filter((g) => g.priority !== "info").slice(0, PRIORITY_PAGES);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>SEO audit: ${esc(host)} (${fmtDate(d.overview.createdAt)})</title>
<style>
  :root { --brand: ${color}; --ink: #1a1a1a; --muted: #5c6370; --line: #d9dde3; --warn: #8a4b00; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #fff; color: var(--ink); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 0 16px 48px; }
  h1, h2, h3 { line-height: 1.2; }
  h2 { color: var(--brand); border-bottom: 2px solid var(--brand); padding-bottom: 4px; margin-top: 40px; }
  h4 { margin: 16px 0 4px; }
  a { color: var(--brand); word-break: break-all; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0 16px; }
  th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .n { text-align: right; font-variant-numeric: tabular-nums; }
  tr.total td { font-weight: 600; }
  .cover { min-height: 90vh; display: flex; flex-direction: column; justify-content: center; border-left: 8px solid var(--brand); padding-left: 24px; }
  .cover h1 { font-size: 40px; margin: 8px 0; }
  .cover .domain { font-size: 24px; color: var(--brand); margin: 0 0 24px; }
  .cover .agency { color: var(--muted); margin: 0; }
  .cover .logo { max-width: 220px; max-height: 90px; margin-bottom: 16px; }
  .cover dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; }
  .cover dt { color: var(--muted); }
  .cover dd { margin: 0; }
  .score { display: flex; gap: 16px; align-items: center; border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; }
  .score .num { font-size: 44px; font-weight: 700; color: var(--brand); min-width: 96px; text-align: center; }
  .score.partial .num { color: var(--muted); }
  .warn { color: var(--warn); }
  .note { color: var(--muted); font-size: 12px; }
  .eyebrow { text-transform: uppercase; letter-spacing: .04em; font-size: 11px; color: var(--muted); margin: 32px 0 0; }
  .facts { color: var(--muted); }
  .urls { padding-left: 18px; }
  .urls li { word-break: break-all; }
  .ev { border-left: 3px solid var(--line); padding-left: 8px; margin: 8px 0; }
  .ev p { margin: 2px 0; }
  pre { white-space: pre-wrap; word-break: break-all; background: #f5f6f8; padding: 6px; font-size: 12px; }
  .bars .bar { width: 50%; }
  .bars .bar span { display: block; height: 10px; background: var(--brand); }
  .glossary dt { font-weight: 600; margin-top: 8px; }
  .glossary dd { margin: 0; }
  header.brand { display: flex; justify-content: space-between; color: var(--muted); font-size: 12px; border-bottom: 1px solid var(--line); padding: 8px 0; }
  @media print {
    @page { size: A4; margin: 16mm 14mm; }
    main { max-width: none; padding: 0; }
    .page { break-before: page; }
    .group h3 { break-after: avoid; }
    a { color: inherit; text-decoration: none; }
  }
</style>
</head>
<body>
<main>
<header class="brand"><span>${esc(b.agencyName ?? "")}</span><span>${esc(host)} · ${fmtDate(d.overview.createdAt)}</span></header>
${cover(d, b)}
${summary(d)}
${limitations(d)}
<section class="page"><h2>Priority issues</h2><p>${priority.length ? `${m("priorityPages", priority.length)} issue groups above info priority, highest priority first${d.groups.filter((g) => g.priority !== "info").length > priority.length ? `; the rest are listed by category` : ""}.` : "No issue group above info priority."}</p></section>
${priority.map(groupPage).join("\n")}
${categories(d)}
${appendix(d, o)}
</main>
</body>
</html>`;
}

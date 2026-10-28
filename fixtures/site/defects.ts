// Phase 2a defects on the fixture site, as data: which page carries which defect, how it changes the page, and the
// findings it must produce. The expectations are declared here by hand (cascades included, e.g. a canonicalised
// sitemap URL is also IDX-029); they are not computed from rule code, so the gate compares two independent things.
import { NOINDEX_COUNT, noindexPaths, REDIRECTS, SECTIONS, sectionPaths, type RedirectSpec } from "./definition";
import { cleanParts, OG_IMAGE, type Parts } from "./pages";
import { paragraph, topic } from "./text";

export type RuleId = string;

export interface Defect {
  name: string;
  expect: RuleId[];
  apply(p: Parts, ctx: { path: string; origin: string }): void;
}

/** English prose for the META-012 mismatch page: real sentences, so the detector is confident it is English
 * (tinyld accuracy 1.0 on this text; an earlier, more descriptive draft scored 0.897, under the 0.9 bar). */
export const ENGLISH_PROSE = `It was the end of the summer, and the town was quiet again. Most of the visitors had gone home, and the shops on
the main street were getting ready for the long winter. In the evening the old men sat outside the cafe and talked about the
weather, the price of bread and the football results. Their wives walked along the harbour and looked at the boats that
were still in the water. Some of them would be taken out of the sea next week and painted before the spring. The children
were back at school, and the teachers were happy to see them, even if the first days were always difficult. Nobody in the
town was in a hurry. There was time to read a book, to write a letter to a friend, or to walk up the hill behind the
church and watch the sun go down over the islands. When it was dark the lights came on in the houses, one after another,
and the smell of cooking drifted down the narrow streets. It was the kind of place where people knew each other by name,
where doors were not locked at night, and where a stranger was noticed as soon as they stepped off the bus. Later in the
year the storms would come, but for now the sea was calm and the sky was clear, and everyone was glad of it.`.replace(/\s+/g, " ");

const LONG_TITLE_TAIL = "with a very long list of additional words that keeps going well past the point where results cut it off";

// ---------- /meta/ ----------

const META: Defect[] = [
  { name: "no title", expect: ["META-001"], apply: (p) => void (p.title = "") },
  { name: "empty title", expect: ["META-002"], apply: (p) => void (p.title = "<title></title>") },
  { name: "two titles", expect: ["META-003"], apply: (p, c) => void (p.head += `<title>Second title for ${c.path}</title>`) },
  { name: "duplicate title A", expect: ["META-004"], apply: (p, c) => dupTitle(p, c.path) },
  { name: "duplicate title B", expect: ["META-004"], apply: (p, c) => dupTitle(p, c.path) },
  { name: "long title", expect: ["META-005"], apply: (p, c) => void (p.title = `<title>${topic(c.path)} ${LONG_TITLE_TAIL} | ${c.path}</title>`) },
  { name: "short title", expect: ["META-006"], apply: (p, c) => ((p.title = "<title>Short page</title>"), (p.h1 = `<h1>${topic(c.path)} short page</h1>`)) },
  { name: "title equals H1 (template 1/3)", expect: ["META-007"], apply: (p, c) => titleIsH1(p, c.path) },
  { name: "title equals H1 (template 2/3)", expect: ["META-007"], apply: (p, c) => titleIsH1(p, c.path) },
  { name: "title equals H1 (template 3/3)", expect: ["META-007"], apply: (p, c) => titleIsH1(p, c.path) },
  { name: "no description", expect: ["META-008"], apply: (p) => void (p.description = "") },
  { name: "empty description", expect: ["META-008"], apply: (p) => void (p.description = '<meta name="description" content="">') },
  { name: "duplicate description A", expect: ["META-009"], apply: (p) => dupDescription(p) },
  { name: "duplicate description B", expect: ["META-009"], apply: (p) => dupDescription(p) },
  { name: "short description", expect: ["META-010"], apply: (p) => void (p.description = '<meta name="description" content="A short description.">') },
  {
    name: "long description",
    expect: ["META-010"],
    apply: (p, c) => void (p.description = `<meta name="description" content="${paragraph(`longdesc:${c.path}`, 60).replace(/"/g, "")}">`),
  },
  { name: "no lang", expect: ["META-011"], apply: (p) => void (p.lang = "") },
  { name: "invalid lang", expect: ["META-012"], apply: (p) => void (p.lang = ' lang="english"') },
  { name: "lang mismatch", expect: ["META-012"], apply: (p) => ((p.lang = ' lang="fr"'), (p.text = `<p>${ENGLISH_PROSE}</p>`)) },
  { name: "no viewport", expect: ["META-013"], apply: (p) => void (p.viewport = "") },
  { name: "viewport blocks zoom", expect: ["META-014"], apply: (p) => void (p.viewport = '<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">') },
  { name: "no charset", expect: ["META-015"], apply: (p) => ((p.charset = ""), (p.type = "text/html")) },
  {
    name: "late charset",
    expect: ["META-015"],
    apply: (p) => ((p.charset = ""), (p.type = "text/html"), (p.head += `<!-- ${"padding ".repeat(150)}--><meta charset="utf-8">`)),
  },
  { name: "no og:url", expect: ["META-016"], apply: (p) => void (p.og = p.og.replace(/<meta property="og:url"[^>]*>/, "")) },
  { name: "small og:image", expect: ["META-017"], apply: (p) => void (p.og = p.og.replace(OG_IMAGE, "/assets/og-small.png")) },
  { name: "missing og:image", expect: ["META-017"], apply: (p) => void (p.og = p.og.replace(OG_IMAGE, "/assets/og-missing.png")) },
  { name: "no twitter:card", expect: ["META-018"], apply: (p) => void (p.twitter = "") },
];

function dupTitle(p: Parts, path: string) {
  p.title = "<title>Shared title of two fixture pages</title>";
  p.h1 = `<h1>${topic(path)} shared title</h1>`;
}
function dupDescription(p: Parts) {
  p.description = '<meta name="description" content="One description shared by two fixture pages, which is a duplicate on purpose here.">';
}
function titleIsH1(p: Parts, path: string) {
  p.title = `<title>${topic(path)} template page</title>`;
  p.h1 = `<h1>${topic(path)} template page</h1>`;
  p.wrap = ['<article class="tpl"><section>', "</section></article>"]; // a template of its own (3 pages)
}

// ---------- /index/ ----------

/** Extra /index/ URLs linked from the /index/ index page; not in the manifest or any sitemap. */
export interface Extra {
  path: string;
  expect: RuleId[];
  status: number;
  /** Self-canonical clean page unless set. */
  apply?(p: Parts, ctx: { path: string; origin: string }): void;
}
export const INDEX_EXTRAS: Extra[] = [
  { path: "/index/gone-1", status: 404, expect: ["IDX-001"] },
  { path: "/index/gone-2", status: 404, expect: ["IDX-001"] },
  { path: "/index/error-1", status: 500, expect: ["IDX-002"] },
  // Both forms 200 with their own content: duplicates by URL shape, and indexable pages missing from the sitemap.
  { path: "/index/slash-a/", status: 200, expect: ["IDX-022", "IDX-032"] },
  { path: "/index/slash-a", status: 200, expect: ["IDX-022", "IDX-032"] },
  { path: "/index/case-a", status: 200, expect: ["IDX-032"] },
  { path: "/index/CASE-A", status: 200, expect: ["IDX-023", "IDX-032"] },
  { path: "/index/param?sort=asc", status: 200, expect: ["IDX-024", "IDX-011", "IDX-032"], apply: (p) => void (p.canonical = "") },
];

/** Path of a noindexed /index/ page, used as a canonical target. */
const firstNoindex = () => sectionPaths(SECTIONS.find((s) => s.path === "/index/")!).slice(-NOINDEX_COUNT)[0];

const INDEX: Defect[] = [
  {
    name: "meta nofollow vs header follow",
    expect: ["IDX-010"],
    apply: (p) => ((p.head += '<meta name="robots" content="nofollow">'), (p.headers["x-robots-tag"] = "follow")),
  },
  { name: "no canonical", expect: ["IDX-011"], apply: (p) => void (p.canonical = "") },
  { name: "canonical to a 404", expect: ["IDX-012", "IDX-029"], apply: (p, c) => void (p.canonical = `<link rel="canonical" href="${c.origin}/index/gone-1">`) },
  { name: "canonical chain start", expect: ["IDX-013", "IDX-029"], apply: (p, c) => void (p.canonical = `<link rel="canonical" href="${c.origin}${nextIndexPage(c.path)}">`) },
  { name: "canonical chain middle", expect: ["IDX-029"], apply: (p, c) => void (p.canonical = `<link rel="canonical" href="${c.origin}${nextIndexPage(c.path)}">`) },
  { name: "canonical chain end (self-canonical)", expect: [], apply: () => {} },
  { name: "canonical to a noindexed page", expect: ["IDX-014", "IDX-029"], apply: (p, c) => void (p.canonical = `<link rel="canonical" href="${c.origin}${firstNoindex()}">`) },
  { name: "two canonicals", expect: ["IDX-015"], apply: (p, c) => void (p.canonical += `<link rel="canonical" href="${c.origin}/index/">`) },
  {
    name: "canonical in body",
    expect: ["IDX-016"],
    apply: (p, c) => ((p.body += `<link rel="canonical" href="${c.origin}${c.path}">`), (p.canonical = "")),
  },
  { name: "relative canonical", expect: ["IDX-017"], apply: (p, c) => void (p.canonical = `<link rel="canonical" href="${c.path}">`) },
  {
    name: "soft 404",
    expect: ["IDX-019", "CNT-011"],
    apply: (p, c) => ((p.title = `<title>Page not found | ${c.path}</title>`), (p.h1 = "<h1>Page not found</h1>")),
  },
  { name: "stylesheet blocked by robots.txt", expect: ["IDX-026"], apply: (p) => void (p.head += '<link rel="stylesheet" href="/assets/private/site.css">') },
];

const nextIndexPage = (path: string) => `/index/p-${Number(path.slice("/index/p-".length)) + 1}`;

// ---------- /content/ ----------

const BOILERPLATE_FOOTER = (path: string) => `<footer><p>${paragraph(`footer:${path}`, 1300)}</p></footer>`;
/** Same main text as `paragraph(key)` with two words changed: a near duplicate. */
function nearDuplicate(key: string): string {
  const words = paragraph(key).split(" ");
  words[40] = "orchard";
  words[120] = "lantern";
  return words.join(" ");
}

/** Same main content (H1 and text, which the text hash covers); title and description stay unique. */
function exactDuplicate(p: Parts, path: string) {
  const t = topic("content:duplicate");
  p.title = `<title>${t} | ${path}</title>`;
  p.h1 = `<h1>${t}</h1>`;
  p.text = `<p>${paragraph("content:duplicate")}</p>`;
}

const CONTENT: Defect[] = [
  { name: "no H1", expect: ["CNT-001"], apply: (p) => void (p.h1 = "") },
  { name: "two H1s", expect: ["CNT-002"], apply: (p, c) => void (p.h1 += `<h1>${topic(c.path)} again</h1>`) },
  { name: "empty heading", expect: ["CNT-003"], apply: (p) => void (p.body += "<h2></h2><p>More notes.</p>") },
  { name: "skipped heading level", expect: ["CNT-004"], apply: (p) => void (p.body += "<h3>Details</h3><p>More notes.</p>") },
  { name: "thin content", expect: ["CNT-005"], apply: (p, c) => void (p.text = `<p>${paragraph(c.path, 80)}</p>`) },
  { name: "exact duplicate A", expect: ["CNT-006"], apply: (p, c) => exactDuplicate(p, c.path) },
  { name: "exact duplicate B", expect: ["CNT-006"], apply: (p, c) => exactDuplicate(p, c.path) },
  { name: "near duplicate A", expect: ["CNT-007"], apply: (p) => void (p.text = `<p>${paragraph("content:near")}</p>`) },
  { name: "near duplicate B", expect: ["CNT-007"], apply: (p) => void (p.text = `<p>${nearDuplicate("content:near")}</p>`) },
  { name: "boilerplate over 80%", expect: ["CNT-008"], apply: (p, c) => void (p.footer = BOILERPLATE_FOOTER(c.path)) },
  { name: "title and H1 share no terms", expect: ["CNT-009"], apply: (p, c) => void (p.h1 = `<h1>${topic(`other:${c.path}`)}</h1>`) },
  { name: "lorem ipsum", expect: ["CNT-010"], apply: (p, c) => void (p.text = `<p>Lorem ipsum dolor sit amet. ${paragraph(c.path)}</p>`) },
  { name: "not-found text on a 200 page", expect: ["CNT-011"], apply: (p, c) => void (p.text = `<p>Error 404: this item is gone. ${paragraph(c.path)}</p>`) },
  { name: "low text-to-HTML ratio", expect: ["CNT-012"], apply: (p) => void (p.head += `<script>${"var fixtureFiller = 0;\n".repeat(1600)}</script>`) },
];

/** Page path → defect. Defects take the first pages of their section (p-1, p-2…); the rest stay clean. */
export const DEFECTS: Record<string, Defect> = (() => {
  const out: Record<string, Defect> = {};
  for (const [section, list] of [["/meta/", META], ["/index/", INDEX], ["/content/", CONTENT]] as const) {
    list.forEach((d, i) => (out[`${section}p-${i + 1}`] = d));
  }
  return out;
})();

export const DEFECT_COUNTS = { meta: META.length, index: INDEX.length, content: CONTENT.length };

/** The noindexed /index/ pages (Phase 1): header noindex on every third, meta noindex on the rest. */
export function noindexKind(path: string): "header" | "meta" {
  const paths = sectionPaths(SECTIONS.find((s) => s.path === "/index/")!);
  return paths.indexOf(path) % 3 === 0 ? "header" : "meta";
}

/** Findings each /redirects/ URL must produce, from the redirect table. */
export function redirectExpectations(): Record<string, RuleId[]> {
  const out: Record<string, RuleId[]> = { "/redirects/": [] };
  const hopsFrom = (path: string): { hops: number; loop: boolean } => {
    const seen = new Set<string>();
    let at: string | undefined = path;
    let hops = 0;
    while (at && REDIRECTS[at] && "status" in REDIRECTS[at]) {
      if (seen.has(at)) return { hops, loop: true };
      seen.add(at);
      hops++;
      at = (REDIRECTS[at] as { to: string }).to;
    }
    return { hops, loop: false };
  };
  for (const [path, spec] of Object.entries(REDIRECTS) as [string, RedirectSpec][]) {
    if (!("status" in spec)) {
      out[path] = ["IDX-006"]; // meta refresh or JavaScript redirect on a 200 page
      continue;
    }
    const w = hopsFrom(path);
    const e: RuleId[] = ["IDX-028"]; // every redirect URL is listed in the sitemap
    if (w.loop) e.push("IDX-004");
    else if (w.hops >= 3) e.push("IDX-003");
    if (!w.loop && (spec.status === 302 || spec.status === 307)) e.push("IDX-005");
    out[path] = e;
  }
  return out;
}

export function applyDefect(path: string, origin: string, body: string): Parts {
  const p = cleanParts(path, origin, body);
  DEFECTS[path]?.apply(p, { path, origin });
  return p;
}

/** Sections whose findings the gate compares exactly (every other section is presence-checked only). */
export const EXACT_SECTIONS = ["/clean/", "/meta/", "/index/", "/redirects/", "/content/"] as const;

/**
 * Every finding the fixture site's main host must produce on the pages of EXACT_SECTIONS, the home page and the
 * /index/ extras, by path (with query). An empty list means the page must be silent.
 */
/** How the manifest names a finding: the rule id for an issue, `RULE:inconclusive` for an inconclusive one. */
export const findingKey = (ruleId: string, outcome: string) => (outcome === "issue" ? ruleId : `${ruleId}:${outcome}`);

export function expectedFindings(): Map<string, RuleId[]> {
  const out = new Map<string, RuleId[]>([["/", []]]);
  const noindex = new Set(noindexPaths());
  for (const s of SECTIONS.filter((x) => (EXACT_SECTIONS as readonly string[]).includes(x.path))) {
    if (s.path === "/redirects/") continue;
    for (const path of sectionPaths(s)) {
      if (noindex.has(path)) out.set(path, [noindexKind(path) === "header" ? "IDX-009" : "IDX-008", "IDX-029"]);
      else out.set(path, [...(DEFECTS[path]?.expect ?? [])]);
    }
  }
  for (const [path, e] of Object.entries(redirectExpectations())) out.set(path, e);
  for (const x of INDEX_EXTRAS) out.set(x.path, [...x.expect]);
  return out;
}

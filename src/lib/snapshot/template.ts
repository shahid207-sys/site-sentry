// Template detection. A page's shape is the set of element paths from <body> down a fixed depth, built from structural
// tags and stable landmarks only, so text, list lengths, inline styles, ids and build-generated class names do not
// split one template into many. The site pass then clusters shapes: identical shapes form one template, and a shape
// joins an existing template when most of its paths are shared (Jaccard). The URL pattern (/blog/*, /services/*/*)
// only breaks ties near the threshold; it never joins two layouts on its own.
//
// example-client.ae (Phase 2 validation) showed what splits real templates: wrapper <div>s that one page has and its
// sibling does not, and optional blocks inside an otherwise identical layout.
import { createHash } from "node:crypto";
import type { CheerioAPI } from "cheerio";

/** Element levels below <body> that count (transparent wrappers do not use a level). */
export const SHAPE_DEPTH = 6;
/** Jaccard similarity at which a shape joins an existing template. */
export const JOIN_SIMILARITY = 0.9;
/** Lower bar when the shape's URL pattern equals the template's (the URL-pattern tiebreaker). */
export const JOIN_SIMILARITY_SAME_PATTERN = 0.8;

const SKIP = new Set(["script", "style", "noscript", "template", "link", "meta", "br", "wbr", "base"]);
/** Leaves: their inside is not part of the layout. */
const LEAF = new Set(["svg", "iframe", "picture", "video", "audio", "canvas", "select", "math", "object"]);
/** Elements that are only wrappers unless they carry a landmark. */
const WRAPPER = new Set(["div", "span"]);

// Utility-class vocabularies (Tailwind, Bootstrap and similar) describe styling, not layout roles. A class counts as
// a landmark only when it is a plain lower-case name ("site-header", "product", "gallery"): no digits, no variant
// prefixes (md:, hover:), no brackets or slashes, not a utility. CSS-module and styled-jsx names (Header_nav__3xYz1,
// jsx-123456, __className_a1b2c3) fail the plain-name test.
const UTILITY_WORDS = new Set(
  "flex grid block inline hidden contents table container relative absolute fixed sticky static visible invisible isolate grow shrink truncate underline uppercase lowercase capitalize italic antialiased transform transition filter blur shadow rounded border outline ring prose group peer row col btn clearfix active disabled show fade collapse collapsed open closed dark light sr-only not-sr-only".split(
    " ",
  ),
);
const UTILITY_PREFIXES =
  "text- bg- border- rounded- shadow- font- leading- tracking- items- justify- content- self- place- gap- space- divide- overflow- object- inset- top- left- right- bottom- z- w- h- min- max- p- px- py- pt- pb- pl- pr- ps- pe- m- mx- my- mt- mb- ml- mr- ms- me- opacity- transition- duration- delay- ease- animate- translate- scale- rotate- skew- origin- cursor- select- pointer- col- row- order- basis- grow- shrink- aspect- backdrop- from- via- to- fill- stroke- list- decoration- line- whitespace- break- align- outline- ring- size- columns- float- clear- mix- drop- will- appearance- resize- scroll- snap- touch- accent- caret- box- flex- grid- auto- d- g- is- has- js- u- inline- lucide fa- fa icon bi- material- glyphicon".split(
    " ",
  );

export function landmarkClasses(cls: string | undefined): string[] {
  const out: string[] = [];
  for (const t of (cls ?? "").split(/\s+/)) {
    if (!/^[a-z][a-z_-]{2,39}$/.test(t) || /[-_]$/.test(t) || t.includes("--")) continue;
    if (UTILITY_WORDS.has(t) || UTILITY_PREFIXES.some((p) => t.startsWith(p))) continue;
    out.push(t);
  }
  return out.sort().slice(0, 2);
}

type Node = { tagName?: string; attribs?: Record<string, string> };

function label(el: Node): { label: string; landmark: boolean } {
  const tag = el.tagName!.toLowerCase();
  // An icon's or embed's classes name its picture (lucide-house), not a layout role.
  if (LEAF.has(tag)) return { label: tag, landmark: false };
  const role = (el.attribs?.role ?? "").trim().toLowerCase();
  const cls = landmarkClasses(el.attribs?.class);
  const extra = [role && /^[a-z]+$/.test(role) ? `[${role}]` : "", cls.length ? `.${cls.join(".")}` : ""].join("");
  return { label: `${tag}${extra}`, landmark: !!extra };
}

/** The page's shape: sorted, de-duplicated element paths (repeated siblings such as list items collapse to one). */
export function templatePaths($: CheerioAPI): string[] | null {
  const body = $("body").get(0);
  if (!body) return null;
  const paths = new Set<string>();
  const elements = (el: unknown) => ($(el as never).children().toArray() as Node[]).filter((c) => c.tagName && !SKIP.has(c.tagName.toLowerCase()));
  const hasText = (el: unknown) => ($(el as never).contents().toArray() as { type?: string; data?: string }[]).some((n) => n.type === "text" && (n.data ?? "").trim());
  const walk = (el: unknown, path: string, depth: number) => {
    for (const child of elements(el)) {
      const { label: l, landmark } = label(child);
      const tag = child.tagName!.toLowerCase();
      // A bare wrapper around a single element adds nothing to the layout: look through it at the same level.
      if (WRAPPER.has(tag) && !landmark && elements(child).length === 1 && !hasText(child)) {
        walk(child, path, depth);
        continue;
      }
      const p = `${path}>${l}`;
      paths.add(p);
      if (depth < SHAPE_DEPTH && !LEAF.has(tag)) walk(child, p, depth + 1);
    }
  };
  walk(body, "body", 1);
  return [...paths].sort();
}

const hash32 = (s: string) => createHash("sha256").update(s).digest().readUInt32BE(0);

/** Exact fingerprint of a shape, and the compact form stored for clustering (one 32-bit hash per path). */
export function templateShape($: CheerioAPI): { fingerprint: string; shape: number[] } | null {
  const paths = templatePaths($);
  if (!paths) return null;
  return {
    fingerprint: createHash("sha256").update(paths.join("\n")).digest("hex").slice(0, 16),
    shape: [...new Set(paths.map(hash32))].sort((a, b) => a - b),
  };
}

/**
 * The URL pattern a CMS route would use: the first path segment kept, deeper segments as "*", and a trailing slash
 * ignored. /blog/how-to-x → /blog/*, /services/web/dubai → /services/*\/*, / → /.
 */
export function urlPattern(url: string): string {
  const segs = new URL(url).pathname.split("/").filter(Boolean);
  if (!segs.length) return "/";
  return `/${[segs[0], ...segs.slice(1).map(() => "*")].join("/")}`;
}

/** Jaccard similarity of two sorted, de-duplicated number lists. */
export function jaccard(a: readonly number[], b: readonly number[]): number {
  let i = 0;
  let j = 0;
  let both = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      both++;
      i++;
      j++;
    } else if (a[i] < b[j]) i++;
    else j++;
  }
  const union = a.length + b.length - both;
  return union ? both / union : 1;
}

export interface ShapedPage {
  url: string;
  fingerprint: string;
  /** Absent on snapshots from before the shape was stored: such pages group by exact fingerprint only. */
  shape: number[] | null;
}

/**
 * Template id per page URL. Exact shapes group first; groups are then taken largest first (ties by fingerprint, so the
 * result does not depend on crawl order) and each joins the most similar earlier template when the similarity reaches
 * JOIN_SIMILARITY, or JOIN_SIMILARITY_SAME_PATTERN when both have the same majority URL pattern. A template's id is
 * the fingerprint of its first (largest) shape, and its shape is that one too, so templates do not drift as they grow.
 */
export function clusterTemplates(pages: Iterable<ShapedPage>): Map<string, string> {
  const groups = new Map<string, { fingerprint: string; shape: number[] | null; urls: string[] }>();
  for (const p of pages) {
    const g = groups.get(p.fingerprint) ?? { fingerprint: p.fingerprint, shape: p.shape, urls: [] };
    g.shape ??= p.shape;
    g.urls.push(p.url);
    groups.set(p.fingerprint, g);
  }
  const majority = (urls: string[]) => {
    const n = new Map<string, number>();
    for (const u of urls) n.set(urlPattern(u), (n.get(urlPattern(u)) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
  };
  const ordered = [...groups.values()].sort((a, b) => b.urls.length - a.urls.length || (a.fingerprint < b.fingerprint ? -1 : 1));
  const templates: { id: string; shape: number[]; pattern: string }[] = [];
  const out = new Map<string, string>();
  for (const g of ordered) {
    const pattern = majority(g.urls);
    let best: { id: string; score: number; same: boolean } | null = null;
    if (g.shape) {
      for (const t of templates) {
        const score = jaccard(g.shape, t.shape);
        const same = t.pattern === pattern;
        if (score < (same ? JOIN_SIMILARITY_SAME_PATTERN : JOIN_SIMILARITY)) continue;
        // Most similar wins; on equal similarity, the template with the same URL pattern.
        if (!best || score > best.score || (score === best.score && same && !best.same)) best = { id: t.id, score, same };
      }
    }
    const id = best?.id ?? g.fingerprint;
    if (!best && g.shape) templates.push({ id, shape: g.shape, pattern });
    for (const u of g.urls) out.set(u, id);
  }
  return out;
}

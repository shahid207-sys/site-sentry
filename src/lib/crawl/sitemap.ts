// XML sitemap parsing with a minimal well-formedness check. Pure.
import * as cheerio from "cheerio";

/** Legacy engine default. sitemaps.org allows 50,000 URLs per file (SITEMAP_PROTOCOL_MAX_URLS); crawler v2 uses that. */
export const MAX_SITEMAP_URLS = 5000;
export const SITEMAP_PROTOCOL_MAX_URLS = 50_000;

export interface ParsedSitemap {
  kind: "urlset" | "sitemapindex" | "unknown";
  /** Page URLs (urlset) or child sitemap URLs (sitemapindex), as written. */
  locs: string[];
  /** URLs past `maxUrls` were not read. */
  truncated: boolean;
  /** Well-formedness or structure errors; empty when the document looks valid. */
  errors: string[];
  /** <lastmod> values of the read entries (urlset only); one per entry that has one. */
  lastmods: string[];
}

/**
 * A small XML well-formedness check: balanced, properly nested tags, a single root element.
 * htmlparser2 (used by cheerio) is forgiving, so without this malformed sitemaps would parse "successfully".
 */
export function checkWellFormed(xml: string): string[] {
  const errors: string[] = [];
  const stack: string[] = [];
  let roots = 0;
  const src = xml.replace(/^﻿/, "");
  const tag = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<|&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(src)) && errors.length < 5) {
    const token = m[0];
    if (token.startsWith("<!--") || token.startsWith("<![CDATA[") || token.startsWith("<?") || token.startsWith("<!DOCTYPE")) continue;
    if (token === "<") {
      errors.push(`Malformed tag near character ${m.index}: "${src.slice(m.index, m.index + 40).replace(/\s+/g, " ")}"`);
      continue;
    }
    if (token === "&") {
      errors.push(`Unescaped "&" near character ${m.index}: "${src.slice(Math.max(0, m.index - 20), m.index + 20).replace(/\s+/g, " ")}"`);
      continue;
    }
    const [, closing, name, , selfClosing] = m;
    if (closing) {
      const open = stack.pop();
      if (open !== name) {
        errors.push(open ? `Mismatched closing tag </${name}> (expected </${open}>)` : `Unexpected closing tag </${name}>`);
      }
    } else {
      if (stack.length === 0) roots++;
      if (!selfClosing) stack.push(name);
    }
  }
  if (stack.length && errors.length < 5) errors.push(`Unclosed element <${stack.at(-1)}>`);
  if (roots === 0 && errors.length === 0) errors.push("No root element found.");
  if (roots > 1 && errors.length < 5) errors.push("More than one root element.");
  return errors;
}

export function parseSitemap(xml: string, maxUrls = MAX_SITEMAP_URLS): ParsedSitemap {
  const errors = checkWellFormed(xml);
  const $ = cheerio.load(xml, { xml: true });
  const root = $.root().children().first();
  const rootName = (root.prop("tagName") as string | undefined)?.toLowerCase().replace(/^.*:/, "") ?? "";
  const kind = rootName === "urlset" ? "urlset" : rootName === "sitemapindex" ? "sitemapindex" : "unknown";
  if (kind === "unknown" && errors.length === 0) {
    errors.push(`Root element is <${rootName || "none"}>, expected <urlset> or <sitemapindex>.`);
  }
  const itemTag = kind === "sitemapindex" ? "sitemap" : "url";
  const locs: string[] = [];
  const lastmods: string[] = [];
  let truncated = false;
  root.children().each((_, el) => {
    const name = ((el as { tagName?: string }).tagName ?? "").toLowerCase().replace(/^.*:/, "");
    if (name !== itemTag) return;
    const loc = $(el)
      .children()
      .filter((__, c) => ((c as { tagName?: string }).tagName ?? "").toLowerCase().replace(/^.*:/, "") === "loc")
      .first()
      .text()
      .trim();
    if (!loc) return;
    if (locs.length >= maxUrls) {
      truncated = true;
      return false;
    }
    locs.push(loc);
    const lastmod = $(el)
      .children()
      .filter((__, c) => ((c as { tagName?: string }).tagName ?? "").toLowerCase().replace(/^.*:/, "") === "lastmod")
      .first()
      .text()
      .trim();
    if (lastmod && kind === "urlset") lastmods.push(lastmod);
  });
  const invalid = locs.filter((l) => !/^https?:\/\//i.test(l));
  if (invalid.length) errors.push(`${invalid.length} <loc> value(s) are not absolute http(s) URLs, e.g. "${invalid[0].slice(0, 100)}".`);
  return { kind, locs, truncated, errors, lastmods };
}

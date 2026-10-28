// Link and image extraction for the crawl graph. Pure.
import type { Doc } from "../audit/parse";
import { isInternal, resolveHref } from "./url";

export const MAX_LINKS_PER_PAGE = 300;
export const MAX_IMAGES_PER_PAGE = 100;

export interface PageLinks {
  /** Unique internal link targets (normalised, fragment removed), capped. */
  internal: string[];
  /** Internal targets only reached through rel=nofollow links. */
  nofollowInternal: string[];
  externalCount: number;
  /** Unique internal image URLs, capped. */
  images: string[];
  /** True when caps were hit. */
  capped: boolean;
}

export function extractLinks($: Doc, pageUrl: string, siteOrigin: string): PageLinks {
  // <base href> changes how relative links resolve.
  const baseHref = $("base[href]").first().attr("href");
  const base = (baseHref && resolveHref(baseHref, pageUrl)) || pageUrl;
  const internal = new Set<string>();
  const followed = new Set<string>();
  let externalCount = 0;
  let capped = false;

  $("a[href]").each((_, el) => {
    const target = resolveHref($(el).attr("href"), base);
    if (!target) return;
    if (!isInternal(target, siteOrigin)) {
      externalCount++;
      return;
    }
    if (internal.size >= MAX_LINKS_PER_PAGE && !internal.has(target)) {
      capped = true;
      return;
    }
    internal.add(target);
    const rel = ($(el).attr("rel") ?? "").toLowerCase().split(/\s+/);
    if (!rel.includes("nofollow")) followed.add(target);
  });

  const images = new Set<string>();
  $("img[src]").each((_, el) => {
    const src = resolveHref($(el).attr("src"), base);
    if (!src || !isInternal(src, siteOrigin)) return;
    if (images.size >= MAX_IMAGES_PER_PAGE) {
      capped = true;
      return;
    }
    images.add(src);
  });

  return {
    internal: [...internal],
    nofollowInternal: [...internal].filter((u) => !followed.has(u)),
    externalCount,
    images: [...images],
    capped,
  };
}

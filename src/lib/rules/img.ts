// Image and video rules (docs/SPEC.md catalog, IMG). Page rules read the snapshot's <img> list; the size, type and
// intrinsic dimensions come from the resource phase (crawl.resources.images: HEAD plus the header bytes, at most
// 2,000 images per crawl). An image the resource phase did not check is never judged on size. IMG-009 (LCP image
// lazy-loaded) needs the Phase 5 renderer and is not implemented.
import { finding, inconclusive, type CrawlView, type PageRule, type PageView, type ResourceFacts, type ResourceRule } from "./contract";
import { entities } from "./jsonld";
import { isHtml200 } from "./util";

const page = (r: Omit<PageRule, "scope" | "category">): PageRule => ({ scope: "page", category: "images", ...r });
const resource = (r: Omit<ResourceRule, "scope" | "category" | "kind">): ResourceRule => ({ scope: "resource", category: "images", kind: "image", ...r });

const EVIDENCE_CAP = 20;
/** Spec: alt text over 125 characters. */
export const MAX_ALT_CHARS = 125;
/** Spec: image over 200 KB. */
export const MAX_IMAGE_BYTES = 200 * 1024;
/** IMG-002: an image at least this wide or high (declared or intrinsic) is content, not decoration. */
export const LARGE_IMAGE_PX = 200;
/** IMG-010: intrinsic width from which one fixed file is too much for small screens. */
export const RESPONSIVE_MIN_WIDTH = 800;

const imgs = (p: PageView) => p.images.filter((i) => i.resolved && !i.resolved.startsWith("data:"));
const checked = (crawl: CrawlView, url: string | null): ResourceFacts | null => {
  const r = url ? crawl.resources.images.get(url) : undefined;
  return r && r.state === "done" && r.status !== null && r.status >= 200 && r.status < 300 ? r : null;
};
const px = (v: string | null) => (v && /^\s*\d+(\.\d+)?\s*(px)?\s*$/i.test(v) ? Number.parseFloat(v) : null);

const IMG001 = page({
  id: "IMG-001",
  version: 1,
  confidence: "verified",
  impact: 2,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p)) return [];
    const bad = imgs(p).filter((i) => i.alt === null);
    return bad.length ? [finding(IMG001, p.url, `${bad.length} image(s) have no alt attribute.`, { count: bad.length, images: bad.slice(0, EVIDENCE_CAP).map((i) => i.resolved) })] : [];
  },
  explain: {
    why: "Screen readers announce an image without alt by its file name, and search engines get no text for it.",
    fix: 'Add alt text that describes the image, or alt="" if it is purely decorative.',
    acceptance: "Every <img> has an alt attribute.",
  },
});

const IMG002 = page({
  id: "IMG-002",
  version: 1,
  confidence: "heuristic",
  impact: 2,
  needs: ["raw"],
  evaluate({ page: p, crawl }) {
    if (!isHtml200(p)) return [];
    const bad = imgs(p)
      .filter((i) => i.alt === "")
      .map((i) => {
        const r = checked(crawl, i.resolved);
        const large = Math.max(px(i.width) ?? 0, px(i.height) ?? 0, r?.width ?? 0, r?.height ?? 0) >= LARGE_IMAGE_PX;
        const why = [i.linked ? "linked" : "", large ? "large" : "", i.inMain ? "in main content" : ""].filter(Boolean);
        return { src: i.resolved, why };
      })
      .filter((x) => x.why.length);
    return bad.length ? [finding(IMG002, p.url, `${bad.length} image(s) with empty alt look like content (linked, large or in the main content).`, { count: bad.length, images: bad.slice(0, EVIDENCE_CAP) })] : [];
  },
  explain: {
    why: 'alt="" tells assistive technology to skip the image; a linked image with empty alt is a link with no name.',
    fix: "Describe what the image shows (or where the link goes).",
    acceptance: 'alt="" only on decorative images.',
  },
});

const IMG003 = page({
  id: "IMG-003",
  version: 2,
  confidence: "heuristic",
  impact: 1,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p)) return [];
    const bad = imgs(p).flatMap((i) => {
      const alt = (i.alt ?? "").trim();
      if (!alt) return [];
      const file = decodeURIComponent(new URL(i.resolved!).pathname.split("/").pop() ?? "").toLowerCase();
      // The stem counts only when it looks machine-made (digits, _ or -): alt "MongoDB" on mongodb.svg names the logo.
      const stem = file.replace(/\.[a-z0-9]+$/, "");
      const isName = alt.toLowerCase() === file || (alt.toLowerCase() === stem && /[\d_-]/.test(stem)) || /\.(jpe?g|png|gif|webp|avif|svg|bmp)$/i.test(alt);
      if (isName) return [{ src: i.resolved, alt, problem: "file name" }];
      return alt.length > MAX_ALT_CHARS ? [{ src: i.resolved, alt: alt.slice(0, 60) + "…", problem: `${alt.length} characters` }] : [];
    });
    return bad.length ? [finding(IMG003, p.url, `${bad.length} image(s) with alt text that is a file name or over ${MAX_ALT_CHARS} characters.`, { count: bad.length, images: bad.slice(0, EVIDENCE_CAP) })] : [];
  },
  explain: {
    why: "A file name says nothing to a screen-reader user; very long alt text is tiring and is often keyword stuffing.",
    fix: `Write a short description (under ${MAX_ALT_CHARS} characters); put long descriptions in the page text.`,
    acceptance: `No alt text equals the file name or exceeds ${MAX_ALT_CHARS} characters.`,
  },
});

const IMG004 = resource({
  id: "IMG-004",
  version: 1,
  confidence: "verified",
  impact: 3,
  needs: ["headers"],
  evaluate({ resource: r }) {
    if (r.state !== "done") return [];
    const ev = { status: r.status, error: r.error?.code ?? null, usedOn: r.referrers, pages: r.samplePages };
    if (r.status !== null && r.status >= 400 && r.status !== 429 && r.status < 500) return [finding(IMG004, r.url, `Image returns HTTP ${r.status}; used on ${r.referrers} page(s).`, ev)];
    if ((r.status !== null && (r.status === 429 || r.status >= 500)) || (r.error && r.status === null)) {
      return [inconclusive(IMG004, r.url, "ambiguous_status", `Image answered ${r.status !== null ? `HTTP ${r.status}` : r.error!.message}, which may be temporary.`, ev)];
    }
    return [];
  },
  explain: {
    why: "A broken image leaves a gap in the page and wastes a request.",
    fix: "Restore the file, fix the path, or remove the <img>.",
    acceptance: "The image returns 2xx.",
  },
});

const IMG005 = resource({
  id: "IMG-005",
  version: 1,
  confidence: "heuristic",
  impact: 2,
  needs: ["headers"],
  evaluate({ resource: r }) {
    if (r.state !== "done" || r.status === null || r.status < 200 || r.status >= 300) return [];
    const ev = { bytes: r.contentLength, threshold: MAX_IMAGE_BYTES, contentType: r.contentType, usedOn: r.referrers, pages: r.samplePages };
    if (r.contentLength === null) return [inconclusive(IMG005, r.url, "size_unknown", "The server sent no Content-Length, so the image's size is unknown.", ev)];
    return r.contentLength > MAX_IMAGE_BYTES ? [finding(IMG005, r.url, `Image is ${Math.round(r.contentLength / 1024)} KB (over ${MAX_IMAGE_BYTES / 1024} KB).`, ev)] : [];
  },
  explain: {
    why: "Large images slow page loads, especially on mobile, and hurt LCP.",
    fix: "Resize to the displayed size, compress, and serve a modern format.",
    acceptance: `The image is ${MAX_IMAGE_BYTES / 1024} KB or less.`,
  },
});

/**
 * IMG-006: legacy formats at sizes where WebP/AVIF reliably save over 30% (published comparisons: WebP lossless is
 * ~26% smaller than PNG and lossy WebP 25–34% smaller than JPEG at equal quality; AVIF more). An estimate, not a
 * measured re-encode, so the rule is heuristic and the message says "typically".
 */
const LEGACY = [
  { type: /^image\/(png|gif|bmp|tiff)\b/i, minBytes: 30 * 1024 },
  { type: /^image\/jpe?g\b/i, minBytes: 100 * 1024 },
];

const IMG006 = resource({
  id: "IMG-006",
  version: 1,
  confidence: "heuristic",
  impact: 1,
  needs: ["headers"],
  evaluate({ resource: r }) {
    if (r.state !== "done" || r.status === null || r.status < 200 || r.status >= 300 || r.contentLength === null || !r.contentType) return [];
    const l = LEGACY.find((x) => x.type.test(r.contentType!));
    if (!l || r.contentLength < l.minBytes) return [];
    return [finding(IMG006, r.url, `Served as ${r.contentType.split(";")[0]} (${Math.round(r.contentLength / 1024)} KB); WebP or AVIF typically saves over 30% at this size.`, { contentType: r.contentType, bytes: r.contentLength, usedOn: r.referrers, pages: r.samplePages })];
  },
  explain: {
    why: "Modern formats deliver the same quality in fewer bytes.",
    fix: "Serve WebP or AVIF (with <picture> or content negotiation), keeping the legacy file as a fallback if needed.",
    acceptance: "The image is served as WebP or AVIF, or is small enough that conversion saves little.",
  },
});

const IMG007 = page({
  id: "IMG-007",
  version: 2,
  confidence: "verified",
  impact: 1,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p)) return [];
    // An image positioned over its whole parent (Next.js <Image fill>) takes the parent's box: no shift from it.
    const bad = imgs(p).filter((i) => (!i.width || !i.height) && !i.fillsParent);
    return bad.length ? [finding(IMG007, p.url, `${bad.length} image(s) without both width and height attributes (layout shift risk).`, { count: bad.length, images: bad.slice(0, EVIDENCE_CAP).map((i) => ({ src: i.resolved, width: i.width, height: i.height })) })] : [];
  },
  explain: {
    why: "Without dimensions the browser cannot reserve space, so content jumps when the image loads (CLS).",
    fix: "Add width and height attributes matching the image's aspect ratio (CSS can still scale it).",
    acceptance: "Every <img> has width and height.",
  },
});

const IMG008 = page({
  id: "IMG-008",
  version: 1,
  confidence: "heuristic",
  impact: 2,
  needs: ["raw", "headers"],
  evaluate({ page: p, crawl }) {
    if (!isHtml200(p)) return [];
    const bad = imgs(p).flatMap((i) => {
      // With srcset the browser picks a candidate; the src alone says nothing about what is downloaded.
      if (i.srcset) return [];
      const shown = px(i.width);
      const r = checked(crawl, i.resolved);
      if (!shown || !r?.width || r.width <= 2 * shown) return [];
      return [{ src: i.resolved, intrinsic: `${r.width}×${r.height}`, displayedWidth: shown }];
    });
    return bad.length ? [finding(IMG008, p.url, `${bad.length} image(s) over twice the width they are displayed at.`, { count: bad.length, images: bad.slice(0, EVIDENCE_CAP) })] : [];
  },
  explain: {
    why: "Downloading far more pixels than are shown wastes bandwidth and slows the page.",
    fix: "Resize the file to about the displayed size (2× for high-density screens via srcset).",
    acceptance: "Intrinsic width is at most twice the displayed width.",
  },
});

const IMG010 = page({
  id: "IMG-010",
  version: 1,
  confidence: "advisory",
  impact: 1,
  needs: ["raw", "headers"],
  evaluate({ page: p, crawl }) {
    if (!isHtml200(p)) return [];
    const bad = imgs(p).flatMap((i) => {
      if (i.srcset || i.inPicture) return [];
      const r = checked(crawl, i.resolved);
      return r?.width && r.width >= RESPONSIVE_MIN_WIDTH ? [{ src: i.resolved, width: r.width }] : [];
    });
    return bad.length ? [finding(IMG010, p.url, `${bad.length} large image(s) (${RESPONSIVE_MIN_WIDTH}px or wider) without srcset.`, { count: bad.length, images: bad.slice(0, EVIDENCE_CAP) })] : [];
  },
  explain: {
    why: "Without srcset, phones download the full desktop image.",
    fix: "Add srcset (and sizes) with smaller renditions, or use <picture>.",
    acceptance: `Images ${RESPONSIVE_MIN_WIDTH}px or wider have srcset or are inside <picture>.`,
  },
});

const IMG011 = page({
  id: "IMG-011",
  version: 1,
  confidence: "advisory",
  impact: 1,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p) || !p.facts?.videos?.length) return [];
    if (entities(p.jsonLd).some((r) => r.types.includes("VideoObject"))) return [];
    const bad = p.facts.videos.filter((v) => !v.poster);
    return bad.length ? [finding(IMG011, p.url, `${bad.length} video(s) with neither a poster image nor VideoObject structured data.`, { count: bad.length, videos: bad.slice(0, EVIDENCE_CAP) })] : [];
  },
  explain: {
    why: "A poster gives the video a thumbnail before it plays; VideoObject markup lets search engines show it in video results.",
    fix: "Add a poster attribute, and VideoObject markup with name, thumbnailUrl and uploadDate.",
    acceptance: "Every <video> has a poster or the page has VideoObject markup.",
  },
});

export const IMG_RULES = [IMG001, IMG002, IMG003, IMG004, IMG005, IMG006, IMG007, IMG008, IMG010, IMG011];

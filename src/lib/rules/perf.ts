// Performance rules (docs/SPEC.md catalog, PERF) that the fetched response answers, without a browser: TTFB,
// render-blocking head resources, HTML size, text compression and DOM size. Every measured number is lab data (the
// crawler's own request), so its evidence says source "lab"; field data (CrUX) is not available, and nothing here
// is labelled field. PERF-001/003/007/009/011 need the rendered page; PERF-002 needs field data.
import type { HeadTag } from "../snapshot/types";
import { finding, type PageRule } from "./contract";
import { isHtml200 } from "./util";

const page = (r: Omit<PageRule, "scope" | "category">): PageRule => ({ scope: "page", category: "performance", ...r });

/** Spec thresholds. */
export const TTFB_MS = 800;
export const HTML_BYTES = 500 * 1024;
export const DOM_NODES = 1500;
/** Below one TCP packet, compressing gains nothing; servers commonly skip it (nginx gzip_min_length). */
export const COMPRESS_MIN_BYTES = 1400;
const EVIDENCE_CAP = 20;

const PERF004 = page({
  id: "PERF-004",
  version: 1,
  confidence: "verified",
  impact: 2,
  needs: ["headers"],
  evaluate({ page: p }) {
    const ms = p.timings.fetchMs;
    if (!isHtml200(p) || !(ms > TTFB_MS)) return [];
    return [finding(PERF004, p.url, `The server took ${Math.round(ms)} ms to start answering (over ${TTFB_MS} ms).`, { ttfbMs: Math.round(ms), threshold: TTFB_MS, source: "lab", measuredBy: "crawler" })];
  },
  explain: {
    why: "Every other loading step waits for the first byte; a slow server delays LCP for every visitor.",
    fix: "Cache rendered pages (CDN or server cache), speed up slow database or API calls, and serve from a region near your users.",
    acceptance: `The crawler receives the response headers within ${TTFB_MS} ms.`,
  },
});

/** Head scripts and stylesheets that block the first render: classic scripts without async/defer, screen stylesheets. */
export function renderBlocking(head: HeadTag[]): { url: string; kind: "script" | "stylesheet" }[] {
  const out: { url: string; kind: "script" | "stylesheet" }[] = [];
  for (const t of head) {
    const a = t.attrs;
    if (t.tag === "script" && a.src) {
      const type = (a.type ?? "").trim().toLowerCase();
      // Module scripts are deferred by default; a non-JavaScript type is not executed at all.
      if ("async" in a || "defer" in a || type === "module" || (type && !/^(text|application)\/(x-)?(java|ecma)script$/.test(type))) continue;
      out.push({ url: a.src, kind: "script" });
    } else if (t.tag === "link" && a.href && (a.rel ?? "").toLowerCase().split(/\s+/).includes("stylesheet")) {
      const media = (a.media ?? "all").trim().toLowerCase();
      if ("disabled" in a || (media !== "all" && media !== "screen" && media !== "")) continue;
      out.push({ url: a.href, kind: "stylesheet" });
    }
  }
  return out;
}

const PERF005 = page({
  id: "PERF-005",
  version: 1,
  confidence: "heuristic",
  impact: 2,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p)) return [];
    const blocking = renderBlocking(p.head);
    if (!blocking.length) return [];
    const scripts = blocking.filter((b) => b.kind === "script").length;
    return [
      finding(PERF005, p.url, `${blocking.length} resource(s) in <head> block the first render (${scripts} script(s), ${blocking.length - scripts} stylesheet(s)).`, {
        count: blocking.length,
        scripts,
        stylesheets: blocking.length - scripts,
        resources: blocking.slice(0, EVIDENCE_CAP),
      }),
    ];
  },
  explain: {
    why: "The browser stops painting until every classic head script and screen stylesheet has downloaded and run.",
    fix: "Add defer (or async) to head scripts, inline the critical CSS and load the rest without blocking (media or preload).",
    acceptance: "No classic script without async/defer and no screen stylesheet in <head>, or only the critical ones you chose to keep.",
  },
});

const PERF006 = page({
  id: "PERF-006",
  version: 1,
  confidence: "heuristic",
  impact: 2,
  needs: ["raw"],
  evaluate({ page: p }) {
    // bytes: the decoded HTML as read (capped at the crawler's limit, so a truncated body is over it too).
    const bytes = p.facts?.htmlBytes ?? p.bytes;
    if (!isHtml200(p) || !(bytes > HTML_BYTES || p.truncated)) return [];
    return [finding(PERF006, p.url, `The HTML is ${Math.round(bytes / 1024)} KB${p.truncated ? " or more (the crawler stopped reading)" : ""}, over ${HTML_BYTES / 1024} KB.`, { bytes, truncated: p.truncated, threshold: HTML_BYTES })];
  },
  explain: {
    why: "Large HTML takes longer to download and parse, and crawlers may stop reading before the end.",
    fix: "Move inline data, SVG sprites and repeated markup out of the HTML; paginate long lists.",
    acceptance: `The HTML is at most ${HTML_BYTES / 1024} KB.`,
  },
});

const PERF008 = page({
  id: "PERF-008",
  version: 1,
  confidence: "verified",
  impact: 2,
  needs: ["headers"],
  evaluate({ page: p }) {
    const bytes = p.facts?.htmlBytes ?? p.bytes;
    if (!isHtml200(p) || bytes < COMPRESS_MIN_BYTES) return [];
    const enc = (p.headers["content-encoding"] ?? "").trim().toLowerCase();
    if (enc && enc !== "identity") return [];
    // The crawler asks with Accept-Encoding: gzip, deflate (undici's default).
    return [finding(PERF008, p.url, `The ${Math.round(bytes / 1024)} KB HTML is sent uncompressed although the request accepted gzip.`, { bytes, contentEncoding: enc || null, acceptEncoding: "gzip, deflate" })];
  },
  explain: {
    why: "Compression typically shrinks HTML by 70–90%, cutting download time on every page view.",
    fix: "Enable gzip or Brotli for text responses (HTML, CSS, JS, JSON, SVG) on the server or CDN.",
    acceptance: "The HTML response has Content-Encoding gzip or br when the request accepts it.",
  },
});

const PERF010 = page({
  id: "PERF-010",
  version: 1,
  confidence: "heuristic",
  impact: 1,
  needs: ["raw"],
  evaluate({ page: p }) {
    // Counted in the HTML as served (snapshots from before Phase 5 have no count and are not judged).
    const nodes = p.facts?.domNodes;
    if (!isHtml200(p) || nodes === undefined || nodes <= DOM_NODES) return [];
    return [finding(PERF010, p.url, `The HTML has ${nodes} elements (over ${DOM_NODES}).`, { nodes, threshold: DOM_NODES, counted: "raw" })];
  },
  explain: {
    why: "A large DOM costs memory and slows style calculation, layout and every interaction.",
    fix: "Remove hidden or duplicated markup, paginate or virtualise long lists, and flatten deep wrapper nesting.",
    acceptance: `The page has at most ${DOM_NODES} elements.`,
  },
});

export const PERF_RULES = [PERF004, PERF005, PERF006, PERF008, PERF010];

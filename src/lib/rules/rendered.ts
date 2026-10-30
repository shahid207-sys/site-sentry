// Rules that read a page's headless-browser render (docs/SPEC.md Phase 5): raw vs rendered differences (IDX-018,
// AIS-004), links that only JavaScript makes (LNK-009), the LCP element (IMG-009), lab metrics and the page's
// requests (PERF-001/003/007/009/011) and axe-core accessibility checks (A11Y-001..004).
//
// They need "rendered": analysis evaluates them only on pages with a successful render (page.render.status
// "rendered"), and they report needs_config when the audit's render mode is off. Every metric is lab data from one
// load in the render worker's browser (no CPU or network throttling), so evidence says source "lab"; no field data
// (CrUX) is available, and nothing here is labelled field.
import { effectiveCanonical } from "./analyse";
import { finding, inconclusive, type Category, type PageRenderView, type PageRule, type PageView } from "./contract";
import { isHtml200 } from "./util";

const rule = (category: Category, r: Omit<PageRule, "scope" | "category" | "needs">): PageRule => ({ scope: "page", category, needs: ["rendered"], ...r });

/** The page's successful render, or null (rendered rules do not judge pages without one). */
const rendered = (p: PageView): PageRenderView | null => (isHtml200(p) && p.render?.status === "rendered" ? p.render : null);

/** Spec thresholds (Core Web Vitals "good" limits and the catalog's own). */
export const LCP_MS = 2500;
export const CLS = 0.1;
export const PAGE_WEIGHT_BYTES = 3 * 1024 * 1024;
export const THIRD_PARTY_SCRIPT_SHARE = 0.5;
/** AIS-004: the rendered page has at least this many words, and the raw HTML under half of them. */
export const JS_CONTENT_MIN_WORDS = 100;
export const JS_CONTENT_RAW_SHARE = 0.5;
const SAMPLE = 20;
const LAB = { source: "lab", measuredBy: "render worker (headless Chromium, 412×915 viewport, no throttling)" } as const;

const IDX018 = rule("indexability", {
  id: "IDX-018",
  version: 1,
  confidence: "verified",
  impact: 4,
  evaluate({ page: p }) {
    const r = rendered(p);
    if (!r?.extract) return [];
    const raw = effectiveCanonical(p.canonicals);
    const after = effectiveCanonical(r.extract.canonicals);
    if (raw === after) return [];
    const what = !raw ? `JavaScript adds a canonical (${after}) the HTML does not have` : !after ? `JavaScript removes the canonical (${raw})` : `JavaScript changes the canonical from ${raw} to ${after}`;
    return [finding(IDX018, p.url, `${what}.`, { raw, rendered: after })];
  },
  explain: {
    why: "Google reads the canonical in the HTML and again after rendering; when they disagree it may pick either, or ignore both.",
    fix: "Put the final canonical in the server HTML and stop scripts (tag managers, SPA routers, SEO plugins) from writing another.",
    acceptance: "The canonical is the same before and after JavaScript runs.",
  },
});

const AIS004 = rule("ai_search", {
  id: "AIS-004",
  version: 1,
  confidence: "heuristic",
  impact: 3,
  evaluate({ page: p }) {
    const r = rendered(p);
    if (!r?.extract) return [];
    const after = r.extract.wordCount;
    if (after < JS_CONTENT_MIN_WORDS || p.wordCount >= after * JS_CONTENT_RAW_SHARE) return [];
    return [
      finding(AIS004, p.url, `The HTML has ${p.wordCount} words of main content; after JavaScript runs it has ${after}.`, {
        rawWords: p.wordCount,
        renderedWords: after,
        rawShare: Math.round((p.wordCount / after) * 100) / 100,
      }),
    ];
  },
  explain: {
    why: "AI crawlers (GPTBot, ClaudeBot, PerplexityBot) and many other bots do not run JavaScript: content written by scripts is invisible to them.",
    fix: "Render the main content on the server (SSR or static generation), or pre-render it for bots.",
    acceptance: "At least half the rendered page's main content words are in the HTML as served.",
  },
});

const LNK009 = rule("links", {
  id: "LNK-009",
  version: 1,
  confidence: "verified",
  impact: 3,
  evaluate({ page: p }) {
    const s = rendered(p)?.scriptLinks;
    if (!s) return [];
    const n = s.counts.onclick + s.counts.noHref;
    if (!n) return [];
    return [
      finding(LNK009, p.url, `${n} element(s) act as links only through JavaScript (${s.counts.onclick} with a navigating onclick, ${s.counts.noHref} <a> without href).`, {
        onclick: s.counts.onclick,
        noHref: s.counts.noHref,
        sample: [...s.onclick, ...s.noHref].slice(0, SAMPLE),
        // What the check cannot see: handlers attached with addEventListener or by a framework.
        detects: "inline onclick handlers that navigate, and <a> elements without href",
      }),
    ];
  },
  explain: {
    why: "Search engines follow <a href> links only; a destination reached by a click handler is not discovered or credited through it.",
    fix: "Use <a href=\"/target\"> for navigation (scripts can still enhance the click); keep buttons for actions.",
    acceptance: "Every element that navigates is an <a> with an href.",
  },
});

const IMG009 = rule("images", {
  id: "IMG-009",
  version: 1,
  confidence: "verified",
  impact: 3,
  evaluate({ page: p }) {
    const m = rendered(p)?.metrics;
    const el = m?.lcpElement;
    if (!el || el.tag !== "img" || (el.loading ?? "").trim().toLowerCase() !== "lazy") return [];
    return [finding(IMG009, p.url, `The largest image in view (the LCP element) has loading="lazy".`, { image: el.url, selector: el.selector, lcpMs: m!.lcpMs, ...LAB })];
  },
  explain: {
    why: "A lazy image waits until layout confirms it is in view, delaying the largest paint the user is waiting for.",
    fix: "Remove loading=\"lazy\" from the hero image (add fetchpriority=\"high\"); keep lazy loading for images below the fold.",
    acceptance: "The LCP image is not lazy-loaded.",
  },
});

const PERF001 = rule("performance", {
  id: "PERF-001",
  version: 1,
  confidence: "verified",
  impact: 3,
  evaluate({ page: p }) {
    const m = rendered(p)?.metrics;
    if (!m) return [];
    if (m.lcpMs === null) return isHtml200(p) ? [inconclusive(PERF001, p.url, "not_measured", "The browser recorded no Largest Contentful Paint for this page.", { ...LAB })] : [];
    if (m.lcpMs <= LCP_MS) return [];
    return [finding(PERF001, p.url, `Largest Contentful Paint took ${m.lcpMs} ms in the lab (over ${LCP_MS} ms).`, { lcpMs: m.lcpMs, threshold: LCP_MS, element: m.lcpElement, ...LAB, field: null })];
  },
  explain: {
    why: "LCP is a Core Web Vital: how long until the main content is visible. Slow LCP loses visitors and ranking signals.",
    fix: "Serve the LCP image or text early: preload it, cut render-blocking resources, compress and size images, speed up the server.",
    acceptance: `LCP is at most ${LCP_MS} ms (the lab value here; field data, when available, is the real target).`,
  },
});

const PERF003 = rule("performance", {
  id: "PERF-003",
  version: 1,
  confidence: "verified",
  impact: 3,
  evaluate({ page: p }) {
    const m = rendered(p)?.metrics;
    if (!m || m.cls === null || m.cls <= CLS) return [];
    return [finding(PERF003, p.url, `Cumulative Layout Shift was ${m.cls} in the lab (over ${CLS}).`, { cls: m.cls, threshold: CLS, ...LAB, field: null })];
  },
  explain: {
    why: "Content that jumps while loading causes misclicks and is a Core Web Vital (CLS).",
    fix: "Give images, embeds and ad slots explicit width and height, reserve space for late content, and avoid inserting content above what is shown.",
    acceptance: `CLS is at most ${CLS} during load.`,
  },
});

const fulfilled = (r: PageRenderView) => r.requests.filter((q) => q.outcome === "fulfilled");
/** The request log is capped; totals beyond it are not in the sums. */
const partialLog = (r: PageRenderView) => !!r.requestTotals && r.requestTotals.count > r.requestTotals.logged;

const PERF007 = rule("performance", {
  id: "PERF-007",
  version: 1,
  confidence: "heuristic",
  impact: 2,
  evaluate({ page: p }) {
    const r = rendered(p);
    if (!r) return [];
    const got = fulfilled(r);
    const bytes = got.reduce((n, q) => n + (q.transferBytes ?? 0), 0);
    if (bytes <= PAGE_WEIGHT_BYTES) return [];
    const byType: Record<string, number> = {};
    for (const q of got) byType[q.type] = (byType[q.type] ?? 0) + (q.transferBytes ?? 0);
    const largest = [...got].sort((a, b) => (b.transferBytes ?? 0) - (a.transferBytes ?? 0)).slice(0, 5).map((q) => ({ url: q.url, type: q.type, bytes: q.transferBytes ?? 0 }));
    return [
      finding(PERF007, p.url, `The page loads ${(bytes / 1048576).toFixed(1)} MB (over ${PAGE_WEIGHT_BYTES / 1048576} MB).`, {
        bytes,
        threshold: PAGE_WEIGHT_BYTES,
        requests: got.length,
        byType,
        largest,
        // Ads and analytics are blocked while rendering, so their bytes are not counted.
        blockedRequests: r.requests.filter((q) => q.outcome === "blocked").length,
        partial: partialLog(r),
        ...LAB,
      }),
    ];
  },
  explain: {
    why: "Every byte costs load time and data on mobile connections.",
    fix: "Compress and resize images (AVIF/WebP), remove unused JavaScript and CSS, subset fonts and lazy-load what is below the fold.",
    acceptance: `The page loads at most ${PAGE_WEIGHT_BYTES / 1048576} MB.`,
  },
});

const STATIC = new Set(["script", "stylesheet", "image", "font"]);

const PERF009 = rule("performance", {
  id: "PERF-009",
  version: 1,
  confidence: "verified",
  impact: 1,
  evaluate({ page: p }) {
    const r = rendered(p);
    if (!r) return [];
    // The site's own static files (third parties' caching is not the site's to fix) that a browser must re-request.
    const uncached = fulfilled(r).filter((q) => STATIC.has(q.type) && !q.thirdParty && q.status === 200 && !q.cacheControl && !q.expires);
    if (!uncached.length) return [];
    return [
      finding(PERF009, p.url, `${uncached.length} static file(s) are served without Cache-Control or Expires.`, {
        count: uncached.length,
        sample: uncached.slice(0, SAMPLE).map((q) => ({ url: q.url, type: q.type })),
        partial: partialLog(r),
      }),
    ];
  },
  explain: {
    why: "Without caching headers browsers revalidate or re-download scripts, styles, images and fonts on every visit.",
    fix: "Serve versioned static files with Cache-Control: public, max-age=31536000, immutable; give the rest a sensible max-age.",
    acceptance: "Every static file the site serves has Cache-Control (or Expires).",
  },
});

const PERF011 = rule("performance", {
  id: "PERF-011",
  version: 1,
  confidence: "advisory",
  impact: 1,
  evaluate({ page: p }) {
    const r = rendered(p);
    if (!r) return [];
    const scripts = fulfilled(r).filter((q) => q.type === "script");
    const total = scripts.reduce((n, q) => n + (q.transferBytes ?? 0), 0);
    const third = scripts.filter((q) => q.thirdParty).reduce((n, q) => n + (q.transferBytes ?? 0), 0);
    if (!total || third / total <= THIRD_PARTY_SCRIPT_SHARE) return [];
    const hosts: Record<string, number> = {};
    for (const q of scripts.filter((s) => s.thirdParty)) {
      const h = new URL(q.url).host;
      hosts[h] = (hosts[h] ?? 0) + (q.transferBytes ?? 0);
    }
    return [
      finding(PERF011, p.url, `${Math.round((third / total) * 100)}% of the page's JavaScript bytes come from other domains.`, {
        thirdPartyBytes: third,
        scriptBytes: total,
        share: Math.round((third / total) * 100) / 100,
        hosts,
        // Ads and analytics are blocked while rendering: with them the share is higher still.
        note: "ads and analytics hosts are not loaded while rendering and are not counted",
      }),
    ];
  },
  explain: {
    why: "Third-party scripts compete with your own code for the main thread, and you cannot control their size or speed.",
    fix: "Remove tags you no longer use, load the rest after the page is interactive (defer, facades for embeds), and self-host what you can.",
    acceptance: "Third-party JavaScript is at most half the page's script bytes.",
  },
});

/** An axe-core based rule: violations of `axeRules` on the rendered page. */
function axeRule(id: string, impact: 1 | 2, confidence: "verified" | "heuristic", axeRules: string[], what: string, explain: PageRule["explain"]): PageRule {
  const r: PageRule = rule("accessibility", {
    id,
    version: 1,
    confidence,
    impact,
    evaluate({ page: p }) {
      const rr = rendered(p);
      if (!rr) return [];
      if (!rr.a11y) return [inconclusive(r, p.url, "not_measured", "axe-core could not run on the rendered page.", {})];
      const hits = axeRules.flatMap((a) => (rr.a11y!.rules[a as keyof typeof rr.a11y.rules] ? [{ rule: a, ...rr.a11y!.rules[a as keyof typeof rr.a11y.rules]! }] : []));
      const count = hits.reduce((n, h) => n + h.count, 0);
      if (!count) return [];
      return [
        finding(r, p.url, `${count} ${what}.`, {
          count,
          byAxeRule: Object.fromEntries(hits.map((h) => [h.rule, h.count])),
          sample: hits.flatMap((h) => h.nodes.map((n) => ({ axeRule: h.rule, ...n }))).slice(0, SAMPLE),
          axe: rr.a11y.version,
        }),
      ];
    },
    explain,
  });
  return r;
}

const A11Y001 = axeRule("A11Y-001", 1, "verified", ["color-contrast"], "text element(s) with insufficient colour contrast (WCAG 1.4.3)", {
  why: "Low-contrast text is hard or impossible to read for people with low vision and for everyone in bright light.",
  fix: "Raise the contrast to at least 4.5:1 for body text and 3:1 for large text.",
  acceptance: "axe-core reports no color-contrast violation on the rendered page.",
});
const A11Y002 = axeRule("A11Y-002", 1, "verified", ["label", "select-name"], "form field(s) without a label (WCAG 1.3.1, 4.1.2)", {
  why: "Screen readers announce an unlabelled field as just \"edit text\": users cannot tell what to enter.",
  fix: "Give each input, select and textarea a <label for>, a wrapping <label>, or aria-label / aria-labelledby.",
  acceptance: "axe-core reports no label or select-name violation on the rendered page.",
});
const A11Y003 = axeRule("A11Y-003", 2, "verified", ["button-name", "link-name", "input-button-name"], "button(s) or link(s) without an accessible name (WCAG 4.1.2, 2.4.4)", {
  why: "An icon button or image link without a name is announced as \"button\" or \"link\": its purpose is unknown to screen reader users.",
  fix: "Add visible text, an aria-label, or alt text on the image inside the link or button.",
  acceptance: "axe-core reports no button-name, link-name or input-button-name violation on the rendered page.",
});
const A11Y004 = axeRule("A11Y-004", 1, "heuristic", ["target-size"], "tap target(s) smaller than 24×24 px without enough spacing (WCAG 2.5.8)", {
  why: "Small, tightly packed targets cause mis-taps on touch screens and are hard to hit for people with motor impairments.",
  fix: "Make targets at least 24×24 CSS px, or space them so a 24 px circle around each does not overlap its neighbours.",
  acceptance: "axe-core reports no target-size violation on the rendered page (412 px wide viewport).",
});

export const RENDERED_RULES = { IDX: [IDX018], AIS: [AIS004], LNK: [LNK009], IMG: [IMG009], PERF: [PERF001, PERF003, PERF007, PERF009, PERF011], A11Y: [A11Y001, A11Y002, A11Y003, A11Y004] };

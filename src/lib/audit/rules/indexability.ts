import { excerpt } from "../parse";
import type { CriterionEvaluator, RuleDef } from "../rule";

export type IndexabilityFacts = {
  /** Combined content of <meta name="robots"> and <meta name="googlebot">, or null if none. */
  metaRobots: string | null;
  /** X-Robots-Tag response header, or null if absent. */
  xRobotsTag: string | null;
  metaNoindex: boolean;
  headerNoindex: boolean;
  metaNofollow: boolean;
  headerNofollow: boolean;
  /** Robots directives that both allow and forbid indexing, e.g. "index, noindex". */
  contradictory: boolean;
};

const NOINDEX = /(^|[\s,:])(noindex|none)(?=$|[\s,])/i;
const NOFOLLOW = /(^|[\s,:])(nofollow|none)(?=$|[\s,])/i;
const INDEX = /(^|[\s,:])index(?=$|[\s,])/i;

export const indexabilityEvaluators: Record<string, CriterionEvaluator> = {
  "robots.meta-no-noindex": (f) => ({
    passed: f.metaNoindex === false,
    actual: f.metaRobots ? `meta robots: "${f.metaRobots}"` : "no robots meta",
  }),
  "robots.header-no-noindex": (f) => ({
    passed: f.headerNoindex === false,
    actual: f.xRobotsTag ? `X-Robots-Tag: "${f.xRobotsTag}"` : "no X-Robots-Tag header",
  }),
  "robots.has-noindex": (f) => ({
    passed: f.metaNoindex === true || f.headerNoindex === true,
    actual: `meta robots: ${f.metaRobots ? `"${f.metaRobots}"` : "none"}; X-Robots-Tag: ${f.xRobotsTag ? `"${f.xRobotsTag}"` : "none"}`,
  }),
  "robots.no-nofollow": (f) => ({
    passed: f.metaNofollow === false && f.headerNofollow === false,
    actual: `meta robots: ${f.metaRobots ? `"${f.metaRobots}"` : "none"}; X-Robots-Tag: ${f.xRobotsTag ? `"${f.xRobotsTag}"` : "none"}`,
  }),
  "robots.not-contradictory": (f) => ({
    passed: f.contradictory === false,
    actual: `meta robots: ${f.metaRobots ? `"${f.metaRobots}"` : "none"}; X-Robots-Tag: ${f.xRobotsTag ? `"${f.xRobotsTag}"` : "none"}`,
  }),
};

const WHY_INDEX = "Robots directives decide whether search engines may show this page. A mismatch with intent either hides a page that should rank or exposes one that should not.";

export const indexabilityRule: RuleDef<IndexabilityFacts> = {
  id: "indexability",
  name: "Indexability",
  category: "indexability",

  observe({ $, headers }) {
    const metas = $("meta").filter((_, el) => /^(robots|googlebot)$/i.test($(el).attr("name") ?? ""));
    const metaRobots = metas.length
      ? metas
          .toArray()
          .map((el) => $(el).attr("content") ?? "")
          .join(", ")
      : null;
    const xRobotsTag = headers["x-robots-tag"] ?? null;
    const snippets = metas.toArray().map((el) => excerpt($.html(el)));
    if (xRobotsTag) snippets.push(`X-Robots-Tag: ${xRobotsTag}`);
    const all = [metaRobots, xRobotsTag].filter(Boolean).join(", ");
    return {
      facts: {
        metaRobots,
        xRobotsTag,
        metaNoindex: metaRobots !== null && NOINDEX.test(metaRobots),
        headerNoindex: xRobotsTag !== null && NOINDEX.test(xRobotsTag),
        metaNofollow: metaRobots !== null && NOFOLLOW.test(metaRobots),
        headerNofollow: xRobotsTag !== null && NOFOLLOW.test(xRobotsTag),
        contradictory: INDEX.test(all) && NOINDEX.test(all),
      },
      snippets,
    };
  },

  checks: [
    {
      code: "indexability/unexpected-noindex",
      severity: "high",
      kind: "defect",
      certainty: "verified",
      why: WHY_INDEX,
      needs: ["indexability"],
      expectationKey: () => "indexability=index",
      detect: (f, exp) => exp.indexability === "index" && (f.metaNoindex || f.headerNoindex),
      criteria: () => [
        { id: "robots.meta-no-noindex", description: "No robots/googlebot meta tag contains noindex or none", params: {} },
        { id: "robots.header-no-noindex", description: "The X-Robots-Tag header does not contain noindex or none", params: {} },
      ],
      describe: (f) => ({
        title: "Page is blocked from indexing",
        message: "This page is configured to be indexed, but it tells search engines not to index it.",
        observed: [
          f.metaNoindex ? `meta robots "${f.metaRobots}"` : null,
          f.headerNoindex ? `X-Robots-Tag "${f.xRobotsTag}"` : null,
        ]
          .filter(Boolean)
          .join(" and "),
        expected: "No noindex directive in robots meta tags or the X-Robots-Tag header",
        recommendations: [
          "Remove noindex (or none) from the robots meta tag.",
          "Check server/CDN config for an X-Robots-Tag header.",
        ],
        diagnosis: "A noindex on a page meant to rank is frequently left over from a staging environment or a CMS 'discourage search engines' setting. Confirm before changing.",
      }),
    },
    {
      code: "indexability/missing-noindex",
      severity: "medium",
      kind: "defect",
      certainty: "verified",
      why: WHY_INDEX,
      needs: ["indexability"],
      expectationKey: () => "indexability=noindex",
      detect: (f, exp) => exp.indexability === "noindex" && !f.metaNoindex && !f.headerNoindex,
      criteria: () => [
        { id: "robots.has-noindex", description: "A robots meta tag or X-Robots-Tag header contains noindex", params: {} },
      ],
      describe: (f) => ({
        title: "Page should be noindex but is indexable",
        message: "This page is configured to stay out of search results, but it has no noindex directive.",
        observed: `meta robots: ${f.metaRobots ?? "none"}; X-Robots-Tag: ${f.xRobotsTag ?? "none"}`,
        expected: "noindex in a robots meta tag or the X-Robots-Tag header",
        recommendations: [
          'Add <meta name="robots" content="noindex"> to <head>, or send an X-Robots-Tag: noindex header.',
          "Do not block the page in robots.txt as well, or crawlers cannot see the noindex.",
        ],
      }),
    },
    {
      code: "indexability/contradictory",
      severity: "medium",
      kind: "warning",
      certainty: "verified",
      why: "When directives conflict, search engines apply the most restrictive one, which may not be what was intended.",
      detect: (f) => f.contradictory,
      criteria: () => [
        { id: "robots.not-contradictory", description: "Robots directives do not both allow and forbid indexing", params: {} },
      ],
      describe: (f) => ({
        title: "Contradictory robots directives",
        message: "The page's robots directives contain both index and noindex. Search engines will treat it as noindex.",
        observed: `meta robots: ${f.metaRobots ?? "none"}; X-Robots-Tag: ${f.xRobotsTag ?? "none"}`,
        expected: "One consistent indexing directive",
        recommendations: ["Remove whichever directive does not match the page's intended indexing."],
      }),
    },
    {
      code: "indexability/nofollow-on-indexable",
      severity: "low",
      kind: "warning",
      certainty: "needs_review",
      why: "A page-level nofollow stops search engines from following any link on the page, which can hide linked pages. It is sometimes intentional.",
      needs: ["indexability"],
      expectationKey: () => "indexability=index",
      detect: (f, exp) => exp.indexability === "index" && (f.metaNofollow || f.headerNofollow),
      criteria: () => [{ id: "robots.no-nofollow", description: "No page-level nofollow directive", params: {} }],
      describe: (f) => ({
        title: "Indexable page has a page-level nofollow",
        message: "This page is meant to be indexed but tells search engines not to follow any of its links.",
        observed: `meta robots: ${f.metaRobots ?? "none"}; X-Robots-Tag: ${f.xRobotsTag ?? "none"}`,
        expected: "No page-level nofollow on an indexable page (unless intended)",
        recommendations: ["Remove nofollow from the robots directives, or use rel=nofollow on the specific links instead."],
      }),
    },
  ],
};

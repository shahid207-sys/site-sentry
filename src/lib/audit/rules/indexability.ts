import { excerpt } from "../parse";
import type { CriterionEvaluator, RuleDef } from "../rule";

export type IndexabilityFacts = {
  /** Combined content of <meta name="robots"> and <meta name="googlebot">, or null if none. */
  metaRobots: string | null;
  /** X-Robots-Tag response header, or null if absent. */
  xRobotsTag: string | null;
  metaNoindex: boolean;
  headerNoindex: boolean;
};

const NOINDEX = /(^|[\s,:])(noindex|none)(?=$|[\s,])/i;

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
};

export const indexabilityRule: RuleDef<IndexabilityFacts> = {
  id: "indexability",
  name: "Indexability",
  needs: ["indexability"],

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
    return {
      facts: {
        metaRobots,
        xRobotsTag,
        metaNoindex: metaRobots !== null && NOINDEX.test(metaRobots),
        headerNoindex: xRobotsTag !== null && NOINDEX.test(xRobotsTag),
      },
      snippets,
    };
  },

  checks: [
    {
      code: "indexability/unexpected-noindex",
      severity: "high",
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
          "Check server/CDN config for an X-Robots-Tag header, often left over from a staging environment.",
        ],
      }),
    },
    {
      code: "indexability/missing-noindex",
      severity: "medium",
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
  ],
};

import type { CriterionEvaluator, RuleDef } from "../rule";
import { num } from "../rule";
import type { Doc } from "../parse";

export type ContentFacts = {
  wordCount: number;
  /** Which element the count was taken from: main, article, or body minus navigation/boilerplate. */
  contentSource: string;
};

/** Visible main-content words. Strips scripts, styles and common boilerplate regions. */
export function mainContentWords($: Doc): { words: number; source: string } {
  const pick = $("main").first().length ? "main" : $("article").first().length ? "article" : "body";
  const root = $(pick).first().clone();
  root.find("script, style, noscript, template, svg, nav, header, footer, aside, form").remove();
  const text = root.text().replace(/\s+/g, " ").trim();
  const words = text ? text.split(" ").filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0;
  return { words, source: pick };
}

export const contentEvaluators: Record<string, CriterionEvaluator> = {
  "content.min-words": (f, p) => {
    const n = num(f.wordCount);
    return { passed: n !== null && n >= Number(p.min), actual: `${n ?? "unknown"} words in <${f.contentSource}>` };
  },
};

export const contentRule: RuleDef<ContentFacts> = {
  id: "content",
  name: "Content (heuristic)",
  category: "content",

  observe({ $ }) {
    const { words, source } = mainContentWords($);
    return {
      facts: { wordCount: words, contentSource: source },
      snippets: [`${words} words counted in <${source}> (scripts, navigation, header, footer and forms excluded)`],
    };
  },

  checks: [
    {
      code: "content/thin",
      severity: "low",
      kind: "observation",
      certainty: "heuristic",
      why: "Very little text can mean the page is a placeholder or relies on content search engines cannot read. A word count says nothing about quality; many good pages are short.",
      detect: (f, _exp, config) => f.wordCount < config.thinContentWords,
      criteria: (_exp, config) => [
        {
          id: "content.min-words",
          description: `Main content has at least ${config.thinContentWords} words (configurable heuristic)`,
          params: { min: config.thinContentWords },
        },
      ],
      describe: (f, _exp, config) => ({
        title: "Possibly thin content (heuristic)",
        message: `About ${f.wordCount} words of main content, under the configured threshold of ${config.thinContentWords}.`,
        observed: `${f.wordCount} words in <${f.contentSource}>`,
        expected: `≥ ${config.thinContentWords} words, or a confirmed reason the page is short`,
        recommendations: [
          "Check whether the page fully answers what a visitor needs; add substance if not.",
          "If content is loaded by JavaScript, confirm it renders for search engines (Site Sentry reads raw HTML only).",
          "If the page is intentionally short, adjust the threshold in Settings or mark the task Won't fix with a reason.",
        ],
      }),
    },
  ],
};

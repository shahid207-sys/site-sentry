import type { CriterionEvaluator, RuleDef } from "../rule";
import { num } from "../rule";
import type { Doc } from "../parse";

export type ContentFacts = {
  wordCount: number;
  /** Which element the count was taken from: main, article, or body minus navigation/boilerplate. */
  contentSource: string;
};

const BLOCKS = "address, article, aside, blockquote, br, dd, div, dl, dt, figcaption, figure, footer, h1, h2, h3, h4, h5, h6, header, hr, li, main, nav, ol, p, pre, section, table, td, th, tr, ul";

/** Text of a (cloned, disposable) element with block boundaries kept as spaces, so "<h1>A</h1><p>B</p>" reads "A B". */
export function blockText(root: ReturnType<Doc>): string {
  root.find(BLOCKS).after(" ");
  return root.text().replace(/\s+/g, " ").trim();
}

/** Regions that are page furniture, not content: by element, or by ARIA landmark role (page builders often use <div role="navigation">). */
export const BOILERPLATE =
  'script, style, noscript, template, svg, nav, header, footer, aside, form, [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [role="search"]';

/** Visible main-content text: <main>, else <article>, else <body>, without scripts, styles and boilerplate regions. */
export function mainContentText($: Doc): { text: string; source: "main" | "article" | "body" } {
  const pick = mainContentSource($);
  const root = $(pick === "main" ? "main, [role=main]" : pick).first().clone();
  root.find(BOILERPLATE).remove();
  return { text: blockText(root), source: pick };
}

/** Which element holds the main content: <main> (or role=main), else <article>, else <body>. */
export function mainContentSource($: Doc): "main" | "article" | "body" {
  return $("main, [role=main]").first().length ? "main" : $("article").first().length ? "article" : "body";
}

/** Visible main-content words. Strips scripts, styles and common boilerplate regions. */
export function mainContentWords($: Doc): { words: number; source: string } {
  const { text, source } = mainContentText($);
  const words = text ? text.split(" ").filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0;
  return { words, source };
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

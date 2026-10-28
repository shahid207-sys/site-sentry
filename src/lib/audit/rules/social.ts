import { excerpt } from "../parse";
import type { CriterionEvaluator, RuleDef } from "../rule";

export type SocialFacts = {
  ogTitle: boolean;
  ogDescription: boolean;
  ogImage: boolean;
  ogUrl: string | null;
  twitterCard: string | null;
  /** Comma-separated list of missing basic tags, or null. */
  missingOg: string | null;
};

const present = (v: unknown) => (v === true ? "present" : "missing");

export const socialEvaluators: Record<string, CriterionEvaluator> = {
  "og.title": (f) => ({ passed: f.ogTitle === true, actual: `og:title ${present(f.ogTitle)}` }),
  "og.description": (f) => ({ passed: f.ogDescription === true, actual: `og:description ${present(f.ogDescription)}` }),
  "og.image": (f) => ({ passed: f.ogImage === true, actual: `og:image ${present(f.ogImage)}` }),
};

export const socialRule: RuleDef<SocialFacts> = {
  id: "social",
  name: "Social sharing metadata",
  category: "social",

  observe({ $ }) {
    const prop = (name: string) =>
      $("meta").filter((_, el) => (($(el).attr("property") ?? $(el).attr("name")) ?? "").toLowerCase() === name);
    const val = (name: string) => prop(name).first().attr("content")?.trim() || null;
    const ogTitle = !!val("og:title");
    const ogDescription = !!val("og:description");
    const ogImage = !!val("og:image");
    const missing = [!ogTitle && "og:title", !ogDescription && "og:description", !ogImage && "og:image"].filter(Boolean);
    const tags = ["og:title", "og:description", "og:image", "og:url", "twitter:card"].flatMap((n) =>
      prop(n).toArray().slice(0, 1).map((el) => excerpt($.html(el), 200)),
    );
    return {
      facts: { ogTitle, ogDescription, ogImage, ogUrl: val("og:url"), twitterCard: val("twitter:card"), missingOg: missing.length ? missing.join(", ") : null },
      snippets: tags.length ? tags : ["No Open Graph or Twitter card meta tags"],
    };
  },

  checks: [
    {
      code: "social/missing-open-graph",
      severity: "low",
      kind: "opportunity",
      certainty: "verified",
      why: "Social platforms and chat apps use Open Graph tags to build link previews. Without them the preview is guessed or blank. This has no direct effect on search rankings.",
      detect: (f) => !f.ogTitle || !f.ogDescription || !f.ogImage,
      criteria: () => [
        { id: "og.title", description: "og:title is present", params: {} },
        { id: "og.description", description: "og:description is present", params: {} },
        { id: "og.image", description: "og:image is present", params: {} },
      ],
      describe: (f) => ({
        title: "Incomplete Open Graph metadata",
        message: `Missing: ${f.missingOg}.`,
        observed: `Missing ${f.missingOg}`,
        expected: "og:title, og:description and og:image",
        recommendations: ["Add the missing Open Graph tags in the page template (most SEO plugins can generate them)."],
      }),
    },
  ],
};

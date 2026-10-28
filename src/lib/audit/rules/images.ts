import { excerpt } from "../parse";
import type { CriterionEvaluator, RuleDef } from "../rule";
import { num } from "../rule";

export type ImageFacts = {
  imageCount: number;
  missingAlt: number;
  /** alt="" on an image not otherwise marked decorative (role=presentation / aria-hidden). */
  emptyAltUnmarked: number;
  /** alt="" with role=presentation/none or aria-hidden=true: intentionally decorative. */
  decorative: number;
  missingDimensions: number;
};

export const imageEvaluators: Record<string, CriterionEvaluator> = {
  "images.alt-present": (f) => ({ passed: num(f.missingAlt) === 0, actual: `${f.missingAlt} of ${f.imageCount} image(s) without an alt attribute` }),
  "images.empty-alt-reviewed": (f) => ({ passed: num(f.emptyAltUnmarked) === 0, actual: `${f.emptyAltUnmarked} image(s) with alt="" not marked decorative` }),
  "images.dimensions": (f) => ({ passed: num(f.missingDimensions) === 0, actual: `${f.missingDimensions} image(s) without width and height` }),
};

export const imagesRule: RuleDef<ImageFacts> = {
  id: "images",
  name: "Images",
  category: "images",

  observe({ $ }) {
    const imgs = $("img").toArray();
    const missing: string[] = [];
    const emptyUnmarked: string[] = [];
    const noDims: string[] = [];
    let decorative = 0;
    for (const el of imgs) {
      const $el = $(el);
      const alt = $el.attr("alt");
      const html = excerpt($.html(el), 200);
      const marked = /^(presentation|none)$/i.test($el.attr("role") ?? "") || $el.attr("aria-hidden") === "true";
      if (alt === undefined) missing.push(html);
      else if (alt.trim() === "") {
        if (marked) decorative++;
        else emptyUnmarked.push(html);
      }
      if (!$el.attr("width") || !$el.attr("height")) noDims.push(html);
    }
    return {
      facts: {
        imageCount: imgs.length,
        missingAlt: missing.length,
        emptyAltUnmarked: emptyUnmarked.length,
        decorative,
        missingDimensions: noDims.length,
      },
      snippets: [
        ...missing.slice(0, 5).map((s) => `no alt: ${s}`),
        ...emptyUnmarked.slice(0, 3).map((s) => `empty alt: ${s}`),
        ...noDims.slice(0, 3).map((s) => `no width/height: ${s}`),
      ].slice(0, 10),
    };
  },

  checks: [
    {
      code: "images/missing-alt",
      severity: "medium",
      kind: "defect",
      certainty: "verified",
      why: "Images without an alt attribute are announced poorly by screen readers and give search engines no text description.",
      detect: (f) => f.missingAlt > 0,
      criteria: () => [{ id: "images.alt-present", description: "Every <img> has an alt attribute", params: {} }],
      describe: (f) => ({
        title: "Images missing alt attributes",
        message: `${f.missingAlt} of ${f.imageCount} image(s) have no alt attribute.`,
        observed: `${f.missingAlt} <img> without alt`,
        expected: 'Every <img> has alt text, or alt="" if purely decorative',
        recommendations: ["Describe informative images in alt text.", 'Use alt="" for decorative images so screen readers skip them.'],
      }),
    },
    {
      code: "images/empty-alt",
      severity: "low",
      kind: "observation",
      certainty: "needs_review",
      why: 'alt="" is correct for decorative images. Images that carry information need a description. Only a person can tell which is which.',
      detect: (f) => f.emptyAltUnmarked > 0,
      criteria: () => [{ id: "images.empty-alt-reviewed", description: 'Images with alt="" are informative-free or marked decorative', params: {} }],
      describe: (f) => ({
        title: "Images with empty alt text",
        message: `${f.emptyAltUnmarked} image(s) use alt="" without being marked decorative. Confirm each is decorative.`,
        observed: `${f.emptyAltUnmarked} <img alt="">`,
        expected: 'Informative images described; decorative ones may keep alt="" (optionally role="presentation")',
        recommendations: ["Review each image: add alt text if it conveys information.", 'Mark truly decorative images with role="presentation" to record the decision.'],
      }),
    },
    {
      code: "images/missing-dimensions",
      severity: "low",
      kind: "opportunity",
      certainty: "verified",
      why: "A layout-stability improvement, not a ranking defect: without width and height, browsers cannot reserve space before the image loads, which can cause layout shift (CLS).",
      detect: (f) => f.missingDimensions > 0,
      criteria: () => [{ id: "images.dimensions", description: "Every <img> has width and height attributes", params: {} }],
      describe: (f) => ({
        title: "Images without width/height (layout stability)",
        message: `${f.missingDimensions} image(s) have no width and height attributes in the HTML.`,
        observed: `${f.missingDimensions} <img> without width/height`,
        expected: "width and height attributes on each <img> (CSS can still resize it)",
        recommendations: ["Add the intrinsic width and height to each <img>.", "Images sized purely by CSS aspect-ratio may be fine; verify layout shift in the field."],
      }),
    },
  ],
};

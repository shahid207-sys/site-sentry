// The short texts that repeat once per card of a listing: "Request a quote" under every product, "View project" under
// every project. Pure: reads a parsed document.
import type { Doc } from "../audit/parse";

type Node = ReturnType<Doc>;
type El = Parameters<Doc>[0];

/** Siblings of one shape, at least this many, are cards of a listing. */
export const CARD_MIN_SIBLINGS = 3;
/** Card texts are short: a title, a caption, a button. */
export const CARD_TEXT_MAX_WORDS = 8;
const CARD_MAX_DESCENDANTS = 300;
const CARD_TEXTS_CAP = 200;

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
const attr = (el: El, name: string) => ((el as { attribs?: Record<string, string> }).attribs?.[name] ?? "");
const tag = (el: El) => ((el as { tagName?: string }).tagName ?? "").toLowerCase();

/**
 * What siblings of one listing share: the tag and the first class without digits. Later classes differ per card on
 * most CMSs ("post-5952 product_cat-keychains"), and the first ("card", "product", "kt-blocks-post-grid-item") does not.
 */
function shapeOf(el: El): string {
  const first = attr(el, "class").toLowerCase().split(/\s+/).find((c) => c && !/\d/.test(c)) ?? "";
  return `${tag(el)}.${first}`;
}

/** The short texts of one card: its links, headings and the elements that hold text of their own. */
function shortTexts($: Doc, card: El): Set<string> {
  const out = new Set<string>();
  const add = (t: string) => {
    const s = collapse(t).toLowerCase();
    if (s && s.split(" ").length <= CARD_TEXT_MAX_WORDS) out.add(s);
  };
  $(card)
    .find("*")
    .addBack()
    .each((_, el) => {
      const name = tag(el);
      if (/^(script|style|noscript|template|svg)$/.test(name)) return;
      const own = ((el as { children?: { type?: string; data?: string }[] }).children ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.data ?? "")
        .join(" ");
      if (name === "a" || /^h[1-6]$/.test(name) || name === "button" || own.trim()) add($(el).text());
      // "View project<span class=screen-reader-text>Mosque model</span>": the visible words repeat, the hidden ones do not.
      if (own.trim()) add(own);
    });
  return out;
}

/**
 * Short texts that repeat once per card: in at least CARD_MIN_SIBLINGS sibling elements of one shape, the same text
 * ("Request a quote", "View project", "31.50 AED"). Lower-cased, with how many cards carry each.
 */
export function cardTexts($: Doc, root: Node): { text: string; n: number }[] {
  const best = new Map<string, number>();
  root.find("*").each((_, parent) => {
    const kids = $(parent).children().toArray();
    if (kids.length < CARD_MIN_SIBLINGS) return;
    const byShape = new Map<string, El[]>();
    for (const k of kids) {
      if (/^(script|style|br|hr|img|source)$/.test(tag(k))) continue;
      byShape.set(shapeOf(k), [...(byShape.get(shapeOf(k)) ?? []), k]);
    }
    for (const [shape, cards] of byShape) {
      // Paragraphs and plain <div>s side by side are prose, not cards: a card has a class, or is a list item or article.
      if (cards.length < CARD_MIN_SIBLINGS || (shape.endsWith(".") && !/^(li|article)\.$/.test(shape))) continue;
      const counts = new Map<string, number>();
      for (const c of cards) {
        if ($(c).find("*").length > CARD_MAX_DESCENDANTS) continue;
        for (const t of shortTexts($, c)) counts.set(t, (counts.get(t) ?? 0) + 1);
      }
      for (const [t, n] of counts) if (n >= CARD_MIN_SIBLINGS && n > (best.get(t) ?? 0)) best.set(t, n);
    }
  });
  return [...best]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, CARD_TEXTS_CAP)
    .map(([text, n]) => ({ text, n }));
}

// Main-content text without page furniture, and the short texts that repeat once per card of a listing.
// Pure: reads a parsed document, changes only clones.
import { blockText, BOILERPLATE, mainContentSource } from "../audit/rules/content";
import type { Doc } from "../audit/parse";

type Node = ReturnType<Doc>;
type El = Parameters<Doc>[0];

/** A block whose link text is more than this share of its text is a menu or a link list, not content. */
export const LINK_DENSITY_MAX = 0.5;
/** ...when it holds at least this many links: one linked sentence in a short paragraph is content. */
export const LINK_DENSITY_MIN_LINKS = 5;
/** A block named as a menu is dropped only when links are at least this share of its text, so a wrapper that happens
 * to carry "menu" in a class ("has-mega-menu" on the page shell) keeps its content. */
export const NAMED_MENU_MIN_DENSITY = 0.3;
/** A link-dense block with this many headings, or with one and an image, is a listing (a product grid, a post list):
 * the page's content, even with one or two products. */
export const LISTING_MIN_HEADINGS = 2;
const MENU_ROLES = '[role="navigation"], [role="menu"], [role="menubar"]';
const MENU_WORD = /^(nav|navbar|navigation|menu|menus|mega|megamenu|mega-menu)$|^(nav|menu|mega)|(nav|menu)$/;
const CANDIDATES = "ul, ol, div, section, aside, table, details, dl";

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
const attr = (el: El, name: string) => ((el as { attribs?: Record<string, string> }).attribs?.[name] ?? "");

/** Class and id words, split on spaces, hyphens and underscores: "main-navigation" has "navigation". */
function namedAsMenu(el: El): boolean {
  const words = `${attr(el, "class")} ${attr(el, "id")}`.toLowerCase().split(/[\s_-]+/).filter(Boolean);
  return words.some((w) => MENU_WORD.test(w)) || /mega-?menu|main-?nav|site-?nav/.test(`${attr(el, "class")} ${attr(el, "id")}`.toLowerCase());
}

function linkDensity($: Doc, n: Node): { density: number; links: number } {
  const text = collapse(n.text()).length;
  if (!text) return { density: 0, links: 0 };
  let linked = 0;
  // Every anchor: a menu's parent items are often <a> without href, opened by script.
  const anchors = n.find("a");
  anchors.each((_, a) => {
    if ($(a).parents("a").length) return;
    linked += collapse($(a).text()).length;
  });
  return { density: linked / text, links: anchors.length };
}

function isListing(n: Node): boolean {
  const headings = n.find("h2, h3, h4, h5, h6").length;
  return headings >= LISTING_MIN_HEADINGS || (headings > 0 && n.find("img").length > 0);
}

/**
 * The element main text is read from (<main>, else <article>, else <body>), cloned, without boilerplate regions
 * (BOILERPLATE), blocks named or marked as menus, and blocks that are mostly links. Every block is judged on the page
 * as served, then the chosen ones go: a menu inside a content column goes whole and the column stays. A block that
 * holds the page's <h1>, or a listing of cards with their own headings, is never dropped.
 */
export function contentRoot($: Doc): Node {
  const pick = mainContentSource($);
  const root = $(pick === "main" ? "main, [role=main]" : pick).first().clone();
  root.find(BOILERPLATE).remove();
  root.find(MENU_ROLES).remove();
  const drop = root
    .find(CANDIDATES)
    .toArray()
    .filter((el) => {
      const n = $(el);
      if (n.find("h1").length || isListing(n)) return false;
      const { density, links } = linkDensity($, n);
      return (namedAsMenu(el) && density >= NAMED_MENU_MIN_DENSITY) || (links >= LINK_DENSITY_MIN_LINKS && density > LINK_DENSITY_MAX);
    });
  $(drop).remove();
  return root;
}

/** Main-content text: contentRoot's text with block boundaries read as spaces. */
export function mainText($: Doc): string {
  return blockText(contentRoot($));
}

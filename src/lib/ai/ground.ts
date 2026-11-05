// The grounding validator (docs/SPEC.md "AI analysis"). Nothing from the model reaches a stored analysis without it:
// a citation must name a finding of this crawl, or a URL plus a quote that really is in that URL's stored text. An item
// with no valid citation left is dropped, and so is one that claims anything about rankings, traffic or penalties.
// A rewrite is also dropped when it is not in its page's detected language.
import { languageMismatch } from "./language";
import type { AiOutput, Citation, DroppedCounts, GroundedAnalysis } from "./schema";

export const MAX_QUOTE_WORDS = 25;

export interface GroundingContext {
  /** Rule IDs with an issue group in this crawl. */
  findingIds: ReadonlySet<string>;
  /** Stored text per URL: the full title, description, headings, main text and OG tags, not the trimmed copy sent. */
  pageText: ReadonlyMap<string, string>;
  /** Detected language per URL (null when unknown). A rewrite for a URL must be in that language. */
  pageLanguage?: ReadonlyMap<string, string | null>;
}

/** Claims this layer has no data for. Checked on the model's prose, never on quotes or on rewrite copy. */
export const BANNED_CLAIM = /\b(rank(?:s|ed|ing|ings)?|serps?|traffic|penal(?:ty|ties|ise[ds]?|ize[ds]?|ising|izing)|deindex(?:ed|ing)?|algorithm(?:ic)? (?:update|hit)|core update)\b/i;

/** Lowercased, NFKC, straight quotes and dashes, one space between words, so a typographic difference is not a miss. */
export function normaliseText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** One key for a URL however it was written: decoded, no fragment, no trailing slash. */
export function urlKey(u: string): string {
  let s = u.trim().replace(/#.*$/, "");
  try {
    s = decodeURI(s);
  } catch {
    // Not valid percent-encoding: compare it as written.
  }
  return s.replace(/\/+$/, "");
}

const trimQuote = (q: string) => q.trim().replace(/^[\s"'`.…]+|[\s"'`.…]+$/g, "");
const wordsIn = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Words the prose itself puts in quotation marks (three words or more; shorter ones are terms, not quotes). */
function inlineQuotes(text: string): string[] {
  return [...text.matchAll(/["“]([^"“”]+)["”]/g)].map((m) => m[1]).filter((q) => wordsIn(q) >= 3);
}

export function groundAnalysis(raw: AiOutput, ctx: GroundingContext): { analysis: GroundedAnalysis; dropped: DroppedCounts } {
  const dropped: DroppedCounts = { items: 0, citations: 0, bannedClaims: 0, unsupportedQuotes: 0, wrongLanguage: 0 };
  const pages = new Map([...ctx.pageText].map(([u, t]) => [urlKey(u), normaliseText(t)]));
  const languages = new Map([...(ctx.pageLanguage ?? [])].map(([u, l]) => [urlKey(u), l]));
  /** An English title for an Arabic page is no rewrite of it: the whole rewrite goes. */
  const inPageLanguage = (r: AiOutput["rewrites"][number]) => {
    if (!languageMismatch([r.title, r.description, r.h1].join(". "), languages.get(urlKey(r.url)))) return true;
    dropped.items++;
    dropped.wrongLanguage++;
    return false;
  };
  const everything = [...pages.values()];

  const validCitation = (c: Citation): boolean => {
    if (c.findingId && ctx.findingIds.has(c.findingId)) return true;
    if (!c.url || !c.quote) return false;
    const quote = trimQuote(c.quote);
    if (!quote || wordsIn(quote) > MAX_QUOTE_WORDS) return false;
    return pages.get(urlKey(c.url))?.includes(normaliseText(quote)) ?? false;
  };

  /** The item with its valid citations, or null when it must go. `prose` is what the model asserts in its own words. */
  function keep<T extends { citations: Citation[] }>(item: T, prose: string[]): T | null {
    const citations = item.citations.filter(validCitation);
    dropped.citations += item.citations.length - citations.length;
    if (prose.some((p) => BANNED_CLAIM.test(p))) {
      dropped.items++;
      dropped.bannedClaims++;
      return null;
    }
    const quoted = prose.flatMap(inlineQuotes);
    if (quoted.some((q) => wordsIn(q) > MAX_QUOTE_WORDS || !everything.some((t) => t.includes(normaliseText(trimQuote(q)))))) {
      dropped.items++;
      dropped.unsupportedQuotes++;
      return null;
    }
    if (!citations.length) {
      dropped.items++;
      return null;
    }
    return { ...item, citations };
  }
  const filter = <T extends { citations: Citation[] }>(xs: T[], prose: (x: T) => string[]) => xs.map((x) => keep(x, prose(x))).filter((x): x is T => x !== null);
  const points = (xs: AiOutput["actionPlan"]["thisWeek"]) => filter(xs, (x) => [x.text]);

  const analysis: GroundedAnalysis = {
    executiveSummary: { strengths: points(raw.executiveSummary.strengths), weaknesses: points(raw.executiveSummary.weaknesses) },
    qualityIssues: filter(raw.qualityIssues, (x) => [x.issue, x.fix]),
    // Rewrite copy is a proposal, not a claim: a printer may sell "traffic signs". Only the citations are checked.
    rewrites: filter(raw.rewrites.filter(inPageLanguage), () => []).map((r) => ({ ...r, titleChars: [...r.title].length, descriptionChars: [...r.description].length })),
    strategy: filter(raw.strategy, (x) => [x.text]),
    actionPlan: { thisWeek: points(raw.actionPlan.thisWeek), thisQuarter: points(raw.actionPlan.thisQuarter) },
  };
  return { analysis, dropped };
}

/** Items left in an analysis without a citation: the Gate C check, always zero after groundAnalysis. */
export function uncitedItems(a: GroundedAnalysis): number {
  const all: { citations: Citation[] }[] = [...a.executiveSummary.strengths, ...a.executiveSummary.weaknesses, ...a.qualityIssues, ...a.rewrites, ...a.strategy, ...a.actionPlan.thisWeek, ...a.actionPlan.thisQuarter];
  return all.filter((x) => !x.citations.length).length;
}

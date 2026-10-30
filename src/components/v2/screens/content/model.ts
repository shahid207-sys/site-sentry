// Pure numbers of the Content screen (no React): duplicate clusters by kind, the word-count distribution, missing
// title / description / H1 counts over URL rows, and the thin-content list.
//
// The thin-content threshold is CNT-005's THIN_WORDS, but src/lib/rules/cnt.ts imports node:crypto (via
// snapshot/text), so the browser cannot load it. The screen reads the threshold from the rule's own output instead:
// the "(threshold N)" in a CNT-005 finding message, else the "At least N words" of its acceptance text in the rule
// catalog (/api/<ws>/rules). The thin list itself is CNT-005's findings, so it agrees with the Issues screen.
import type { DuplicateCluster } from "@/lib/results/queries";
import type { IssueRow, UrlRow } from "@/lib/results/explore";
import { OPEN_STATES } from "../issues/filter";
import { READ_STATES } from "../urls/filter";

// ---------- duplicates ----------

export type DuplicateKind = "title" | "description" | "content" | "near";

export const DUPLICATE_KINDS: { id: DuplicateKind; ruleId: string; label: string; keyLabel: string }[] = [
  { id: "title", ruleId: "META-004", label: "Same title", keyLabel: "Title" },
  { id: "description", ruleId: "META-009", label: "Same description", keyLabel: "Meta description" },
  { id: "content", ruleId: "CNT-006", label: "Same content", keyLabel: "Content hash" },
  { id: "near", ruleId: "CNT-007", label: "Near-duplicate content", keyLabel: "Cluster" },
];

const KIND_OF_RULE = new Map(DUPLICATE_KINDS.map((k) => [k.ruleId, k.id]));

export const parseDuplicateKind = (v: string | null): DuplicateKind | null => (DUPLICATE_KINDS.some((k) => k.id === v) ? (v as DuplicateKind) : null);

/**
 * Clusters per kind, largest first (then by key). URLs inside a cluster are de-duplicated; clusters of fewer than two
 * distinct URLs are not duplicates and are dropped; rules other than the four duplicate rules are ignored.
 */
export function groupDuplicates(clusters: DuplicateCluster[]): Record<DuplicateKind, DuplicateCluster[]> {
  const out: Record<DuplicateKind, DuplicateCluster[]> = { title: [], description: [], content: [], near: [] };
  for (const c of clusters) {
    const kind = KIND_OF_RULE.get(c.ruleId);
    if (!kind) continue;
    const urls = [...new Set(c.urls)];
    if (urls.length < 2) continue;
    out[kind].push({ ...c, urls });
  }
  for (const k of Object.keys(out) as DuplicateKind[]) out[k].sort((a, b) => b.urls.length - a.urls.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

/** Pages in a kind's clusters (each cluster's URLs; a URL is in at most one cluster of a kind). */
export const pagesIn = (clusters: DuplicateCluster[]) => clusters.reduce((n, c) => n + c.urls.length, 0);

// ---------- pages the content rules read ----------

/**
 * An HTML page answered 200 that has a page snapshot (word count known): the pages the title, description, H1 and
 * thin-content rules evaluate (isHtml200). Without a snapshot, missing fields would look like missing tags.
 */
export const isContentPage = (r: Pick<UrlRow, "state" | "status" | "contentType" | "wordCount">) =>
  READ_STATES.has(r.state) && r.status === 200 && /html/i.test(r.contentType ?? "") && r.wordCount !== null;

export interface MetaGaps {
  /** Content pages counted (isContentPage). */
  pages: number;
  /** No <title> element (META-001). */
  noTitle: number;
  /** A <title> with no text (META-002). */
  emptyTitle: number;
  /** No non-empty meta description in the first one (META-008 checks every description tag). */
  noDescription: number;
  /** No <h1> (CNT-001); an empty <h1> counts as present. */
  noH1: number;
}

export function metaGaps(rows: UrlRow[]): MetaGaps {
  const g: MetaGaps = { pages: 0, noTitle: 0, emptyTitle: 0, noDescription: 0, noH1: 0 };
  for (const r of rows) {
    if (!isContentPage(r)) continue;
    g.pages++;
    if (r.title === null) g.noTitle++;
    else if (!r.title.trim()) g.emptyTitle++;
    if (!r.description?.trim()) g.noDescription++;
    if (r.h1 === null) g.noH1++;
  }
  return g;
}

// ---------- word counts ----------

export const DEFAULT_WORD_EDGES = [0, 50, 100, 200, 300, 500, 1000, 2000];

export interface WordBucket {
  /** Inclusive lower bound. */
  from: number;
  /** Exclusive upper bound; null for the last, open-ended bucket. */
  to: number | null;
  label: string;
  pages: number;
  /** Every page in the bucket is under the thin-content threshold. */
  thin: boolean;
}

/**
 * Content pages per word-count range. The threshold, when known, becomes a bucket edge, so a bucket is either wholly
 * under it (thin) or wholly at or above it.
 */
export function wordBuckets(rows: UrlRow[], threshold: number | null, edges = DEFAULT_WORD_EDGES): WordBucket[] {
  const cuts = [...new Set([...edges, ...(threshold !== null && threshold > 0 ? [threshold] : [])])].filter((e) => e >= 0).sort((a, b) => a - b);
  if (cuts[0] !== 0) cuts.unshift(0);
  const buckets: WordBucket[] = cuts.map((from, i) => {
    const to = i + 1 < cuts.length ? cuts[i + 1] : null;
    return {
      from,
      to,
      label: to === null ? `${from.toLocaleString("en-GB")}+` : `${from.toLocaleString("en-GB")}–${(to - 1).toLocaleString("en-GB")}`,
      pages: 0,
      thin: threshold !== null && to !== null && to <= threshold,
    };
  });
  for (const r of rows) {
    if (!isContentPage(r)) continue;
    const w = r.wordCount!;
    // Last bucket whose lower bound is ≤ w (cuts are few, a linear scan is fine).
    let i = buckets.length - 1;
    while (i > 0 && w < buckets[i].from) i--;
    buckets[i].pages++;
  }
  return buckets;
}

// ---------- thin content ----------

/** CNT-005's threshold from its finding messages ("(threshold N)"), else from its acceptance text ("At least N words"). */
export function thinThreshold(messages: (string | null)[], acceptance?: string | null): number | null {
  for (const m of messages) {
    const x = m ? /\(threshold (\d+)\)/i.exec(m) : null;
    if (x) return Number(x[1]);
  }
  const a = acceptance ? /at least (\d+) words/i.exec(acceptance) : null;
  return a ? Number(a[1]) : null;
}

export interface ThinPage {
  url: string;
  state: IssueRow["state"];
  wordCount: number | null;
  inbound: number | null;
  title: string | null;
}

/** Open CNT-005 findings, one per URL, with the page's word count; fewest words first (unknown last), then URL. */
export function thinPages(issues: IssueRow[], urls: UrlRow[]): ThinPage[] {
  const byUrl = new Map(urls.map((u) => [u.url, u]));
  const seen = new Set<string>();
  const out: ThinPage[] = [];
  for (const i of issues) {
    if (!OPEN_STATES.includes(i.state) || seen.has(i.url)) continue;
    seen.add(i.url);
    const u = byUrl.get(i.url);
    out.push({ url: i.url, state: i.state, wordCount: u?.wordCount ?? null, inbound: u?.inbound ?? null, title: u?.title ?? null });
  }
  return out.sort((a, b) => {
    if (a.wordCount !== b.wordCount) {
      if (a.wordCount === null) return 1;
      if (b.wordCount === null) return -1;
      return a.wordCount - b.wordCount;
    }
    return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
  });
}

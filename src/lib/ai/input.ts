// What the AI analyst is given (docs/SPEC.md "AI analysis"), built from stored data only: nothing is fetched. The
// coverage summary, the top issue groups with evidence, and the homepage plus one sample page per top-10 template.
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { crawlOverview, groupEvidence, issueGroups } from "../results/queries";
import { RULE_TITLES } from "../rules/titles";
import type { GroundingContext } from "./ground";

type Exec = Pick<Db, "execute">;

export const TOP_GROUPS = 25;
export const TOP_TEMPLATES = 10;
/** Starting length of a page's main text; fitToBudget shortens it further if the audit's token cap needs that. */
export const MAIN_TEXT_CHARS = 6_000;
const EVIDENCE_CHARS = 400;

export interface AiPage {
  url: string;
  role: "homepage" | "template_sample";
  templatePages: number | null;
  title: string | null;
  description: string | null;
  headings: { level: number; text: string }[];
  mainText: string;
  navLinkCount: number | null;
  ogTags: Record<string, string>;
}

export interface AiInput {
  site: string;
  coverage: { total: number; inspected: number; eligible: number; percent: number | null; verdict: string; reasons: string[]; states: Record<string, number> };
  issueGroups: { findingId: string; title: string; priority: string; affectedUrls: number; templates: number; evidence: { url: string; message: string; evidence: string }[] }[];
  pages: AiPage[];
}

interface SnapshotRow {
  final_url: string;
  title: string | null;
  description: string | null;
  outline: { level: number; text: string }[] | null;
  main_text: string | null;
  head: { tag: string; attrs: Record<string, string> }[] | null;
  facts: { navLinks?: number } | null;
  page_count: number | null;
}

const ogTags = (head: SnapshotRow["head"]) => {
  const out: Record<string, string> = {};
  for (const t of head ?? []) {
    const name = t.attrs?.property ?? t.attrs?.name;
    if (t.tag === "meta" && name && /^(og|twitter):/i.test(name) && t.attrs.content) out[name.toLowerCase()] = t.attrs.content;
  }
  return out;
};

/** The input at its fullest, and the grounding context: the stored text of every page, untrimmed. */
export async function buildAiInput(db: Exec, crawlId: string): Promise<{ input: AiInput; grounding: GroundingContext }> {
  const o = await crawlOverview(db, crawlId);
  const groups = await issueGroups(db, crawlId);
  const top = groups.slice(0, TOP_GROUPS);
  const evidence = await groupEvidence(db, crawlId, top.map((g) => g.ruleId));

  // The homepage first, then each large template's sample, skipping a sample that is the homepage. Sample URLs without
  // a snapshot (a template's sample is always fetched, but a verify crawl can differ) simply yield no row.
  const r = await db.execute(sql`
    with chosen as (
      select u.id as url_id, null::int as page_count, 0 as ord from crawl_urls u
        where u.crawl_id = ${crawlId}::uuid and (u.url in (${o.siteOrigin}, ${`${o.siteOrigin}/`})
          -- A home that redirects (http to https, or to /en/): the page it lands on is the homepage.
          or u.url in (select h.redirect_target from crawl_urls h where h.crawl_id = ${crawlId}::uuid and h.url in (${o.siteOrigin}, ${`${o.siteOrigin}/`}) and h.redirect_target is not null))
      union all
      select u.id, t.page_count, row_number() over (order by t.page_count desc, t.sample_url collate "C")::int from (
        select * from templates where crawl_id = ${crawlId}::uuid order by page_count desc, sample_url collate "C" limit ${TOP_TEMPLATES}
      ) t join crawl_urls u on u.crawl_id = t.crawl_id and u.url = t.sample_url
    )
    select s.final_url, s.title, s.description, s.outline, s.main_text, s.head, s.facts, c.page_count
    from chosen c join page_snapshots s on s.url_id = c.url_id
    order by c.ord`);
  const seen = new Set<string>();
  const pages: AiPage[] = [];
  const pageText = new Map<string, string>();
  for (const row of r.rows as unknown as SnapshotRow[]) {
    if (seen.has(row.final_url)) continue;
    seen.add(row.final_url);
    const og = ogTags(row.head);
    const headings = (row.outline ?? []).map((h) => ({ level: h.level, text: h.text }));
    pages.push({
      url: row.final_url,
      role: pages.length === 0 && row.page_count === null ? "homepage" : "template_sample",
      templatePages: row.page_count,
      title: row.title,
      description: row.description,
      headings,
      mainText: (row.main_text ?? "").slice(0, MAIN_TEXT_CHARS),
      navLinkCount: row.facts?.navLinks ?? null,
      ogTags: og,
    });
    pageText.set(row.final_url, [row.title, row.description, ...headings.map((h) => h.text), row.main_text, ...Object.values(og)].filter(Boolean).join("\n"));
  }

  const input: AiInput = {
    site: o.siteOrigin,
    coverage: { total: o.coverage.total, inspected: o.coverage.answered, eligible: o.coverage.eligible, percent: o.coverage.percent, verdict: o.verdict.verdict, reasons: o.verdict.reasons.map((x) => x.message), states: o.coverage.states },
    issueGroups: top.map((g) => ({
      findingId: g.ruleId,
      title: RULE_TITLES[g.ruleId] ?? g.ruleId,
      priority: g.priority,
      affectedUrls: g.affectedUrls,
      templates: g.templateCount,
      evidence: (evidence.get(g.ruleId) ?? []).map((e) => ({ url: e.url, message: e.message, evidence: JSON.stringify(e.evidence).slice(0, EVIDENCE_CHARS) })),
    })),
    pages,
  };
  // A finding ID is valid only if this crawl has the group: every group, not only those sent.
  return { input, grounding: { findingIds: new Set(groups.map((g) => g.ruleId)), pageText } };
}

/**
 * Fits the input under the audit's cap (AI_MAX_INPUT_TOKENS) by shortening main text, then by dropping pages from the
 * end, the smallest templates first. Null when even the homepage and the groups alone are over it: the job then
 * records `over_budget` and sends nothing. The cap is checked with the API's own count, never estimated.
 */
export async function fitToBudget(input: AiInput, maxTokens: number, count: (input: AiInput) => Promise<number>): Promise<{ input: AiInput; tokens: number } | null> {
  let cur = input;
  let tokens = await count(cur);
  let chars = MAIN_TEXT_CHARS;
  while (tokens > maxTokens && chars > 500) {
    chars = Math.floor(chars / 2);
    const limit = chars;
    cur = { ...cur, pages: input.pages.map((p) => ({ ...p, mainText: p.mainText.slice(0, limit) })) };
    tokens = await count(cur);
  }
  while (tokens > maxTokens && cur.pages.length > 1) {
    cur = { ...cur, pages: cur.pages.slice(0, -1) };
    tokens = await count(cur);
  }
  return tokens > maxTokens ? null : { input: cur, tokens };
}

// Finding states across audits (docs/SPEC.md "Finding states across audits"). A project's history is its crawls of
// one workspace and site (crawls.site_id, or the site origin for crawls from before Phase 3), in creation order.
//
// For crawl C, every occurrence C observed gets a state from the fingerprint's latest conclusive state in an
// earlier crawl (inconclusive results are skipped):
//   inconclusive outcome            → inconclusive
//   earlier state open (new, persistent, regressed, not_rechecked) → persistent
//   earlier state resolved          → regressed
//   never seen                      → new
// Every fingerprint whose latest conclusive state is open and that C did not observe is carried over:
//   C re-checked it (`rechecked`)   → resolved
//   otherwise                       → not_rechecked (stays open)
// A URL C did not fetch can therefore never resolve a finding.
//
// Fix verifications (crawls.kind 'verify') are part of the history, so the next audit sees a verified fix as resolved
// (and a fix that came back as regressed), but they write states only for the fingerprints they target
// (writeVerifyStates) and are never a comparison base.
import { sql } from "drizzle-orm";
import type { VerifyConfig } from "../crawl/v2/runner";
import type { Db } from "../db/client";
import type { CrawlKind, IssueState } from "../db/schema";
import { ANSWERED, NOT_OURS } from "./coverage";

type Exec = Pick<Db, "execute">;

export const OPEN_STATES: IssueState[] = ["new", "persistent", "regressed", "not_rechecked"];
const OPEN = sql.raw(OPEN_STATES.map((s) => `'${s}'`).join(", "));
const ANSWERED_SQL = sql.raw(ANSWERED.map((s) => `'${s}'`).join(", "));
/** States in which a crawl leaves out a URL another crawl answered: its scope rules, subfolder or robots.txt. */
const NARROWED_SQL = sql.raw([...NOT_OURS, "out_of_scope"].map((s) => `'${s}'`).join(", "));

/** SQL: the project key of crawl row alias `c`. */
export const projectKey = (alias: string) => sql.raw(`coalesce(${alias}.site_id, ${alias}.site_origin)`);

/**
 * SQL predicate: did crawl `checker` re-check fingerprint row `s` (columns rule_id, url)?
 * The rule must have run in that crawl (rule_runs status 'ran': not needs_config, not error), and its subject must
 * have been examined: a page rule's URL answered (an ANSWERED state: a page that now redirects or is no longer HTML
 * no longer has the page defect), a resource rule's resource answered (resources.state = 'done'), and for a site
 * rule, a crawl that left no URL of the host unfetched (`complete`), saw at least what the audit that last observed
 * the finding saw (that audit is in `wide`, see wideAudits), and, when the subject is a URL of the crawl inventory
 * (page_subject), answered that URL. A site rule's verdict on one URL depends on other pages (a duplicate title is
 * a duplicate of another page), so a crawl that excluded or could not reach part of the site re-checks none of them.
 * Robots-blocked, excluded, failed, budget- or depth-limited URLs are never re-checked.
 */
export function rechecked(checker: string, complete: boolean, wide: string[], s = "s") {
  const c = sql`${checker}::uuid`;
  const row = sql.raw(s);
  return sql`(exists (select 1 from rule_runs rr where rr.crawl_id = ${c} and rr.rule_id = ${row}.rule_id and rr.status = 'ran')
    and case (select scope from rules where id = ${row}.rule_id)
      when 'page' then exists (select 1 from crawl_urls u where u.crawl_id = ${c} and u.normalised_url = ${row}.url and u.state in (${ANSWERED_SQL}))
      when 'resource' then exists (select 1 from resources r where r.crawl_id = ${c} and r.url = ${row}.url and r.state = 'done')
      -- A history rule judges the audit as a whole (SITE-004, SITE-005): running is re-checking.
      when 'history' then true
      else ${complete}
        and (select o.crawl_id from issue_states o join crawls p on p.id = o.crawl_id join crawls k on k.id = ${c}
             where o.fingerprint = ${row}.fingerprint and o.outcome = 'issue' and p.kind = 'audit' and p.workspace = k.workspace
               and ${projectKey("p")} = ${projectKey("k")} and (p.created_at, p.id) < (k.created_at, k.id)
             order by p.created_at desc, p.id desc limit 1) in (select jsonb_array_elements_text(${JSON.stringify(wide)}::jsonb)::uuid)
        and (not ${row}.page_subject
        or exists (select 1 from crawl_urls u where u.crawl_id = ${c} and u.normalised_url = ${row}.url and u.state in (${ANSWERED_SQL})))
    end)`;
}

/**
 * The project's earlier audits that crawl `checker` saw at least as much of the site as: the same seeds, and no URL
 * the audit answered is excluded by the checker's scope rules, outside its subfolder, blocked by robots.txt or
 * CDN-managed in the checker.
 * Only these can have their site-rule findings resolved by `checker` (rechecked).
 */
export async function wideAudits(db: Exec, checker: string): Promise<string[]> {
  const r = await db.execute(sql`select p.id from crawls c join crawls p on p.workspace = c.workspace and ${projectKey("p")} = ${projectKey("c")}
    where c.id = ${checker}::uuid and p.kind = 'audit' and (p.created_at, p.id) < (c.created_at, c.id)
      and coalesce(p.config->'seeds', 'null'::jsonb) = coalesce(c.config->'seeds', 'null'::jsonb)
      and not exists (select 1 from crawl_urls pu join crawl_urls cu on cu.crawl_id = c.id and cu.normalised_url = pu.normalised_url
        where pu.crawl_id = p.id and pu.state in (${ANSWERED_SQL}) and cu.state in (${NARROWED_SQL}))`);
  return (r.rows as { id: string }[]).map((x) => x.id);
}

/** The project's latest earlier analysed audit (not a verification), or null. */
export async function previousAudit(db: Exec, crawlId: string): Promise<string | null> {
  const r = await db.execute(sql`select p.id from crawls c join crawls p on p.workspace = c.workspace and ${projectKey("p")} = ${projectKey("c")}
    where c.id = ${crawlId}::uuid and p.id <> c.id and (p.created_at, p.id) < (c.created_at, c.id)
      and p.kind = 'audit' and p.analysis->>'status' = 'completed'
    order by p.created_at desc, p.id desc limit 1`);
  return ((r.rows[0] as { id: string } | undefined)?.id ?? null) as string | null;
}

export type StateCounts = Record<IssueState, number>;

export async function stateCounts(db: Exec, crawlId: string): Promise<StateCounts> {
  const r = await db.execute(sql`select state, count(*)::int as n from issue_states where crawl_id = ${crawlId}::uuid group by state`);
  const out: StateCounts = { new: 0, persistent: 0, resolved: 0, regressed: 0, not_rechecked: 0, inconclusive: 0 };
  for (const x of r.rows as { state: IssueState; n: number }[]) out[x.state] = x.n;
  return out;
}

/** SQL: `and <col> is one of ruleIds`, or nothing when ruleIds is undefined. */
export function onlyRules(col: string, ruleIds?: string[]) {
  return ruleIds ? sql`and ${sql.raw(col)} in (select jsonb_array_elements_text(${JSON.stringify(ruleIds)}::jsonb))` : sql``;
}

/**
 * (Re)computes crawl `crawlId`'s states from its occurrences and the project's history. `complete`: see rechecked.
 * `ruleIds`: rewrite only those rules' states (the history pass, after the rest are written).
 */
export async function writeIssueStates(db: Exec, crawlId: string, complete: boolean, ruleIds?: string[]): Promise<StateCounts> {
  const wide = complete ? await wideAudits(db, crawlId) : [];
  await db.execute(sql`delete from issue_states where crawl_id = ${crawlId}::uuid ${onlyRules("rule_id", ruleIds)}`);
  await db.execute(sql`insert into issue_states (crawl_id, fingerprint, rule_id, url, evidence_key, template_id, outcome, state, first_seen_at, page_subject)
    select o.crawl_id, o.fingerprint, o.rule_id, o.url, o.evidence_key, o.template_id, o.outcome,
      case when o.outcome = 'inconclusive' then 'inconclusive'
           when last.state in (${OPEN}) then 'persistent'
           when last.state = 'resolved' then 'regressed'
           else 'new' end,
      coalesce(last.first_seen_at, c.created_at), o.reach_pages is not null
    from finding_occurrences o join crawls c on c.id = o.crawl_id
    left join lateral (
      select s.state, s.first_seen_at from issue_states s join crawls p on p.id = s.crawl_id
      where s.fingerprint = o.fingerprint and s.state <> 'inconclusive' and p.workspace = c.workspace and ${projectKey("p")} = ${projectKey("c")}
        and (p.created_at, p.id) < (c.created_at, c.id)
      order by p.created_at desc, p.id desc limit 1) last on true
    where o.crawl_id = ${crawlId}::uuid ${onlyRules("o.rule_id", ruleIds)}`);
  await db.execute(sql`insert into issue_states (crawl_id, fingerprint, rule_id, url, evidence_key, template_id, outcome, state, first_seen_at, page_subject)
    select ${crawlId}::uuid, s.fingerprint, s.rule_id, s.url, s.evidence_key, s.template_id, null,
      case when ${rechecked(crawlId, complete, wide)} then 'resolved' else 'not_rechecked' end, s.first_seen_at, s.page_subject
    from (select distinct on (s.fingerprint) s.* from issue_states s join crawls p on p.id = s.crawl_id join crawls c on c.id = ${crawlId}::uuid
          where s.state <> 'inconclusive' and p.workspace = c.workspace and ${projectKey("p")} = ${projectKey("c")} and (p.created_at, p.id) < (c.created_at, c.id)
          order by s.fingerprint, p.created_at desc, p.id desc) s
    where s.state in (${OPEN}) ${onlyRules("s.rule_id", ruleIds)}
      and not exists (select 1 from finding_occurrences o where o.crawl_id = ${crawlId}::uuid and o.fingerprint = s.fingerprint)`);
  return stateCounts(db, crawlId);
}

/** Later analysed crawls (audits and verifications) of the project, oldest first: re-analysing a crawl recomputes their states too. */
export type LaterAudit = {
  id: string;
  status: string;
  kind: CrawlKind;
  config: { verify?: VerifyConfig };
  site_origin: string;
  /** Its indexable pages (the reach denominator), as its analysis stored them. */
  indexable: number;
};

export async function laterAudits(db: Exec, crawlId: string): Promise<LaterAudit[]> {
  const r = await db.execute(sql`select p.id, p.status, p.kind, p.config, p.site_origin,
      coalesce((p.analysis->>'indexablePages')::int, (select max(g.indexable_pages) from issue_groups g where g.crawl_id = p.id), 0)::int as indexable
    from crawls c join crawls p on p.workspace = c.workspace and ${projectKey("p")} = ${projectKey("c")}
    where c.id = ${crawlId}::uuid and p.id <> c.id and (p.created_at, p.id) > (c.created_at, c.id)
      and p.analysis->>'status' = 'completed'
    order by p.created_at, p.id`);
  return r.rows as LaterAudit[];
}

/**
 * A verification's states: one row per target fingerprint and nothing else. Observed again as an issue →
 * persistent; observed inconclusive → inconclusive; not observed and re-checked by the verification → resolved;
 * otherwise not_rechecked. Row details come from the fingerprint's latest earlier state.
 */
export async function writeVerifyStates(db: Exec, crawlId: string, v: VerifyConfig): Promise<StateCounts> {
  await db.execute(sql`delete from issue_states where crawl_id = ${crawlId}::uuid`);
  await db.execute(sql`insert into issue_states (crawl_id, fingerprint, rule_id, url, evidence_key, template_id, outcome, state, first_seen_at, page_subject)
    select ${crawlId}::uuid, s.fingerprint, s.rule_id, s.url, s.evidence_key, s.template_id, o.outcome,
      case when o.outcome = 'issue' then 'persistent'
           when o.outcome = 'inconclusive' then 'inconclusive'
           when ${rechecked(crawlId, false, [])} then 'resolved'
           else 'not_rechecked' end,
      s.first_seen_at, s.page_subject
    from (select distinct on (s.fingerprint) s.* from issue_states s join crawls p on p.id = s.crawl_id join crawls c on c.id = ${crawlId}::uuid
          where s.fingerprint in (select jsonb_array_elements_text(${JSON.stringify(v.fingerprints)}::jsonb))
            and p.workspace = c.workspace and ${projectKey("p")} = ${projectKey("c")} and (p.created_at, p.id) < (c.created_at, c.id)
          order by s.fingerprint, p.created_at desc, p.id desc) s
    left join finding_occurrences o on o.crawl_id = ${crawlId}::uuid and o.fingerprint = s.fingerprint`);
  return stateCounts(db, crawlId);
}

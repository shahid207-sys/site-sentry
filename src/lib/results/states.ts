// Finding states across audits (docs/SPEC.md "Finding states across audits"). A project's history is its crawls of
// one workspace and site (crawls.site_id, or the site origin for crawls from before Phase 3), in creation order.
//
// For crawl C, every occurrence C observed gets a state from the fingerprint's latest state in an earlier crawl:
//   inconclusive outcome            → inconclusive
//   earlier state open (new, persistent, regressed, not_rechecked) → persistent
//   earlier state resolved          → regressed
//   otherwise (never seen, or last inconclusive) → new
// Every fingerprint open in the previous audit that C did not observe is carried over:
//   C re-checked it (`rechecked`)   → resolved
//   otherwise                       → not_rechecked (stays open)
// A URL C did not fetch can therefore never resolve a finding.
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import type { IssueState } from "../db/schema";

type Exec = Pick<Db, "execute">;

export const OPEN_STATES: IssueState[] = ["new", "persistent", "regressed", "not_rechecked"];
const OPEN = sql.raw(OPEN_STATES.map((s) => `'${s}'`).join(", "));

/** SQL: the project key of crawl row alias `c`. */
export const projectKey = (alias: string) => sql.raw(`coalesce(${alias}.site_id, ${alias}.site_origin)`);

/**
 * SQL predicate: did crawl `checker` re-check fingerprint row `s` (columns rule_id, url)?
 * The rule must have run in that crawl (rule_runs status 'ran': not needs_config, not error), and its subject must
 * have been examined: a page rule's URL fetched (it has a snapshot), a resource rule's resource answered
 * (resources.state = 'done'), and for a site rule, a crawl that left no URL of the host unfetched (`complete`).
 */
export function rechecked(checker: string, complete: boolean, s = "s") {
  const c = sql`${checker}::uuid`;
  const row = sql.raw(s);
  return sql`(exists (select 1 from rule_runs rr where rr.crawl_id = ${c} and rr.rule_id = ${row}.rule_id and rr.status = 'ran')
    and case (select scope from rules where id = ${row}.rule_id)
      when 'page' then exists (select 1 from crawl_urls u join page_snapshots ps on ps.url_id = u.id where u.crawl_id = ${c} and u.normalised_url = ${row}.url)
      when 'resource' then exists (select 1 from resources r where r.crawl_id = ${c} and r.url = ${row}.url and r.state = 'done')
      else ${complete}
    end)`;
}

/** The project's latest earlier analysed crawl (the previous audit), or null. */
export async function previousAudit(db: Exec, crawlId: string): Promise<string | null> {
  const r = await db.execute(sql`select p.id from crawls c join crawls p on p.workspace = c.workspace and ${projectKey("p")} = ${projectKey("c")}
    where c.id = ${crawlId}::uuid and p.id <> c.id and (p.created_at, p.id) < (c.created_at, c.id)
      and p.analysis->>'status' = 'completed'
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

/** (Re)computes crawl `crawlId`'s states from its occurrences and the project's history. `complete`: see rechecked. */
export async function writeIssueStates(db: Exec, crawlId: string, complete: boolean): Promise<StateCounts> {
  await db.execute(sql`delete from issue_states where crawl_id = ${crawlId}::uuid`);
  await db.execute(sql`insert into issue_states (crawl_id, fingerprint, rule_id, url, evidence_key, template_id, outcome, state, first_seen_at)
    select o.crawl_id, o.fingerprint, o.rule_id, o.url, o.evidence_key, o.template_id, o.outcome,
      case when o.outcome = 'inconclusive' then 'inconclusive'
           when last.state in (${OPEN}) then 'persistent'
           when last.state = 'resolved' then 'regressed'
           else 'new' end,
      coalesce(last.first_seen_at, c.created_at)
    from finding_occurrences o join crawls c on c.id = o.crawl_id
    left join lateral (
      select s.state, s.first_seen_at from issue_states s join crawls p on p.id = s.crawl_id
      where s.fingerprint = o.fingerprint and p.workspace = c.workspace and ${projectKey("p")} = ${projectKey("c")}
        and (p.created_at, p.id) < (c.created_at, c.id)
      order by p.created_at desc, p.id desc limit 1) last on true
    where o.crawl_id = ${crawlId}::uuid`);
  const prev = await previousAudit(db, crawlId);
  if (prev) {
    await db.execute(sql`insert into issue_states (crawl_id, fingerprint, rule_id, url, evidence_key, template_id, outcome, state, first_seen_at)
      select ${crawlId}::uuid, s.fingerprint, s.rule_id, s.url, s.evidence_key, s.template_id, null,
        case when ${rechecked(crawlId, complete)} then 'resolved' else 'not_rechecked' end, s.first_seen_at
      from issue_states s
      where s.crawl_id = ${prev}::uuid and s.state in (${OPEN})
        and not exists (select 1 from finding_occurrences o where o.crawl_id = ${crawlId}::uuid and o.fingerprint = s.fingerprint)`);
  }
  return stateCounts(db, crawlId);
}

/** Later analysed crawls of the same project, oldest first: re-analysing a crawl recomputes their states too. */
export async function laterAudits(db: Exec, crawlId: string): Promise<{ id: string; status: string }[]> {
  const r = await db.execute(sql`select p.id, p.status from crawls c join crawls p on p.workspace = c.workspace and ${projectKey("p")} = ${projectKey("c")}
    where c.id = ${crawlId}::uuid and p.id <> c.id and (p.created_at, p.id) > (c.created_at, c.id)
      and p.analysis->>'status' = 'completed'
    order by p.created_at, p.id`);
  return r.rows as { id: string; status: string }[];
}

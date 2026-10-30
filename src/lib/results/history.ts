// History rules (SITE-004, SITE-005): judge an audit against the project's earlier audits. They read this audit's
// issue states and issue groups, so they run after both are written, as a second pass over the same crawl. Their
// findings, occurrences, rule_runs, groups and states are rewritten here and nowhere else, so the pass can run again
// whenever the audit's states change (re-analysing an earlier audit recomputes later audits' states).
//
// An audit with no earlier analysed audit has nothing to compare: the history rules do not run and get no rule_runs
// row (they did not run, and they found nothing).
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { NeedsConfig, type Finding, type HistoryCtx, type HistoryRule } from "../rules/contract";
import { fingerprintOf } from "../rules/fingerprint";
import { HISTORY_RULES } from "../rules/site";
import { ANSWERED } from "./coverage";
import { insertOccurrences, writeIssueGroups, type Occurrence } from "./occurrences";
import { onlyRules, previousAudit, projectKey, writeIssueStates } from "./states";

type Exec = Pick<Db, "execute">;

const ANSWERED_SQL = sql.raw(ANSWERED.map((s) => `'${s}'`).join(", "));

/** The history context of crawl `crawlId`, or null when it has no earlier analysed audit. */
export async function historyContext(db: Exec, crawlId: string, origin: string, ruleIds: string[]): Promise<HistoryCtx | null> {
  const prev = await previousAudit(db, crawlId);
  if (!prev) return null;
  // History findings are never the input of a history rule.
  const notOwn = (col: string) => sql`and ${sql.raw(col)} not in (select jsonb_array_elements_text(${JSON.stringify(ruleIds)}::jsonb))`;
  const regressed = await db.execute(sql`select fingerprint, rule_id, url from issue_states
    where crawl_id = ${crawlId}::uuid and state = 'regressed' ${notOwn("rule_id")} order by rule_id, url collate "C", fingerprint`);
  // New: answered here, and in no earlier audit's inventory, in any state. Not only the previous audit's: after a
  // partial audit (one subfolder), the next full audit would otherwise call the whole rest of the site new.
  // Critical: an issue occurrence on the URL whose rule's issue group in this audit has Critical priority.
  const fresh = await db.execute(sql`select u.normalised_url as url, coalesce(c.rules, '[]'::jsonb) as rules from crawl_urls u
    left join (select o.url, jsonb_agg(distinct o.rule_id) as rules from finding_occurrences o
      join issue_groups g on g.crawl_id = o.crawl_id and g.rule_id = o.rule_id
      where o.crawl_id = ${crawlId}::uuid and o.outcome = 'issue' and g.priority = 'critical' ${notOwn("o.rule_id")}
      group by o.url) c on c.url = u.normalised_url
    where u.crawl_id = ${crawlId}::uuid and u.state in (${ANSWERED_SQL})
      and not exists (select 1 from crawl_urls p join crawls e on e.id = p.crawl_id join crawls k on k.id = ${crawlId}::uuid
        where p.normalised_url = u.normalised_url and e.kind = 'audit' and e.workspace = k.workspace and ${projectKey("e")} = ${projectKey("k")}
          and (e.created_at, e.id) < (k.created_at, k.id))
    order by u.normalised_url collate "C"`);
  return {
    crawl: { id: crawlId, origin },
    previousAuditId: prev,
    regressed: (regressed.rows as { fingerprint: string; rule_id: string; url: string }[]).map((x) => ({ ruleId: x.rule_id, url: x.url, fingerprint: x.fingerprint })),
    newUrls: (fresh.rows as { url: string; rules: string[] }[]).map((x) => ({ url: x.url, criticalRules: [...x.rules].sort() })),
  };
}

/**
 * (Re)writes crawl `crawlId`'s history-rule results. Needs the crawl's other occurrences, issue groups and states.
 * `indexable`: the crawl's indexable pages, the reach denominator. Returns the findings and groups it wrote.
 */
export async function writeHistoryFindings(db: Exec, crawlId: string, origin: string, indexable: number, rules: HistoryRule[] = HISTORY_RULES): Promise<{ findings: number; groups: number }> {
  const ids = rules.map((r) => r.id);
  const only = onlyRules("rule_id", ids);
  for (const table of ["findings", "finding_occurrences", "rule_runs", "issue_groups", "issue_group_templates"]) {
    await db.execute(sql`delete from ${sql.raw(table)} where crawl_id = ${crawlId}::uuid ${only}`);
  }
  const ctx = await historyContext(db, crawlId, origin, ids);
  const found: Finding[] = [];
  if (ctx) {
    for (const rule of rules) {
      const t = performance.now();
      let status: "ran" | "needs_config" | "error" = "ran";
      let detail: string | null = null;
      let own: Finding[] = [];
      try {
        own = rule.evaluate(ctx);
      } catch (e) {
        status = e instanceof NeedsConfig ? "needs_config" : "error";
        detail = (e as Error)?.message ?? String(e);
      }
      found.push(...own);
      await db.execute(sql`insert into rule_runs (crawl_id, rule_id, rule_version, status, evaluated, findings, total_ms, detail)
        values (${crawlId}::uuid, ${rule.id}, ${rule.version}, ${status}, 1, ${own.length}, ${Math.round((performance.now() - t) * 1000) / 1000}, ${detail})`);
    }
  }
  const byId = new Map(rules.map((r) => [r.id, r]));
  const occurrences: Occurrence[] = [];
  for (const f of found) {
    const { fingerprint, key } = fingerprintOf(byId.get(f.ruleId), f);
    await db.execute(sql`insert into findings (crawl_id, rule_id, rule_version, url, confidence, outcome, message, evidence, fingerprint, evidence_key)
      values (${crawlId}::uuid, ${f.ruleId}, ${f.ruleVersion}, ${f.url}, ${f.confidence}, ${f.outcome}, ${f.message}, ${JSON.stringify(f.evidence)}::jsonb, ${fingerprint}, ${key})`);
    // A summary of the audit, not of one page: no template; reach counts the URLs it stands for (evidence.pages).
    const pages = typeof f.evidence.pages === "number" ? Math.max(0, Math.min(f.evidence.pages, indexable)) : null;
    occurrences.push({ fingerprint, ruleId: f.ruleId, url: f.url, evidenceKey: key, templateId: null, outcome: f.outcome, reachPages: pages });
  }
  await insertOccurrences(db, crawlId, occurrences);
  const groups = await writeIssueGroups(db, crawlId, rules, indexable, ids);
  // After rule_runs: a history finding of an earlier audit resolves when the rules ran here and did not report it.
  await writeIssueStates(db, crawlId, false, ids);
  return { findings: found.length, groups };
}

// Fix verification (docs/SPEC.md "Fix verification loop"): re-crawl only the URLs of one issue group of an audit (plus
// their redirect targets), run that group's rule over them, and update the states of that group's open fingerprints.
// Nothing else changes state: the verification crawl writes issue_states rows for its target fingerprints only
// (states.ts writeVerifyStates), and the audit shows them through effectiveStates (queries.ts).
import { randomUUID } from "node:crypto";
import type { Queue } from "bullmq";
import { sql } from "drizzle-orm";
import { enqueueCrawl, type CrawlJob } from "../crawl/v2/queue";
import { MAX_REDIRECT_HOPS, type CrawlConfig } from "../crawl/v2/runner";
import { crawlSecretScope, decryptSecret, encryptSecret, secretKey } from "../crawl/v2/secrets";
import type { Db } from "../db/client";
import { RULES } from "../rules/registry";
import { openFingerprints, ResultsError } from "./queries";

type Exec = Pick<Db, "execute">;

/**
 * Why a rule's group cannot be verified by re-fetching its URLs, or null when it can: only page rules that judge the
 * page itself. Site rules need the whole site, resource rules the resource phase, and graph rules (links, inlinks,
 * duplicates, hreflang) the other pages; a partial re-crawl would make them look fixed.
 */
export function notVerifiable(ruleId: string): string | null {
  const rule = RULES.find((r) => r.id === ruleId);
  if (!rule) return "Unknown rule.";
  if (rule.scope !== "page") return `${ruleId} is a ${rule.scope} rule: the next full audit re-checks it.`;
  if (rule.needs.includes("graph")) return `${ruleId} judges a page by other pages of the site: the next full audit re-checks it.`;
  return null;
}

export interface StartedVerification {
  verifyCrawlId: string;
  auditCrawlId: string;
  ruleId: string;
  fingerprints: number;
  /** The URLs the verification fetches: the group's URLs, then their redirect targets. */
  urls: string[];
}

export async function startVerification(db: Exec, queue: Queue<CrawlJob>, auditCrawlId: string, ruleId: string, env: Record<string, string | undefined> = process.env): Promise<StartedVerification> {
  const r = await db.execute(sql`select id, kind, workspace, site_id, site_origin, profile, config, analysis->>'status' as analysis from crawls where id = ${auditCrawlId}::uuid`);
  const audit = r.rows[0] as { id: string; kind: string; workspace: string; site_id: string | null; site_origin: string; profile: string; config: CrawlConfig; analysis: string | null } | undefined;
  if (!audit || audit.kind !== "audit") throw new ResultsError("NOT_FOUND", "Audit not found.");
  if (audit.analysis !== "completed") throw new ResultsError("INVALID", "The audit must be analysed before its fixes can be verified.");
  const why = notVerifiable(ruleId);
  if (why) throw new ResultsError("INVALID", why);
  const targets = await openFingerprints(db, auditCrawlId, ruleId);
  if (!targets.length) throw new ResultsError("INVALID", `${ruleId} has no open finding in this audit to verify.`);
  const urls = [...new Set(targets.map((t) => t.url))];
  const redirects = await db.execute(sql`select distinct redirect_target from crawl_urls where crawl_id = ${auditCrawlId}::uuid and redirect_target is not null
    and normalised_url in (select jsonb_array_elements_text(${JSON.stringify(urls)}::jsonb)) order by redirect_target`);
  const seeds = [...new Set([...urls, ...(redirects.rows as { redirect_target: string }[]).map((x) => x.redirect_target)])];

  const id = randomUUID();
  let auth = audit.config.auth;
  if (auth) {
    const key = secretKey(env);
    if (!key) throw new ResultsError("INVALID", "The audit used Basic auth: verification needs CRAWLER_SECRET_KEY set on the server.");
    auth = { username: auth.username, password: encryptSecret(decryptSecret(auth.password, key, crawlSecretScope(auditCrawlId)), key, crawlSecretScope(id)) };
  }
  const config: CrawlConfig = {
    seeds,
    scope: audit.config.scope,
    auth,
    aiCrawlers: audit.config.aiCrawlers,
    keyPages: audit.config.keyPages,
    verify: { auditCrawlId, ruleId, fingerprints: targets.map((t) => t.fingerprint) },
  };
  // Depth 0: the seeds and their redirect hops (which keep their source's depth), never the links on them.
  await db.execute(sql`insert into crawls (id, workspace, audit_id, site_id, kind, site_origin, profile, config, status, budget, max_depth)
    values (${id}::uuid, ${audit.workspace}, ${`verify:${id}`}, ${audit.site_id}, 'verify', ${audit.site_origin}, ${audit.profile}, ${JSON.stringify(config)}::jsonb, 'queued',
      ${seeds.length * (1 + MAX_REDIRECT_HOPS)}, 0)`);
  await enqueueCrawl(queue, id);
  return { verifyCrawlId: id, auditCrawlId, ruleId, fingerprints: targets.length, urls: seeds };
}

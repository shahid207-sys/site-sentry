// Generated load-test data for gate:p4 (docs/SPEC.md "Phase 4": "filter 50k rows < 200 ms"). This is not a crawl:
// it is 50,000 findings written straight into the gate's own database for a site named "Generated load test", so
// the Issues screen can be timed on a list of that size. Everything above the occurrences (issue groups, states,
// health) is computed by the same functions the analysis job uses, so the screens read it exactly as they read a
// real audit. It never runs against the app's database.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "../src/lib/db/client";
import { createAudit } from "../src/lib/crawl/engine";
import type { CrawlerV2Ref } from "../src/lib/model";
import { writeHealth } from "../src/lib/results/health";
import { insertOccurrences, writeIssueGroups, type Occurrence } from "../src/lib/results/occurrences";
import { writeIssueStates } from "../src/lib/results/states";
import { findingFingerprint } from "../src/lib/rules/fingerprint";
import { RULES } from "../src/lib/rules/registry";
import type { Store } from "../src/lib/store/store";

export const GENERATED_ORIGIN = "https://generated-load-test.test";
export const GENERATED_NAME = "Generated load test (50k findings, not a real site)";
/** Pages × page rules = findings. */
const PAGES = 5_000;
const RULES_PER_PAGE = 10;
export const GENERATED_FINDINGS = PAGES * RULES_PER_PAGE;

/** Creates the site, a finished audit and its crawl with GENERATED_FINDINGS open findings. Returns the audit id. */
export async function seedGenerated(db: Db, store: Store, ws: "live"): Promise<{ auditId: string; crawlId: string }> {
  const siteId = `generated-${randomUUID().slice(0, 8)}`;
  const now = new Date();
  await store.update((d) => {
    d.sites[siteId] = { id: siteId, name: GENERATED_NAME, origin: GENERATED_ORIGIN, createdAt: now.toISOString() };
  });
  const { audit } = await createAudit(
    { siteId, config: { mode: "single", urls: [`${GENERATED_ORIGIN}/`], profile: "standard", maxPages: PAGES, maxDepth: null, categories: [], checkLinks: false, includeImportant: false } },
    { store, fetch: () => Promise.reject(new Error("generated data: no fetch")), now: () => now, newId: () => randomUUID(), source: ws },
  );

  const crawlId = randomUUID();
  const urls = Array.from({ length: PAGES }, (_, i) => `${GENERATED_ORIGIN}/section-${i % 50}/page-${i}`);
  // Real page rules (no template grouping), so titles, categories and priorities come from the catalog.
  // Taken round-robin across categories, like a real audit's mix.
  const pageRules = RULES.filter((r) => r.scope === "page" && !("groupByTemplate" in r && r.groupByTemplate));
  const categories = [...new Set(pageRules.map((r) => r.category))];
  const rules: typeof pageRules = [];
  for (let round = 0; rules.length < RULES_PER_PAGE && round < pageRules.length; round++) {
    for (const c of categories) {
      const r = pageRules.filter((x) => x.category === c)[round];
      if (r && rules.length < RULES_PER_PAGE) rules.push(r);
    }
  }
  if (rules.length < RULES_PER_PAGE) throw new Error(`Only ${rules.length} page rules to generate findings with.`);

  await db.transaction(async (tx) => {
    await tx.execute(sql`insert into crawls (id, workspace, kind, audit_id, site_id, site_origin, profile, config, status, budget, discovery_done, created_at, started_at, finished_at)
      values (${crawlId}::uuid, ${ws}, 'audit', ${audit.id}, ${siteId}, ${GENERATED_ORIGIN}, 'standard', ${JSON.stringify({ seeds: [`${GENERATED_ORIGIN}/`], generated: true })}::jsonb,
        'completed', ${PAGES}, true, ${now.toISOString()}, ${now.toISOString()}, ${now.toISOString()})`);
    for (let i = 0; i < urls.length; i += 1000) {
      const part = urls.slice(i, i + 1000).map((u, j) => ({ url: u, depth: 1 + ((i + j) % 4) }));
      await tx.execute(sql`insert into crawl_urls (crawl_id, url, normalised_url, state, reason, depth, discovered_via, status_code, content_type)
        select ${crawlId}::uuid, v.url, v.url, 'analysed', 'HTTP 200 (generated)', v.depth, array['link'], 200, 'text/html'
        from jsonb_to_recordset(${JSON.stringify(part)}::jsonb) as v(url text, depth int)`);
    }
    for (const r of rules) {
      await tx.execute(sql`insert into rules (id, version, category, scope, confidence, impact, updated_at) values (${r.id}, ${r.version}, ${r.category}, ${r.scope}, ${r.confidence}, ${r.impact}, now())
        on conflict (id) do update set version = excluded.version, category = excluded.category, scope = excluded.scope, confidence = excluded.confidence, impact = excluded.impact, updated_at = now()`);
    }
    const occurrences: Occurrence[] = [];
    const findings: { rule_id: string; rule_version: number; url: string; confidence: string; fingerprint: string }[] = [];
    for (const url of urls) {
      for (const r of rules) {
        const fingerprint = findingFingerprint(r.id, url, "");
        occurrences.push({ fingerprint, ruleId: r.id, url, evidenceKey: "", templateId: null, outcome: "issue", reachPages: 1 });
        findings.push({ rule_id: r.id, rule_version: r.version, url, confidence: r.confidence, fingerprint });
      }
    }
    for (let i = 0; i < findings.length; i += 2000) {
      await tx.execute(sql`insert into findings (crawl_id, rule_id, rule_version, url, confidence, message, outcome, evidence, fingerprint, evidence_key)
        select ${crawlId}::uuid, v.rule_id, v.rule_version, v.url, v.confidence, 'Generated finding (gate:p4 load test, not observed on a real page).', 'issue', '{"generated": true}'::jsonb, v.fingerprint, ''
        from jsonb_to_recordset(${JSON.stringify(findings.slice(i, i + 2000))}::jsonb) as v(rule_id text, rule_version int, url text, confidence text, fingerprint text)`);
    }
    await insertOccurrences(tx, crawlId, occurrences, 2000);
    await writeIssueGroups(tx, crawlId, rules, PAGES);
    for (const r of rules) {
      await tx.execute(sql`insert into rule_runs (crawl_id, rule_id, rule_version, status, evaluated, findings, total_ms, detail)
        values (${crawlId}::uuid, ${r.id}, ${r.version}, 'ran', ${PAGES}, ${PAGES}, 0, 'generated')`);
    }
    const states = await writeIssueStates(tx, crawlId, true);
    const health = await writeHealth(tx, crawlId, rules);
    await tx.execute(sql`update crawls set analysis = ${JSON.stringify({ status: "completed", generated: true, pages: PAGES, findings: findings.length, states, health: health.score })}::jsonb where id = ${crawlId}::uuid`);
  });

  const ref: CrawlerV2Ref = { version: 2, crawlId, status: "completed", states: { analysed: PAGES }, analysis: "completed", syncedAt: now.toISOString() };
  await store.update((d) => {
    const a = d.audits[audit.id];
    Object.assign(a, { crawler: ref, status: "completed", phase: "done", finishedAt: now.toISOString(), progress: { planned: PAGES, done: PAGES, inspected: PAGES, failed: 0, skipped: 0, linksChecked: 0 } });
  });
  return { auditId: audit.id, crawlId };
}

// Phase 3 real-site summary: the latest two analysed audits of one site in the validation database (written by
// scripts/validate-site.ts), printed as Markdown: template groups, the top 10 issue groups with their priority
// inputs, the health score, finding states, and the comparison of the two audits. Reads the database only.
//
// Run: npx tsx scripts/summarise-audits.ts https://example.com   (VALIDATE_DATABASE_URL, default sitesentry_validate)
import { createDb } from "../src/lib/db/client";
import { compareCrawls, crawlOverview } from "../src/lib/results/queries";

const DB_URL = process.env.VALIDATE_DATABASE_URL ?? "postgres://sitesentry:sitesentry@127.0.0.1:5433/sitesentry_validate";

async function main() {
  const site = process.argv[2] ? new URL(process.argv[2]).origin : null;
  if (!site) throw new Error("Usage: tsx scripts/summarise-audits.ts <https://site>");
  const db = createDb(DB_URL, 2);
  try {
    const audits = (await db.$client.query<{ id: string; created_at: Date }>(
      "select id, created_at from crawls where site_id = $1 and kind = 'audit' and analysis->>'status' = 'completed' order by created_at desc, id desc limit 2", [site])).rows.reverse();
    if (audits.length < 2) throw new Error(`Need two analysed audits of ${site}; found ${audits.length}.`);
    const [base, head] = audits.map((a) => a.id);
    const out: string[] = [];
    for (const [label, id] of [["Audit A", base], ["Audit B", head]] as const) {
      const o = await crawlOverview(db, id);
      out.push(`**${label}** \`${id}\` (${o.createdAt}): ${o.status}, coverage ${o.coverage.answered}/${o.coverage.eligible} answered (${o.coverage.percent}%), health ${o.health?.score ?? "n/a"}${o.health?.partialCoverage ? " (partial coverage)" : ""}, ${o.issueGroups} issue groups, states ${JSON.stringify(o.states)}.`, "");
    }
    const o = await crawlOverview(db, head);
    out.push("### Health score (audit B)", "", "| Category | Weight | Rules ran | Deduction | Maximum | Score |", "| --- | --- | --- | --- | --- | --- |");
    for (const [k, c] of Object.entries(o.health?.categories ?? {})) out.push(`| ${k} | ${c.weight} | ${c.rulesRan} | ${c.deduction} | ${c.maximum} | ${c.score} |`);
    out.push(`| **Overall** (weighted mean) | | | | | **${o.health?.score ?? "n/a"}** |`, "");

    const templates = (await db.$client.query<{ template_id: string; pages: number; sample: string }>(
      `select u.template_id, count(*)::int as pages, min(u.normalised_url) as sample from crawl_urls u join page_snapshots s on s.url_id = u.id
       where u.crawl_id = $1 and u.template_id is not null group by 1 order by 2 desc, 3 limit 12`, [head])).rows;
    const tCount = (await db.$client.query<{ n: number; pages: number }>("select count(distinct template_id)::int as n, count(*)::int as pages from crawl_urls where crawl_id = $1 and template_id is not null", [head])).rows[0];
    out.push(`### Template groups (audit B): ${tCount.n} templates over ${tCount.pages} pages; largest 12`, "", "| Template | Pages | First URL |", "| --- | --- | --- |");
    for (const t of templates) out.push(`| \`${t.template_id.slice(0, 12)}\` | ${t.pages} | ${t.sample.replace(site, "").replace(/^https?:\/\/[^/]+/, "") || "/"} |`);
    out.push("");

    const top = (await db.$client.query<{ rule_id: string; category: string; impact: number; confidence: string; confidence_weight: number; affected_pages: number; indexable_pages: number; reach: number; score: number; priority: string; affected_urls: number; template_count: number }>(
      "select * from issue_groups where crawl_id = $1 and affected_urls > 0 order by score desc, rule_id limit 10", [head])).rows;
    out.push("### Top 10 issue groups by priority (audit B)", "", "| # | Rule | Category | Impact | Confidence (weight) | Affected / indexable pages | Reach | Score | Priority | URLs | Templates |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    top.forEach((g, i) =>
      out.push(`| ${i + 1} | ${g.rule_id} | ${g.category} | ${g.impact} | ${g.confidence} (${g.confidence_weight}) | ${g.affected_pages} / ${g.indexable_pages} | ${Number(g.reach).toFixed(4)} | ${g.score} | ${g.priority} | ${g.affected_urls} | ${g.template_count} |`),
    );
    out.push("", "Score = impact × reach × confidence weight; reach = ln(1 + affected) / ln(1 + indexable).", "");

    const cmp = await compareCrawls(db, base, head);
    const sum = (k: "new" | "persistent" | "resolved" | "regressed" | "not_rechecked" | "inconclusive") => cmp.groups.reduce((n, g) => n + g.counts[k], 0);
    out.push("### Comparison, audit A → audit B", "", `Groups: ${JSON.stringify(cmp.totals)}. Fingerprints: new ${sum("new")}, persistent ${sum("persistent")}, resolved ${sum("resolved")}, regressed ${sum("regressed")}, not_rechecked ${sum("not_rechecked")}, inconclusive ${sum("inconclusive")}. Scope mismatch: ${cmp.scopeMismatch}${cmp.warnings.length ? ` (${cmp.warnings.join(" ")})` : ""}.`, "");
    const changed = cmp.groups.filter((g) => g.change !== "persistent" || g.counts.new || g.counts.resolved || g.counts.not_rechecked || g.counts.regressed);
    if (changed.length) {
      out.push("| Rule | Change | new | persistent | resolved | regressed | not_rechecked |", "| --- | --- | --- | --- | --- | --- | --- |");
      for (const g of changed) out.push(`| ${g.ruleId} | ${g.change} | ${g.counts.new} | ${g.counts.persistent} | ${g.counts.resolved} | ${g.counts.regressed} | ${g.counts.not_rechecked} |`);
      out.push("");
    }
    console.log(out.join("\n"));
  } finally {
    await db.$client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

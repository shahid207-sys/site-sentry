// Template groups of a stored crawl: the grouping it was analysed with (crawl_urls.template_id) next to the current
// template detection (src/lib/snapshot/template.ts) recomputed from the stored raw HTML of the same pages. Read-only.
//
//   npx tsx scripts/template-report.ts <crawl id> [--db <postgres url>]
//   (default database: VALIDATE_DATABASE_URL or sitesentry_validate, where scripts/validate-site.ts writes)
import { Client } from "pg";
import { parseHtml } from "../src/lib/audit/parse";
import { blobStoreFromEnv, getRawHtml } from "../src/lib/snapshot/blob-store";
import { clusterTemplates, templateShape, urlPattern } from "../src/lib/snapshot/template";

const args = process.argv.slice(2);
const crawlId = args.find((a) => !a.startsWith("--"));
const dbAt = args.indexOf("--db");
const DB_URL = dbAt >= 0 ? args[dbAt + 1] : (process.env.VALIDATE_DATABASE_URL ?? "postgres://sitesentry:sitesentry@127.0.0.1:5433/sitesentry_validate");
if (!crawlId) {
  console.error("Usage: npx tsx scripts/template-report.ts <crawl id> [--db <postgres url>]");
  process.exit(2);
}

function report(name: string, ids: Map<string, string>, origin: string) {
  const groups = new Map<string, string[]>();
  for (const [u, t] of ids) groups.set(t, [...(groups.get(t) ?? []), u]);
  const sorted = [...groups.values()].map((g) => g.sort()).sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : 1));
  const families = new Map<string, Set<string>>();
  for (const [u, t] of ids) families.set(urlPattern(u), (families.get(urlPattern(u)) ?? new Set()).add(t));
  const split = [...families].filter(([, s]) => s.size > 1).sort((a, b) => b[1].size - a[1].size);
  const path = (u: string) => u.slice(origin.length) || "/";
  console.log(`\n${name}: ${groups.size} template groups over ${ids.size} pages; ${sorted.filter((g) => g.length === 1).length} single-page groups`);
  console.log(`  URL patterns spread over more than one template: ${split.length} (${split.slice(0, 12).map(([k, s]) => `${k} ${s.size}`).join(", ")})`);
  console.log("  Largest groups (pages: URL patterns; sample URLs):");
  for (const g of sorted.slice(0, 10)) {
    const fam = new Map<string, number>();
    for (const u of g) fam.set(urlPattern(u), (fam.get(urlPattern(u)) ?? 0) + 1);
    const top = [...fam].sort((a, b) => b[1] - a[1]);
    console.log(`  ${String(g.length).padStart(5)}: ${top.slice(0, 4).map(([k, n]) => `${k} ×${n}`).join(", ")}${top.length > 4 ? `, +${top.length - 4} more patterns` : ""}`);
    console.log(`         ${g.slice(0, 3).map(path).join("  ")}`);
  }
}

async function main() {
  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  try {
    const crawl = (await db.query<{ site_origin: string }>("select site_origin from crawls where id = $1", [crawlId])).rows[0];
    if (!crawl) throw new Error(`No crawl ${crawlId} in ${DB_URL.replace(/:[^:@/]+@/, ":***@")}.`);
    const rows = (
      await db.query<{ url: string; stored: string | null; key: string | null }>(
        `select u.normalised_url as url, u.template_id as stored, s.raw_html_key as key from page_snapshots s join crawl_urls u on u.id = s.url_id
         where s.crawl_id = $1 and s.facts is not null and s.template_fingerprint is not null order by u.id`,
        [crawlId],
      )
    ).rows;
    const store = blobStoreFromEnv();
    const shaped = [];
    let missing = 0;
    for (const r of rows) {
      const html = r.key ? await getRawHtml(store, r.key) : null;
      const s = html ? templateShape(parseHtml(html)) : null;
      if (!s) {
        missing++;
        continue;
      }
      shaped.push({ url: r.url, fingerprint: s.fingerprint, shape: s.shape });
    }
    const origin = new URL(rows[0]?.url ?? crawl.site_origin).origin;
    console.log(`Crawl ${crawlId}: ${rows.length} HTML pages, ${shaped.length} re-read from the blob store${missing ? `, ${missing} without stored HTML (left out of "after")` : ""}.`);
    report("Before (as analysed: crawl_urls.template_id)", new Map(rows.filter((r) => r.stored).map((r) => [r.url, r.stored!])), origin);
    report("After (exact shapes only)", new Map(shaped.map((p) => [p.url, p.fingerprint])), origin);
    report("After (clustered: current detection)", clusterTemplates(shaped), origin);
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

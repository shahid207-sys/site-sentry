// Runs the AI analysis of one finished audit now, in this process, and prints what the validator did. It uses the same
// job and cache as the worker: an audit with a finished analysis is not sent again. docs/RUNBOOK.md.
//   node --env-file=.env.local --import tsx scripts/ai-analyse.ts <auditId>
import { sql } from "drizzle-orm";
import { aiClientFromEnv } from "../src/lib/ai/client";
import { uncitedItems } from "../src/lib/ai/ground";
import { readAiAnalysis, runAiAnalysis } from "../src/lib/ai/run";
import { createDb } from "../src/lib/db/client";

const auditId = process.argv[2];
if (!auditId) {
  console.error("usage: scripts/ai-analyse.ts <auditId>");
  process.exit(2);
}
const db = createDb(undefined, 2);
const row = (await db.execute(sql`select id from crawls where audit_id = ${auditId} and kind = 'audit' order by created_at desc limit 1`)).rows[0] as { id: string } | undefined;
if (!row) {
  console.error(`No crawl for audit ${auditId}`);
  process.exit(1);
}
const out = await runAiAnalysis(db, row.id, { client: aiClientFromEnv(), log: (event, data) => console.log(event, JSON.stringify(data ?? {})) });
const stored = await readAiAnalysis(db, auditId);
console.log(JSON.stringify({ ...out, model: stored?.model, dropped: stored?.dropped, usage: stored?.usage, detail: stored?.detail, uncited: stored?.analysis ? uncitedItems(stored.analysis) : null }, null, 2));
await db.$client.end();

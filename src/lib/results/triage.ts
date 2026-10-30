// Triage: what people decided about an audit's issues (Fix board column per issue group; marked fixed or ignored
// with a reason per fingerprint), kept per project with an audit log. Triage is a claim, never a result: issue
// states, counts and the health score come only from crawls, and "Verified" on the board is earned only by a fix
// verification that resolved the group (verify.ts), never set by hand.
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import type { TriageStatus } from "../db/schema";
import { effectiveStates, ResultsError } from "./queries";
import { OPEN_STATES, projectKey } from "./states";

type Exec = Pick<Db, "execute">;

export type BoardColumn = "todo" | "in_progress" | "ready" | "verified";
const GROUP_STATUSES: TriageStatus[] = ["todo", "in_progress", "ready"];
const FINGERPRINT_STATUSES: TriageStatus[] = ["todo", "fixed", "ignored"];

export interface TriageEntry {
  subject: string;
  status: TriageStatus;
  assignee: string | null;
  note: string | null;
  updatedAt: string;
}

export interface TriageChange {
  status: TriageStatus;
  assignee?: string | null;
  note?: string | null;
}

const isRule = (subject: string) => subject.startsWith("rule:");
const isFingerprint = (subject: string) => subject.startsWith("fp:");

/** The workspace and project of an audit crawl (the scope triage is kept in). */
async function auditScope(db: Exec, crawlId: string): Promise<{ workspace: string; project: string }> {
  const r = await db.execute(sql`select workspace, ${projectKey("c")} as project, kind from crawls c where id = ${crawlId}::uuid`);
  const c = r.rows[0] as { workspace: string; project: string; kind: string } | undefined;
  if (!c) throw new ResultsError("NOT_FOUND", "Crawl not found.");
  if (c.kind !== "audit") throw new ResultsError("INVALID", "This crawl is a fix verification, not an audit.");
  return { workspace: c.workspace, project: c.project };
}

/**
 * Set the triage of subjects ("rule:<id>" or "fp:<fingerprint>") of an audit's project and log each change. A group
 * takes todo / in_progress / ready; a fingerprint takes todo (clears it), fixed or ignored, and ignored needs a reason.
 * Subjects must belong to the audit: a rule with an issue group, or one of its fingerprints.
 */
export async function setTriage(db: Db, crawlId: string, subjects: string[], change: TriageChange, actor: string): Promise<TriageEntry[]> {
  if (!subjects.length) throw new ResultsError("INVALID", "Choose at least one issue.");
  if (subjects.length > 5000) throw new ResultsError("INVALID", "At most 5,000 issues at once.");
  const note = change.note?.trim() || null;
  const assignee = change.assignee === undefined ? undefined : change.assignee?.trim() || null;
  for (const s of subjects) {
    if (isRule(s)) {
      if (!GROUP_STATUSES.includes(change.status)) throw new ResultsError("INVALID", `An issue group's column is todo, in_progress or ready (got ${change.status}).`);
    } else if (isFingerprint(s)) {
      if (!FINGERPRINT_STATUSES.includes(change.status)) throw new ResultsError("INVALID", `An issue is todo, fixed or ignored (got ${change.status}).`);
    } else throw new ResultsError("INVALID", `Unknown subject ${s}.`);
  }
  if (change.status === "ignored" && !note) throw new ResultsError("INVALID", "Say why the issue is ignored.");
  const { workspace, project } = await auditScope(db, crawlId);

  const rules = subjects.filter(isRule).map((s) => s.slice(5));
  const fps = subjects.filter(isFingerprint).map((s) => s.slice(3));
  const known = await db.execute(sql`select 'rule:' || rule_id as subject from issue_groups where crawl_id = ${crawlId}::uuid and rule_id = any(${pgArray(rules)}::text[])
    union all select 'fp:' || fingerprint from issue_states where crawl_id = ${crawlId}::uuid and fingerprint = any(${pgArray(fps)}::text[])`);
  const found = new Set((known.rows as { subject: string }[]).map((x) => x.subject));
  const missing = subjects.filter((s) => !found.has(s));
  if (missing.length) throw new ResultsError("NOT_FOUND", `Not part of this audit: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ` and ${missing.length - 3} more` : ""}.`);

  return db.transaction(async (tx) => {
    const out: TriageEntry[] = [];
    for (const subject of [...new Set(subjects)]) {
      const prev = (
        await tx.execute(sql`select status, assignee, note from issue_triage where workspace = ${workspace} and project = ${project} and subject = ${subject} for update`)
      ).rows[0] as { status: TriageStatus; assignee: string | null; note: string | null } | undefined;
      const next = { status: change.status, assignee: assignee === undefined ? (prev?.assignee ?? null) : assignee, note: change.status === "ignored" || note ? note : null };
      const r = await tx.execute(sql`insert into issue_triage (workspace, project, subject, status, assignee, note, updated_at)
          values (${workspace}, ${project}, ${subject}, ${next.status}, ${next.assignee}, ${next.note}, now())
        on conflict (workspace, project, subject) do update set status = excluded.status, assignee = excluded.assignee, note = excluded.note, updated_at = excluded.updated_at
        returning updated_at`);
      await tx.execute(sql`insert into triage_events (workspace, project, subject, after, before, actor)
        values (${workspace}, ${project}, ${subject}, ${JSON.stringify(next)}::jsonb, ${prev ? JSON.stringify(prev) : null}::jsonb, ${actor})`);
      out.push({ subject, ...next, updatedAt: new Date((r.rows[0] as { updated_at: Date | string }).updated_at).toISOString() });
    }
    return out;
  });
}

const pgArray = (xs: string[]) => `{${xs.map((x) => `"${x.replace(/["\\]/g, "\\$&")}"`).join(",")}}`;

/** Every triage entry of the audit's project. */
export async function auditTriage(db: Exec, crawlId: string): Promise<TriageEntry[]> {
  const { workspace, project } = await auditScope(db, crawlId);
  const r = await db.execute(sql`select subject, status, assignee, note, updated_at from issue_triage where workspace = ${workspace} and project = ${project} order by subject collate "C"`);
  return (r.rows as { subject: string; status: TriageStatus; assignee: string | null; note: string | null; updated_at: Date | string }[]).map((x) => ({
    subject: x.subject,
    status: x.status,
    assignee: x.assignee,
    note: x.note,
    updatedAt: new Date(x.updated_at).toISOString(),
  }));
}

export interface TriageEvent {
  subject: string;
  after: { status: TriageStatus; assignee: string | null; note: string | null };
  before: { status: TriageStatus; assignee: string | null; note: string | null } | null;
  actor: string;
  at: string;
}

/** The audit log of one subject (or of the whole project), newest first. */
export async function triageLog(db: Exec, crawlId: string, subject?: string, limit = 200): Promise<TriageEvent[]> {
  const { workspace, project } = await auditScope(db, crawlId);
  const r = await db.execute(sql`select subject, after, before, actor, at from triage_events where workspace = ${workspace} and project = ${project}
      ${subject === undefined ? sql`` : sql`and subject = ${subject}`} order by id desc limit ${limit}`);
  return (r.rows as { subject: string; after: TriageEvent["after"]; before: TriageEvent["before"]; actor: string; at: Date | string }[]).map((x) => ({ ...x, at: new Date(x.at).toISOString() }));
}

export interface BoardCard {
  ruleId: string;
  column: BoardColumn;
  assignee: string | null;
  /** Fingerprints still open (new, persistent, regressed, not re-checked) after verifications. */
  open: number;
  /** Fingerprints a fix verification resolved. */
  verified: number;
}

/**
 * The Fix board: one card per issue group of the audit. A group whose fingerprints are all closed and at least one
 * of them was resolved by a fix verification is Verified; otherwise it sits in its triage column (default To do).
 */
export async function fixBoard(db: Exec, crawlId: string): Promise<BoardCard[]> {
  const { workspace, project } = await auditScope(db, crawlId);
  const open = sql.raw(OPEN_STATES.map((x) => `'${x}'`).join(", "));
  const r = await db.execute(sql`select g.rule_id,
      count(e.fingerprint) filter (where e.state in (${open}))::int as open,
      count(e.fingerprint) filter (where e.verify_state = 'resolved')::int as verified,
      t.status, t.assignee
    from issue_groups g
    left join ${effectiveStates(crawlId)} e on e.rule_id = g.rule_id
    left join issue_triage t on t.workspace = ${workspace} and t.project = ${project} and t.subject = 'rule:' || g.rule_id
    where g.crawl_id = ${crawlId}::uuid and g.affected_urls > 0
    group by g.rule_id, g.score, t.status, t.assignee order by g.score desc, g.rule_id collate "C"`);
  return (r.rows as { rule_id: string; open: number; verified: number; status: TriageStatus | null; assignee: string | null }[]).map((x) => ({
    ruleId: x.rule_id,
    column: x.open === 0 && x.verified > 0 ? "verified" : ((x.status ?? "todo") as BoardColumn),
    assignee: x.assignee,
    open: x.open,
    verified: x.verified,
  }));
}

import { fingerprintOf } from "../audit/fingerprint";
import type { AuditFinding, Observation } from "../audit/types";
import { displayPath } from "../crawl/url";
import type { FixTask, ManualCheck, TaskItem, TaskVerification, VerificationStatus, WorkflowStatus } from "../model";
import { TRANSITIONS, WORKFLOW_STATUSES } from "../model";
import { WorkflowError, type Deps } from "./deps";
import { summarizeVerification, verifyItem } from "./verify";

export const MAX_TASK_ITEMS = 25;

export { TRANSITIONS };


export const isActive = (t: FixTask) => t.workflowStatus !== "resolved" && t.workflowStatus !== "wont_fix";
export const statusLabel = (s: WorkflowStatus) => WORKFLOW_STATUSES.find((w) => w.id === s)?.label ?? s;

function defaultTitle(findings: AuditFinding[]): string {
  if (findings.length === 1) {
    const f = findings[0];
    return f.scope.kind === "page" ? `${f.title} — ${displayPath(f.pageUrl)}` : f.title;
  }
  const codes = new Set(findings.map((f) => f.ruleCode));
  if (codes.size === 1) return `${findings[0].title} on ${findings.length} pages`;
  return `${findings.length} issues to fix`;
}

export interface CreateTaskInput {
  auditId: string;
  fingerprints: string[];
  title?: string;
  owner?: string | null;
  notes?: string;
}

/**
 * Create a task from findings in a stored audit. The client only names findings by fingerprint;
 * the evidence and acceptance criteria are copied from the server's own audit record.
 */
export async function createTask(input: CreateTaskInput, deps: Deps): Promise<{ task: FixTask; skipped: { fingerprint: string; taskId: string }[] }> {
  const fps = [...new Set(input.fingerprints)];
  if (fps.length === 0) throw new WorkflowError("INVALID", "Select at least one finding.");
  if (fps.length > MAX_TASK_ITEMS) throw new WorkflowError("INVALID", `A task can cover at most ${MAX_TASK_ITEMS} findings.`);
  const data = await deps.store.read();
  const audit = data.audits[input.auditId];
  if (!audit) throw new WorkflowError("NOT_FOUND", "Audit not found.");
  if (audit.status === "running") throw new WorkflowError("INVALID", "Wait for the audit to finish before creating tasks from it.");
  const blob = await deps.store.readAudit(input.auditId);
  const byFp = new Map(blob.findings.map((f) => [f.fingerprint, f]));
  const missing = fps.filter((fp) => !byFp.has(fp));
  if (missing.length) throw new WorkflowError("NOT_FOUND", `Finding ${missing[0]} is not in this audit.`);

  return deps.store.update((d) => {
    const active = Object.values(d.tasks).filter((t) => t.siteId === audit.siteId && isActive(t));
    const skipped: { fingerprint: string; taskId: string }[] = [];
    const items: TaskItem[] = [];
    for (const fp of fps) {
      const f = byFp.get(fp)!;
      // Fingerprints are recomputed so a tampered stored value can't alias another issue.
      if (fingerprintOf(f) !== fp) throw new WorkflowError("INVALID", "Finding identity mismatch.");
      const owner = active.find((t) => t.items.some((i) => i.fingerprint === fp));
      if (owner) {
        skipped.push({ fingerprint: fp, taskId: owner.id });
        continue;
      }
      const snap = blob.snapshots.find((p) => f.scope.kind === "page" && (p.finalUrl === f.pageUrl || p.url === f.pageUrl));
      if (f.verify === "page" && snap?.truncated) {
        throw new WorkflowError("INVALID", "This page is larger than 2 MB, so a fix could never be verified. Not creating a task for it.");
      }
      const originalObservation: Observation = {
        capturedAt: snap?.fetchedAt ?? audit.startedAt,
        source: audit.source,
        finalUrl: snap?.finalUrl ?? f.pageUrl,
        httpStatus: snap?.status ?? 0,
        facts: f.evidence.facts,
        snippets: f.evidence.snippets,
      };
      items.push({ fingerprint: fp, auditId: audit.id, finding: f, originalObservation, lastOutcome: null });
    }
    if (items.length === 0) {
      throw new WorkflowError("CONFLICT", "These findings are already covered by an open task.", { taskId: skipped[0].taskId });
    }
    const at = deps.now().toISOString();
    const task: FixTask = {
      id: deps.newId(),
      siteId: audit.siteId,
      source: audit.source,
      createdAt: at,
      updatedAt: at,
      title: (input.title?.trim() || defaultTitle(items.map((i) => i.finding))).slice(0, 200),
      owner: input.owner?.trim() || null,
      notes: (input.notes ?? "").slice(0, 10_000),
      manualChecks: [],
      workflowStatus: "open",
      wontFixReason: null,
      verificationStatus: "unverified",
      items,
      verifications: [],
      history: [{ at, kind: "created", note: `${items.length} finding(s) from audit ${audit.id}` }],
    };
    d.tasks[task.id] = task;
    return { task, skipped };
  });
}

export interface TaskPatch {
  title?: string;
  owner?: string | null;
  notes?: string;
  manualChecks?: ManualCheck[];
  workflowStatus?: WorkflowStatus;
  wontFixReason?: string;
}

function applyPatch(task: FixTask, patch: TaskPatch, at: string): FixTask {
  const t: FixTask = structuredClone(task);
  if (patch.workflowStatus && patch.workflowStatus !== t.workflowStatus) {
    const allowed = TRANSITIONS[t.workflowStatus];
    if (!allowed.includes(patch.workflowStatus)) {
      throw new WorkflowError(
        "INVALID",
        `A task cannot move from ${statusLabel(t.workflowStatus)} to ${statusLabel(patch.workflowStatus)}. Allowed: ${allowed.map(statusLabel).join(", ")}.`,
      );
    }
    if (patch.workflowStatus === "wont_fix") {
      const reason = patch.wontFixReason?.trim();
      if (!reason) throw new WorkflowError("INVALID", "Record why this issue is deliberately not being fixed.");
      t.wontFixReason = reason.slice(0, 2000);
    } else if (t.workflowStatus === "wont_fix") {
      t.wontFixReason = null;
    }
    const note =
      patch.workflowStatus === "resolved" && t.verificationStatus !== "passing"
        ? "Marked resolved without a passing verification."
        : patch.workflowStatus === "wont_fix"
          ? t.wontFixReason!
          : undefined;
    t.history.push({ at, kind: "status", from: t.workflowStatus, to: patch.workflowStatus, note });
    t.workflowStatus = patch.workflowStatus;
  }
  if (patch.owner !== undefined) {
    const owner = patch.owner?.trim().slice(0, 100) || null;
    if (owner !== t.owner) {
      t.history.push({ at, kind: "owner", from: t.owner ?? "unassigned", to: owner ?? "unassigned" });
      t.owner = owner;
    }
  }
  const edited: string[] = [];
  if (patch.title !== undefined && patch.title.trim() && patch.title.trim() !== t.title) {
    t.title = patch.title.trim().slice(0, 200);
    edited.push("title");
  }
  if (patch.notes !== undefined && patch.notes !== t.notes) {
    t.notes = patch.notes.slice(0, 10_000);
    edited.push("notes");
  }
  if (patch.manualChecks !== undefined) {
    t.manualChecks = patch.manualChecks.slice(0, 30).map((c) => ({ id: c.id.slice(0, 40), text: c.text.slice(0, 500), done: !!c.done }));
    edited.push("manual checks");
  }
  if (edited.length) t.history.push({ at, kind: "edited", note: `Edited ${edited.join(", ")}` });
  t.updatedAt = at;
  return t;
}

export async function updateTask(id: string, patch: TaskPatch, deps: Deps): Promise<FixTask> {
  return deps.store.update((d) => {
    const t = d.tasks[id];
    if (!t) throw new WorkflowError("NOT_FOUND", "Task not found.");
    d.tasks[id] = applyPatch(t, patch, deps.now().toISOString());
    return d.tasks[id];
  });
}

export interface BulkResult {
  updated: string[];
  failed: { id: string; message: string }[];
}

/** Apply the same patch to many tasks. Each task is validated on its own; one invalid move doesn't block the rest. */
export async function bulkUpdateTasks(ids: string[], patch: Pick<TaskPatch, "workflowStatus" | "owner" | "wontFixReason">, deps: Deps): Promise<BulkResult> {
  if (ids.length === 0 || ids.length > 200) throw new WorkflowError("INVALID", "Select between 1 and 200 tasks.");
  return deps.store.update((d) => {
    const at = deps.now().toISOString();
    const result: BulkResult = { updated: [], failed: [] };
    for (const id of new Set(ids)) {
      const t = d.tasks[id];
      if (!t) {
        result.failed.push({ id, message: "Task not found." });
        continue;
      }
      try {
        d.tasks[id] = applyPatch(t, patch, at);
        result.updated.push(id);
      } catch (e) {
        result.failed.push({ id, message: (e as Error).message });
      }
    }
    return result;
  });
}

/**
 * Re-check every item against its frozen acceptance criteria and record one verification.
 * Fetches happen outside the store lock. Verification never changes the workflow status, except that
 * a failing re-check of a Resolved task reopens it as a regression.
 */
export async function verifyTask(id: string, deps: Deps, env: Omit<Parameters<typeof verifyItem>[1], "fetch" | "now" | "source">): Promise<FixTask> {
  const snapshot = await deps.store.read();
  const task = snapshot.tasks[id];
  if (!task) throw new WorkflowError("NOT_FOUND", "Task not found.");
  const site = snapshot.sites[task.siteId];
  const at = deps.now().toISOString();
  const items: Awaited<ReturnType<typeof verifyItem>>[] = [];
  for (const item of task.items) {
    items.push(await verifyItem(item, { ...env, fetch: deps.fetch, now: deps.now, source: task.source, origin: site?.origin ?? env.origin }));
  }
  const summary = summarizeVerification(items);
  const verification: TaskVerification = { id: deps.newId(), at, outcome: summary.outcome, reason: summary.reason, items };

  return deps.store.update((d) => {
    const current = d.tasks[id];
    if (!current) throw new WorkflowError("NOT_FOUND", "Task not found.");
    const t = structuredClone(current);
    t.verifications.push(verification);
    t.verificationStatus = summary.outcome as VerificationStatus;
    for (const iv of items) {
      const it = t.items.find((x) => x.fingerprint === iv.fingerprint);
      if (it) it.lastOutcome = iv.outcome;
    }
    t.history.push({ at, kind: "verified", to: summary.outcome, note: summary.reason });
    if (summary.outcome === "failing" && t.workflowStatus === "resolved") {
      t.history.push({ at, kind: "regression", from: "resolved", to: "open", note: "Reopened: a re-check failed after the task was resolved." });
      t.workflowStatus = "open";
    }
    t.updatedAt = at;
    d.tasks[id] = t;
    return t;
  });
}

export async function deleteTask(id: string, deps: Deps): Promise<void> {
  await deps.store.update((d) => {
    if (!d.tasks[id]) throw new WorkflowError("NOT_FOUND", "Task not found.");
    delete d.tasks[id];
  });
}

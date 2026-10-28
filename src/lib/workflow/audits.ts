import { WorkflowError, type Deps } from "./deps";

const RUNNING = "This audit is still running. Cancel it first, then delete it.";

/**
 * Deletes one audit and its stored results. Tasks created from it are kept: they carry their own
 * copy of each finding, so they can still be verified. Irreversible; the UI asks for confirmation.
 */
export async function deleteAudit(id: string, deps: Deps): Promise<{ siteId: string }> {
  const siteId = await deps.store.update((d) => {
    const a = d.audits[id];
    if (!a) throw new WorkflowError("NOT_FOUND", "Audit not found.");
    // A step in flight would write a running audit back after deletion.
    if (a.status === "running") throw new WorkflowError("CONFLICT", RUNNING);
    delete d.audits[id];
    return a.siteId;
  });
  await deps.store.deleteAudit(id);
  return { siteId };
}

/**
 * Deletes every audit of a site and the tasks built from them, so the site starts with a clean
 * history. The site itself, its important URLs and workspace settings are kept.
 */
export async function clearAuditHistory(siteId: string, deps: Deps): Promise<{ auditsDeleted: number; tasksDeleted: number }> {
  const { auditIds, tasksDeleted } = await deps.store.update((d) => {
    if (!d.sites[siteId]) throw new WorkflowError("NOT_FOUND", "Site not found.");
    const audits = Object.values(d.audits).filter((a) => a.siteId === siteId);
    if (audits.some((a) => a.status === "running")) throw new WorkflowError("CONFLICT", "An audit is running for this site. Cancel it first.");
    for (const a of audits) delete d.audits[a.id];
    let tasks = 0;
    for (const [tid, t] of Object.entries(d.tasks)) {
      if (t.siteId === siteId) {
        delete d.tasks[tid];
        tasks++;
      }
    }
    return { auditIds: audits.map((a) => a.id), tasksDeleted: tasks };
  });
  for (const id of auditIds) await deps.store.deleteAudit(id);
  return { auditsDeleted: auditIds.length, tasksDeleted };
}

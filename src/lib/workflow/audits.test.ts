import { describe, expect, it } from "vitest";
import { buildSampleSeed } from "../sample/seed";
import { MemoryStore } from "../store/store";
import { clearAuditHistory, deleteAudit } from "./audits";
import type { Deps } from "./deps";

async function setup() {
  const seed = await buildSampleSeed();
  const store = new MemoryStore(seed.state, { blobs: seed.blobs });
  const deps: Deps = { store, fetch: async () => { throw new Error("no network"); }, now: () => new Date("2026-10-20T00:00:00Z"), newId: () => "x", source: "live" };
  return { store, deps };
}

describe("deleting audits", () => {
  it("deletes one audit and its results, keeping the site and its tasks", async () => {
    const { store, deps } = await setup();
    const before = await store.read();
    const audit = Object.values(before.audits)[0];
    const tasks = Object.keys(before.tasks).length;
    expect((await store.readAudit(audit.id)).findings.length).toBeGreaterThan(0);
    await expect(deleteAudit(audit.id, deps)).resolves.toEqual({ siteId: audit.siteId });
    const after = await store.read();
    expect(after.audits[audit.id]).toBeUndefined();
    expect(after.sites[audit.siteId]).toBeDefined();
    expect(Object.keys(after.tasks)).toHaveLength(tasks);
    expect((await store.readAudit(audit.id)).findings).toHaveLength(0);
    await expect(deleteAudit(audit.id, deps)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses to delete a running audit", async () => {
    const { store, deps } = await setup();
    const id = Object.keys((await store.read()).audits)[0];
    await store.update((d) => { d.audits[id].status = "running"; });
    await expect(deleteAudit(id, deps)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await store.read()).audits[id]).toBeDefined();
  });

  it("clears a site's audit history and tasks but keeps the site and other sites' data", async () => {
    const { store, deps } = await setup();
    const before = await store.read();
    const [siteId, otherId] = Object.keys(before.sites);
    const otherAudits = Object.values(before.audits).filter((a) => a.siteId === otherId).length;
    const r = await clearAuditHistory(siteId, deps);
    expect(r.auditsDeleted).toBe(Object.values(before.audits).filter((a) => a.siteId === siteId).length);
    const after = await store.read();
    expect(after.sites[siteId]).toBeDefined();
    expect(Object.values(after.audits).filter((a) => a.siteId === siteId)).toHaveLength(0);
    expect(Object.values(after.tasks).filter((t) => t.siteId === siteId)).toHaveLength(0);
    expect(Object.values(after.audits).filter((a) => a.siteId === otherId)).toHaveLength(otherAudits);
  });
});

import { describe, expect, it } from "vitest";
import type { AuditRun } from "../model";
import { isStale, LIMITS } from "./engine";

const now = new Date("2026-11-05T12:00:00Z");
const old = new Date(now.getTime() - LIMITS.staleMs - 1000).toISOString();
const audit = (o: Partial<AuditRun>) => ({ status: "running", heartbeatAt: old, ...o }) as AuditRun;

describe("isStale", () => {
  it("calls a legacy audit with an old heartbeat interrupted", () => {
    expect(isStale(audit({}), now)).toBe(true);
    expect(isStale(audit({ heartbeatAt: now.toISOString() }), now)).toBe(false);
    expect(isStale(audit({ status: "completed" }), now)).toBe(false);
  });
  it("never calls a v2 audit interrupted: its heartbeat is only the last sync", () => {
    expect(isStale(audit({ crawler: { crawlId: "c1" } as AuditRun["crawler"] }), now)).toBe(false);
  });
});

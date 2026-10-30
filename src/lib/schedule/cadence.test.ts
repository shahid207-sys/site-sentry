import { describe, expect, it } from "vitest";
import { describeTiming, nextRun, timingProblem } from "./cadence";

const at = (iso: string) => new Date(iso);

describe("nextRun", () => {
  it("daily: later today, else tomorrow; never the same instant", () => {
    expect(nextRun({ cadence: "daily", hourUtc: 6 }, at("2026-10-30T05:59:00Z")).toISOString()).toBe("2026-10-30T06:00:00.000Z");
    expect(nextRun({ cadence: "daily", hourUtc: 6 }, at("2026-10-30T06:00:00Z")).toISOString()).toBe("2026-10-31T06:00:00.000Z");
    expect(nextRun({ cadence: "daily", hourUtc: 0 }, at("2026-12-31T23:30:00Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("weekly: the next given weekday at the hour", () => {
    // 2026-10-30 is a Friday (5).
    expect(nextRun({ cadence: "weekly", hourUtc: 9, weekday: 1 }, at("2026-10-30T12:00:00Z")).toISOString()).toBe("2026-11-02T09:00:00.000Z");
    expect(nextRun({ cadence: "weekly", hourUtc: 9, weekday: 5 }, at("2026-10-30T08:00:00Z")).toISOString()).toBe("2026-10-30T09:00:00.000Z");
    expect(nextRun({ cadence: "weekly", hourUtc: 9, weekday: 5 }, at("2026-10-30T09:00:00Z")).toISOString()).toBe("2026-11-06T09:00:00.000Z");
  });

  it("monthly: the day this month if still ahead, else next month (28 exists in February)", () => {
    expect(nextRun({ cadence: "monthly", hourUtc: 3, monthday: 28 }, at("2026-02-27T00:00:00Z")).toISOString()).toBe("2026-02-28T03:00:00.000Z");
    expect(nextRun({ cadence: "monthly", hourUtc: 3, monthday: 1 }, at("2026-10-30T00:00:00Z")).toISOString()).toBe("2026-11-01T03:00:00.000Z");
    expect(nextRun({ cadence: "monthly", hourUtc: 3, monthday: 28 }, at("2027-01-31T00:00:00Z")).toISOString()).toBe("2027-02-28T03:00:00.000Z");
    expect(nextRun({ cadence: "monthly", hourUtc: 3, monthday: 15 }, at("2026-12-20T00:00:00Z")).toISOString()).toBe("2027-01-15T03:00:00.000Z");
  });

  it("rejects invalid timings", () => {
    expect(timingProblem({ cadence: "daily", hourUtc: 24 })).toMatch(/hour/);
    expect(timingProblem({ cadence: "weekly", hourUtc: 1 })).toMatch(/weekday/);
    expect(timingProblem({ cadence: "monthly", hourUtc: 1, monthday: 29 })).toMatch(/1–28/);
    expect(() => nextRun({ cadence: "monthly", hourUtc: 1, monthday: 0 }, new Date())).toThrow();
    expect(timingProblem({ cadence: "weekly", hourUtc: 23, weekday: 0 })).toBeNull();
  });

  it("describes a timing", () => {
    expect(describeTiming({ cadence: "weekly", hourUtc: 6, weekday: 1 })).toBe("Weekly on Monday at 06:00 UTC");
    expect(describeTiming({ cadence: "monthly", hourUtc: 18, monthday: 1 })).toBe("Monthly on day 1 at 18:00 UTC");
  });
});

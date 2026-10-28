import { describe, expect, it } from "vitest";
import { parseRetryAfter } from "./politeness";

// HostThrottle keeps its state in Redis: its tests are in politeness.int.test.ts.

describe("parseRetryAfter", () => {
  it("reads delta-seconds and HTTP dates", () => {
    expect(parseRetryAfter("120")).toBe(120_000);
    const now = Date.parse("2026-10-28T10:00:00Z");
    expect(parseRetryAfter("Wed, 28 Oct 2026 10:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfter("Wed, 28 Oct 2026 09:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});

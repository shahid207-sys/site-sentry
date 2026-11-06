import { describe, expect, it } from "vitest";
import { finding } from "./contract";
import { evidenceKey } from "./fingerprint";

const f = (evidence: Record<string, unknown>) => finding({ id: "LNK-016", version: 1, confidence: "heuristic" }, "https://a.test/", "m", evidence);

describe("evidenceKey", () => {
  it("never returns a NUL, which Postgres refuses in text and jsonb", () => {
    expect(evidenceKey(undefined, f({ groupKey: "get a quote\u0000https://a.test/" }))).toBe("get a quote https://a.test/");
    expect(evidenceKey({ evidenceKey: () => "a\u0000b" }, f({}))).toBe("a b");
  });

  it("is empty without a key", () => {
    expect(evidenceKey(undefined, f({}))).toBe("");
  });
});

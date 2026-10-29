import { describe, expect, it } from "vitest";
import { bfsDepth, pageRank } from "./graph";

describe("pageRank", () => {
  // 0 → 1, 0 → 2, 1 → 2, 2 → 0, and 3 → 2 (3 has no inbound links). Hand-checked against the power iteration:
  // 2 collects from everyone, 0 gets all of 2's rank, 3 only the teleport share.
  const edges: [number, number][] = [[0, 1], [0, 2], [1, 2], [2, 0], [3, 2], [1, 2], [2, 2]]; // a duplicate and a self-link, ignored

  it("ranks a 4-node graph, keeps the total at 1, and normalises 0–100 on a log scale", () => {
    const { raw, score } = pageRank(4, edges);
    expect(raw.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    const order = [...raw.keys()].sort((a, b) => raw[b] - raw[a]);
    expect(order).toEqual([2, 0, 1, 3]);
    expect(raw[3]).toBeCloseTo(0.15 / 4, 10); // teleport only
    expect(score[2]).toBe(100);
    expect(score[3]).toBe(0);
    expect(score[0]).toBeGreaterThan(score[1]);
    // One step by hand from the stationary values: PR(1) = 0.15/4 + 0.85 × PR(0)/2.
    expect(raw[1]).toBeCloseTo(0.15 / 4 + (0.85 * raw[0]) / 2, 3);
  });

  it("spreads a dangling node's rank evenly, so the total stays 1", () => {
    const { raw } = pageRank(3, [[0, 1], [1, 2]]); // 2 has no outlinks
    expect(raw.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(raw[2]).toBeGreaterThan(raw[1]);
    expect(raw[1]).toBeGreaterThan(raw[0]);
  });

  it("gives every node 100 when the scores are equal", () => {
    expect([...pageRank(1, []).score]).toEqual([100]);
    expect([...pageRank(2, [[0, 1], [1, 0]]).score]).toEqual([100, 100]);
  });
});

describe("bfsDepth", () => {
  it("counts clicks from the start and marks unreachable nodes -1", () => {
    expect([...bfsDepth(5, [[1, 2], [3], [3], [], []], 0)]).toEqual([0, 1, 1, 2, -1]);
  });
});

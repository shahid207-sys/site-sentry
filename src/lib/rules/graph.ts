// Link-graph metrics for the site-level pass (docs/SPEC.md "Phase 2" item 4): internal PageRank and click depth.
// Pure functions over integer node ids, so the site pass can build the graph from url_edges in batches and keep only
// typed arrays in memory.

export const PAGERANK_ITERATIONS = 20;
export const PAGERANK_DAMPING = 0.85;

/**
 * Internal PageRank: `iterations` power iterations with damping `d`, starting from 1/N.
 * - Edges are deduplicated per (from, to) and self-links dropped: one page linking another twice passes rank once.
 * - Dangling nodes (no outlinks: non-HTML, 404s, redirects not resolved into an edge) spread their rank evenly over
 *   every node, the standard fix that keeps the total at 1.
 * Returns raw scores (summing to 1) and scores normalised to 0–100 on a log scale: 100 × (ln p − ln min) /
 * (ln max − ln min), so the long tail of leaf pages stays distinguishable (a linear scale puts almost all of them at 0).
 * With one node, or all scores equal, every normalised score is 100.
 */
export function pageRank(n: number, edges: Iterable<[number, number]>, iterations = PAGERANK_ITERATIONS, d = PAGERANK_DAMPING): { raw: Float64Array; score: Float64Array } {
  const raw = new Float64Array(n);
  const score = new Float64Array(n);
  if (n === 0) return { raw, score };
  const seen = new Set<string>();
  const out: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of edges) {
    if (a === b) continue;
    const k = `${a}:${b}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out[a].push(b);
  }
  raw.fill(1 / n);
  let next = new Float64Array(n);
  for (let it = 0; it < iterations; it++) {
    let dangling = 0;
    for (let i = 0; i < n; i++) if (!out[i].length) dangling += raw[i];
    next.fill((1 - d) / n + (d * dangling) / n);
    for (let i = 0; i < n; i++) {
      if (!out[i].length) continue;
      const share = (d * raw[i]) / out[i].length;
      for (const j of out[i]) next[j] += share;
    }
    const prev = raw.slice();
    raw.set(next);
    next = prev;
  }
  let min = Infinity;
  let max = -Infinity;
  for (const v of raw) {
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  const span = Math.log(max) - Math.log(min);
  for (let i = 0; i < n; i++) score[i] = span > 1e-12 ? (100 * (Math.log(raw[i]) - Math.log(min))) / span : 100;
  return { raw, score };
}

/** Breadth-first click depth from `start` over directed edges; -1 where unreachable. */
export function bfsDepth(n: number, adjacency: number[][], start: number): Int32Array {
  const depth = new Int32Array(n).fill(-1);
  if (start < 0 || start >= n) return depth;
  depth[start] = 0;
  const queue = [start];
  for (let q = 0; q < queue.length; q++) {
    const at = queue[q];
    for (const next of adjacency[at]) {
      if (depth[next] !== -1) continue;
      depth[next] = depth[at] + 1;
      queue.push(next);
    }
  }
  return depth;
}

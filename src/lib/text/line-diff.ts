// Line diff (Myers' O((N+M)·D) algorithm) for the inspector's raw vs rendered HTML view. Pure and client-safe. HTML is
// split one tag per line first, so a script's change shows as the lines it changed, not one long line.

export type DiffOp = "same" | "add" | "del";
export interface DiffLine {
  op: DiffOp;
  text: string;
  /** 1-based line numbers in the old and new documents (null on the side the line is not in). */
  a: number | null;
  b: number | null;
}
export interface DiffResult {
  lines: DiffLine[];
  added: number;
  removed: number;
  /** The documents differ in more than `maxEdits` lines: no line diff, only the counts of lines. */
  tooLarge: boolean;
}

/** One tag (or text run) per line, trimmed, without blank lines. */
export function htmlLines(html: string): string[] {
  return html
    .replace(/>\s*</g, ">\n<")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** The shortest edit script from `a` to `b`, as lines. Gives up (tooLarge) past `maxEdits` differing lines. */
export function diffLines(a: string[], b: string[], maxEdits = 4000): DiffResult {
  // Common prefix and suffix are cheap and usually most of a page.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const n = A.length;
  const m = B.length;
  const max = Math.min(n + m, maxEdits);
  const off = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = n === 0 && m === 0;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) {
        x++;
        y++;
      }
      next[off + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
    v = next;
  }
  if (!found) return { lines: [], added: b.length - pre - suf, removed: a.length - pre - suf, tooLarge: true };

  // Walk the trace back from (n, m) to (0, 0).
  const mid: DiffLine[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vv = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1]);
    const pk = down ? k + 1 : k - 1;
    const px = vv[off + pk];
    const py = px - pk;
    while (x > px && y > py) {
      x--;
      y--;
      mid.push({ op: "same", text: A[x], a: 0, b: 0 });
    }
    if (d === 0) break;
    if (down) {
      y--;
      mid.push({ op: "add", text: B[y], a: null, b: 0 });
    } else {
      x--;
      mid.push({ op: "del", text: A[x], a: 0, b: null });
    }
  }
  mid.reverse();

  const lines: DiffLine[] = [];
  let ai = 1;
  let bi = 1;
  const push = (op: DiffOp, text: string) => {
    lines.push({ op, text, a: op === "add" ? null : ai, b: op === "del" ? null : bi });
    if (op !== "add") ai++;
    if (op !== "del") bi++;
  };
  for (let i = 0; i < pre; i++) push("same", a[i]);
  for (const l of mid) push(l.op, l.text);
  for (let i = a.length - suf; i < a.length; i++) push("same", a[i]);
  return { lines, added: lines.filter((l) => l.op === "add").length, removed: lines.filter((l) => l.op === "del").length, tooLarge: false };
}

/** The changed lines with `context` unchanged lines around each change; a null entry marks skipped lines. */
export function hunks(lines: DiffLine[], context = 3): (DiffLine | null)[] {
  const keep = new Uint8Array(lines.length);
  lines.forEach((l, i) => {
    if (l.op === "same") return;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep[j] = 1;
  });
  const out: (DiffLine | null)[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) out.push(lines[i]);
    else if (out.length && out[out.length - 1] !== null) out.push(null);
  }
  if (out.length && out[0] === null) out.shift();
  return out;
}

// English spell check for short labels (CNT-023): nav labels and headings. Hunspell's en_US dictionary through nspell,
// pure JS, loaded on first use and kept for the process. Words of the project's allowlist and the built-in one
// (place names, trade terms) are known words.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import nspell from "nspell";
import { BUILTIN_ALLOW } from "./data/spelling-allow";

type Speller = ReturnType<typeof nspell>;
/** A typo is one edit from the word meant. */
export const MAX_EDITS = 1;
let speller: Speller | null = null;
const verdicts = new Map<string, string | null>();

function load(): Speller {
  if (speller) return speller;
  // dictionary-en exports only its loader, which reads with import.meta.url; read its files from the package folder.
  const dir = path.dirname(createRequire(path.join(process.cwd(), "package.json")).resolve("dictionary-en"));
  speller = nspell(readFileSync(path.join(dir, "index.aff")), readFileSync(path.join(dir, "index.dic")));
  for (const w of BUILTIN_ALLOW) speller.add(w);
  return speller;
}

/** A word worth checking: letters only, 4+ of them, not an acronym ("UAE", "CNC") or a word with digits ("3D"). */
export const checkable = (w: string) => /^\p{L}{4,}$/u.test(w) && /^[A-Za-z]+$/.test(w) && !(w.length <= 5 && w === w.toUpperCase());

/**
 * The suggested spelling when `word` is not an English word, else null. Only words one edit from a known word count
 * (a swap, a missing or extra letter): a word further from any is more often a name ("Himars") than a typo. Of the
 * closest suggestions, one with the same first letter wins: "Tabels" is "tables", not "babels". Checked as written, then lower-cased, so "Dubai" and "DUBAI" pass
 * when either form is known.
 */
export function misspelling(word: string, allow: ReadonlySet<string> = new Set()): string | null {
  if (!checkable(word) || allow.has(word.toLowerCase())) return null;
  const key = word.toLowerCase();
  if (verdicts.has(key)) return verdicts.get(key)!;
  const s = load();
  const title = key[0].toUpperCase() + key.slice(1);
  let out: string | null = null;
  if (!s.correct(word) && !s.correct(key) && !s.correct(title) && !britishOf(s, key)) {
    const close = s
      .suggest(key)
      .map((x, i) => ({ x, i, d: editDistance(x.toLowerCase(), key), first: x[0].toLowerCase() === key[0] ? 0 : 1 }))
      .filter((c) => c.d <= MAX_EDITS && !/[\s'-]/.test(c.x) && likelyTypo(key, c.x.toLowerCase()))
      .sort((a, b) => a.d - b.d || a.first - b.first || a.i - b.i)[0];
    out = close?.x ?? null;
  }
  verdicts.set(key, out);
  return out;
}

/** British forms of American words: colour, centre, woollen, skilful, fulfil, organise, analyse, catalogue, defence. */
const BRITISH: [RegExp, string][] = [
  [/our/g, "or"],
  [/tre(s?)$/, "ter$1"],
  [/ll/g, "l"],
  [/ilf/g, "illf"],
  [/(fulfil|instil|enrol|distil)(s|ment|ments)?$/, "$1l$2"],
  [/is(e|es|ed|ing|ation|ations)$/, "iz$1"],
  [/ys(e|es|ed|ing)$/, "yz$1"],
  [/ogue(s?)$/, "og$1"],
  [/ence(s?)$/, "ense$1"],
];
/** The dictionary is American English: a word is known when its American form is. */
function britishOf(s: Speller, key: string): boolean {
  return BRITISH.some(([re, us]) => {
    const v = key.replace(re, us);
    return v !== key && s.correct(v);
  });
}

/**
 * Is one edit from `word` to `meant` a typo rather than a name? A swap ("Tabels") or a dropped letter ("Humve")
 * from 5 letters, a wrong letter from 6 ("Tomnes"), an extra letter from 7. Shorter words one letter from a
 * dictionary word are mostly names: "Frej", "Hosn", "Mila", "Aldar".
 */
export function likelyTypo(word: string, meant: string): boolean {
  if (meant.length > word.length) return word.length >= 5;
  if (meant.length < word.length) return word.length >= 7;
  const swap = [...word].sort().join() === [...meant].sort().join();
  return (swap && word.length >= 5) || word.length >= 6;
}

/** Two words run together: "FilesPLOAD" (a lower-case letter, then two capitals and more). */
export const joinedWords = (w: string) => /\p{Ll}\p{Lu}{2,}/u.test(w);

/** Same case as written: "Tabels" gives "Tables", "TABELS" gives "TABLES". */
export function matchCase(written: string, word: string): string {
  if (written === written.toUpperCase()) return word.toUpperCase();
  if (written[0] === written[0].toUpperCase()) return word[0].toUpperCase() + word.slice(1);
  return word;
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

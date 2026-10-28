// Text measures used by page snapshots and content rules. Pure and dependency-free.
import { createHash } from "node:crypto";

/** Words of visible text: whitespace-separated tokens that contain a letter or digit. */
export function words(text: string): string[] {
  const t = text.replace(/\s+/g, " ").trim();
  return t ? t.split(" ").filter((w) => /[\p{L}\p{N}]/u.test(w)) : [];
}

/** Lower-cased word tokens with punctuation stripped, for hashing and term comparison. */
export function terms(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/** sha256 of the whitespace-normalised, lower-cased text; null when the text is too short to compare. */
export function textHash(text: string, minWords = 50): string | null {
  const t = terms(text);
  if (t.length < minWords) return null;
  return createHash("sha256").update(t.join(" ")).digest("hex");
}

// ---------- SimHash ----------

/** SimHash features: every word and every pair of adjacent words. */
export const SIMHASH_MAX_SHINGLE = 2;

function fnv1a32(s: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 64-bit SimHash (Charikar) of the text, as 16 hex characters; null under 4 words. Features are words and
 * adjacent-word pairs: measured on generated text, 3-word shingles alone put pages with 1% of words changed
 * anywhere from 77% to 98% similar, while words + pairs keep such pages near 97% (fixtures/site/simhash.test.ts).
 * Each feature is hashed with two seeded 32-bit FNV-1a hashes to make 64 bits.
 */
export function simhash(text: string): string | null {
  const t = terms(text);
  if (t.length < 4) return null;
  const v = new Int32Array(64);
  const add = (f: string) => {
    const hi = fnv1a32(f, 0x811c9dc5);
    const lo = fnv1a32(f, 0x9e3779b9);
    for (let b = 0; b < 32; b++) {
      v[b] += (hi >>> b) & 1 ? 1 : -1;
      v[32 + b] += (lo >>> b) & 1 ? 1 : -1;
    }
  };
  for (let i = 0; i < t.length; i++) {
    add(t[i]);
    if (i + 1 < t.length) add(`${t[i]} ${t[i + 1]}`);
  }
  let hi = 0;
  let lo = 0;
  for (let b = 0; b < 32; b++) {
    if (v[b] > 0) hi |= 1 << b;
    if (v[32 + b] > 0) lo |= 1 << b;
  }
  return (hi >>> 0).toString(16).padStart(8, "0") + (lo >>> 0).toString(16).padStart(8, "0");
}

function popcount32(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Share of the 64 SimHash bits two hashes agree on, 0–1. */
export function simhashSimilarity(a: string, b: string): number {
  const d = popcount32((parseInt(a.slice(0, 8), 16) ^ parseInt(b.slice(0, 8), 16)) >>> 0) + popcount32((parseInt(a.slice(8), 16) ^ parseInt(b.slice(8), 16)) >>> 0);
  return 1 - d / 64;
}

// ---------- pixel width ----------

// Arial advance widths in 1/1000 em for printable ASCII (32–126). Search results render titles in Arial-like fonts.
const ARIAL = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/**
 * Estimated rendered width in pixels of text in Arial at the given size. Characters outside ASCII count as an
 * average Latin letter (556), or a full em for CJK and other wide scripts. An estimate, not a measurement.
 */
export function pixelWidth(text: string, fontPx: number): number {
  let units = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c >= 32 && c <= 126) units += ARIAL[c - 32];
    else if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(ch)) units += 1000;
    else units += 556;
  }
  return Math.round((units * fontPx) / 1000);
}

/** Title width in search results: Arial 20 px. */
export const titlePixels = (t: string) => pixelWidth(t, 20);
/** Description width in search results: Arial 14 px. */
export const descriptionPixels = (t: string) => pixelWidth(t, 14);

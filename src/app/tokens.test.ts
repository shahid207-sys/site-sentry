// WCAG 2.2 AA contrast of the design tokens in globals.css, light and dark: every text token on every surface it
// sits on, and every status colour on its own soft fill (badges). Parses the CSS so a token edit cannot drift.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.join(__dirname, "globals.css"), "utf8");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block`);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1], m[2].toLowerCase()]));
}

const light = block(":root");
const dark = block(':root[data-theme="dark"]');

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const ratio = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const TEXT = ["fg", "fg-2", "fg-3", "accent-ink", "sev-high", "sev-medium", "sev-low", "ok", "info", "sample", "p-critical", "p-high", "p-medium", "p-low", "p-info"];
const SURFACES = ["bg", "surface", "surface-secondary", "elevated"];
const ON_SOFT = ["sev-high", "sev-medium", "sev-low", "ok", "info", "sample", "p-critical", "p-high", "p-medium", "p-low", "p-info"];

describe.each([
  ["light", light],
  ["dark", dark],
])("%s theme tokens", (_name, t) => {
  it("defines the same text and surface tokens", () => {
    for (const k of [...TEXT, ...SURFACES, ...ON_SOFT.map((x) => `${x}-soft`), "accent-fg", "accent", "accent-hover", "code-fg", "code-bg"]) expect(t[k], k).toMatch(/^#/);
  });
  it.each(TEXT.flatMap((fg) => SURFACES.map((bg) => [fg, bg])))("%s on %s is at least 4.5:1", (fg, bg) => {
    expect(ratio(t[fg], t[bg])).toBeGreaterThanOrEqual(4.5);
  });
  it.each(ON_SOFT)("%s on its soft fill is at least 4.5:1", (k) => {
    expect(ratio(t[k], t[`${k}-soft`])).toBeGreaterThanOrEqual(4.5);
  });
  it("keeps button text and code blocks readable", () => {
    expect(ratio(t["accent-fg"], t.accent)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t["accent-fg"], t["accent-hover"])).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t["code-fg"], t["code-bg"])).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t["accent-ink"], t["accent-soft"])).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t["accent-ink"], t["sidebar-active"])).toBeGreaterThanOrEqual(4.5);
  });
});

it("the OS dark theme and the chosen dark theme define the same tokens", () => {
  expect(block(':root:not([data-theme="light"])')).toEqual(dark);
  expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
});

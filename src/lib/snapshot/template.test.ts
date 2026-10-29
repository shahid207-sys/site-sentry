import { describe, expect, it } from "vitest";
import { parseHtml } from "../audit/parse";
import { clusterTemplates, jaccard, landmarkClasses, templatePaths, templateShape, urlPattern, type ShapedPage } from "./template";

const shape = (body: string) => templateShape(parseHtml(`<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`))!;
const LAYOUT = (main: string) => `<header class="site-header"><nav><a href="/">Home</a><a href="/b">Blog</a></nav></header><main>${main}</main><footer><p>© Shop</p></footer>`;

describe("template shape", () => {
  it("ignores text, list lengths, ids, inline styles, utility and generated class names", () => {
    const a = shape(LAYOUT(`<article><h1>One</h1><ul><li>a</li><li>b</li></ul><p>Text</p></article>`));
    const b = shape(
      LAYOUT(
        `<article id="post-123" class="px-4 md:flex jsx-2841 Post_body__x9Yq2" style="color:red"><h1 class="text-2xl font-bold">Another title</h1><ul><li>a</li><li>b</li><li>c</li><li>d</li></ul><p>Other text</p></article>`,
      ),
    );
    expect(b.fingerprint).toBe(a.fingerprint);
  });

  it("looks through bare single-child wrappers, and reads icons and embeds as leaves", () => {
    const a = shape(LAYOUT(`<section><h2>x</h2><p>y</p></section>`));
    expect(shape(LAYOUT(`<div><div><section><h2>x</h2><p>y</p></section></div></div>`)).fingerprint).toBe(a.fingerprint);
    expect(shape(LAYOUT(`<section><h2>x<svg class="lucide lucide-house"><path d="M0"/></svg></h2><p>y</p></section>`)).fingerprint).toBe(shape(LAYOUT(`<section><h2>x<svg class="lucide lucide-x"><circle/></svg></h2><p>y</p></section>`)).fingerprint);
  });

  it("tells layouts apart: other structure, other landmarks", () => {
    const a = shape(LAYOUT(`<article><h1>x</h1><p>y</p></article>`));
    expect(shape(LAYOUT(`<div class="product-grid"><h1>x</h1><p>y</p></div>`)).fingerprint).not.toBe(a.fingerprint);
    expect(shape(LAYOUT(`<article><h1>x</h1><p>y</p></article><aside><h2>More</h2></aside>`)).fingerprint).not.toBe(a.fingerprint);
    expect(shape(LAYOUT(`<article role="feed"><h1>x</h1><p>y</p></article>`)).fingerprint).not.toBe(a.fingerprint);
    // A wrapper with text, or with a landmark class, is part of the layout.
    expect(shape(LAYOUT(`<div>Note<article><h1>x</h1><p>y</p></article></div>`)).fingerprint).not.toBe(a.fingerprint);
  });

  it("keeps plain component names as landmarks and drops utilities", () => {
    expect(landmarkClasses("site-header px-4 md:flex text-center inline-flex lucide-house card__title Header_nav__3xYz1 jsx-123 bg-white/50 hidden")).toEqual(["card__title", "site-header"]);
    expect(templatePaths(parseHtml("<html><body><p>x</p></body></html>"))).toEqual(["body>p"]);
  });

  it("URL pattern keeps the first segment", () => {
    expect(urlPattern("https://a.test/")).toBe("/");
    expect(urlPattern("https://a.test/blog/how-to-dig/")).toBe("/blog/*");
    expect(urlPattern("https://a.test/services/web/dubai")).toBe("/services/*/*");
  });
});

describe("clusterTemplates", () => {
  const hashes = (n: number, from = 0) => Array.from({ length: n }, (_, i) => from + i);
  const pagesOf = (prefix: string, n: number, fingerprint: string, shapeArr: number[] | null): ShapedPage[] =>
    Array.from({ length: n }, (_, i) => ({ url: `https://a.test${prefix}${i}`, fingerprint, shape: shapeArr }));

  it("joins a near-identical shape (Jaccard ≥ 0.9) and keeps a different layout apart", () => {
    const base = hashes(20);
    const optional = [...base, 100, 101]; // two extra paths: 20/22 = 0.91
    const other = hashes(20, 50);
    const ids = clusterTemplates([...pagesOf("/p/", 5, "A", base), ...pagesOf("/q/", 2, "B", optional), ...pagesOf("/r/", 3, "C", other)]);
    expect(jaccard(base, optional)).toBeGreaterThanOrEqual(0.9);
    expect(new Set([...ids].filter(([u]) => /\/(p|q)\//.test(u)).map(([, id]) => id))).toEqual(new Set(["A"]));
    expect(new Set([...ids].filter(([u]) => u.includes("/r/")).map(([, id]) => id))).toEqual(new Set(["C"]));
  });

  it("uses the URL pattern only as a tiebreaker near the threshold", () => {
    const base = hashes(20);
    const near = [...hashes(18), 200, 201, 202]; // 18/23 ≈ 0.78 … below both bars
    const close = [...hashes(19), 300, 301]; // 19/22 ≈ 0.86: joins only within the same URL pattern
    expect(jaccard(base, close)).toBeGreaterThan(0.8);
    expect(jaccard(base, close)).toBeLessThan(0.9);
    const same = clusterTemplates([...pagesOf("/blog/a", 5, "A", base), ...pagesOf("/blog/b", 2, "B", close), ...pagesOf("/blog/c", 2, "N", near)]);
    expect(same.get("https://a.test/blog/b0")).toBe("A");
    expect(same.get("https://a.test/blog/c0")).toBe("N");
    const other = clusterTemplates([...pagesOf("/blog/a", 5, "A", base), ...pagesOf("/shop/b", 2, "B", close)]);
    expect(other.get("https://a.test/shop/b0")).toBe("B");
  });

  it("does not depend on page order; legacy snapshots without a shape group by exact fingerprint", () => {
    const list = [...pagesOf("/p/", 4, "A", hashes(20)), ...pagesOf("/q/", 4, "B", [...hashes(20), 99]), ...pagesOf("/old/", 3, "L", null), ...pagesOf("/old2/", 1, "A", null)];
    const a = clusterTemplates(list);
    const b = clusterTemplates([...list].reverse());
    expect([...a].sort()).toEqual([...b].sort());
    expect(a.get("https://a.test/old/0")).toBe("L");
    expect(a.get("https://a.test/old2/0")).toBe("A"); // same exact fingerprint as a shaped group
  });
});

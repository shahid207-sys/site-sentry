import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEEP_CHAIN_DEPTH, deepChainPath, manifestPaths, noindexPaths, REDIRECTS, SECTION_PAGE_TOTAL, SECTIONS, sectionPaths, SSRF_TARGETS } from "./definition";
import { startFixtureSite, type FixtureSite } from "./server";

let site: FixtureSite;
beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(() => site.close());

const get = (path: string) => fetch(`http://127.0.0.1:${site.port}${path}`, { redirect: "manual" });
const locs = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

describe("fixture definition", () => {
  it("has the spec's 16 sections at the spec's page counts, and unique paths", () => {
    expect(SECTIONS).toHaveLength(16);
    expect(SECTION_PAGE_TOTAL).toBe(1_170);
    for (const s of SECTIONS) expect(sectionPaths(s), s.path).toHaveLength(s.pages);
    const all = manifestPaths();
    expect(all).toHaveLength(1_171); // plus the home page
    expect(new Set(all).size).toBe(all.length);
    for (const s of SECTIONS) expect(sectionPaths(s).every((p) => p.startsWith(s.path))).toBe(true);
  });

  it("has a /deep/ chain to depth 12, 40 redirect URLs and 9 SSRF redirects", () => {
    expect(sectionPaths(SECTIONS.find((s) => s.path === "/deep/")!)).toContain(deepChainPath(DEEP_CHAIN_DEPTH));
    expect(Object.keys(REDIRECTS)).toHaveLength(39); // + the /redirects/ index = 40
    expect(SSRF_TARGETS).toHaveLength(9); // + the /ssrf/ index = 10
  });
});

describe("fixture server", () => {
  it("lists every manifest page exactly once across its gzipped child sitemaps", async () => {
    const robots = await (await get("/robots.txt")).text();
    expect(robots).toContain("User-agent: GPTBot\nDisallow: /");
    expect(robots).toContain(`Sitemap: ${site.origin}/sitemap_index.xml`);
    const children = locs(await (await get("/sitemap_index.xml")).text());
    expect(children.length).toBe(17);
    const listed: string[] = [];
    for (const child of children) {
      const res = await get(new URL(child).pathname);
      const buf = Buffer.from(await res.arrayBuffer());
      expect(buf.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b])); // really gzip
      listed.push(...locs(gunzipSync(buf).toString("utf8")).map((u) => new URL(u).pathname));
    }
    expect(listed.sort()).toEqual(manifestPaths().sort());
    const noindexSitemap = gunzipSync(Buffer.from(await (await get("/sitemaps/index-noindex.xml.gz")).arrayBuffer())).toString();
    expect(locs(noindexSitemap).map((u) => new URL(u).pathname)).toEqual(noindexPaths());
  });

  it("serves every manifest page except /slow/ as 200 or a redirect, and never-linked URLs as 404", async () => {
    const paths = manifestPaths().filter((p) => !p.startsWith("/slow/"));
    const statuses: (readonly [string, number])[] = [];
    for (let i = 0; i < paths.length; i += 50) {
      statuses.push(...(await Promise.all(paths.slice(i, i + 50).map(async (p) => [p, (await get(p)).status] as const))));
    }
    const bad = statuses.filter(([, s]) => ![200, 301, 302, 307, 308].includes(s));
    expect(bad).toEqual([]);
    expect((await get("/links/missing-1")).status).toBe(404);
    expect((await get("/.env")).status).toBe(200);
  });

  it("chains /deep/ one level per page, and the products listing never runs out of new query URLs", async () => {
    for (let d = 1; d < DEEP_CHAIN_DEPTH; d++) expect(await (await get(deepChainPath(d))).text()).toContain(`href="${deepChainPath(d + 1)}"`);
    expect(await (await get("/products/?color=red&page=7")).text()).toContain('href="/products/?color=red&page=8"');
  });

  it("hides /js/ links from non-rendering crawlers and redirects /ssrf/ pages to the canary and private ranges", async () => {
    expect(await (await get("/js/")).text()).not.toMatch(/<a\s/);
    const r = await get("/ssrf/p-1");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect((await get("/ssrf/p-3")).headers.get("location")).toBe("http://169.254.169.254/latest/meta-data/");
  });
});

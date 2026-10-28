import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseHtml } from "../../audit/parse";
import { send, startLocalServer, type LocalServer } from "@/test/local-server";
import { discoverSitemaps, extractOutlinks, type SitemapDocRecord, type SitemapEvent } from "./discovery";

const XML = "application/xml";
const urlset = (urls: string[]) => `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${u}</loc></url>`).join("")}</urlset>`;
const index = (urls: string[]) => `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<sitemap><loc>${u}</loc></sitemap>`).join("")}</sitemapindex>`;

let srv: LocalServer;
beforeEach(async () => {
  srv = await startLocalServer();
});
afterEach(async () => {
  await srv.close();
});

async function collect(events: AsyncGenerator<SitemapEvent>) {
  const docs: SitemapDocRecord[] = [];
  const urls: string[] = [];
  const rejected: string[] = [];
  let batches = 0;
  for await (const e of events) {
    if (e.type === "doc") docs.push(e.doc);
    else {
      batches++;
      urls.push(...e.urls.map((u) => u.url));
      rejected.push(...e.rejected.map((r) => `${r.reason}:${r.original}`));
    }
  }
  return { docs, urls, rejected, batches };
}

const run = (robotsSitemaps: string[], extra: Partial<Parameters<typeof discoverSitemaps>[0]> = {}) =>
  collect(discoverSitemaps({ origin: srv.origin, robotsSitemaps, fetch: srv.fetch, ...extra }));

describe("discoverSitemaps", () => {
  it("reads robots.txt Sitemap lines first, then /sitemap.xml and /sitemap_index.xml", async () => {
    const o = srv.origin;
    srv.routes.set("/declared.xml", send(urlset([`${o}/a`]), XML));
    srv.routes.set("/sitemap.xml", send(urlset([`${o}/b`]), XML));
    const { docs, urls } = await run([`${o}/declared.xml`]);
    expect(docs.map((d) => [d.url.replace(o, ""), d.via, d.status])).toEqual([
      ["/declared.xml", "robots", 200],
      ["/sitemap.xml", "default", 200],
      ["/sitemap_index.xml", "default", 404],
    ]);
    expect(urls).toEqual([`${o}/a`, `${o}/b`]);
  });

  it("does not read a default location twice when robots.txt already declares it", async () => {
    srv.routes.set("/sitemap.xml", send(urlset([`${srv.origin}/a`]), XML));
    const { docs } = await run([`${srv.origin}/sitemap.xml`]);
    expect(docs.filter((d) => d.url.endsWith("/sitemap.xml"))).toHaveLength(1);
    expect(srv.hits.get("/sitemap.xml")).toBe(1);
  });

  it("decompresses gzipped child sitemaps served without Content-Encoding", async () => {
    const o = srv.origin;
    srv.routes.set("/sitemap_index.xml", send(index([`${o}/products.xml.gz`]), XML));
    srv.routes.set("/products.xml.gz", send(gzipSync(urlset([`${o}/p/1`, `${o}/p/2`])), "application/x-gzip"));
    const { docs, urls } = await run([]);
    const gz = docs.find((d) => d.url.endsWith(".gz"))!;
    expect(gz).toMatchObject({ via: "index", parent: `${o}/sitemap_index.xml`, depth: 1, kind: "urlset", urlCount: 2, errors: [] });
    expect(urls).toEqual([`${o}/p/1`, `${o}/p/2`]);
  });

  it("recurses indexes to depth 3 and reports a deeper sitemap as skipped", async () => {
    const o = srv.origin;
    srv.routes.set("/sitemap_index.xml", send(index([`${o}/i1.xml`]), XML));
    srv.routes.set("/i1.xml", send(index([`${o}/i2.xml`]), XML));
    srv.routes.set("/i2.xml", send(index([`${o}/at3.xml`, `${o}/i3.xml`]), XML));
    srv.routes.set("/at3.xml", send(urlset([`${o}/depth3-page`]), XML));
    srv.routes.set("/i3.xml", send(index([`${o}/at4.xml`]), XML));
    srv.routes.set("/at4.xml", send(urlset([`${o}/depth4-page`]), XML));
    const { docs, urls } = await run([]);
    expect(urls).toEqual([`${o}/depth3-page`]);
    expect(docs.find((d) => d.url.endsWith("/at4.xml"))).toMatchObject({ depth: 4, skipped: "max_index_depth", status: null });
    expect(srv.hits.get("/at4.xml")).toBeUndefined();
  });

  it("reads each document once when indexes reference each other", async () => {
    const o = srv.origin;
    srv.routes.set("/sitemap_index.xml", send(index([`${o}/loop.xml`, `${o}/sitemap_index.xml`]), XML));
    srv.routes.set("/loop.xml", send(index([`${o}/sitemap_index.xml`, `${o}/leaf.xml`]), XML));
    srv.routes.set("/leaf.xml", send(urlset([`${o}/x`]), XML));
    const { urls } = await run([]);
    expect(urls).toEqual([`${o}/x`]);
    expect(srv.hits.get("/sitemap_index.xml")).toBe(1);
    expect(srv.hits.get("/loop.xml")).toBe(1);
  });

  it("normalises sitemap URLs and reports unusable <loc> values with a reason", async () => {
    const o = srv.origin;
    srv.routes.set("/sitemap.xml", send(urlset([`${o}/a?utm_source=x&b=2&a=1`, "mailto:x@example.com", `${o.toUpperCase()}/A`]), XML));
    const { urls, rejected } = await run([]);
    expect(urls).toEqual([`${o}/a?a=1&b=2`, `${o}/A`]);
    expect(rejected).toEqual(["unsupported_scheme:mailto:x@example.com"]);
  });

  it("reads more than the legacy 5,000-URL cap from one sitemap, in batches", async () => {
    const o = srv.origin;
    const many = Array.from({ length: 6200 }, (_, i) => `${o}/p/${i}`);
    srv.routes.set("/sitemap.xml", send(urlset(many), XML));
    const { urls, batches, docs } = await run([], { batchSize: 1000 });
    expect(urls).toHaveLength(6200);
    expect(batches).toBe(7);
    expect(docs[0]).toMatchObject({ urlCount: 6200, truncated: false });
  });

  it("records failed sitemap fetches instead of dropping them", async () => {
    srv.routes.set("/sitemap.xml", send("oops", "text/plain", 500));
    const { docs } = await run([]);
    expect(docs[0]).toMatchObject({ status: 500, kind: null });
  });

  it("stops reading after maxDocs and reports the rest as skipped", async () => {
    const o = srv.origin;
    srv.routes.set("/sitemap_index.xml", send(index([1, 2, 3, 4].map((i) => `${o}/s${i}.xml`)), XML));
    for (const i of [1, 2, 3, 4]) srv.routes.set(`/s${i}.xml`, send(urlset([`${o}/u${i}`]), XML));
    // Reads /sitemap.xml (404), /sitemap_index.xml, s1 and s2: four documents.
    const { docs } = await run([], { maxDocs: 4 });
    expect(docs.filter((d) => d.skipped === "max_docs").map((d) => d.url.replace(o, ""))).toEqual(["/s3.xml", "/s4.xml"]);
  });
});

describe("extractOutlinks", () => {
  const page = "https://example.com/section/page";
  const html = `<!doctype html><html><head>
    <link rel="canonical" href="/section/page?utm_source=x">
    <link rel="next" href="/section/page?p=2">
    <link rel="prev" href="/section/page?p=0">
    <link rel="alternate" hreflang="fr" href="https://example.com/fr/page">
    <link rel="alternate" type="application/rss+xml" href="/feed.xml">
    <link rel="stylesheet" href="/style.css">
  </head><body>
    <header><nav><a href="/">Home</a><a href="/about">About</a></nav></header>
    <main>
      <a href="child">Child</a>
      <a href="child">Child</a>
      <a href="/private" rel="nofollow sponsored">Private</a>
      <a href="#top">Top</a>
      <a href="">Empty</a>
      <a href="mailto:hi@example.com">Mail</a>
      <a href="javascript:void(0)">JS</a>
      <a href="/img-link"><img src="x.png" alt="Pictured"></a>
      <map><area href="/area" alt="Area"></map>
      <iframe src="/embed"></iframe>
    </main>
    <footer><a href="/terms">Terms</a></footer>
  </body></html>`;
  const out = extractOutlinks(parseHtml(html), page);
  const by = (via: string) => out.links.filter((l) => l.via === via).map((l) => l.url);

  it("tags each reference with its discovery source", () => {
    expect(by("canonical")).toEqual(["https://example.com/section/page"]);
    expect(by("pagination")).toEqual(["https://example.com/section/page?p=2", "https://example.com/section/page?p=0"]);
    expect(by("hreflang")).toEqual(["https://example.com/fr/page"]);
    expect(by("alternate")).toEqual(["https://example.com/feed.xml"]);
    expect(by("iframe")).toEqual(["https://example.com/embed"]);
    expect(out.links.some((l) => l.url.endsWith("/style.css"))).toBe(false);
  });

  it("resolves relative links, de-duplicates identical links and skips self-references", () => {
    expect(by("link")).toEqual([
      "https://example.com/",
      "https://example.com/about",
      "https://example.com/section/child",
      "https://example.com/private",
      "https://example.com/img-link",
      "https://example.com/area",
      "https://example.com/terms",
    ]);
  });

  it("records anchor, rel, nofollow, location and the original value", () => {
    const priv = out.links.find((l) => l.url.endsWith("/private"))!;
    expect(priv).toMatchObject({ anchor: "Private", rel: "nofollow sponsored", nofollow: true, location: "main", original: "/private" });
    expect(out.links.find((l) => l.url.endsWith("/about"))!.location).toBe("nav");
    expect(out.links.find((l) => l.url.endsWith("/terms"))!.location).toBe("footer");
    expect(out.links.find((l) => l.url.endsWith("/img-link"))!.anchor).toBe("Pictured");
    expect(out.links.find((l) => l.via === "hreflang")!.hreflang).toBe("fr");
  });

  it("reports rejected references with their reason instead of dropping them silently", () => {
    expect(out.rejected.map((r) => `${r.via}:${r.reason}:${r.original}`)).toEqual([
      "link:unsupported_scheme:mailto:hi@example.com",
      "link:unsupported_scheme:javascript:void(0)",
    ]);
  });

  it("resolves against <base href>", () => {
    const o = extractOutlinks(parseHtml(`<head><base href="https://example.com/base/"></head><a href="rel">x</a>`), page);
    expect(o.links[0].url).toBe("https://example.com/base/rel");
  });
});

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { detectAll } from "tinyld";
import { ACRONYM_PROSE, MIXED_PROSE } from "../../../fixtures/site/defects";
import { parseHtml } from "../audit/parse";
import { extractOutlinks } from "../crawl/v2/discovery";
import { assertKey, getRawHtml, LocalBlobStore, putRawHtml, rawHtmlKey } from "./blob-store";
import { extractHtml, parseRobotsHeader } from "./extract";
import { pixelWidth, simhash, simhashSimilarity, textHash, words } from "./text";

const URL_ = "https://a.test/dir/page";
const extract = (html: string, headers: Record<string, string> = {}) => {
  const $ = parseHtml(html);
  return extractHtml({ $, html, pageUrl: URL_, headers, bytes: Buffer.byteLength(html), outlinks: extractOutlinks($, URL_).links });
};

describe("text measures", () => {
  it("counts words with a letter or digit", () => {
    expect(words("  one, two — 3 !! ")).toEqual(["one,", "two", "3"]);
  });

  it("hashes text only above the minimum word count", () => {
    expect(textHash("a b c")).toBeNull();
    expect(textHash("word ".repeat(50))).toMatch(/^[0-9a-f]{64}$/);
    expect(textHash("Word ".repeat(50))).toBe(textHash("word  ".repeat(50)));
  });

  it("SimHash: identical text is 100% similar, unrelated text is not near", () => {
    const a = "the river runs past the old mill where farmers bring grain every autumn morning before dawn";
    const b = "quantum processors schedule entangled registers while compilers lower circuits into native gate sets";
    expect(simhashSimilarity(simhash(a)!, simhash(a)!)).toBe(1);
    expect(simhashSimilarity(simhash(a)!, simhash(b)!)).toBeLessThan(0.9);
    expect(simhash("too short")).toBeNull();
  });

  it("estimates pixel width from Arial advance widths", () => {
    expect(pixelWidth("i", 20)).toBe(4);
    expect(pixelWidth("W", 20)).toBe(19);
    expect(pixelWidth("漢", 20)).toBe(20);
  });
});

describe("extractHtml", () => {
  const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>Hello world</title>
    <meta name="description" content="  A   page ">
    <meta name="viewport" content="width=device-width">
    <meta name="robots" content="noindex, follow">
    <meta property="og:title" content="OG"><meta property="og:image" content="/og.png"><meta name="twitter:card" content="summary">
    <link rel="canonical" href="https://a.test/dir/page"><link rel="icon" href="/favicon.ico"><link rel="stylesheet" href="/s.css">
    <script type="application/ld+json">{"@type":"Thing"}</script><script type="application/ld+json">{bad</script></head>
    <body><nav><a href="/x">Nav</a></nav><main><h1>Hello</h1><h3>Sub</h3><p>Main text here.</p><img src="a.png" alt="" width="10" loading="lazy"><img src="b.png"></main>
    <link rel="canonical" href="/other"><svg><title>icon</title></svg><script>location.replace("/next")</script></body></html>`;
  const x = extract(html, { "x-robots-tag": "googlebot: nofollow, noarchive", link: '<https://a.test/h>; rel="canonical"' });

  it("reads titles (not SVG titles), descriptions and outline", () => {
    expect(x.titles).toEqual(["Hello world"]);
    expect(x.descriptions).toEqual(["A page"]);
    expect(x.outline).toEqual([{ level: 1, text: "Hello" }, { level: 3, text: "Sub", adjacent: true }]);
  });

  it("records every canonical with where it was found and whether it is absolute", () => {
    expect(x.canonicals).toEqual([
      { href: "https://a.test/dir/page", resolved: "https://a.test/dir/page", location: "head", absolute: true },
      { href: "/other", resolved: "https://a.test/other", location: "body", absolute: false },
      { href: "https://a.test/h", resolved: "https://a.test/h", location: "header", absolute: true },
    ]);
  });

  it("separates meta and header robots directives; agent-prefixed header lines do not apply to everyone", () => {
    expect(x.robots.noindex).toEqual({ meta: true, header: false });
    expect(x.robots.nofollow).toEqual({ meta: false, header: false });
    expect(parseRobotsHeader("noindex, googlebot: nofollow, max-snippet: 20")).toEqual([
      { source: "header", agent: "*", directives: ["noindex"] },
      { source: "header", agent: "googlebot", directives: ["nofollow", "max-snippet: 20"] },
    ]);
  });

  it("main text excludes navigation; images keep missing vs empty alt", () => {
    expect(x.mainText).toBe("Hello Sub Main text here.");
    expect(x.wordCount).toBe(5);
    expect(x.images.map((i) => [i.resolved, i.alt, i.loading])).toEqual([["https://a.test/dir/a.png", "", "lazy"], ["https://a.test/dir/b.png", null, null]]);
  });

  it("parses JSON-LD and keeps the error for a broken block", () => {
    expect(x.jsonLd[0]).toMatchObject({ parsed: { "@type": "Thing" }, error: null });
    expect(x.jsonLd[1].parsed).toBeNull();
    expect(x.jsonLd[1].error).toBeTruthy();
  });

  it("collects head facts", () => {
    expect(x.facts.metaCharset).toEqual({ value: "utf-8", offset: html.indexOf("<meta charset") });
    expect(x.facts.viewport).toEqual(["width=device-width"]);
    expect(x.facts.og).toEqual({ title: "OG", image: "/og.png", url: null });
    expect(x.facts.twitterCard).toBe("summary");
    expect(x.facts.icons).toEqual(["https://a.test/favicon.ico"]);
    expect(x.facts.renderResources).toEqual(["https://a.test/s.css"]);
    expect(x.facts.jsRedirect).toBe("https://a.test/next");
    expect(x.language.declared).toBe("en-GB");
    expect(x.language.detected).toBeNull(); // too little text to judge
  });

  it("detects language on enough text, and fingerprints the template not the content", () => {
    const para = (t: string) => `<html><body><main><p>${t}</p></main></body></html>`;
    const en = extract(para("The farmers in the valley bring their grain to the old mill every autumn, and the miller keeps a careful record of each sack so that nobody is cheated when the flour comes back to the village in the spring."));
    expect(en.language.detected).toBe("en");
    expect(en.language.accuracy).toBeGreaterThan(0.9);
    expect(extract(para("one")).templateFingerprint).toBe(en.templateFingerprint);
    expect(extract("<html><body><div><p>one</p></div></body></html>").templateFingerprint).not.toBe(en.templateFingerprint);
  });

  it("reads <br> and block ends in headings as spaces", () => {
    const x = extract(`<html><body><h1>When Customers Ask AI<br class="x"/>Who to Choose</h1><h2><div>A</div>B</h2></body></html>`);
    expect(x.outline).toEqual([
      { level: 1, text: "When Customers Ask AI Who to Choose" },
      { level: 2, text: "A B", adjacent: true },
    ]);
  });

  it("detects English dense with an acronym the detector misreads (\"SEO\" as Irish), and stays unsure on mixed text", () => {
    const page = (t: string) => extract(`<html lang="en"><body><main><p>${t}</p></main></body></html>`).language;
    expect(detectAll(ACRONYM_PROSE)[0].lang).toBe("ga"); // the whole-text reading this replaces
    expect(page(ACRONYM_PROSE)).toMatchObject({ detected: "en", accuracy: 1 });
    const mixed = page(MIXED_PROSE);
    expect(mixed.detected).toBe("es");
    expect(mixed.accuracy).toBeGreaterThan(0.5);
    expect(mixed.accuracy).toBeLessThan(0.9);
  });

  it("keeps hreflang on alternate links, image placement and videos (Phase 2b)", () => {
    const y = extract(`<html><head><link rel="alternate" hreflang="de-DE" href="/de/"><link rel="alternate" href="/feed.xml"></head><body>
      <header><img src="/logo.png" alt="Logo"></header>
      <main><p>Text</p><a href="/big.jpg"><img src="/thumb.jpg" alt="t"></a><picture><source srcset="/p.webp"><img src="/p.jpg" alt="p"></picture>
      <video src="/v.mp4" poster="/v.jpg"></video><video><source src="/w.webm"></video></main></body></html>`);
    expect(y.links.filter((l) => l.hreflang)).toEqual([expect.objectContaining({ href: "https://a.test/de/", via: "hreflang", hreflang: "de-DE" })]);
    const img = (src: string) => y.images.find((i) => i.src === src);
    expect(img("/logo.png")).toMatchObject({ linked: false, inMain: false, inPicture: false });
    expect(img("/thumb.jpg")).toMatchObject({ linked: true, inMain: true, inPicture: false });
    expect(img("/p.jpg")).toMatchObject({ linked: false, inMain: true, inPicture: true, fillsParent: false });
    // Next.js <Image fill>: absolutely positioned over its parent.
    const z = extract(`<html><body><main><div style="position:relative;height:40px"><img src="/fill.png" alt="f" style="position:absolute;height:100%;width:100%;left:0;top:0;right:0;bottom:0;color:transparent"></div>
      <img src="/inset.png" alt="i" style="position: fixed; inset: 0"><img src="/half.png" alt="h" style="position:absolute;width:100%;height:50%"><img src="/static.png" alt="s" style="width:100%;height:100%"></main></body></html>`);
    expect(z.images.map((i) => [i.src, i.fillsParent])).toEqual([["/fill.png", true], ["/inset.png", true], ["/half.png", false], ["/static.png", false]]);
    expect(y.facts.videos).toEqual([
      { src: "https://a.test/v.mp4", poster: "https://a.test/v.jpg" },
      { src: "https://a.test/w.webm", poster: null },
    ]);
  });

  it("finds a meta refresh target", () => {
    expect(extract(`<html><head><meta http-equiv="Refresh" content="0; url=/to"></head></html>`).facts.metaRefresh).toEqual({ content: "0; url=/to", target: "https://a.test/to" });
  });
});

describe("LocalBlobStore", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it("round-trips gzipped HTML under an S3-style key and leaves no temp files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "blobs-"));
    dirs.push(dir);
    const store = new LocalBlobStore(dir);
    const key = await putRawHtml(store, "3F2A0000-0000-4000-8000-000000000001", 7, "<p>héllo</p>");
    expect(key).toBe(rawHtmlKey("3f2a0000-0000-4000-8000-000000000001", 7));
    expect(await getRawHtml(store, key)).toBe("<p>héllo</p>");
    expect(await store.headObject(key)).toMatchObject({ ContentType: "text/html; charset=utf-8", ContentEncoding: "gzip" });
    const files = await readdir(path.dirname(path.join(dir, ...key.split("/"))));
    expect(files.filter((f) => f.endsWith(".tmp") || f.endsWith(".meta"))).toEqual([]);
    await store.deleteObject(key);
    expect(await store.getObject(key)).toBeNull();
  });

  it("refuses keys that could escape the root", () => {
    for (const k of ["../x", "a/../b", "/abs", "a//b", "A/b", "a\\b", ""]) expect(() => assertKey(k), k).toThrow("Invalid blob key");
    expect(() => assertKey("crawls/x/html/1.html.gz")).not.toThrow();
  });
});

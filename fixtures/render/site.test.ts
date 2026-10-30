import { request } from "node:http";
import { inflateSync, crc32 } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RULES } from "@/lib/rules/registry";
import { JS_PAGES, PAGES, SCRIPT_ONLY_TARGETS, expectedFindings, noisePng, startRenderFixture, type RenderFixture } from "./site";

let fx: RenderFixture;
beforeAll(async () => {
  fx = await startRenderFixture();
});
afterAll(() => fx.close());

/** GET with the Host header set (fetch does not send a custom one). */
const get = (host: string, path: string) =>
  new Promise<{ status: number; headers: { get(k: string): string | null }; text(): Promise<string> }>((resolve, reject) => {
    request({ host: "127.0.0.1", port: fx.port, path, headers: { host: `${host}:${fx.port}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const h = res.headers;
        resolve({ status: res.statusCode ?? 0, headers: { get: (k) => (h[k] === undefined ? null : String(h[k])) }, text: async () => Buffer.concat(chunks).toString("utf8") });
      });
    })
      .on("error", reject)
      .end();
  });

describe("render fixture", () => {
  it("names a fixture page for every rendered rule", () => {
    const rendered = RULES.filter((r) => r.needs.includes("rendered")).map((r) => r.id).sort();
    expect([...new Set([...expectedFindings().values()].flat())].sort()).toEqual(rendered);
    for (const p of expectedFindings().keys()) expect(PAGES).toContain(p);
    expect(PAGES.filter((p) => p.startsWith("/js/p-"))).toHaveLength(JS_PAGES);
  });

  it("writes valid PNGs of incompressible noise", () => {
    const png = noisePng(20, 10, 3);
    let at = 8;
    const types: string[] = [];
    while (at < png.length) {
      const len = png.readUInt32BE(at);
      const td = png.subarray(at + 4, at + 8 + len);
      expect(png.readUInt32BE(at + 8 + len)).toBe(crc32(td) >>> 0);
      types.push(td.subarray(0, 4).toString("latin1"));
      at += 12 + len;
    }
    expect(types).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)))).toHaveLength(10 * (20 * 3 + 1));
    expect(noisePng(640, 640, 101).length).toBeGreaterThan(640 * 640 * 3);
  });

  it("serves JavaScript-only shells, caches static files except one stylesheet, and lists no script-only target", async () => {
    const shell = await (await get("render.test", "/js/p-7")).text();
    expect(shell).toContain('<div id="root"></div>');
    expect(shell).not.toMatch(/<title>|rel="canonical"|<h1>/);
    expect((await get("render.test", "/js/p-41")).status).toBe(404);
    expect((await get("render.test", "/static/js-page.js")).headers.get("cache-control")).toMatch(/max-age/);
    expect((await get("render.test", "/img/clean.png")).headers.get("cache-control")).toMatch(/max-age/);
    expect((await get("render.test", "/static/uncached.css")).headers.get("cache-control")).toBeNull();
    expect((await get("widgets.test", "/widget.js")).status).toBe(200);
    expect((await get("widgets.test", "/")).status).toBe(404);
    const sitemap = await (await get("render.test", "/sitemap.xml")).text();
    expect(sitemap.match(/<loc>/g)).toHaveLength(PAGES.length);
    for (const t of SCRIPT_ONLY_TARGETS) expect(sitemap).not.toContain(t);
    const home = await (await get("render.test", "/")).text();
    for (const t of SCRIPT_ONLY_TARGETS) expect(home).not.toContain(t);
  });
});

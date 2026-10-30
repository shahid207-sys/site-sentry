// The render pool against a real headless Chromium and a local site. The page tries every way out of the sandbox we
// know of: the cloud metadata address, private and loopback addresses, a WebSocket, a prefetch, a preconnect, a form
// POST and an analytics tag. A canary socket that the fetch policy does not allow counts every connection that
// reaches it: there must be none.
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:net";
import { crc32, deflateSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { send, startLocalServer, type LocalServer } from "@/test/local-server";
import { RenderPool, renderBrowsers, type RenderResult } from "./pool";

let srv: LocalServer;
let canary: Server;
let canaryOrigin: string;
let canaryHits = 0;
let pool: RenderPool;

beforeAll(async () => {
  srv = await startLocalServer();
  canary = createServer((sock) => {
    canaryHits++;
    sock.destroy();
  });
  await new Promise<void>((r) => canary.listen(0, "127.0.0.1", r));
  canaryOrigin = `http://127.0.0.1:${(canary.address() as AddressInfo).port}`;
  pool = new RenderPool({ fetch: srv.fetch, budgetMs: 10_000 });
});
afterAll(async () => {
  await pool?.close();
  await srv?.close();
  await new Promise((r) => canary?.close(r));
});

/** A PNG of random pixels (incompressible, so high entropy). */
function noisePng(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(t));
    return Buffer.concat([len, t, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const rows = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), randomBytes(w * 3)])));
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

const doc = (body: string, head = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Raw title</title>${head}</head><body>${body}</body></html>`;
const reqs = (r: RenderResult, pred: (x: RenderResult["requests"][number]) => boolean) => r.requests.filter(pred);

describe("render pool", () => {
  it("RENDER_BROWSERS defaults to 1 and is capped at 4", () => {
    expect(renderBrowsers({})).toBe(1);
    expect(renderBrowsers({ RENDER_BROWSERS: "3" })).toBe(3);
    expect(renderBrowsers({ RENDER_BROWSERS: "12" })).toBe(4);
    expect(renderBrowsers({ RENDER_BROWSERS: "0" })).toBe(1);
    expect(renderBrowsers({ RENDER_BROWSERS: "x" })).toBe(1);
  });

  it("renders JavaScript content, and nothing leaves through any channel but the guarded fetcher", { timeout: 60_000 }, async () => {
    srv.routes.set(
      "/app.js",
      send(
        `document.querySelector("main").insertAdjacentHTML("beforeend", "<h1>Injected heading</h1><p>Only JavaScript writes this.</p>");
         fetch("http://169.254.169.254/latest/meta-data/").catch(() => {});
         fetch("${canaryOrigin}/xhr").catch(() => {});
         fetch("/api/data", { method: "POST", body: "x" }).catch(() => {});
         try { new WebSocket("ws://127.0.0.1:${canaryOrigin.split(":")[2]}/ws"); } catch {}
         try { new WebSocket("wss://example.com/ws"); } catch {}`,
        "application/javascript",
      ),
    );
    srv.routes.set("/style.css", send("main{display:block}", "text/css", 200, { "cache-control": "max-age=60" }));
    const html = doc(
      `<main><p>Raw paragraph.</p></main>
       <img src="http://10.0.0.1/private.png" alt="">
       <img src="${canaryOrigin}/loopback.png" alt="">
       <img src="http://169.254.169.254/latest/meta-data/iam.png" alt="">
       <iframe src="${canaryOrigin}/frame"></iframe>
       <script src="/app.js"></script>
       <script async src="https://www.googletagmanager.com/gtag/js?id=G-TEST"></script>`,
      `<link rel="stylesheet" href="/style.css"><link rel="prefetch" href="${canaryOrigin}/prefetch"><link rel="preconnect" href="${canaryOrigin}"><link rel="dns-prefetch" href="//evil.example">`,
    );
    const r = await pool.render({ url: `${srv.origin}/page`, html });

    expect(r.status).toBe("rendered");
    expect(r.html).toContain("Injected heading");
    expect(r.html).not.toContain("Injected heading".repeat(2));
    // The document came from the stored HTML: the server was never asked for /page.
    expect(srv.hits.get("/page")).toBeUndefined();
    expect(srv.hits.get("/app.js")).toBe(1);
    expect(reqs(r, (x) => x.url.endsWith("/style.css"))[0]).toMatchObject({ outcome: "fulfilled", status: 200, cacheControl: "max-age=60", thirdParty: false });

    // Refused by the SSRF guard: metadata, private and disallowed loopback addresses.
    const ssrf = reqs(r, (x) => x.reason === "ssrf").map((x) => x.url);
    expect(ssrf).toEqual(expect.arrayContaining(["http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/private.png", `${canaryOrigin}/loopback.png`, `${canaryOrigin}/xhr`]));
    expect(reqs(r, (x) => x.url.includes("googletagmanager"))[0]).toMatchObject({ outcome: "blocked", reason: "ads_analytics", thirdParty: true });
    expect(reqs(r, (x) => x.url.endsWith("/api/data"))[0]).toMatchObject({ outcome: "blocked", reason: "method" });
    expect(reqs(r, (x) => x.type === "websocket").map((x) => x.reason)).toEqual(["websocket", "websocket"]);
    expect(srv.hits.get("/api/data")).toBeUndefined();

    // Give any stray connection time to arrive, then check the canary saw none (img, iframe, XHR, prefetch,
    // preconnect, WebSocket).
    await new Promise((res) => setTimeout(res, 500));
    expect(canaryHits).toBe(0);
    expect(r.requestTotals.count).toBe(r.requests.length);
  });

  it("measures LCP and CLS as lab data, finds a lazy-loaded LCP image, script-only links and axe violations", { timeout: 60_000 }, async () => {
    // A noisy 300x200 PNG: the largest element, and not a low-entropy image (Chrome ignores those for LCP).
    srv.routes.set("/hero.png", send(noisePng(300, 200), "image/png"));
    const html = doc(
      `<main>
         <img src="/hero.png" loading="lazy" width="400" height="267" alt="Hero">
         <div id="shift"></div>
         <span onclick="location.href='/next-page'">Next</span>
         <div role="button" onclick="window.open('https://example.com/other')">Other</div>
         <a onclick="doSomething()">Inert</a>
         <a>Bare anchor</a>
         <a name="top"></a>
         <button></button>
         <input type="text" id="q">
         <p style="color:#777;background:#888">Low contrast text</p>
       </main>
       <script>addEventListener("load", () => setTimeout(() => { document.getElementById("shift").style.height = "300px"; }, 100));</script>`,
    );
    const r = await pool.render({ url: `${srv.origin}/metrics`, html });
    expect(r.status).toBe("rendered");
    expect(r.metrics).toMatchObject({ source: "lab", viewport: { width: 412, height: 915 } });
    expect(r.metrics!.lcpMs).toBeGreaterThan(0);
    expect(r.metrics!.lcpElement).toMatchObject({ tag: "img", loading: "lazy" });
    expect(r.metrics!.lcpElement!.url).toBe(`${srv.origin}/hero.png`);
    expect(r.metrics!.cls).toBeGreaterThan(0);
    expect(r.metrics!.domNodes).toBeGreaterThan(10);

    expect(r.scriptLinks!.counts).toEqual({ onclick: 2, noHref: 1 });
    expect(r.scriptLinks!.onclick.map((l) => l.target)).toEqual(["/next-page", "https://example.com/other"]);
    expect(r.scriptLinks!.noHref[0]).toMatchObject({ tag: "a", text: "Bare anchor" });

    expect(r.a11y?.version).toMatch(/^4\./);
    expect(Object.keys(r.a11y!.rules).sort()).toEqual(expect.arrayContaining(["button-name", "color-contrast", "label"]));
    expect(r.a11y!.rules["button-name"]!.count).toBe(1);
  });

  it("aborts script navigations away from the page and keeps the render", { timeout: 60_000 }, async () => {
    const r = await pool.render({ url: `${srv.origin}/redirector`, html: doc(`<main><p>Stay</p></main><script>location.href = "/elsewhere";</script>`) });
    expect(r.status).toBe("rendered");
    expect(r.scriptNavigations).toEqual([`${srv.origin}/elsewhere`]);
    expect(srv.hits.get("/elsewhere")).toBeUndefined();
    expect(r.html).toContain("Stay");
  });

  it("a page that never finishes loading is a timeout, and the gate decides same-host requests", { timeout: 60_000 }, async () => {
    srv.routes.set("/hang.png", () => {}); // never answers
    const gated: string[] = [];
    const small = new RenderPool({
      fetch: srv.fetch,
      budgetMs: 3_000,
      gate: async (u) => {
        gated.push(u.pathname);
        return u.pathname === "/private.js" ? { ok: false, reason: "robots" } : { ok: true, done: async () => {} };
      },
    });
    try {
      // A browser's first page is slow to start; warm it so the budget below measures the page.
      await small.render({ url: `${srv.origin}/warm`, html: doc("<p>warm</p>") });
      gated.length = 0;
      const r = await small.render({ url: `${srv.origin}/slow`, html: doc(`<script src="/private.js"></script><img src="/hang.png" alt="">`) });
      expect(r.status).toBe("timeout");
      expect(r.error).toMatch(/3 s/);
      expect(reqs(r, (x) => x.url.endsWith("/private.js"))[0]).toMatchObject({ outcome: "blocked", reason: "robots" });
      expect(srv.hits.get("/private.js")).toBeUndefined();
      expect(gated).toEqual(expect.arrayContaining(["/private.js", "/hang.png"]));
    } finally {
      await small.close();
    }
  });

  it("recycles a browser after its page quota", { timeout: 60_000 }, async () => {
    const recycling = new RenderPool({ fetch: srv.fetch, pagesPerBrowser: 2 });
    try {
      for (let i = 0; i < 3; i++) expect((await recycling.render({ url: `${srv.origin}/r${i}`, html: doc(`<p>${i}</p>`) })).status).toBe("rendered");
      expect(recycling.launched).toBe(2);
    } finally {
      await recycling.close();
    }
  });
});

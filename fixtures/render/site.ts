// The Phase 5 fixture (gate:p5): a small plain-HTTP site on render.test whose pages differ only once JavaScript runs
// in a browser, plus widgets.test, a third-party script host. One page per rendered rule defect, a /js/ section of 40
// pages whose title, content, links and canonical are written only by JavaScript (docs/SPEC.md fixture table), and
// clean pages that must stay silent. EXPECTED lists every finding of the rendered rules (IDX-018, AIS-004, LNK-009,
// IMG-009, PERF-001/003/007/009/011, A11Y-001..004) by path.
//
// It is separate from fixtures/site: that site's /js/ pages are server-rendered with JavaScript-only index links, and
// the Phase 1–4 and 6 gate manifests depend on that HTML; making them JavaScript-only would rewrite those manifests.
//
// Every first-party static file is served with Cache-Control, except the one stylesheet PERF-009 is about.
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { deflateSync, crc32 } from "node:zlib";

export const SITE_HOST = "render.test";
export const THIRD_PARTY_HOST = "widgets.test";
/** CRAWLER_LOCAL_HOSTS value mapping both hosts to loopback. */
export const RENDER_LOCAL_HOSTS_ENV = `${SITE_HOST}=127.0.0.1,${THIRD_PARTY_HOST}=127.0.0.1`;
export const JS_PAGES = 40;
/** The hero image's response delay: the lab LCP lands past PERF-001's 2,500 ms. */
export const HERO_DELAY_MS = 4_000;
/** Linked only by JavaScript (the /js/ index) or an onclick handler, and in no sitemap: must never be crawled. */
export const SCRIPT_ONLY_TARGETS = ["/js/hidden", "/links/onclick-target"];

const CACHED = { "cache-control": "public, max-age=31536000, immutable" };

/** Deterministic noise (xorshift32), so image bytes do not compress and Chromium does not treat them as low-entropy. */
function noise(n: number, seed: number): Buffer {
  const b = Buffer.alloc(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    b[i] = x & 0xff;
  }
  return b;
}

/** A valid RGB PNG of noise (checksums included: Chromium decodes and paints it). */
export function noisePng(w: number, h: number, seed: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const px = noise(h * (w * 3 + 1), seed);
  for (let y = 0; y < h; y++) px[y * (w * 3 + 1)] = 0; // filter type "none" on every row
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(px, { level: 1 })), chunk("IEND", Buffer.alloc(0))]);
}

const WORDS = "render fixture page explains how scripts build this document after it loads in a browser while the server sends only an empty shell".split(" ");
const prose = (n: number, seed: number) => Array.from({ length: n }, (_, i) => WORDS[(i * 7 + seed) % WORDS.length]).join(" ");

const STYLE = "<style>body{font:16px/1.6 system-ui,sans-serif;margin:0 16px;color:#111;background:#fff}nav a{display:block;padding:12px 0}img{max-width:100%;height:auto}</style>";
const page = (o: { title: string; description?: string; canonical?: string; head?: string; nav?: string; main: string }) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${o.title}</title>` +
  `<meta name="description" content="${o.description ?? `${o.title}: a page of the SiteSentry Phase 5 render fixture.`}">` +
  `${o.canonical ? `<link rel="canonical" href="${o.canonical}">` : ""}${STYLE}${o.head ?? ""}</head>` +
  `<body><header><p>Render fixture</p></header>${o.nav ?? ""}<main>${o.main}</main><footer><p>SiteSentry render fixture.</p></footer></body></html>`;
const navOf = (links: [string, string][]) => `<nav aria-label="Sections"><ul>${links.map(([h, t]) => `<li><a href="${h}">${t}</a></li>`).join("")}</ul></nav>`;

export const SECTIONS: [string, string][] = [
  ["/js/", "JavaScript-only pages"],
  ["/images/lazy-lcp", "Lazy hero image"],
  ["/links/onclick", "Links made by script"],
  ["/perf/shift", "Layout shift"],
  ["/perf/heavy", "Heavy page"],
  ["/perf/uncached", "Uncached stylesheet"],
  ["/perf/third-party", "Third-party script"],
  ["/a11y/defects", "Accessibility defects"],
  ["/clean/", "Clean page"],
];
export const jsPaths = () => Array.from({ length: JS_PAGES }, (_, i) => `/js/p-${i + 1}`);
/** Every page the site serves with HTML 200 (also the sitemap). */
export const PAGES = ["/", ...SECTIONS.map(([p]) => p), ...jsPaths()];

/**
 * The rendered rules' findings, by path: "RULE" for an issue (rendered full mode). Every other page has none of them.
 * /js/p-N: content and canonical exist only after JavaScript (AIS-004, IDX-018 "adds a canonical").
 */
export function expectedFindings(): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const p of jsPaths()) m.set(p, ["AIS-004", "IDX-018"]);
  m.set("/images/lazy-lcp", ["IMG-009", "PERF-001"]);
  m.set("/links/onclick", ["LNK-009"]);
  m.set("/perf/shift", ["PERF-003"]);
  m.set("/perf/heavy", ["PERF-007"]);
  m.set("/perf/uncached", ["PERF-009"]);
  m.set("/perf/third-party", ["PERF-011"]);
  m.set("/a11y/defects", ["A11Y-001", "A11Y-002", "A11Y-003", "A11Y-004"]);
  return m;
}

/** /js/p-N as served: an empty shell. The script writes the title, description, canonical, content and a link. */
const JS_PAGE_SCRIPT = `document.addEventListener("DOMContentLoaded", function () {
  var n = Number(location.pathname.split("-").pop());
  var words = "render fixture page explains how scripts build this document after it loads in a browser while the server sends only an empty shell".split(" ");
  var text = []; for (var i = 0; i < 160; i++) text.push(words[(i * 7 + n) % words.length]);
  document.title = "JavaScript page " + n;
  var c = document.createElement("link"); c.rel = "canonical"; c.href = "/js/p-" + n; document.head.appendChild(c);
  var d = document.createElement("meta"); d.name = "description"; d.content = "JavaScript page " + n + " of the render fixture."; document.head.appendChild(d);
  document.getElementById("root").innerHTML = "<main><h1>JavaScript page " + n + "</h1><p>" + text.join(" ") + "</p><p>Back to the <a href=\\"/js/\\">JavaScript section</a>.</p></main>";
});`;

/** The /js/ index writes its links: every /js/p-N (also in the sitemap) and /js/hidden (nowhere else). */
const JS_INDEX_SCRIPT = `document.addEventListener("DOMContentLoaded", function () {
  var ul = document.getElementById("pages");
  for (var i = 1; i <= ${JS_PAGES}; i++) { var li = document.createElement("li"); li.innerHTML = "<a href=\\"/js/p-" + i + "\\">Page " + i + "</a>"; ul.appendChild(li); }
  var h = document.createElement("li"); h.innerHTML = "<a href=\\"/js/hidden\\">A page only this script links to</a>"; ul.appendChild(h);
});`;

/** A few hundred KB of third-party JavaScript (a comment pads it; it does nothing). */
const WIDGET_JS = `/* ${prose(30_000, 3)} */\nwindow.widget = { ready: true };\n`;
const SITE_JS = `document.documentElement.dataset.site = "1";\n`;

interface Out {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
  delayMs?: number;
}
const html = (body: string): Out => ({ status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body });
const asset = (type: string, body: string | Buffer, headers: Record<string, string> = CACHED): Out => ({ status: 200, headers: { "content-type": type, ...headers }, body });

export interface RenderFixture {
  port: number;
  origin: string;
  thirdPartyOrigin: string;
  /** Requests per host + path, from any client (crawler, renderer). */
  hits: Map<string, number>;
  close(): Promise<void>;
}

export async function startRenderFixture(opts: { port?: number } = {}): Promise<RenderFixture> {
  const hits = new Map<string, number>();
  const images = { hero: noisePng(400, 500, 7), clean: noisePng(200, 150, 11), heavy: [1, 2, 3].map((s) => noisePng(640, 640, 100 + s)) };
  let origin = "";
  let thirdPartyOrigin = "";

  const route = (host: string, path: string): Out | null => {
    if (host === THIRD_PARTY_HOST) {
      if (path === "/widget.js") return asset("application/javascript", WIDGET_JS);
      if (path === "/robots.txt") return asset("text/plain", "User-agent: *\nAllow: /\n");
      return null;
    }
    if (host !== SITE_HOST) return null;
    if (path === "/robots.txt") return asset("text/plain", `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`, {});
    if (path === "/sitemap.xml")
      return asset("application/xml", `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${PAGES.map((p) => `<url><loc>${origin}${p}</loc></url>`).join("")}</urlset>`, {});
    if (path === "/static/js-page.js") return asset("application/javascript", JS_PAGE_SCRIPT);
    if (path === "/static/js-index.js") return asset("application/javascript", JS_INDEX_SCRIPT);
    if (path === "/static/site.js") return asset("application/javascript", SITE_JS);
    if (path === "/static/uncached.css") return asset("text/css", "main{border-top:4px solid #036}", {});
    if (path === "/img/hero.png") return { ...asset("image/png", images.hero), delayMs: HERO_DELAY_MS };
    if (path === "/img/clean.png") return asset("image/png", images.clean);
    const heavy = /^\/img\/heavy-([123])\.png$/.exec(path);
    if (heavy) return asset("image/png", images.heavy[Number(heavy[1]) - 1]);
    if (path === "/favicon.ico") return { status: 404, headers: {}, body: "" };

    if (path === "/") return html(page({ title: "Render fixture home", canonical: "/", nav: navOf(SECTIONS), main: `<h1>Render fixture</h1><p>${prose(80, 1)}</p>` }));
    if (path === "/clean/")
      return html(page({ title: "Clean page", canonical: "/clean/", nav: navOf([["/", "Home"]]), main: `<h1>Clean page</h1><p>${prose(120, 2)}</p><img src="/img/clean.png" width="200" height="150" alt="Noise sample">` }));
    if (path === "/js/")
      return html(
        page({
          title: "JavaScript-only pages",
          canonical: "/js/",
          head: `<script src="/static/js-index.js"></script>`,
          main: `<h1>JavaScript-only pages</h1><p>${prose(120, 4)}</p><nav aria-label="JavaScript pages"><ul id="pages"></ul></nav>`,
        }),
      );
    if (/^\/js\/p-(\d+)$/.test(path) && Number(path.slice(6)) >= 1 && Number(path.slice(6)) <= JS_PAGES)
      return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${STYLE}<script src="/static/js-page.js"></script></head><body><div id="root"></div></body></html>`);
    if (path === "/images/lazy-lcp")
      return html(page({ title: "Lazy hero image", canonical: "/images/lazy-lcp", main: `<h1>Lazy hero</h1><img src="/img/hero.png" loading="lazy" width="400" height="500" alt="Hero noise"><p>${prose(40, 5)}</p>` }));
    if (path === "/links/onclick")
      return html(
        page({
          title: "Links made by script",
          canonical: "/links/onclick",
          main:
            `<h1>Links made by script</h1><p>${prose(60, 6)}</p>` +
            `<p>Read the <span class="go" onclick="location.href='/links/onclick-target'">next part</span> of the story.</p>` +
            `<p>There is also <a class="nohref">an anchor with no destination</a> here.</p>`,
        }),
      );
    if (path === "/perf/shift")
      return html(
        page({
          title: "Layout shift",
          canonical: "/perf/shift",
          main:
            `<div id="slot"></div><h1>Layout shift</h1><p>${prose(140, 7)}</p>` +
            `<script>setTimeout(function () { var b = document.createElement("div"); b.style.height = "450px"; b.style.background = "#eef"; document.getElementById("slot").appendChild(b); }, 300);</script>`,
        }),
      );
    if (path === "/perf/heavy")
      return html(
        page({
          title: "Heavy page",
          canonical: "/perf/heavy",
          main: `<h1>Heavy page</h1><p>${prose(60, 8)}</p>${[1, 2, 3].map((i) => `<img src="/img/heavy-${i}.png" width="640" height="640" alt="Heavy noise ${i}">`).join("")}`,
        }),
      );
    if (path === "/perf/uncached")
      return html(page({ title: "Uncached stylesheet", canonical: "/perf/uncached", head: `<link rel="stylesheet" href="/static/uncached.css">`, main: `<h1>Uncached stylesheet</h1><p>${prose(80, 9)}</p>` }));
    if (path === "/perf/third-party")
      return html(
        page({
          title: "Third-party script",
          canonical: "/perf/third-party",
          head: `<script src="/static/site.js" defer></script><script src="${thirdPartyOrigin}/widget.js" defer></script>`,
          main: `<h1>Third-party script</h1><p>${prose(80, 10)}</p>`,
        }),
      );
    if (path === "/a11y/defects")
      return html(
        page({
          title: "Accessibility defects",
          canonical: "/a11y/defects",
          main:
            `<h1>Accessibility defects</h1><p>${prose(40, 11)}</p>` +
            `<p style="color:#c4c4c4">This sentence is pale grey on white.</p>` +
            `<form action="/" style="margin:32px 0"><input type="text" name="q" style="height:44px;width:200px"></form>` +
            `<p style="margin:32px 0"><button type="button" style="width:44px;height:44px"><svg width="16" height="16" aria-hidden="true"><rect width="16" height="16"></rect></svg></button></p>` +
            `<div style="margin:32px 0"><a href="/" aria-label="Home" style="display:inline-block;width:10px;height:10px;background:#036"></a><a href="/clean/" aria-label="Clean page" style="display:inline-block;width:10px;height:10px;background:#036"></a></div>`,
        }),
      );
    return null;
  };

  const send = (res: ServerResponse, o: Out) => void res.writeHead(o.status, { "content-length": String(Buffer.byteLength(o.body)), ...o.headers }).end(o.body);
  const server = createServer((req, res) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    const path = (req.url ?? "/").split("?")[0];
    const key = `${host}${path}`;
    hits.set(key, (hits.get(key) ?? 0) + 1);
    const o = route(host, path) ?? { status: 404, headers: { "content-type": "text/html; charset=utf-8" }, body: "<!doctype html><title>Not found</title><h1>Not found</h1>" };
    if (o.delayMs) setTimeout(() => send(res, o), o.delayMs);
    else send(res, o);
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  origin = `http://${SITE_HOST}:${port}`;
  thirdPartyOrigin = `http://${THIRD_PARTY_HOST}:${port}`;
  return {
    port,
    origin,
    thirdPartyOrigin,
    hits,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

// Serves the fixture site defined in definition.ts (Phase 1 behaviour) with the Phase 2a defects of defects.ts.
// Used by the gates (scripts/gate-p1.ts, scripts/gate-p2a.ts) and their tests. Every request is logged with a
// timestamp, so a gate can prove which URLs were fetched, how often and when.
//
// The responses come from `createRouter`, a pure function of host, path and query, so the fast fixture test
// (site-rules.test.ts) renders exactly what the server sends. Only /slow/ timing and throttling live in the server.
//
// Hosts (all on one port, chosen by the Host header; the crawler maps each name to loopback):
//   fixture.test      the site itself
//   www.fixture.test  301 to fixture.test (IDX-021 negative)
//   alt.test          robots.txt answers 503 (IDX-025)
//   alt2.test         robots.txt without a Sitemap line, no sitemap, no favicon, no llms.txt; www.alt2.test serves 200 too
//   alt3.test         a 50,001-URL sitemap (IDX-030) and an llms.txt served as HTML (AIS-003)
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import {
  DEEP_CHAIN_DEPTH,
  deepChainPath,
  manifestPaths,
  noindexPaths,
  REDIRECTS,
  ROBOTS_BLOCKED_PREFIX,
  SECTIONS,
  sectionPaths,
  SLOW,
  SSRF_TARGETS,
} from "./definition";
import { applyDefect, INDEX_EXTRAS, noindexKind } from "./defects";
import { cleanParts, FAVICON, links, png, renderParts, SITE_NAME, type Parts } from "./pages";

export interface Hit {
  t: number;
  path: string;
  status: number;
  host?: string;
}

export interface FixtureSite {
  /** e.g. http://fixture.test:51234 (the host must be mapped to 127.0.0.1 by the crawler's fetch policy). */
  origin: string;
  port: number;
  /** Origin of each alternate host, same port. */
  origins: Record<HostKey, string>;
  /** Responses, logged when sent. */
  hits: Hit[];
  /** Requests, logged on arrival (status 0): a request cut off by a killed client is still counted. */
  requests: Hit[];
  /** Requests that reached the 127.0.0.1 canary the /ssrf/ pages redirect to. Must stay empty. */
  canaryHits: Hit[];
  close(): Promise<void>;
}

export const HOSTS = {
  main: "fixture.test",
  www: "www.fixture.test",
  alt: "alt.test",
  alt2: "alt2.test",
  www2: "www.alt2.test",
  alt3: "alt3.test",
} as const;
export type HostKey = keyof typeof HOSTS;

/** CRAWLER_LOCAL_HOSTS value mapping every fixture host to loopback. */
export const LOCAL_HOSTS_ENV = Object.values(HOSTS)
  .map((h) => `${h}=127.0.0.1`)
  .join(",");

/** URLs in the alt3.test sitemap: one past the protocol limit. */
export const ALT3_SITEMAP_URLS = 50_001;
/** Sitemap lastmods: the /index/ sitemap uses one date for every URL, the noindex one a date in the future. */
export const LASTMOD = { identical: "2026-03-01", future: "2099-01-01" } as const;
export const LLMS_TXT = `# ${SITE_NAME}\n\n> A test site for SiteSentry, with one section per defect family.\n\n- [Clean pages](/clean/): pages with no defects\n`;

export interface Response {
  status: number;
  type: string;
  headers: Record<string, string>;
  body: string | Buffer;
}

/**
 * /slow/ and /ssrf/ come first in the home page's links and the sitemap index, so a budgeted breadth-first crawl
 * (which claims in discovery order within a depth) reaches them: the gate then exercises the 4 s TTFB, 429/503
 * handling and SSRF redirects instead of leaving them as budget_exhausted.
 */
const FIRST = ["/slow/", "/ssrf/"];

/** Products: every listing page links to the next page and to colour facets, so query variants never run out. */
const FACETS = ["red", "blue", "green"];
function productListing(search: URLSearchParams): string {
  const n = Number(search.get("page") ?? 1);
  const next = new URLSearchParams(search);
  next.set("page", String(n + 1));
  const facets = FACETS.map((c) => {
    const q = new URLSearchParams(search);
    q.set("color", c);
    return `/products/?${q}`;
  });
  return links([`/products/?${next}`, ...facets]);
}

const errorPage = (status: number, title: string, headers: Record<string, string> = {}): Response => ({
  status,
  type: "text/html; charset=utf-8",
  headers,
  body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1></body></html>`,
});
const notFound = () => errorPage(404, "Not found");
const html = (p: Parts, status = 200): Response => ({ status, type: p.type, headers: p.headers, body: renderParts(p) });
const text = (body: string, type = "text/plain; charset=utf-8", status = 200): Response => ({ status, type, headers: {}, body });
const redirectTo = (status: number, location: string): Response => ({ status, type: "text/html", headers: { location }, body: "" });

interface Sitemap {
  path: string;
  paths: string[];
  lastmod?: (path: string, i: number) => string;
}
const urlset = (origin: string, s: Sitemap) =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${s.paths
    .map((p, i) => `<url><loc>${origin}${p}</loc>${s.lastmod ? `<lastmod>${s.lastmod(p, i)}</lastmod>` : ""}</url>`)
    .join("")}</urlset>`;

/** Distinct past dates, one per URL. */
const distinctPast = (_: string, i: number) => new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);

/** The fixture site's child sitemaps, in the order the sitemap index lists them. */
export function fixtureSitemaps(): Sitemap[] {
  const noindex = new Set(noindexPaths());
  const out: Sitemap[] = [];
  for (const s of [...SECTIONS].sort((a, b) => Number(FIRST.includes(b.path)) - Number(FIRST.includes(a.path)))) {
    const paths = sectionPaths(s).filter((p) => !noindex.has(p));
    if (s.path === "/clean/") paths.unshift("/");
    const lastmod = s.path === "/clean/" ? distinctPast : s.path === "/index/" ? () => LASTMOD.identical : undefined;
    out.push({ path: `/sitemaps/${s.path.slice(1, -1)}.xml.gz`, paths, lastmod });
  }
  out.push({ path: "/sitemaps/index-noindex.xml.gz", paths: noindexPaths(), lastmod: () => LASTMOD.future });
  return out;
}

export interface Router {
  (host: string, pathAndQuery: string): Response;
  origins: Record<HostKey, string>;
}

/** Every response of the fixture site, by Host header and request target. Deterministic; caches sitemap bodies. */
export function createRouter(port: number, canaryPort: number): Router {
  const origins = Object.fromEntries(Object.entries(HOSTS).map(([k, h]) => [k, `http://${h}:${port}`])) as Record<HostKey, string>;
  const origin = origins.main;
  const manifest = new Set(manifestPaths());
  const noindex = new Set(noindexPaths());
  const bySection = new Map(SECTIONS.map((s) => [s.path, sectionPaths(s)]));
  const extras = new Map(INDEX_EXTRAS.map((e) => [e.path, e]));
  const sitemaps = new Map(fixtureSitemaps().map((s) => [s.path, s]));
  const gz = new Map<string, Buffer>();
  const sitemapBody = (o: string, s: Sitemap) => {
    const k = `${o}${s.path}`;
    if (!gz.has(k)) gz.set(k, gzipSync(urlset(o, s)));
    return gz.get(k)!;
  };

  function mainSite(path: string, search: URLSearchParams, rawSearch: string): Response {
    if (path === "/robots.txt") {
      return text(`User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow: ${ROBOTS_BLOCKED_PREFIX}\nDisallow: /assets/private/\n\nSitemap: ${origin}/sitemap_index.xml\n`);
    }
    if (path === "/sitemap_index.xml") {
      const children = [...sitemaps.keys()].map((p) => `<sitemap><loc>${origin}${p}</loc></sitemap>`).join("");
      return text(`<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${children}</sitemapindex>`, "application/xml");
    }
    if (sitemaps.has(path)) return { status: 200, type: "application/x-gzip", headers: {}, body: sitemapBody(origin, sitemaps.get(path)!) };
    if (path === "/.env") return text("DB_PASSWORD=fixture-not-a-secret\n"); // the spec's exposed file; never linked
    if (path === "/llms.txt") return text(LLMS_TXT, "text/markdown; charset=utf-8");
    if (path === "/favicon.ico") return { status: 200, type: "image/x-icon", headers: {}, body: FAVICON };
    if (path === "/assets/og.png") return { status: 200, type: "image/png", headers: {}, body: png(1200, 630) };
    if (path === "/assets/og-small.png") return { status: 200, type: "image/png", headers: {}, body: png(100, 100) };
    if (path === "/assets/private/site.css") return text("body{margin:0}", "text/css");

    const extra = extras.get(path + rawSearch);
    if (extra) {
      if (extra.status !== 200) return errorPage(extra.status, extra.status === 404 ? "Not found" : "Server error");
      const p = cleanParts(path + rawSearch, origin);
      extra.apply?.(p, { path: path + rawSearch, origin });
      return html(p);
    }

    if (path === "/products/" && rawSearch) return html(cleanParts(path + rawSearch, origin, productListing(search)));
    if (rawSearch) return notFound();

    if (path === "/") {
      const sections = FIRST.concat(SECTIONS.filter((s) => s.linking !== "none" && !FIRST.includes(s.path)).map((s) => s.path));
      return html(cleanParts("/", origin, links(sections)));
    }
    const redirect = REDIRECTS[path];
    if (redirect) {
      if ("status" in redirect) return redirectTo(redirect.status, redirect.to);
      const p = cleanParts(path, origin);
      if ("meta" in redirect) p.head += `<meta http-equiv="refresh" content="0; url=${redirect.meta}">`;
      else p.body += `<script>location.replace(${JSON.stringify(redirect.js)})</script>`;
      return html(p);
    }
    if (path.startsWith("/ssrf/p-")) {
      const target = SSRF_TARGETS[Number(path.slice("/ssrf/p-".length)) - 1];
      if (target) return redirectTo(302, target.replace("{canary}", String(canaryPort)));
    }
    if (!manifest.has(path)) return notFound();

    const section = SECTIONS.find((s) => path.startsWith(s.path))!;
    const paths = bySection.get(section.path)!;
    let body = "";
    if (path === section.path) {
      if (section.linking === "index") body = links(paths.slice(1));
      if (section.path === "/index/") body += links(INDEX_EXTRAS.map((e) => e.path)); // not in any sitemap
      if (section.linking === "js") {
        // Links exist only after JavaScript runs; a crawler that does not render sees none.
        body = `<div id="nav"></div><script>for (let i = 1; i < ${paths.length}; i++) { const a = document.createElement("a"); a.href = "/js/p-" + i; a.textContent = String(i); document.getElementById("nav").append(a); }</script>`;
      }
      if (section.path === "/products/") body += productListing(new URLSearchParams());
    }
    if (section.linking === "chain") {
      const depth = path === "/deep/" ? 1 : Number(/^\/deep\/d-(\d+)$/.exec(path)?.[1] ?? 0);
      const out: string[] = [];
      if (depth && depth < DEEP_CHAIN_DEPTH) out.push(deepChainPath(depth + 1));
      if (depth) out.push(...paths.filter((p) => p.startsWith(`/deep/d-${depth}-s-`)));
      body = links(out);
    }
    if (section.path === "/links/" && path !== section.path) {
      const i = Number(path.slice("/links/p-".length));
      if (i <= 10) body += links([`/links/missing-${i}`, "/redirects/s301-1"]); // a broken internal link and one to a redirect
    }

    const p = applyDefect(path, origin, body);
    if (noindex.has(path)) {
      if (noindexKind(path) === "header") p.headers["x-robots-tag"] = "noindex";
      else p.head += '<meta name="robots" content="noindex">';
    }
    return html(p);
  }

  /** A minimal clean site for the alt hosts: a home page, plus /item-N pages on alt3. */
  function altSite(key: HostKey, path: string): Response {
    const o = origins[key];
    if (path === "/robots.txt") {
      if (key === "alt") return text("Service unavailable", "text/plain", 503);
      if (key === "alt2" || key === "www2") return text("User-agent: *\nDisallow: /private/\n");
      return text(`User-agent: *\nDisallow: /private/\n\nSitemap: ${o}/sitemap.xml.gz\n`);
    }
    if (key === "alt3" && path === "/sitemap.xml.gz") {
      const paths = ["/"];
      for (let i = 1; paths.length < ALT3_SITEMAP_URLS; i++) paths.push(`/item-${i}`);
      return { status: 200, type: "application/x-gzip", headers: {}, body: sitemapBody(o, { path, paths }) };
    }
    if (key === "alt3" && path === "/llms.txt") return text(`<!doctype html><html><body><h1>${SITE_NAME}</h1></body></html>`, "text/html; charset=utf-8");
    if (path === "/assets/og.png") return { status: 200, type: "image/png", headers: {}, body: png(1200, 630) };
    if (key !== "alt2" && key !== "www2" && path === "/favicon.ico") return { status: 200, type: "image/x-icon", headers: {}, body: FAVICON };
    if (path === "/" || (key === "alt3" && /^\/item-\d+$/.test(path))) {
      const p = cleanParts(path, o);
      if (key === "alt2" || key === "www2") p.icon = "";
      // Page text differs per host, so alt pages never look like copies of fixture.test pages.
      p.title = p.title.replace("</title>", ` on ${HOSTS[key]}</title>`);
      return html(p);
    }
    return notFound();
  }

  const route = ((hostHeader: string, target: string): Response => {
    const host = hostHeader.replace(/:\d+$/, "").toLowerCase();
    const url = new URL(target, "http://x");
    const key = (Object.keys(HOSTS) as HostKey[]).find((k) => HOSTS[k] === host) ?? "main";
    if (key === "www") return redirectTo(301, `${origin}${url.pathname}${url.search}`);
    if (key === "main") return mainSite(url.pathname, url.searchParams, url.search);
    return altSite(key, url.pathname);
  }) as Router;
  route.origins = origins;
  return route;
}

export async function startFixtureSite(opts: { port?: number } = {}): Promise<FixtureSite> {
  const hits: Hit[] = [];
  const requests: Hit[] = [];
  const canaryHits: Hit[] = [];
  const canary = createServer((req, res) => {
    canaryHits.push({ t: Date.now(), path: req.url ?? "/", status: 200 });
    res.end("canary");
  });
  await new Promise<void>((r) => canary.listen(0, "127.0.0.1", r));
  const canaryPort = (canary.address() as AddressInfo).port;

  let router: Router | null = null;
  const throttled = new Set<string>();

  function respond(req: IncomingMessage, res: ServerResponse) {
    const host = (req.headers.host ?? HOSTS.main).replace(/:\d+$/, "");
    // Hits keep the bare path for fixture.test (what the Phase 1 gate compares); other hosts are tagged.
    const log = (status: number): Hit => ({ t: Date.now(), path: req.url ?? "/", status, ...(host === HOSTS.main ? {} : { host }) });
    requests.push(log(0));
    const send = (r: Response) => {
      hits.push(log(r.status));
      res.writeHead(r.status, { "content-type": r.type, ...r.headers }).end(r.body);
    };
    const r = router!(host, req.url ?? "/");
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (host !== HOSTS.main || !path.startsWith("/slow/") || r.status !== 200) return send(r);

    const i = path === "/slow/" ? 0 : Number(path.slice("/slow/p-".length));
    setTimeout(() => {
      if (i >= 1 && i <= SLOW.throttledOnce && !throttled.has(path)) {
        throttled.add(path);
        return send(errorPage(429, "Too many requests", { "retry-after": String(SLOW.retryAfterS) }));
      }
      if (i === SLOW.throttledOnce + 1) return send(errorPage(503, "Unavailable", { "retry-after": String(SLOW.unavailableRetryAfterS) }));
      send(r);
    }, SLOW.ttfbMs);
  }

  const server: Server = createServer(respond);
  await new Promise<void>((r) => server.listen(opts.port ?? 0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  router = createRouter(port, canaryPort);

  return {
    origin: router.origins.main,
    port,
    origins: router.origins,
    hits,
    requests,
    canaryHits,
    close: async () => {
      server.closeAllConnections();
      canary.closeAllConnections();
      await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => canary.close(r))]);
    },
  };
}

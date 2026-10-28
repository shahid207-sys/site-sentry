// Serves the fixture site defined in definition.ts. Used by the Phase 1 gate (scripts/gate-p1.ts) and its tests.
// Every request is logged with a timestamp, so the gate can prove which URLs were fetched, how often and when.
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

export interface Hit {
  t: number;
  path: string;
  status: number;
}

export interface FixtureSite {
  /** e.g. http://fixture.test:51234 (the host must be mapped to 127.0.0.1 by the crawler's fetch policy). */
  origin: string;
  port: number;
  /** Responses, logged when sent. */
  hits: Hit[];
  /** Requests, logged on arrival (status 0): a request cut off by a killed client is still counted. */
  requests: Hit[];
  /** Requests that reached the 127.0.0.1 canary the /ssrf/ pages redirect to. Must stay empty. */
  canaryHits: Hit[];
  close(): Promise<void>;
}

const page = (title: string, body: string, head = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const links = (paths: string[]) => `<ul>${paths.map((p) => `<li><a href="${p}">${p}</a></li>`).join("")}</ul>`;
const urlset = (origin: string, paths: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map((p) => `<url><loc>${origin}${p}</loc></url>`).join("")}</urlset>`;

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

export async function startFixtureSite(opts: { host?: string; port?: number } = {}): Promise<FixtureSite> {
  const host = opts.host ?? "fixture.test";
  const hits: Hit[] = [];
  const requests: Hit[] = [];
  const canaryHits: Hit[] = [];
  const canary = createServer((req, res) => {
    canaryHits.push({ t: Date.now(), path: req.url ?? "/", status: 200 });
    res.end("canary");
  });
  await new Promise<void>((r) => canary.listen(0, "127.0.0.1", r));
  const canaryPort = (canary.address() as AddressInfo).port;

  let origin = "";
  const sitemaps = new Map<string, Buffer>();
  const throttled = new Set<string>();
  const manifest = new Set(manifestPaths());
  const noindex = new Set(noindexPaths());
  const bySection = new Map(SECTIONS.map((s) => [s.path, sectionPaths(s)]));

  function respond(req: IncomingMessage, res: ServerResponse) {
    requests.push({ t: Date.now(), path: req.url ?? "/", status: 0 });
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    const send = (status: number, body: string | Buffer, type = "text/html; charset=utf-8", headers: Record<string, string> = {}) => {
      hits.push({ t: Date.now(), path: req.url ?? "/", status });
      res.writeHead(status, { "content-type": type, ...headers }).end(body);
    };

    if (path === "/robots.txt") {
      return send(200, `User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow: ${ROBOTS_BLOCKED_PREFIX}\n\nSitemap: ${origin}/sitemap_index.xml\n`, "text/plain");
    }
    if (path === "/sitemap_index.xml") {
      const children = [...sitemaps.keys()].map((p) => `<sitemap><loc>${origin}${p}</loc></sitemap>`).join("");
      return send(200, `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${children}</sitemapindex>`, "application/xml");
    }
    if (sitemaps.has(path)) return send(200, sitemaps.get(path)!, "application/x-gzip");
    if (path === "/.env") return send(200, "DB_PASSWORD=fixture-not-a-secret\n", "text/plain"); // the spec's exposed file; never linked

    if (path === "/products/" && url.search) return send(200, page("Products (filtered)", productListing(url.searchParams)));
    if (url.search) return send(404, page("Not found", ""));

    if (path === "/") {
      const sections = FIRST.concat(SECTIONS.filter((s) => s.linking !== "none" && !FIRST.includes(s.path)).map((s) => s.path));
      return send(200, page("Fixture home", links(sections)));
    }
    const redirect = REDIRECTS[path];
    if (redirect) {
      if ("status" in redirect) return send(redirect.status, "", "text/html", { location: redirect.to });
      if ("meta" in redirect) return send(200, page("Moved", "", `<meta http-equiv="refresh" content="0; url=${redirect.meta}">`));
      return send(200, page("Moved", `<script>location.replace(${JSON.stringify(redirect.js)})</script>`));
    }
    if (path.startsWith("/ssrf/p-")) {
      const target = SSRF_TARGETS[Number(path.slice("/ssrf/p-".length)) - 1];
      if (target) return send(302, "", "text/html", { location: target.replace("{canary}", String(canaryPort)) });
    }
    if (!manifest.has(path)) return send(404, page("Not found", ""));

    const section = SECTIONS.find((s) => path.startsWith(s.path))!;
    const paths = bySection.get(section.path)!;
    let body = "";
    if (path === section.path) {
      if (section.linking === "index") body = links(paths.slice(1));
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

    const headers: Record<string, string> = {};
    let head = "";
    if (noindex.has(path)) {
      if (paths.indexOf(path) % 3 === 0) headers["x-robots-tag"] = "noindex";
      else head = `<meta name="robots" content="noindex">`;
    }
    const html = page(path, body, head);

    if (section.path === "/slow/") {
      const i = path === "/slow/" ? 0 : Number(path.slice("/slow/p-".length));
      setTimeout(() => {
        if (i >= 1 && i <= SLOW.throttledOnce && !throttled.has(path)) {
          throttled.add(path);
          return send(429, page("Too many requests", ""), "text/html", { "retry-after": String(SLOW.retryAfterS) });
        }
        if (i === SLOW.throttledOnce + 1) return send(503, page("Unavailable", ""), "text/html", { "retry-after": String(SLOW.unavailableRetryAfterS) });
        send(200, html, undefined, headers);
      }, SLOW.ttfbMs);
      return;
    }
    send(200, html, undefined, headers);
  }

  const server: Server = createServer(respond);
  await new Promise<void>((r) => server.listen(opts.port ?? 0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  origin = `http://${host}:${port}`;

  // One gzipped child sitemap per section (the noindexed /index/ pages get their own), all listed in the index.
  for (const s of [...SECTIONS].sort((a, b) => Number(FIRST.includes(b.path)) - Number(FIRST.includes(a.path)))) {
    const paths = bySection.get(s.path)!.filter((p) => !noindex.has(p));
    if (s.path === "/clean/") paths.unshift("/");
    sitemaps.set(`/sitemaps/${s.path.slice(1, -1)}.xml.gz`, gzipSync(urlset(origin, paths)));
  }
  sitemaps.set("/sitemaps/index-noindex.xml.gz", gzipSync(urlset(origin, noindexPaths())));

  return {
    origin,
    port,
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

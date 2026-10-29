// Serves the fixture site defined in definition.ts (Phase 1 behaviour) with the Phase 2a defects of defects.ts.
// Used by the gates (scripts/gate-p1.ts, scripts/gate-p2a.ts) and their tests. Every request is logged with a
// timestamp, so a gate can prove which URLs were fetched, how often and when.
//
// The responses come from `createRouter`, a pure function of host, path and query, so the fast fixture test
// (site-rules.test.ts) renders exactly what the server sends. Only /slow/ timing and throttling live in the server.
//
// One port serves https and plain http: the first byte of a connection picks TLS (0x16, a handshake) or HTTP. Plain http
// answers 301 to https (the IDX-020 negative), except on alt2.test, which serves both schemes. Certificates are made at
// startup (no key is kept in the repo): fixture.test's expires in TLS_DAYS.main days (SEC-003 positive), the alternate
// hosts' in a year (negative). FixtureSite.ca lists them, for the crawler to trust (CRAWLER_LOCAL_CA, tests only).
//
// Hosts (all on one port, chosen by the Host header; the crawler maps each name to loopback):
//   fixture.test      the site itself
//   www.fixture.test  301 to https://fixture.test (IDX-021 negative)
//   alt.test          robots.txt answers 503 (IDX-025)
//   alt2.test         robots.txt without a Sitemap line, no sitemap, no favicon, no llms.txt; www.alt2.test serves 200 too,
//                     and so does plain http (IDX-020 positive)
//   alt3.test         a 50,001-URL sitemap (IDX-030) and an llms.txt served as HTML (AIS-003)
//   ext.test          external link targets (520 of them, over the 500-URL budget); ext2.test: /gone 404 (LNK-010), /ok 200
//
// Every host but alt2.test sends HSTS, nosniff and a frame-ancestors CSP; alt2.test's home page is the SEC-004,
// SEC-005 and SD-007 positive (those rules judge the start page only).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer, type AddressInfo, type Socket } from "node:net";
import { createSecureContext } from "node:tls";
import { generate } from "selfsigned";
import { gzipSync } from "node:zlib";
import {
  DEEP_CHAIN_DEPTH,
  deepChainPath,
  EXT_HOSTS,
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
import { ENV_BODY, GIT_HEAD_BODY, IMAGE_BUDGET_PAGES, imageBudgetBody, imageFile, PLAIN_HTTP_PAGE, SCHEMA_DEEP, schemaDeepParts } from "./defects-2b";
import { cleanParts, FAVICON, links, png, renderParts, SITE_NAME, type Parts } from "./pages";

export interface Hit {
  t: number;
  path: string;
  status: number;
  host?: string;
  /** Set for plain-http requests (https is the default). */
  scheme?: "http";
  /** Set when not GET. */
  method?: string;
  /** The Range header, when sent. */
  range?: string;
}

/** Hit key for duplicate checks: host (other than fixture.test), scheme and method are part of a request's identity. */
export const hitKey = (h: Hit) => `${h.method && h.method !== "GET" ? `${h.method} ` : ""}${h.scheme ? "http://" : ""}${h.host ?? ""}${h.path}`;

export interface FixtureSite {
  /** e.g. https://fixture.test:51234 (the host must be mapped to 127.0.0.1 by the crawler's fetch policy). */
  origin: string;
  /** PEM certificates of the TLS listener, for the crawler to trust (CRAWLER_LOCAL_CA). */
  ca: string;
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
  ...EXT_HOSTS,
} as const;
export type HostKey = keyof typeof HOSTS;

/** CRAWLER_LOCAL_HOSTS value mapping every fixture host to loopback. */
export const LOCAL_HOSTS_ENV = Object.values(HOSTS)
  .map((h) => `${h}=127.0.0.1`)
  .join(",");

/** Days until the TLS certificates expire: fixture.test's is inside SEC-003's 21-day window, the others' are not. */
export const TLS_DAYS = { main: 10, other: 365 } as const;

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

/** Sent by every host but alt2.test: SEC-004 and SEC-005 negatives. */
const SECURITY_HEADERS = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "content-security-policy": "frame-ancestors 'self'",
};

export interface Router {
  (host: string, pathAndQuery: string, scheme?: "http" | "https"): Response;
  origins: Record<HostKey, string>;
}

/** Every response of the fixture site, by Host header and request target. Deterministic; caches sitemap bodies. */
export function createRouter(port: number, canaryPort: number): Router {
  const origins = Object.fromEntries(Object.entries(HOSTS).map(([k, h]) => [k, `https://${h}:${port}`])) as Record<HostKey, string>;
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
    // The spec's exposed files (SEC-006), never linked: the crawler meets them only as probes.
    if (path === "/.env") return text(ENV_BODY);
    if (path === "/.git/HEAD") return text(GIT_HEAD_BODY);
    if (path.startsWith("/img/")) {
      const f = imageFile(path);
      return f ? { status: 200, type: f.type, headers: {}, body: f.body } : notFound();
    }
    if (path === "/assets/app.js") return text("void 0;", "text/javascript");
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
      p.nav = navOf(SECTIONS.find((s) => s.path === "/redirects/")!, path, bySection.get("/redirects/")!);
      return html(p);
    }
    if (path.startsWith("/ssrf/p-")) {
      const target = SSRF_TARGETS[Number(path.slice("/ssrf/p-".length)) - 1];
      if (target) return redirectTo(302, target.replace("{canary}", String(canaryPort)));
    }
    if (path === PLAIN_HTTP_PAGE) {
      const p = cleanParts(path, origin.replace("https:", "http:"), "");
      // Absolute links: relative ones would resolve to http URLs that redirect (LNK-002).
      p.header = p.header.replace('href="/"', `href="${origin}/"`);
      p.nav = nav([`${origin}/security/`], "Security pages");
      return html(p);
    }
    if (IMAGE_BUDGET_PAGES.includes(path)) {
      const p = cleanParts(path, origin, imageBudgetBody(path));
      p.nav = nav(["/images/"], "Image pages");
      return html(p);
    }
    if (SCHEMA_DEEP.includes(path)) {
      const p = cleanParts(path, origin);
      p.nav = nav(SCHEMA_DEEP.filter((x) => x !== path), "Related guide");
      schemaDeepParts(p, path, origin);
      return html(p);
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
      if (section.path === "/schema/") body += links(SCHEMA_DEEP); // three segments deep, not in any sitemap
    }
    if (path === "/index/p-20") body += links(INDEX_EXTRAS.filter((e) => e.status === 200).map((e) => e.path)); // a second inbound link
    if (path === "/images/p-58" || path === "/images/p-59") body += links(IMAGE_BUDGET_PAGES);
    if (section.linking === "chain") {
      const depth = path === "/deep/" ? 1 : Number(/^\/deep\/d-(\d+)$/.exec(path)?.[1] ?? 0);
      const out: string[] = [];
      if (depth && depth < DEEP_CHAIN_DEPTH) out.push(deepChainPath(depth + 1));
      if (depth) out.push(...paths.filter((p) => p.startsWith(`/deep/d-${depth}-s-`)));
      body = out.length ? links(out) : "";
    }

    const p = applyDefect(path, origin, body);
    p.nav = navOf(section, path, paths);
    if (noindex.has(path)) {
      if (noindexKind(path) === "header") p.headers["x-robots-tag"] = "noindex";
      else p.head += '<meta name="robots" content="noindex">';
    }
    return html(p);
  }

  /**
   * Links to neighbouring pages, so no page fires LNK-005 (one inbound link) by accident. Index-linked sections: the
   * previous and next page (/redirects/: its HTML pages only). /deep/: the parent chain page, and side pages their
   * siblings (click depth is unchanged). Orphans and /js/ pages link out only: they stay orphans.
   */
  function navOf(section: (typeof SECTIONS)[number], path: string, paths: string[]): string {
    if (section.path === "/ssrf/") return "";
    if (section.path === "/redirects/") return prevNext(paths.filter((x) => x === section.path || !("status" in REDIRECTS[x])), path);
    if (section.linking === "index") return prevNext(paths, path);
    if (section.linking === "chain") {
      const m = /^\/deep\/d-(\d+)(-s-\d+)?$/.exec(path);
      if (!m) return "";
      const depth = Number(m[1]);
      if (!m[2]) return nav([deepChainPath(depth - 1)], "Up one level");
      return nav([deepChainPath(depth), ...paths.filter((x) => x !== path && x.startsWith(`/deep/d-${depth}-s-`))], "Related page");
    }
    return nav([section.linking === "js" ? section.path : "/clean/", "/clean/p-1"], "Related pages");
  }
  const prevNext = (list: string[], path: string) => {
    const i = list.indexOf(path);
    return i < 0 ? "" : `<nav>${i > 0 ? `<a href="${list[i - 1]}">Previous page</a>` : ""}${i < list.length - 1 ? `<a href="${list[i + 1]}">Next page</a>` : ""}</nav>`;
  };
  const nav = (targets: string[], label: string) => `<nav>${targets.map((t) => `<a href="${t}">${label}</a>`).join("")}</nav>`;

  /** External link targets: robots allows everything; /gone is 404, every other path a small page. */
  function extSite(path: string): Response {
    if (path === "/robots.txt") return text("User-agent: *\nDisallow:\n");
    if (path === "/gone") return notFound();
    return { status: 200, type: "text/html; charset=utf-8", headers: {}, body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Partner ${path}</title></head><body><p>Partner page.</p></body></html>` };
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
    // A soft 200: HTML for /.env and /.git/HEAD, with no file behind it (SEC-006 negative).
    if (key === "alt3" && (path === "/.env" || path === "/.git/HEAD")) return text(`<!doctype html><html><body><h1>${SITE_NAME}</h1><p>Page not found.</p></body></html>`, "text/html; charset=utf-8");
    if (path === "/assets/og.png") return { status: 200, type: "image/png", headers: {}, body: png(1200, 630) };
    if (key !== "alt2" && key !== "www2" && path === "/favicon.ico") return { status: 200, type: "image/x-icon", headers: {}, body: FAVICON };
    if (path === "/" || (key === "alt3" && /^\/item-\d+$/.test(path))) {
      const p = cleanParts(path, o);
      if (key === "alt2" || key === "www2") {
        p.icon = "";
        p.head = ""; // no Organization structured data on the home page (SD-007 positive)
      }
      // Page text differs per host, so alt pages never look like copies of fixture.test pages.
      p.title = p.title.replace("</title>", ` on ${HOSTS[key]}</title>`);
      return html(p);
    }
    return notFound();
  }

  const route = ((hostHeader: string, target: string, scheme: "http" | "https" = "https"): Response => {
    const host = hostHeader.replace(/:\d+$/, "").toLowerCase();
    const url = new URL(target, "http://x");
    const key = (Object.keys(HOSTS) as HostKey[]).find((k) => HOSTS[k] === host) ?? "main";
    const secure = (r: Response): Response => (key === "alt2" || key === "www2" ? r : { ...r, headers: { ...SECURITY_HEADERS, ...r.headers } });
    if (key === "www") return secure(redirectTo(301, `${origin}${url.pathname}${url.search}`));
    if (key === "ext" || key === "ext2") return extSite(url.pathname);
    // Plain http answers 301 to https, except on alt2 (both schemes serve 200) and the one plain-http page (SEC-001).
    const plain = key === "main" && url.pathname === PLAIN_HTTP_PAGE;
    if (scheme === "http" && key !== "alt2" && key !== "www2" && !plain) return secure(redirectTo(301, `${origins[key]}${url.pathname}${url.search}`));
    if (key === "main") return secure(mainSite(url.pathname, url.searchParams, url.search));
    return secure(altSite(key, url.pathname));
  }) as Router;
  route.origins = origins;
  return route;
}

/** Self-signed certificates for the fixture hosts, made per run: fixture.test (and www) and the alternate hosts. */
async function certificates() {
  const make = async (names: string[], days: number) => {
    const pems = await generate([{ name: "commonName", value: names[0] }], {
      keyType: "ec",
      algorithm: "sha256",
      notBeforeDate: new Date(Date.now() - 86_400_000),
      notAfterDate: new Date(Date.now() + days * 86_400_000),
      // The library's default extensions, with every host name in the SAN.
      extensions: [
        { name: "basicConstraints", cA: false, critical: true },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
        { name: "extKeyUsage", serverAuth: true, clientAuth: true },
        { name: "subjectAltName", altNames: names.map((value) => ({ type: 2, value })) },
      ],
    });
    return { names, key: pems.private, cert: pems.cert };
  };
  const others = Object.values(HOSTS).filter((h) => h !== HOSTS.main && h !== HOSTS.www);
  return [await make([HOSTS.main, HOSTS.www], TLS_DAYS.main), await make(others, TLS_DAYS.other)];
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

  function respond(req: IncomingMessage, res: ServerResponse, scheme: "http" | "https") {
    const host = (req.headers.host ?? HOSTS.main).replace(/:\d+$/, "");
    // Hits keep the bare path for GETs to fixture.test over https (what the Phase 1 gate compares); anything else is tagged.
    const log = (status: number): Hit => ({
      t: Date.now(),
      path: req.url ?? "/",
      status,
      ...(host === HOSTS.main ? {} : { host }),
      ...(scheme === "http" ? { scheme } : {}),
      ...(req.method && req.method !== "GET" ? { method: req.method } : {}),
      ...(req.headers.range ? { range: req.headers.range } : {}),
    });
    requests.push(log(0));
    const send = (r: Response) => {
      hits.push(log(r.status));
      // Content-Length on HEAD too, as real servers send it: the resource phase reads image sizes from HEAD.
      res.writeHead(r.status, { "content-type": r.type, "content-length": String(Buffer.byteLength(r.body)), ...r.headers }).end(req.method === "HEAD" ? undefined : r.body);
    };
    const r = router!(host, req.url ?? "/", scheme);
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (host !== HOSTS.main || scheme !== "https" || !path.startsWith("/slow/") || r.status !== 200) return send(r);

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

  const certs = await certificates();
  const contexts = new Map(certs.flatMap((c) => c.names.map((n) => [n, createSecureContext({ key: c.key, cert: c.cert })] as const)));
  const http = createServer((req, res) => respond(req, res, "http"));
  const https = createHttpsServer(
    { key: certs[0].key, cert: certs[0].cert, SNICallback: (name, cb) => cb(null, contexts.get(name.toLowerCase()) ?? contexts.get(HOSTS.main)!) },
    (req, res) => respond(req, res, "https"),
  );
  // One port for both schemes: a TLS connection opens with a handshake record (0x16); anything else is plain HTTP.
  const sockets = new Set<Socket>();
  const server = createNetServer({ pauseOnConnect: true }, (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.once("data", (first) => {
      socket.pause();
      socket.unshift(first);
      (first[0] === 0x16 ? https : http).emit("connection", socket);
      process.nextTick(() => socket.resume());
    });
    socket.resume();
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  router = createRouter(port, canaryPort);

  return {
    origin: router.origins.main,
    ca: certs.map((c) => `${c.cert.trim()}\n`).join(""),
    port,
    origins: router.origins,
    hits,
    requests,
    canaryHits,
    close: async () => {
      for (const s of sockets) s.destroy();
      canary.closeAllConnections();
      await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => canary.close(r))]);
    },
  };
}

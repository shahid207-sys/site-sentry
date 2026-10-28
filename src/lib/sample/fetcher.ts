// Serves the fixture sites through the same Fetcher contract as the live, SSRF-guarded fetcher.
import { SafeFetchError, type Fetcher, type FetchResult } from "../fetch/safe-fetch";
import type { SampleState } from "../model";
import { fixtureSites, renderPage, type FixtureSite } from "./fixtures";

const MAX_REDIRECTS = 5;

export function sampleFetcher(state: SampleState): Fetcher {
  return async (input, opts) => {
    if (state === "offline") throw new SafeFetchError("NETWORK", "SAMPLE: the simulated site is offline.");
    const sites = fixtureSites(state);
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new SafeFetchError("INVALID_URL", `"${input}" is not a valid URL.`);
    }
    const requestedUrl = url.toString();
    const chain: { url: string; status: number }[] = [];
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const site = sites.find((s) => new URL(s.origin).host === url.host);
      if (!site) throw new SafeFetchError("DNS_FAILED", `SAMPLE: ${url.host} is not part of the sample workspace.`);
      const r = respond(site, url, opts.accept);
      if (r.redirect) {
        chain.push({ url: url.toString(), status: r.status });
        url = new URL(r.redirect, url);
        continue;
      }
      const accepted =
        opts.accept === "status" || opts.accept === "robots"
          ? true
          : opts.accept === "xml"
            ? /xml/.test(r.contentType)
            : /text\/html/.test(r.contentType);
      const ok = r.status >= 200 && r.status < 300;
      const body = ok && accepted && opts.accept !== "status" ? r.body : "";
      const res: FetchResult = {
        requestedUrl,
        finalUrl: url.toString(),
        status: r.status,
        redirectChain: chain,
        contentType: r.contentType,
        contentTypeAccepted: accepted,
        body,
        bytes: new TextEncoder().encode(body).byteLength,
        truncated: false,
        headers: { "content-type": r.contentType },
        elapsedMs: 42,
      };
      return res;
    }
    throw new SafeFetchError("TOO_MANY_REDIRECTS", `Stopped after ${MAX_REDIRECTS} redirects.`);
  };
}

function respond(site: FixtureSite, url: URL, accept: string): { status: number; contentType: string; body: string; redirect?: string } {
  const path = `${url.pathname}${url.search}`;
  if (url.pathname === "/robots.txt") {
    return site.robots === null ? { status: 404, contentType: "text/html", body: "" } : { status: 200, contentType: "text/plain", body: site.robots };
  }
  if (url.pathname === "/sitemap.xml") {
    return site.sitemap === null ? { status: 404, contentType: "text/html", body: "" } : { status: 200, contentType: "application/xml", body: site.sitemap };
  }
  if (url.pathname.startsWith("/images/")) {
    const missing = url.pathname.includes("missing");
    return { status: missing ? 404 : 200, contentType: missing ? "text/html" : "image/jpeg", body: "" };
  }
  const page = site.pages.find((p) => p.path === path) ?? site.pages.find((p) => p.path === url.pathname && !url.search);
  if (!page) return { status: 404, contentType: "text/html", body: "<!doctype html><title>Not found</title><h1>Not found</h1>" };
  if (page.redirect) return { status: page.status ?? 301, contentType: "text/html", body: "", redirect: page.redirect };
  if (page.status && page.status >= 400) return { status: page.status, contentType: "text/html", body: "<!doctype html><title>Not found</title>" };
  void accept;
  return { status: 200, contentType: page.contentType ?? "text/html; charset=utf-8", body: renderPage(site, page) };
}

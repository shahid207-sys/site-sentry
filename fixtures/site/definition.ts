// The fixture site (docs/SPEC.md "Test fixture site and definition of done"), as data. The server, its sitemaps
// and the gate's manifest are all generated from this one table, so they cannot drift apart.
//
// Phase 1 needs the crawler-facing behaviour only: link structure, sitemaps, robots.txt, redirects, slow and
// throttled responses, SSRF redirects and URL traps. Rule-level defects (titles, schema, images...) are Phase 2.

export interface Section {
  /** Path prefix, e.g. "/clean/". The section's first page is the prefix itself. */
  path: string;
  /** Page count from the spec table. */
  pages: number;
  /** How a crawler reaches the section's pages. */
  linking: "index" | "chain" | "none" | "js";
}

export const SECTIONS: Section[] = [
  { path: "/clean/", pages: 100, linking: "index" },
  { path: "/meta/", pages: 60, linking: "index" },
  { path: "/index/", pages: 80, linking: "index" },
  { path: "/redirects/", pages: 40, linking: "index" },
  { path: "/links/", pages: 120, linking: "index" },
  { path: "/deep/", pages: 50, linking: "chain" },
  { path: "/orphans/", pages: 30, linking: "none" },
  { path: "/content/", pages: 150, linking: "index" },
  { path: "/images/", pages: 60, linking: "index" },
  { path: "/schema/", pages: 60, linking: "index" },
  { path: "/intl/", pages: 40, linking: "index" },
  { path: "/js/", pages: 40, linking: "js" },
  { path: "/products/", pages: 300, linking: "index" },
  { path: "/security/", pages: 20, linking: "index" },
  { path: "/slow/", pages: 10, linking: "index" },
  { path: "/ssrf/", pages: 10, linking: "index" },
];

/** The spec's table sums to 1,170 pages ("about 1,200 URLs"); the home page makes 1,171 manifest URLs. */
export const SECTION_PAGE_TOTAL = SECTIONS.reduce((n, s) => n + s.pages, 0);

/** Deepest link depth of the /deep/ chain (home = 0, /deep/ = 1). */
export const DEEP_CHAIN_DEPTH = 12;
/** robots.txt blocks this subsection for every crawler, and the whole site for GPTBot. */
export const ROBOTS_BLOCKED_PREFIX = "/security/admin/";
/** /index/ pages that are noindexed; they are listed in their own child sitemap. */
export const NOINDEX_COUNT = 30;
/** /slow/ timings, as the spec's "4 s TTFB, 429 responses, Retry-After headers". */
export const SLOW = { ttfbMs: 4_000, throttledOnce: 5, retryAfterS: 1, unavailableRetryAfterS: 3_600 } as const;

/** Paths of a section's pages, in order. The first is the section index. */
export function sectionPaths(s: Section): string[] {
  if (s.path === "/redirects/") return REDIRECT_PATHS;
  if (s.path === "/deep/") return deepPaths();
  const out = [s.path];
  for (let i = 1; i < s.pages; i++) out.push(`${s.path}p-${i}`);
  if (s.path === "/security/") for (let i = 0; i < 5; i++) out[out.length - 1 - i] = `${ROBOTS_BLOCKED_PREFIX}a-${i + 1}`;
  return out;
}

/** /deep/: a chain /deep/ → d-2 → … → d-12 (depth 1 to 12), plus side pages hanging off the chain. */
function deepPaths(): string[] {
  const chain = ["/deep/"];
  for (let d = 2; d <= DEEP_CHAIN_DEPTH; d++) chain.push(`/deep/d-${d}`);
  const side: string[] = [];
  for (let i = 0; chain.length + side.length < 50; i++) side.push(`/deep/d-${(i % DEEP_CHAIN_DEPTH) + 1}-s-${Math.floor(i / DEEP_CHAIN_DEPTH) + 1}`);
  return [...chain, ...side];
}

/** The chain page at a given depth (1 = /deep/). */
export const deepChainPath = (depth: number) => (depth === 1 ? "/deep/" : `/deep/d-${depth}`);

// ---------- /redirects/: 40 URLs ----------

export type RedirectSpec = { status: 301 | 302 | 307 | 308; to: string } | { meta: string } | { js: string };

/** Every /redirects/ URL and what it does. All hops are /redirects/ URLs; the final targets are /clean/ pages. */
export const REDIRECTS: Record<string, RedirectSpec> = (() => {
  const r: Record<string, RedirectSpec> = {};
  for (let i = 1; i <= 5; i++) r[`/redirects/s301-${i}`] = { status: 301, to: `/clean/p-${i}` };
  for (let i = 1; i <= 5; i++) r[`/redirects/s302-${i}`] = { status: 302, to: `/clean/p-${10 + i}` };
  r["/redirects/s308-1"] = { status: 308, to: "/clean/p-20" };
  for (let n = 2; n <= 6; n++) {
    for (let h = 1; h <= n; h++) r[`/redirects/chain${n}-${h}`] = { status: 301, to: h < n ? `/redirects/chain${n}-${h + 1}` : `/clean/p-${30 + n}` };
  }
  r["/redirects/loop-a"] = { status: 302, to: "/redirects/loop-b" };
  r["/redirects/loop-b"] = { status: 302, to: "/redirects/loop-a" };
  for (let i = 1; i <= 3; i++) r[`/redirects/meta-${i}`] = { meta: `/clean/p-${40 + i}` };
  for (let i = 1; i <= 3; i++) r[`/redirects/js-${i}`] = { js: `/clean/p-${50 + i}` };
  return r;
})();
const REDIRECT_PATHS = ["/redirects/", ...Object.keys(REDIRECTS)];

// ---------- /ssrf/: 10 URLs, each but the index redirecting somewhere a crawler must never go ----------

/** Targets; "{canary}" is replaced by a listener on 127.0.0.1 that must see zero requests. */
export const SSRF_TARGETS = [
  "http://127.0.0.1:{canary}/",
  "http://localhost:{canary}/",
  "http://169.254.169.254/latest/meta-data/",
  "http://10.0.0.1/",
  "http://192.168.0.1/",
  "http://172.16.0.1/",
  "http://[::1]:{canary}/",
  "http://0.0.0.0:{canary}/",
  "http://100.64.0.1/",
];

// ---------- manifest ----------

/** Every page the fixture serves on purpose: the URLs a full discovery must find. Paths only. */
export function manifestPaths(): string[] {
  return ["/", ...SECTIONS.flatMap(sectionPaths)];
}

/** The noindexed /index/ pages. */
export const noindexPaths = () => sectionPaths(SECTIONS.find((s) => s.path === "/index/")!).slice(-NOINDEX_COUNT);

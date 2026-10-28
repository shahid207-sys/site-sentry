# SiteSentry — current architecture (pre crawler v2)

Snapshot of the code at commit `910263c` ("P0: baseline (pre-crawler)") on branch `feat/crawler-v2`.
Paths are relative to the repo root. Line numbers are as of that commit.

## 1. Overview

```
Browser (React client views)
   │  POST /api/{ws}/audits            create run   (JSON store)
   │  POST /api/{ws}/audits/{id}/step  advance run  (≤ 8 s of work per call, polled by the UI)
   │  POST /api/{ws}/audits/{id}/cancel
   ▼
Next.js route handlers (src/app/api/[ws]/…)
   ▼
src/lib/crawl/engine.ts  ── step-based crawler, state machine robots → sitemap → pages → links → finalize → done
   │        │                      │
   │        ├─ deps.fetch ─────────┴─► src/lib/fetch/safe-fetch.ts (SSRF-guarded undici fetch)
   │        └─ rules ─► src/lib/audit/run.ts (page rules)  +  src/lib/audit/analyze.ts (site rules, fingerprints)
   ▼
deps.store ─► src/lib/store/store.ts  JsonFileStore: .data/{live,sample}/state.json + audits/<id>.json
```

There is no background worker and no queue. A crawl only advances while a client keeps calling the `step` endpoint
(the progress view does this in a loop), or when `runAuditToCompletion` drives it in-process (tests, sample seeding).

## 2. Crawler

| Concern | File | Notes |
|---|---|---|
| Engine / state machine | `src/lib/crawl/engine.ts` | `createAudit` (l.70), `stepAudit` (l.488), `cancelAudit` (l.563), `runAuditToCompletion` (l.576). Phases: `doRobots` (l.135), `doSitemap` (l.174), `doPagesBatch` (l.320), `doLinksBatch` (l.419), `finalize` (l.442). |
| Hard limits | `src/lib/crawl/engine.ts:23-35` (`LIMITS`) | `maxPages 100`, `maxDepth 3`, `maxListUrls 100`, `concurrency 4`, `linkChecks 60`, `sitemapChildren 5`, `storedSitemapUrls 2000`, `stepBudgetMs 8000`, `leaseMs 45000`, `staleMs 120000`. |
| Frontier | `AuditRun.queue` / `AuditRun.seen` in the JSON state (`src/lib/model.ts:71-75`, `QueueItem`) | In-memory array persisted whole on every step. Each item has one `via` (`seed \| sitemap \| important \| link`), so a URL found by more than one source keeps only the first. |
| Concurrency | `engine.ts:331` | Batches of `LIMITS.concurrency` (4) via `Promise.all`. No per-host limit, rate cap, backoff, `Retry-After` or `Crawl-delay` handling. |
| Leasing / resume | `engine.ts:488-498` | One lease per audit in the JSON state (`leaseUntil`). A stale run (`isStale`, l.58) can be resumed by stepping again. |
| Cancel | `engine.ts:563` | Sets `cancelRequested`; the next step finalises with partial results. No pause. |
| URL identity | `src/lib/crawl/url.ts` | `normalizePageUrl` (l.8): WHATWG parse, http(s) only, lower-case scheme/host, drop default port, fragment and userinfo. Keeps path case, trailing slash and query order. `isInternal` compares hostnames only. No tests for this file. |
| robots.txt | `src/lib/crawl/robots.ts` | RFC 9309 parser and matcher (`parseRobots`, `isAllowed`). Collects `Sitemap:` lines. Ignores `Crawl-delay`. |
| Sitemaps | `src/lib/crawl/sitemap.ts` | `parseSitemap`: urlset or sitemapindex, capped at `MAX_SITEMAP_URLS = 5000`, well-formedness check. No gzip. Engine reads only the **first** candidate sitemap (`engine.ts:181`) and only **one level** of index children (max 5, l.199). |
| Link extraction | `src/lib/crawl/extract.ts` | `<a href>` and `<img src>`, honours `<base href>`, caps of 300 links / 100 images per page, tracks nofollow-only targets. |

### Where sitemap URLs are used
Only in `mode: "sitemap"` are sitemap URLs added to the frontier (`engine.ts:215-231`). In `single`/`list` mode the sitemap is
read only for the crawlability site rules, so sitemap-only pages are never fetched.

### The "10 page / 1 click" caps (UI defaults, below the engine cap)
| Location | Value |
|---|---|
| `src/components/marketing/HeroAuditForm.tsx:14` `QUICK_AUDIT` | 10 pages, depth 1 (public hero form) |
| `src/components/domain.tsx:78` `FIRST_AUDIT` | single 10/1, sitemap 25/0, list 25/0 |
| `src/components/views/Audits.tsx:36` `LIMITS` (copy of engine limits) | 100 / 3, UI default 25 pages, depth 1 (l.292-293) |
| `src/app/api/[ws]/audits/route.ts:16-17` (Zod) | `maxPages ≤ 100`, `maxDepth ≤ 3` |
| `src/app/(marketing)/methodology/page.tsx:141` | copy text quoting `LIMITS` |

## 3. Fetching and SSRF

`src/lib/fetch/safe-fetch.ts`
- `validateTargetUrl` (l.39): http(s) only, no credentials, ports 80/443 only, rejects single-label, `.local`, `.internal` etc., literal private IPs.
- `assertPublicHost` (l.74): resolves every address before each hop and rejects if any address is blocked.
- `guardedLookup` (l.102): undici `connect.lookup` hook that checks the addresses again at connect time, so the socket only ever
  connects to an address that passed the check (defence against DNS rebinding).
- Redirects are manual (`redirect: "manual"`), at most 5, and every `Location` goes through `validateTargetUrl` again.
- Byte caps: 2 MB for HTML, 5 MB for XML, 512 KB for robots.txt. 10 s timeout. One shared `Agent` with `connections: 8`.

`src/lib/fetch/ip-guard.ts`: `isBlockedIp` uses a `BlockList` of IPv4/IPv6 special-purpose ranges, including 169.254.0.0/16 (cloud
metadata), plus IPv4-mapped and NAT64-embedded addresses.

Tests: `ip-guard.test.ts` (address classification), `safe-fetch.test.ts` (15 lines; connect-time guard). There is no DNS stub, so
there are no tests that run a full fetch against hostnames that resolve to private addresses.

Workspace policy: `src/lib/workspace.ts:38` `policyFetcher` adds `SITE_SENTRY_LIVE_SCANS` and `SITE_SENTRY_ALLOWED_HOSTS` checks.
The `sample` workspace uses `src/lib/sample/fetcher.ts`, an in-memory fake site, so it never touches the network.

## 4. Parser and rule registry

| Concern | File |
|---|---|
| HTML parsing (cheerio) | `src/lib/audit/parse.ts` |
| Rule types (`RuleDef`, `CheckDef`, `PageContext`) | `src/lib/audit/rule.ts` |
| Page-rule registry `RULES`, `CRITERION_EVALUATORS`, `runRules` | `src/lib/audit/run.ts:17-45` |
| Page rules | `src/lib/audit/rules/{http,title,meta-description,headings,canonical,indexability,international,social,structured-data,images,content}.ts` |
| Site rules `SITE_RULES` | `src/lib/audit/site/index.ts:7`: robots, sitemap, links, broken images, duplicates |
| Site analysis, fingerprints, priority | `src/lib/audit/analyze.ts`, `fingerprint.ts`, `priority.ts`, `groups.ts`, `health.ts` |
| Rule catalog (UI copy) | `src/lib/audit/catalog.ts` |

The engine runs the page rules per snapshot during `doPagesBatch` → `buildSnapshot` (`engine.ts:260`). Site rules run once in
`finalize` via `analyzeAudit` (`engine.ts:450`), which needs every snapshot in memory.

## 5. Persistence

`src/lib/store/store.ts`
- `Store` interface (l.34): `read`, `update` (mutex-serialised read-modify-write), `readAudit`/`writeAudit`/`deleteAudit` for per-audit blobs.
- `JsonFileStore` (l.92): `<dataDir>/<ws>/state.json` and `<dataDir>/<ws>/audits/<id>.json`. Single-process only (in-process mutex).
- `MemoryStore`: used for tests and as the fallback for the sample workspace.
- `src/lib/store/migrate.ts`: migrates the legacy single-file store.
- Wiring: `src/lib/workspace.ts:129-157` (`getStore`, `getDeps`). Data dir: `SITE_SENTRY_DATA_DIR`, else `.data/`, or `/tmp/site-sentry` on Vercel.

Data model (`src/lib/model.ts`): `StoreDataV2` holds `sites`, `pages` (important URLs and expectations), `audits` (`AuditRun`,
including the frontier), `tasks` and `settings`. The `AuditBlob` holds `snapshots: PageSnapshot[]` and `findings: AuditFinding[]`.

**Scaling constraint:** every step rewrites the whole `state.json`, including the full `queue`/`seen` arrays, and the whole
audit blob. That cost grows with the size of the crawl. It is fine at 100 pages and unworkable at thousands.

## 6. API, reports and UI

| Concern | File |
|---|---|
| Route wrapper, error mapping, per-process rate limiter | `src/app/api/_lib/handler.ts` (`route`, `body`, `rateLimit` l.83) |
| Create / list audits | `src/app/api/[ws]/audits/route.ts` |
| Step / cancel / detail / delete | `src/app/api/[ws]/audits/[id]/{step,cancel}/route.ts`, `[id]/route.ts` |
| Export CSV/JSON | `src/app/api/[ws]/audits/[id]/export/route.ts` → `src/lib/export.ts` |
| Compare runs | `src/app/api/[ws]/audits/[id]/compare/route.ts` → `src/lib/audit/compare.ts` |
| Read models | `src/lib/server/queries.ts` (`summarize`, `getAuditDetail`, `listAudits`, `getOverview`, …), view types in `src/lib/views.ts` |
| Progress view (polls `step`) | `src/components/views/AuditProgress.tsx` (stages mirror engine phases) |
| New-audit form | `src/components/views/Audits.tsx` |
| First audit (onboarding) | `src/components/domain.tsx` |
| Public hero form | `src/components/marketing/HeroAuditForm.tsx` (creates a site and a `single` audit in the `live` workspace) |
| Task verification (re-fetch) | `src/lib/workflow/verify.ts`, `src/lib/workflow/tasks.ts` |

## 7. Tests

- Unit: Vitest (`vitest.config.mts`, `src/**/*.test.ts`). Baseline: 13 files, 152 tests, all passing.
- E2E: Playwright (`playwright.config.ts`, `e2e/*.spec.ts`).
- There are no tests for `crawl/url.ts`, `crawl/sitemap.ts`, `crawl/robots.ts`, `crawl/extract.ts` or `crawl/engine.ts` directly.

## 8. Gaps against the Phase 1 goal

1. No discovery union: one sitemap only, one index level, no gzip, and sitemap URLs are not crawled outside sitemap mode.
2. Discovery source is single-valued (`via`).
3. The frontier lives in a JSON blob; there's no per-URL terminal state with a reason, and no edge table.
4. No queue or worker. Progress depends on a browser tab polling `step`.
5. No politeness (per-host concurrency, rate cap, backoff, `Retry-After`, `Crawl-delay`).
6. SSRF guard exists but has no DNS-stub tests.
7. Caps are duplicated in five places, and there are no profiles.

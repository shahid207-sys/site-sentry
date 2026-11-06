# SiteSentry — Elite Product Spec & Build Plan

Version: 2026-10-28 · Owner: Danish

## Executive summary

SiteSentry becomes elite when every finding is complete, provable and actionable: full-site coverage, 150+ tested rules, evidence per URL, and a UI that turns 10,000 rows into a ranked fix list. The original plan diagnosed the problem correctly (10 pages, 1-click depth, 196 URLs skipped, 17 shallow findings). It stops short in six places this spec closes.

| Gap in the original plan | What this spec adds |
| --- | --- |
| No crawl politeness model | Per-host rate limiting, adaptive throttling on 429/503, crawl-delay, honest user-agent |
| Rules listed as categories, not rules | A numbered catalog (150+ rules) with ID, evidence schema, confidence and fixture per rule |
| Severity is vague | Priority = Impact × Reach × Confidence, and a transparent, decomposable health score |
| Missing modern checks | AI-crawler access (GPTBot, OAI-SearchBot, PerplexityBot, Google-Extended), llms.txt, INP, security headers, mixed content, soft 404s, hreflang reciprocity, canonical chains, internal PageRank |
| UI/UX not specified | Full design system, 12 core screens, live crawl monitor, page inspector, ⌘K command bar, white-label client reports |
| One mega-prompt for the agent | Six phase prompts, each with a hard acceptance gate, so the agent cannot fake progress |

The build order stays crawler first, rules second, UI third, integrations last. Nothing ships to clients until the fixture site passes 100% of expected detections with zero false positives on clean pages.

## Product vision and positioning

SiteSentry is the audit tool an agency hands to a client: Screaming Frog depth, Sitebulb explanations, and a fix-tracking loop none of them close. It wins on three things competitors do poorly together: evidence, prioritisation and verification of fixes.

**Primary users**

- **Agency SEO lead** — runs audits for 5–50 client sites, needs white-label reports and a prioritised fix list for developers.
- **In-house SEO / developer** — needs per-URL evidence, reproducible checks and regression alerts after each deploy.
- **Client stakeholder** — reads a shared report link; needs a plain-language summary and progress over time, not 400 rows.

**Differentiators**

1. **Evidence-first findings** — every finding stores the exact HTML snippet, header or response that triggered it, plus the rule version that ran.
2. **Fix verification loop** — mark an issue "fixed", SiteSentry re-checks only the affected URLs and confirms or reopens it.
3. **Template detection** — groups URLs by DOM template so "612 product pages missing H1" becomes one developer ticket, not 612.
4. **Raw vs rendered diff** — shows what Googlebot sees before and after JavaScript, side by side.
5. **AI-search readiness** — checks whether AI crawlers can access the site and whether content is extractable.
6. **Honest coverage** — the report always states what was and was not checked; no inflated health score.

**Non-goals for v1:** rank tracking (that is RankPilot's job), backlink index, keyword research database. These come via integrations, not in-house data.

## System architecture

Split the web app from long-running work: the UI and API stay on the current Next.js deployment, while crawling, rendering, analysis and reporting run as queue-driven workers on a container host, because serverless functions time out long before a 1,000-URL crawl finishes.

**Component flow (top to bottom)**

1. **Web app (Next.js UI)** — dashboards, page inspector, live crawl monitor. Talks to the API (requests + SSE progress).
2. **Client report link** — white-label PDF and password share page. Reads via the API.
3. **API layer** (route handlers, auth, RBAC) — starts jobs, serves findings, streams live progress. The web app never fetches target sites itself.
4. **Job queue** (Redis + BullMQ) — batches of 200 URLs, retries, pause/resume. Fans out to four worker types:
   - **Crawl worker** — fetch, robots, sitemaps, normalise, snapshot.
   - **Render worker** — Playwright pool, raw vs rendered diff.
   - **Analysis worker** — rules, link graph, priority and scoring.
   - **Report worker** — PDF, share links, alerts, schedules.
5. Workers read/write **Postgres** (crawls, URL states, edges, findings, history, users), **Object storage** (S3/R2: raw and rendered HTML, screenshots, PDF reports) and reach **External services** (target websites; PageSpeed, CrUX, GSC APIs).

Every long task goes through the queue, so any worker can crash and another resumes from the last committed batch.

**Stack decisions**

- **Web/API:** keep the existing Next.js app (Vercel is fine for this tier).
- **Workers:** Node.js + TypeScript in Docker on Railway, Fly.io or a Hetzner VPS; `undici` for HTTP, `parse5`/`cheerio` for parsing, Playwright for rendering.
- **Queue:** Redis + BullMQ with separate queues per worker type so slow renders never block fetches.
- **Database:** Postgres 16 with the project's existing ORM; partition `crawl_urls` and `findings` by crawl for large sites.
- **Storage:** Cloudflare R2 or S3 for HTML bodies (gzip), screenshots and PDFs; Postgres stores only pointers.
- **Realtime:** Redis pub/sub → Server-Sent Events to the live monitor.
- **Later, if a site exceeds ~1M URLs:** move findings analytics to ClickHouse.

**Core data model**

| Table | Purpose | Key columns |
| --- | --- | --- |
| `projects` | One per client site | domain, settings, branding, owner workspace |
| `crawls` | One per audit run | profile, config snapshot, status, counts, coverage %, started/finished |
| `crawl_urls` | URL inventory and frontier | url, normalised_url, state, reason, depth, discovered_via[], status_code, template_id |
| `url_edges` | Internal link graph | from_url, to_url, anchor, rel, location (nav/main/footer) |
| `page_snapshots` | Everything rules read | head tags, headings, text stats, hashes, robots, canonical, schema, storage keys for raw/rendered HTML |
| `resources` | Images, CSS, JS per page | url, type, bytes, status, dimensions |
| `templates` | DOM-skeleton clusters | fingerprint, sample_url, page_count |
| `rules` | Registry with versions | id, version, category, impact, confidence |
| `findings` | One per rule × URL × evidence | fingerprint, rule_id, rule_version, evidence JSON, priority inputs |
| `issue_states` | Lifecycle across audits | fingerprint, state, assignee, fixed_at, verified_at, ignored_reason |

## Crawler engine

The crawler must reach every eligible URL a search engine could reach, at a speed the target server tolerates, and record why any URL was not inspected.

**Discovery sources (all merged into one URL inventory, each URL tagged with how it was found)**

1. robots.txt `Sitemap:` lines, then `/sitemap.xml`, `/sitemap_index.xml` and gzipped sitemaps; recurse indexes to depth 3.
2. Breadth-first link crawl from the start URL: `<a href>`, `<link rel=next/prev/alternate/canonical>`, hreflang targets, iframes, and links found only in rendered DOM (Phase 5).
3. Optional user seed list (CSV upload or paste) and optional GSC page list (Phase 6).

**Crawl profiles**

| Profile | URL budget | Max depth | Rendering | Typical use |
| --- | --- | --- | --- | --- |
| Quick | 25 | 3 | Off | Pre-sales check, single section, public hero form |
| Standard | 1,000 | 10 | Sampled (1 per template) | Monthly client audit |
| Full-site | User-set, default 50,000 | Unlimited | Sampled or full | Migrations, large e-commerce |
| Custom | Any | Any | Any | Include/exclude regex, subfolder-only, staging with auth |

**Politeness and speed**

- Default 3 concurrent requests per host, 5 req/s cap; user can raise it for their own sites.
- Adaptive throttle: on 429, 503 or p95 latency over 3 s, halve concurrency and back off exponentially; honour `Retry-After` and `Crawl-delay`.
- User-agent: `SiteSentryBot/1.0` by default (set `CRAWLER_BOT_NAME` and `CRAWLER_BOT_URL` to your own identity, see docs/BOT.md); switchable to a Googlebot smartphone UA string for parity testing, clearly labelled in the report.
- Timeouts: 10 s connect, 30 s total, 5 MB HTML cap, 10 redirect hops max.

**URL normalisation**

Lowercase scheme and host, strip fragments, resolve relative paths, remove default ports, sort query parameters, and drop configured tracking parameters (`utm_*`, `gclid`, `fbclid`). Keep the original URL as found for evidence. Treat trailing-slash and case variants as distinct URLs, but flag them as duplicates. Where this section is silent, follow the WHATWG URL Standard and record the choice in `docs/CRAWLER-NORMALISATION.md`.

**URL states (every URL ends in exactly one)**

`discovered → queued → fetched → analysed`, or a terminal reason: `blocked_robots`, `out_of_scope`, `excluded_by_rule`, `budget_exhausted`, `depth_exceeded`, `redirected`, `failed_timeout`, `failed_dns`, `failed_tls`, `non_html`, `oversized`, `cancelled`. The report shows counts per state; nothing disappears silently.

**Resumability**

The frontier queue and URL states live in Postgres, not memory. A crawl can pause, survive a worker restart, and resume from the last checkpoint. Batches of 200 URLs commit atomically. URL rows are claimed with `SELECT ... FOR UPDATE SKIP LOCKED` and marked fetched in the same transaction as the snapshot write (at-most-once fetch accounting).

**Security (SSRF)**

- Resolve DNS before every request and after every redirect; reject private, loopback, link-local, CGNAT and cloud metadata ranges (`169.254.169.254`, `fd00::/8`, etc.).
- Pin the resolved IP for the connection to defeat DNS rebinding.
- Allow only `http`/`https` on ports 80, 443, 8080, 8443 unless an admin overrides.
- Staging-site auth (basic auth or cookie) is stored encrypted and scoped to one project.

## Rule engine and rule catalog

Every rule is a small, versioned, independently tested module; the catalog below lists 138 rules for v1, growing to 150+ in Phases 5–6.

**Rule contract (TypeScript)**

```ts
interface Rule {
  id: string;              // "IDX-004"
  version: number;         // bump when logic changes; stored on every finding
  category: Category;
  scope: "page" | "site" | "resource";
  confidence: "verified" | "heuristic" | "advisory";
  impact: 1 | 2 | 3 | 4 | 5;    // SEO consequence if true
  needs: ("raw" | "rendered" | "headers" | "graph" | "lighthouse")[];
  evaluate(ctx): Finding[];      // pure function, no network
  explain: { why: string; fix: string; acceptance: string; docs?: string };
}
```

Rules never fetch; they read the stored page snapshot. That makes them deterministic, fast (target under 5 ms per page per rule) and re-runnable on old crawls when a rule improves.

**Priority model**

Priority score = Impact (1–5) × Reach (share of indexable pages affected, 0–1, log-scaled) × Confidence (verified 1.0, heuristic 0.6, advisory 0.3). Scores map to Critical, High, Medium, Low, Info. The UI always shows the three inputs, so a user can see why something is Critical.

**Health score**

0–100, computed only over checks that actually ran. Formula and per-category weights are published in the report. A crawl under 50% coverage shows the score greyed out with "partial coverage" instead of a confident number.

**Finding states across audits:** `new`, `persistent`, `resolved`, `regressed`, `not_rechecked` (URL not crawled this time), `inconclusive`. Partial crawls can never resolve a finding they did not revisit.

### Catalog

Type: D = verified defect, H = heuristic, A = advisory.

**Crawlability and indexability (IDX)**

| ID | Check | Type | Impact |
| --- | --- | --- | --- |
| IDX-001 | 4xx on internal URL | D | 5 |
| IDX-002 | 5xx on internal URL | D | 5 |
| IDX-003 | Redirect chain of 3+ hops | D | 3 |
| IDX-004 | Redirect loop | D | 5 |
| IDX-005 | Temporary redirect (302/307) on permanent move | H | 2 |
| IDX-006 | Meta-refresh or JS redirect | D | 3 |
| IDX-007 | Indexable page blocked by robots.txt | D | 4 |
| IDX-008 | noindex in meta robots on a sitemap URL | D | 4 |
| IDX-009 | noindex via X-Robots-Tag header | D | 4 |
| IDX-010 | Conflicting robots directives (meta vs header) | D | 3 |
| IDX-011 | Missing canonical on indexable page | H | 2 |
| IDX-012 | Canonical points to non-200 URL | D | 4 |
| IDX-013 | Canonical chain (A→B→C) | D | 3 |
| IDX-014 | Canonical to noindexed or blocked URL | D | 4 |
| IDX-015 | Multiple canonical tags | D | 3 |
| IDX-016 | Canonical in body or outside head | D | 3 |
| IDX-017 | Relative or malformed canonical | D | 2 |
| IDX-018 | Canonical mismatch raw vs rendered | D | 4 |
| IDX-019 | Soft 404 (200 with not-found content) | H | 4 |
| IDX-020 | HTTP and HTTPS both serve 200 | D | 3 |
| IDX-021 | www and non-www both serve 200 | D | 3 |
| IDX-022 | Trailing-slash variants both 200 | D | 2 |
| IDX-023 | Uppercase URL variants resolve | H | 1 |
| IDX-024 | Parameter URLs indexable without canonical | H | 3 |
| IDX-025 | robots.txt unreachable or 5xx | D | 5 |
| IDX-026 | robots.txt blocks CSS/JS needed for render | D | 3 |
| IDX-027 | Sitemap missing or not referenced in robots.txt | H | 2 |
| IDX-028 | Sitemap URL returns non-200 | D | 3 |
| IDX-029 | Sitemap lists noindex or canonicalised URL | D | 3 |
| IDX-030 | Sitemap over 50,000 URLs or 50 MB | D | 3 |
| IDX-031 | Sitemap lastmod in the future or identical on all URLs | H | 1 |
| IDX-032 | Indexable URL missing from sitemap | H | 2 |
| IDX-033 | Commerce utility pages indexable (cart, checkout, my-account, wishlist, compare) | D | 3 |
| IDX-034 | Filter or taxonomy pages indexable without a canonical to the parent | H | 3 |

**AI-search readiness (AIS)**

| ID | Check | Type | Impact |
| --- | --- | --- | --- |
| AIS-001 | robots.txt status for GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, PerplexityBot, Google-Extended, Applebot-Extended (report, not judge) | A | 2 |
| AIS-002 | AI crawler blocked while user intent says "allow" | D | 3 |
| AIS-003 | llms.txt present and well-formed | A | 1 |
| AIS-004 | Main content only available after JS render | H | 3 |
| AIS-005 | Key facts (price, address, hours) not in text or schema | H | 2 |

**Metadata (META)**

| ID | Check | Type | Impact |
| --- | --- | --- | --- |
| META-001 | Missing title | D | 5 |
| META-002 | Empty title | D | 5 |
| META-003 | Multiple title tags | D | 3 |
| META-004 | Duplicate title across pages | D | 3 |
| META-005 | Title over ~580 px width (pixel, not characters) | H | 1 |
| META-006 | Title under 20 characters | H | 2 |
| META-007 | Title identical to H1 on all template pages | A | 1 |
| META-008 | Missing meta description | H | 2 |
| META-009 | Duplicate meta description | H | 2 |
| META-010 | Description over ~920 px or under 70 characters | H | 1 |
| META-011 | Missing html lang | D | 2 |
| META-012 | lang value invalid or mismatches detected language | H | 2 |
| META-013 | Missing viewport meta | D | 4 |
| META-014 | Viewport disables zoom | D | 2 |
| META-015 | Missing charset or late charset | D | 1 |
| META-016 | Missing Open Graph title/image/url | H | 1 |
| META-017 | og:image unreachable or under 200 px | D | 1 |
| META-018 | Missing Twitter card | A | 1 |
| META-019 | Missing favicon | D | 1 |
| META-020 | Title all caps, or no brand name | H | 2 |
| META-021 | Description is a keyword list or has no call to action | A | 1 |
| META-022 | og:image aspect ratio does not fit the twitter:card type | H | 1 |
| META-023 | Generator meta exposes the CMS and version | D | 1 |

**Headings and content (CNT)**

| ID | Check | Type | Impact |
| --- | --- | --- | --- |
| CNT-001 | Missing H1 | D | 3 |
| CNT-002 | Multiple H1 | H | 1 |
| CNT-003 | Empty heading tag | D | 2 |
| CNT-004 | Skipped heading level | A | 1 |
| CNT-005 | Thin content (under 200 main-content words, configurable) | H | 3 |
| CNT-006 | Exact duplicate content (hash match) | D | 4 |
| CNT-007 | Near-duplicate content (SimHash ≥ 90%) | H | 3 |
| CNT-008 | Boilerplate ratio over 80% | H | 2 |
| CNT-009 | Title and H1 share no meaningful terms | H | 2 |
| CNT-010 | Lorem ipsum or placeholder text | D | 4 |
| CNT-011 | Visible text "404", "not found" on 200 page | H | 4 |
| CNT-012 | Low text-to-HTML ratio | A | 1 |
| CNT-013 | Target keyword absent from title/H1/first 100 words (only when user mapped a keyword) | H | 2 |
| CNT-014 | Two pages mapped to the same keyword (cannibalisation) | H | 3 |
| CNT-015 | Readability grade far above audience setting | A | 1 |
| CNT-016 | Fragmented headings: one phrase split across adjacent heading tags | H | 2 |
| CNT-017 | Two or more H2s before the first H1, or no H1 with multiple H2s | H | 2 |
| CNT-018 | Keyword stuffing: a 2-4 word phrase far above the normal rate, or repeated in bold | H | 3 |
| CNT-019 | Stale content: newest article older than 180 days | H | 2 |
| CNT-020 | Brand name differs across og:site_name, title suffix, logo alt and schema | H | 2 |
| CNT-021 | Same phone or email written in different formats across the page and schema | H | 1 |
| CNT-022 | FAQ questions in bold text instead of headings | H | 2 |
| CNT-023 | Spelling mistakes in navigation labels and headings | A | 1 |

**Links and architecture (LNK)**

| ID | Check | Type | Impact |
| --- | --- | --- | --- |
| LNK-001 | Internal link to 4xx/5xx | D | 4 |
| LNK-002 | Internal link to redirect | D | 2 |
| LNK-003 | Orphan candidate (in sitemap, zero inbound in crawl) | H | 3 |
| LNK-004 | Page deeper than 4 clicks | H | 2 |
| LNK-005 | Only one inbound internal link | H | 2 |
| LNK-006 | Internal links with nofollow | H | 2 |
| LNK-007 | Empty or generic anchor text ("click here") | H | 1 |
| LNK-008 | Over 300 links on a page | A | 1 |
| LNK-009 | Links via JS onclick only (not crawlable) | D | 3 |
| LNK-010 | Broken external link | D | 1 |
| LNK-011 | Internal link uses http on https site | D | 2 |
| LNK-012 | Low internal PageRank for high-value page | H | 3 |
| LNK-013 | Pagination without crawlable next links | H | 2 |
| LNK-014 | Faceted URLs creating crawl traps (over N parameter combos) | H | 3 |
| LNK-015 | Navigation bloat: over 60 nav links, or the same nav rendered 2+ times | H | 2 |
| LNK-016 | CTA mismatch: conversion link text points to the homepage or a non-matching page | H | 3 |
| LNK-017 | Inconsistent internal URLs for the same destination | H | 2 |

**Internationalisation (I18N)**

| ID | Check | Type | Impact |
| --- | --- | --- | --- |
| I18N-001 | hreflang target non-200 | D | 3 |
| I18N-002 | Missing return (reciprocal) hreflang | D | 3 |
| I18N-003 | Invalid language or region code | D | 3 |
| I18N-004 | Missing self-referencing hreflang | D | 2 |
| I18N-005 | Missing x-default | A | 1 |
| I18N-006 | hreflang points to non-canonical URL | D | 3 |
| I18N-007 | Mixed-language site without language handling | H | 3 |
| I18N-008 | Percent-encoded non-Latin slugs mixed with Latin slugs in one section | H | 2 |

**Images and media (IMG)**

| ID | Check | Type | Impact |
| --- | --- | --- | --- |
| IMG-001 | Missing alt attribute | D | 2 |
| IMG-002 | Empty alt on non-decorative image (linked, large, or in main content) | H | 2 |
| IMG-003 | Alt equals filename or is over 125 characters | H | 1 |
| IMG-004 | Broken image (4xx/5xx) | D | 3 |
| IMG-005 | Image over 200 KB | H | 2 |
| IMG-006 | Legacy format where WebP/AVIF would save over 30% | H | 1 |
| IMG-007 | Missing width/height (CLS risk) — grouped per template | D | 1 |
| IMG-008 | Intrinsic size over 2× displayed size | H | 2 |
| IMG-009 | LCP image lazy-loaded | D | 3 |
| IMG-010 | No srcset on large responsive images | A | 1 |
| IMG-011 | Video without poster or structured data | A | 1 |

**Structured data (SD)**

| ID | Check | Type | Impact |
| --- | --- | --- | --- |
| SD-001 | JSON-LD parse error | D | 3 |
| SD-002 | Unknown schema.org type or property | D | 2 |
| SD-003 | Required property missing for Google-supported type | D | 3 |
| SD-004 | Recommended property missing | H | 1 |
| SD-005 | Duplicate conflicting blocks of same type | H | 2 |
| SD-006 | Markup content not visible on page (e.g. review rating) | H | 3 |
| SD-007 | Organization/LocalBusiness missing on homepage | A | 1 |
| SD-008 | BreadcrumbList missing on deep pages | A | 1 |
| SD-009 | Product without offers/price | D | 3 |
| SD-010 | Deprecated type used (e.g. HowTo, FAQ for non-eligible sites) | A | 1 |
| SD-011 | Self-serving AggregateRating or Review on Organization or LocalBusiness | H | 3 |

**Performance and UX (PERF) — lab data labelled "lab", CrUX labelled "field"**

| ID | Check | Type | Impact |
| --- | --- | --- | --- |
| PERF-001 | LCP over 2.5 s (field, else lab) | D | 3 |
| PERF-002 | INP over 200 ms (field only) | D | 3 |
| PERF-003 | CLS over 0.1 | D | 3 |
| PERF-004 | TTFB over 800 ms | D | 2 |
| PERF-005 | Render-blocking CSS/JS | H | 2 |
| PERF-006 | HTML over 500 KB | H | 2 |
| PERF-007 | Total page weight over 3 MB | H | 2 |
| PERF-008 | No text compression (gzip/br) | D | 2 |
| PERF-009 | No caching headers on static assets | D | 1 |
| PERF-010 | Excessive DOM size (over 1,500 nodes) | H | 1 |
| PERF-011 | Third-party JS over 50% of script bytes | A | 1 |

**Security and protocol (SEC)**

| ID | Check | Type | Impact |
| --- | --- | --- | --- |
| SEC-001 | Page served over HTTP | D | 4 |
| SEC-002 | Mixed content (http resources on https page) | D | 3 |
| SEC-003 | TLS certificate expired or expiring within 21 days | D | 5 |
| SEC-004 | Missing HSTS | H | 1 |
| SEC-005 | Missing X-Content-Type-Options / frame protection / CSP | A | 1 |
| SEC-006 | Exposed sensitive paths returning 200 (/.env, /.git) | D | 5 |

**Accessibility (A11Y) — via axe-core on rendered pages**

| ID | Check | Type | Impact |
| --- | --- | --- | --- |
| A11Y-001 | Insufficient colour contrast | D | 1 |
| A11Y-002 | Form inputs without labels | D | 1 |
| A11Y-003 | Buttons/links without accessible name | D | 2 |
| A11Y-004 | Tap targets under 24 px | H | 1 |

**Site-wide patterns (SITE)**

| ID | Check | Type | Impact |
| --- | --- | --- | --- |
| SITE-001 | Issue shared by 90%+ of a template group (one fix) | D | — |
| SITE-002 | Sitemap vs crawl discrepancy summary | D | 3 |
| SITE-003 | Indexable page ratio below 50% | H | 3 |
| SITE-004 | Regression: issue reappeared after resolved | D | — |
| SITE-005 | New URLs since last audit with critical issues | D | — |

SITE rules inherit impact from the underlying rule.

## UI/UX specification

The UI answers three questions in order, in under ten seconds each: How healthy is this site? What should we fix first? Where exactly is the evidence?

### Design system

- **Stack:** Next.js App Router, Tailwind, shadcn/ui (Radix primitives), TanStack Table (virtualised), Recharts or visx for charts, Sigma.js/Graphology for the link graph, Framer Motion for restrained transitions.
- **Type:** Inter for UI, JetBrains Mono for URLs, code and evidence. Scale 12 / 13 / 14 / 16 / 20 / 24 / 32.
- **Colour:** neutral zinc base; one brand accent; semantic severity tokens used only for severity: Critical red, High orange, Medium amber, Low blue, Info grey, Passed green. Full dark mode from day one via CSS variables.
- **Spacing and density:** 4 px grid; a density toggle (comfortable / compact) on every data table.
- **Accessibility:** WCAG 2.2 AA, full keyboard navigation, visible focus rings, severity never conveyed by colour alone (icon + label).
- **Motion:** 150–200 ms ease-out; respects `prefers-reduced-motion`.

### Global patterns

- **⌘K command bar:** jump to any project, audit, URL, rule ID or setting; actions like "Start Standard audit on example.com".
- **Keyboard shortcuts:** `j/k` move through rows, `Enter` open, `e` expand evidence, `x` select, `f` mark fixed, `/` filter, `?` shortcut sheet.
- **Filters as URL state:** every filter, sort and grouping is in the query string, so any view is shareable and back-button safe.
- **Saved views:** e.g. "Critical on /products/*", pinned per project.
- **Right-side drawer:** opening a URL or issue never loses the table context.
- **States:** every screen designs empty, loading (skeletons, not spinners), partial, error and "no permission" states explicitly.

### Core screens

| # | Screen | Purpose | Key elements |
| --- | --- | --- | --- |
| 1 | Projects home | All client sites at a glance | Card per site: health score with trend sparkline, last audit date, critical count, coverage %; sort by "needs attention" |
| 2 | New audit wizard | Start a crawl in under 30 s | URL field with live robots/sitemap detection preview, profile picker, advanced drawer (include/exclude regex, UA, auth, render mode, schedule) |
| 3 | Live crawl monitor | Trust during long crawls | Real-time counters (discovered / crawled / remaining / failed), URLs-per-second chart, streaming URL log, issues appearing as found, pause/resume/cancel |
| 4 | Audit overview | The 10-second answer | Health score with decomposition, coverage funnel (discovered → in scope → crawled → indexable), top 5 issues by priority, category scorecards, change vs last audit |
| 5 | Issues explorer | Decide what to fix | Grouped by rule with affected-URL count and template count; expand to URLs; side drawer with why/fix/acceptance and evidence; bulk assign, mark fixed, ignore with reason |
| 6 | URL explorer | Power table | Every crawled URL, 40+ columns toggleable, column presets (Indexability, Content, Links, Performance), regex filters, CSV/XLSX export |
| 7 | Page inspector | The evidence for one URL | Tabs: Overview, Raw vs Rendered diff, Headers, Head tags, Headings outline, Links in/out, Images, Structured data tree, Performance, Issue history; "Re-check now" button |
| 8 | Site architecture | See structure problems | Crawl-depth histogram, directory treemap coloured by issue density, interactive link graph (clustered, max 5k nodes), internal PageRank leaderboard |
| 9 | Content | Duplication and quality | Duplicate and near-duplicate clusters, thin pages list, title/description duplicate groups, keyword mapping table (user-provided) |
| 10 | Compare audits | Prove progress | Side-by-side health and counts, new / resolved / regressed lists, coverage warning when scopes differ |
| 11 | Fix board | Turn findings into work | Kanban (To do / In progress / Ready to verify / Verified), one card per issue group; export to Jira, Linear, Trello, CSV; "Verify" triggers targeted re-crawl |
| 12 | Reports | Client delivery | White-label PDF and live share link, logo and colours per client, executive summary page, sections toggleable, scheduled email delivery |

### Interaction details

- Issue rows show an "affected by template" chip: *612 URLs · 1 template* — one click opens the template's sample URL and DOM selector.
- Evidence blocks highlight the exact offending line in the HTML with line numbers and a copy button.
- Every rule drawer links "Show me a passing example on this site" when one exists.
- Numbers animate only on first load; never re-animate on filter changes.
- Long operations (export, re-check) run in the background with a toast and a notification centre entry.
- First-run onboarding: start an audit on the user's own site in one field, show the live monitor, then a 4-step tour of the overview.

## Reporting, integrations and collaboration

The report is the product clients actually see, so it carries the same evidence and honesty as the app, in plain language.

**Report structure (PDF and live link share the same source)**

1. Cover: client logo, domain, audit date, profile used.
2. Executive summary: health score with its basis, coverage statement ("1,184 of 1,206 discovered URLs inspected; 22 blocked by robots.txt"), top 5 priorities in plain English, change since last audit.
3. Coverage and limitations: what ran, what did not, and why.
4. Priority issues: one page per issue group with why it matters, affected count, sample URLs, evidence, fix and acceptance criteria.
5. Category sections, site architecture visuals, content duplication clusters.
6. Appendix: full affected-URL lists (CSV attached for anything over 50 rows), rule versions, glossary.

Optional AI-written summary is clearly labelled, generated only from stored findings, and never adds facts not in the data.

**Integrations (phased)**

| Integration | What it adds | Phase |
| --- | --- | --- |
| PageSpeed Insights API + CrUX API | Lab and field Core Web Vitals | 5 |
| Google Search Console (OAuth) | Clicks, impressions, queries per URL; indexed pages list as discovery source; sort issues by traffic impact | 6 |
| GSC URL Inspection API | Google's indexed canonical vs declared canonical, last crawl date (quota ~2,000/day/property, so sampled) | 6 |
| GA4 | Sessions per landing page for prioritisation | 6 |
| Jira, Linear, Trello, Asana | Push issue groups as tickets with evidence links | 6 |
| Slack / email / webhook | Scheduled audit summaries, regression alerts | 6 |
| Server log upload | Real Googlebot hits vs crawl: wasted crawl budget, never-crawled pages | 6 (optional) |
| Backlink provider (DataForSEO or similar) | Referring domains per URL, broken backlinks | Post-launch |
| RankPilot | Shared projects; rank drops linked to audit regressions | Post-launch |

**Collaboration and accounts**

- Workspaces with roles: Owner, Admin, Analyst, Developer (sees fix board and evidence only), Client viewer (report link only).
- Comments and @mentions on issue groups; audit log of who marked what as fixed or ignored.
- Scheduled audits (daily, weekly, monthly) with regression diffing and alerts.
- Public read-only share links with optional password and expiry.
- Usage metering per workspace (URLs crawled per month) to support paid plans later.
- Public hero form: Quick profile only, rate-limited to 5 audits per IP per hour (stored in Redis).

## Roadmap and gates

Six phases over about 14 weeks, assuming one developer working full-time with an AI coding agent; no phase starts until the previous gate passes in CI.

| Phase | Weeks | Gate |
| --- | --- | --- |
| P1 · Crawler + coverage | 1–2 | 100% of fixture URLs found; resume after crash; SSRF safe |
| P2 · Snapshots + rules | 3–5 | All rules hit their fixtures; zero findings on /clean/ |
| P3 · Priority + reports | 6–7 | Report counts = DB counts; Verify resolves only re-checked URLs |
| P4 · UI/UX rebuild | 8–10 | Accessibility 95+, fast 50k-row tables, full E2E journey passes — **client-ready v1 ships here** |
| P5 · Rendering + speed | 11–12 | JS-only pages detected; lab never labelled as field |
| P6 · Integrations | 13–14 | GSC data per URL; regression alerts delivered |

Phases 5 and 6 can ship as v1.1 and v1.2. Week estimates are planning assumptions: re-estimate after Phase 1.

## Phase task lists

### Phase 1 — Baseline and crawler

1. Map current crawler, parser, rule registry, persistence and report code in `docs/ARCHITECTURE-CURRENT.md`. Replace hardcoded caps with the profiles above, from one shared config.
2. Discovery: robots.txt Sitemap lines, sitemap.xml, sitemap indexes (recursive, gzip), BFS link crawl. Tag each URL with discovery source(s).
3. URL normalisation per "Crawler engine", with unit tests for 30+ edge cases.
4. Persist frontier and URL states in Postgres (`crawls`, `crawl_urls`, `url_edges`). Every URL ends in exactly one terminal state with a reason. At-most-once claiming.
5. BullMQ + Redis job queue and a worker process separate from the web app. Batches of 200, checkpointing, pause/resume/cancel. Legacy engine stays behind `CRAWLER_V2=false` until the gate passes.
6. Politeness per "Crawler engine".
7. SSRF protection with DNS-stub tests.
8. Profiles, shared config, Redis-backed hero rate limit.

Gate: against the fixture site, Standard discovers 100% of fixture URLs including sitemap-only and depth-8 pages; a killed worker resumes with no duplicate fetches; all SSRF tests pass; 1,000 URLs crawl in under 6 minutes at default politeness on localhost.

### Phase 2 — Page snapshots and rule engine

1. PageSnapshot: requested/final URL, status, redirect chain, headers, raw HTML (compressed in object storage), head tags, canonical(s), robots (meta + header), title, description, H1–H6 outline, main-content text, word count, language, links (href, anchor, rel, location), images (src, alt, dims, loading, srcset), JSON-LD (raw + parsed + errors), content hash + SimHash, template fingerprint, timings.
2. Rule interface exactly as above; pure functions; no network.
3. Implement IDX, AIS, META, CNT (except keyword rules), LNK, I18N, IMG (except size/format), SD and SEC-001/002/006.
4. Site-level pass: duplicates, near-duplicate clusters, inbound counts, depth, internal PageRank (20 iterations, damping 0.85), orphans, sitemap vs crawl diff, hreflang reciprocity. Stream from Postgres in batches of 500; never hold all snapshots in memory.
5. Findings store rule id, rule version, URL, evidence and confidence.

Gate: each rule fires on its positive fixture and is silent on its negative; zero findings on /clean/; under 50 ms per page for all rules.

### Phase 3 — Prioritisation, grouping, history and reports

1. Priority = Impact × Reach × Confidence; store inputs.
2. Group by rule, then template fingerprint.
3. Stable fingerprints: hash(rule_id, normalised URL, evidence key); cross-audit states as above.
4. Health score over checks that ran; greyed under 50% coverage.
5. Report generator (HTML → PDF via Playwright), white-label, share links.
6. Fix verification: re-crawl only affected URLs.
7. Move the remaining JSON store to Postgres.

Gate: after the fixture "fix patch", exact expected resolved count and zero false resolutions; report numbers equal database counts.

### Phase 4 — UI/UX rebuild

Design tokens, screens in order (Overview, Issues, Page inspector, URL explorer, Live monitor, Wizard, Projects, Architecture, Content, Compare, Fix board, Reports), virtualised tables, ⌘K, shortcuts, drawers, states, WCAG 2.2 AA with axe in CI.

Gate: Lighthouse accessibility ≥ 95 and performance ≥ 90 on Overview and Issues; 50,000-finding filter under 200 ms; Playwright E2E for start → monitor → triage → export → verify.

### Phase 5 — Rendering, performance and accessibility

Playwright render pool (max 4 browsers, recycled every 100 pages, 20 s budget, ads/analytics blocked); render modes off / sampled / full; raw vs rendered diff; IDX-018, AIS-004, LNK-009, A11Y rules; PageSpeed (lab) and CrUX (field) with quotas; remaining PERF and IMG rules.

Gate: JS-only fixture pages detected; diff visible in Page inspector; no lab metric labelled as field.

### Phase 6 — Integrations and scheduling

Google OAuth (least scopes) for GSC and GA4; GSC data as columns and discovery source; sampled URL Inspection; scheduled audits with email/Slack/webhook regression alerts; Jira/Linear/Trello push with status sync; optional log upload with reverse-DNS Googlebot verification.

Gate: connected test property shows traffic per URL; scheduled audit sends a correct regression alert; tickets round-trip status.

## Test fixture site and definition of done

A purpose-built fixture site of about 1,200 URLs is the referee: no rule is "working" unless the fixture proves it. Build it under `/fixtures/site`, served locally on a `.test` host, with a manifest of every expected finding.

| Path | Pages | Contains |
| --- | --- | --- |
| `/clean/` | 100 | Perfect pages; must produce zero findings |
| `/meta/` | 60 | Missing, empty, duplicate, multiple and over-long titles and descriptions |
| `/index/` | 80 | noindex (meta and header), conflicting directives, canonical to 404, canonical chains, canonical in body, soft 404s |
| `/redirects/` | 40 | 301, 302, chains of 2–6, loops, meta-refresh, JS redirects |
| `/links/` | 120 | Broken internal links, links to redirects, nofollow internal links, onclick-only links, generic anchors |
| `/deep/` | 50 | Chain reaching depth 12 |
| `/orphans/` | 30 | In sitemap only, no inbound links |
| `/content/` | 150 | Thin pages, exact duplicates, near-duplicates (85–98% similar), lorem ipsum, "not found" text on 200 |
| `/images/` | 60 | Missing/empty/filename alt, broken src, 2 MB PNG, lazy LCP image, missing dimensions |
| `/schema/` | 60 | Malformed JSON-LD, missing required props, invisible review markup, valid Product/Article/LocalBusiness |
| `/intl/` | 40 | hreflang with missing returns, bad codes, non-canonical targets |
| `/js/` | 40 | Content, links, canonical and title injected only by JavaScript |
| `/products/` | 300 | One template with a shared defect plus a faceted URL trap |
| `/security/` | 20 | Mixed content, http-only page, exposed `/.env` returning 200 |
| `/slow/` | 10 | 4 s TTFB, 429 responses, Retry-After headers |
| `/ssrf/` | 10 | Redirects to 127.0.0.1, 169.254.169.254 and private ranges (must be refused) |

Also: a robots.txt blocking one section and GPTBot, a sitemap index with gzipped child sitemaps, one sitemap listing noindexed URLs, and a "fix patch" that corrects a known subset for Phase 3 verification.

**Quality targets**

| Metric | Target |
| --- | --- |
| Expected findings detected on fixture | 100% |
| Findings on `/clean/` | 0 |
| Report counts vs database counts | Exact match |
| Crawl throughput, localhost, default politeness | ≥ 3 URLs/s |
| Rule evaluation per page (all rules) | < 50 ms average |
| Worker crash recovery | Resume with zero duplicate fetches |
| Issues explorer filter on 50k findings | < 200 ms |
| Lighthouse accessibility on app screens | ≥ 95 |
| Unit + integration test coverage on crawler and rules | ≥ 85% lines |

**Definition of done for v1**

- [ ] Full-site crawl of a real site (your own) completes with every discovered URL in a named state and the report states coverage honestly
- [ ] All Phase 1–3 gates pass in CI on every pull request
- [ ] Every catalog rule implemented so far has positive and negative fixtures
- [ ] A client-ready white-label PDF and share link generate from a real audit
- [ ] Fix → Verify loop resolves only what was actually re-checked
- [ ] UI passes Phase 4 gate, including dark mode and keyboard-only journey
- [ ] Engineering report lists what is not done, with no unverified claims

## AI analysis

Opt-in per project (`Site.aiAnalysis`), off by default. After the rules finish, a queue job (`src/lib/ai`) sends stored data
only to the provider `AI_PROVIDER` names (`gemini`, the default, with `GEMINI_API_KEY`, or `anthropic` with `ANTHROPIC_API_KEY`; model `AI_ANALYSIS_MODEL`, default `gemini-flash-latest` or `claude-sonnet-5-5`), under one validator: the coverage summary,
the top issue groups with evidence, and for the homepage plus one sample page per top-10 template the title, description,
headings outline, trimmed main text, nav link count and OG tags. The site is never fetched for it.

- **Output:** strict JSON, validated with Zod: `executiveSummary` (strengths, weaknesses), `qualityIssues[]`, `rewrites[]`,
  `strategy[]`, `actionPlan` (`thisWeek[]`, `thisQuarter[]`). Character counts on rewrites are computed by code.
- **Grounding:** every item must cite a finding ID of this crawl, or a URL plus a quote of 25 words or fewer found in that
  URL's stored text. A validator drops other citations, items left uncited, items quoting words not in stored text, and
  items claiming anything about rankings, traffic or Google penalties, and logs the counts (`ai.grounded`).
- **Cost:** at most `AI_MAX_INPUT_TOKENS` per audit, by the API's own count; text is shortened and pages dropped to fit, and
  if the input still does not fit nothing is sent. A finished analysis is cached by audit ID.
- **Labelling:** shown as "AI analysis" in the UI and the report.

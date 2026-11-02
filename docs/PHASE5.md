# Phase 5: rendering, performance and accessibility: what is built and what is not

docs/SPEC.md Phase 5 asks for a Playwright render pool, the render modes off / sampled / full, a raw vs rendered
diff, IDX-018, AIS-004, LNK-009, the A11Y rules, PageSpeed (lab) and CrUX (field) with quotas, and the remaining PERF
and IMG rules. Its gate is: "JS-only fixture pages detected; diff visible in Page inspector; no lab metric labelled
as field."

| Spec item | Status | Gate |
| --- | --- | --- |
| Render pool: max 4 browsers, recycled every 100 pages, 20 s budget, ads/analytics blocked | Built (`src/lib/render/pool.ts`) | `npm run test:int`, `npm run gate:p5` |
| Render modes per profile (Quick off, Standard sampled, Full-site sampled or full, Custom any) | Built (`src/lib/crawl/profiles.ts`) | unit + route tests, `gate:p5` |
| Raw vs rendered diff in the Page inspector | Built ("Raw vs rendered" tab, lazy-loaded) | `gate:p5` (in Chromium against `next start`) |
| IDX-018, AIS-004, LNK-009, IMG-009, PERF-001/003/007/009/011, A11Y-001..004 | Built (`src/lib/rules/rendered.ts`) | `gate:p5` (exact manifest) |
| PERF-004/005/006/008/010 (from the response as served, no browser) | Built (`src/lib/rules/perf.ts`) | unit tests |
| PageSpeed Insights (lab) and CrUX (field) with quotas | **Not built**: needs a Google API key | Not passed |
| PERF-002 (INP) | **Not built**: INP is field data only (CrUX) | Not passed |
| Crawling links found only in the rendered DOM (SPEC "Discovery" item 2) | **Not built**: reported, not crawled (below) | n/a |

No stub or mock stands in for anything marked not built.

## How rendering runs

- The crawl ends, then the crawl worker hands an audit with a render mode to the render queue
  (`RENDER_QUEUE_NAME`). The render worker runs in the crawl worker's process unless `RENDER_WORKER=off`; then
  `npm run worker:render` runs it on its own. It renders the planned pages, stores each rendered DOM next to the raw
  HTML, and enqueues analysis. Analysis waits for the render phase.
- **Sampled** renders one page per template fingerprint (the shortest URL, then code-point order) plus the start
  URL. **Full** renders every HTML page that answered 200.
- Every browser request goes through the same SSRF-guarded fetcher as the crawl, with the crawl's robots.txt and
  per-host throttle for the site's own host. Service workers are blocked and WebSockets are closed. Ads and
  analytics hosts (`src/lib/render/blocklist.ts`) are aborted and logged as blocked.
- Rules marked `needs: ["rendered"]` judge only pages with a successful render. With rendering off they report
  `needs_config` ("Rendering is off for this audit"). If the render phase failed they report an error. A page that
  timed out has no rendered findings, and the inspector says why.

## Lab, never field

Every metric comes from one load in headless Chromium: 412 × 915 viewport, no CPU or network throttling. Stored
metrics carry `source: "lab"`, as does the evidence of IMG-009, PERF-001, PERF-003 and PERF-007. PERF-001 and
PERF-003 also carry `field: null`. The inspector tags the metrics "Lab". Field data (CrUX) is not built, so nothing
is labelled field. `gate:p5` checks all of this, in the database and in the browser.

Unthrottled lab LCP and CLS are lower than real devices see. A page under the 2,500 ms LCP threshold here can still
fail in the field.

## Links found only after JavaScript

SPEC "Discovery" item 2 includes "links found only in rendered DOM (Phase 5)". They are **reported, not crawled**:

- The inspector lists them under "Links that exist only after JavaScript" ("reported here, not crawled").
- LNK-009 reports elements that navigate only through an inline `onclick`, and `<a>` elements without `href`.
- `gate:p5` checks that such a link (`/js/hidden` in the render fixture) gets no URL row and no request.

Why: the render phase runs after the crawl, so a newly found URL would need a second crawl pass, then a render, then
analysis. Two options are open, and the choice is the product owner's:

1. **Second pass.** After rendering, enqueue rendered-only links in scope as new crawl URLs (`discovered_via`
   `rendered`), crawl them, render them in the same mode, and analyse once at the end. This is the most complete
   option. The cost is a longer audit and a crawl/render loop that needs a depth and budget cap.
2. **Report only (current).** Keep them as evidence, and let the user add them as seeds, or crawl with full rendering
   once rendered discovery exists. Simple and bounded, but pages reachable only through JavaScript are missing from
   the audit.

## Gate

`npm run build && npm run gate:p5` (Postgres and Redis from `docker compose up -d postgres redis`, Chromium from
`npx playwright install chromium`). It uses its own fixture, `fixtures/render/site.ts`, on `render.test`, with
`widgets.test` as a third-party script host. The main fixture's `/js/` pages are server-rendered with
JavaScript-only index links, and the Phase 1–4 and 6 manifests depend on that HTML. The render fixture has:

- `/js/`: 40 pages whose title, content, links and canonical exist only after JavaScript.
- A lazy LCP image delayed 4 s, inline-onclick and href-less links, and a layout shift.
- A page over 3 MB, an uncached stylesheet, and a mostly third-party script load.
- A page with the four accessibility defects, and clean pages.

The gate checks:

1. With full rendering, the rendered rules' findings equal the fixture manifest on every URL.
2. All 40 JavaScript-only pages are detected.
3. Rendered-only links get no URL row and no request.
4. No metric or finding is labelled field.
5. Sampled rendering renders one page per template plus the start URL.
6. In the production app, the inspector shows the before/after table, the Lab tag, the rendered-only links and the HTML
   diff.
7. The worker's Node process stays under 700 MB RSS. Chromium's processes are separate and are not counted.

## Known limits

- The third-party test is a host comparison (`www.` stripped, subdomains first-party). There is no public-suffix
  list, so `a.example.co.uk` and `b.example.co.uk` count as different parties.
- Blocked ads and analytics are not counted in page weight (PERF-007) or the third-party share (PERF-011). Both
  are therefore lower bounds, and the evidence says so.
- Fix verification crawls do not render. A rendered rule's group cannot be verified fixed by "Verify fix" (the rule
  reports needs_config there); the next rendered audit shows whether it is fixed. Across audits, a rendered rule's
  finding counts as rechecked only on pages that audit rendered, so pages outside a sample stay "not rechecked".

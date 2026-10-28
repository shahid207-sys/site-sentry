# Crawler v2 URL states

Source of truth: `docs/SPEC.md` → "Crawler engine → URL states". This file records how crawler v2 implements them
(`src/lib/crawl/v2/types.ts`, `src/lib/crawl/v2/frontier.ts`, table `crawl_urls`).

## Invariants

- Every row in `crawl_urls` is in exactly one state, enforced by the `crawl_urls_state_ck` check constraint.
- Terminal states always carry a `reason` and active states never do (`crawl_urls_reason_ck`).
- When a crawl finishes (completed or cancelled), `finalizeUrls` gives every remaining active row a terminal state,
  so no row is left `discovered`, `queued` or `fetching`.
- A URL is requested at most once per crawl (see "At-most-once" below). The only exception is a deliberate retry
  after 429/503, which reuses the same claim and is counted in `attempts` (`recordRetry`).

## Active states

| State | Meaning |
|---|---|
| `discovered` | Known and eligible for the frontier. |
| `queued` | Reserved by a worker under a lease; no request has been sent. Not in the spec's list; added because it separates "claimed" from "sent". |
| `fetching` | The budget is charged and the request may have been sent. Not in the spec's list; added for the same reason. |

## Terminal states

| State | Set by | Reason example |
|---|---|---|
| `fetched` | worker, after a 2xx/4xx/5xx HTML response | `HTTP 200` |
| `analysed` | Phase 2 rule pass (unused in P1) | — |
| `redirected` | worker, on a 3xx; the target is inserted with via `redirect` | `301 → https://…` |
| `blocked_robots` | discovery, before fetch | `Disallow: /private/ (User-agent: *)` |
| `out_of_scope` | discovery (other host, subfolder or Custom include/exclude) | `Different host: cdn.example.com` |
| `excluded_by_rule` | discovery (normalisation rejected the reference) | `credentials in URL` |
| `budget_exhausted` | `finalizeUrls` at completion | `The crawl's URL budget of 1000 was used up …` |
| `depth_exceeded` | `finalizeUrls` at completion | `Found only through links 11 clicks from the start URL; …` |
| `failed_timeout` / `failed_dns` / `failed_tls` | worker | error code and message |
| `failed_network` | worker, other connection errors (reset, refused, SSRF block at a redirect hop) | error code and message. Not in the spec's list; added so no network failure is filed under the wrong cause. |
| `non_html` / `oversized` | worker | content type, or bytes read against the cap |
| `interrupted` | `sweep`, when a `fetching` lease expires | the request may have gone out but no result was saved; it is not re-requested. Not in the spec's list; added so a killed worker never triggers a second fetch. |
| `cancelled` | `finalizeUrls` on cancel, or when the run fails with an error | `The crawl was cancelled before this URL was fetched.` / `The crawl stopped with an error …` |

## At-most-once

1. `reserve` claims up to N `discovered` rows with `FOR UPDATE SKIP LOCKED` in BFS order (depth ascending, sitemap-only
   URLs last) and moves them to `queued` with a lease. When a reservation expires, the row goes back to `discovered`,
   which is safe because nothing was sent.
2. `commitToSend` runs immediately before each request, in one transaction: it charges `crawls.fetches_committed`
   against the budget and moves the row to `fetching` with a fresh claim token. `reserve` never selects a `fetching` row.
3. `recordResult` runs in one transaction. It writes the page snapshot, the outgoing edges, the newly discovered URLs
   and the terminal state, all conditional on the claim token. If the token does not match, everything rolls back
   (`ClaimLostError`).
4. `sweep` runs at worker boot. It returns expired `queued` rows to `discovered` and moves expired `fetching` rows to
   `interrupted`.
5. `commitToSend` also refuses unless `crawls.status = 'running'`, so pause and cancel take effect before the next
   request, not at the end of a batch.

### One runner per crawl

`runCrawl` holds a Postgres session advisory lock keyed on the crawl ID, on a dedicated connection, for the whole run.
A second runner for the same crawl gets `locked` and exits. The lock dies with the process, so the next runner to get
it knows the previous one is gone. It then **force-sweeps** that crawl straight away, without waiting for leases:
reservations go back to `discovered` and committed requests become `interrupted`.

### Consequence of `interrupted`

An interrupted page is never parsed, so its links are never read. A page that is reachable only through an
interrupted page stays undiscovered. This is the price of at-most-once. Pages listed in a sitemap are unaffected.
The worker kill test (`src/worker/crawl-worker.int.test.ts`) asserts exactly this: every known URL was committed once
and ended `fetched` or `interrupted`.

### robots.txt and sitemaps

- robots.txt: `crawls.robots` is written with `started: true` before the request and completed afterwards. 2xx → parsed;
  4xx → allow all; 5xx or unreachable → full disallow (RFC 9309 §2.3.1.3–4). If a worker dies during this one request,
  the next run requests robots.txt again and flags the record `refetchedAfterInterrupt` (a known exception).
- Sitemaps: `crawls.sitemaps` is an append-only log. It holds a `{started: url}` marker before each request, then the
  finished document record. Index records keep their children, and a urlset record is written only after its URLs.
  A resumed discovery replays finished documents from the log, and reports a document that was started but not
  finished as `INTERRUPTED` without requesting it again.

BullMQ jobs only carry `{ crawlId }` as a trigger. The state above lives in Postgres, so a redelivered job can never
cause a second fetch.

## Depth and eligibility

- `depth` is the minimum link depth from a seed. It is null when only sitemaps found the URL. Merging takes `LEAST`.
- `discovered_via` is the sorted union of every source that found the URL.
- A child's depth is its parent's depth + 1. A page found only through sitemaps (null depth) counts as depth 0 for
  its children, so sitemap-only pages cannot carry links past the depth limit. A redirect target keeps the source's
  depth (a redirect is not a click), with `redirect_hops` + 1. Beyond 10 hops the target is `excluded_by_rule`.
- A row is eligible when its depth is within the profile's maximum, or a seed or sitemap lists it. Rows that are left
  over and beyond the depth limit end as `depth_exceeded`, and all other leftovers as `budget_exhausted`.
- Sitemap-only rows wait: `reserve` claims a null-depth row only when no eligible row with a known link depth is still
  `discovered`. Otherwise one large batch of sitemap pages, fetched before the start page's links are recorded, would
  give their children depth 1 and `LEAST` would keep that wrong depth. The cost: lanes idle while the last link-depth
  rows are in flight, before the first sitemap-only batch can be claimed (not measured separately).
- Depth is still not exact. A sitemap-only page counts as depth 0 for its children, so one fetched after the
  link crawl can lower the depth of a page that links also reach. Click-depth rules (Phase 2) must allow for this.

## Politeness

Code: `src/lib/crawl/v2/politeness.ts` (throttle), `src/lib/crawl/v2/runner.ts` (where it is applied). Spec values:

| Limit | Value | Where |
| --- | --- | --- |
| Requests in flight per host | 3 (`CRAWLER_HOST_CONCURRENCY`) | `HostThrottle.max`; the runner runs that many lanes |
| Request rate per host | 5 req/s (`CRAWLER_HOST_RATE`) | minimum gap between request starts |
| Crawl-delay | from the robots.txt group that applies to `SiteSentryBot` (else `*`), capped at 60 s | the gap becomes `max(1 / rate, Crawl-delay)` |
| User-agent | `SiteSentryBot/1.0 (+https://sitesentry.app/bot)` | `V2_USER_AGENT` |
| Timeouts | 10 s connect, 30 s total | `CONNECT_TIMEOUT_MS` on the agent, `V2_TOTAL_TIMEOUT_MS` per request |
| HTML size | 5 MB; larger pages end `oversized` | `V2_MAX_HTML_BYTES` |

Every request a crawl makes goes through the host throttle: robots.txt, sitemaps and pages. A lane takes a slot
*before* `commitToSend`, so a committed URL is never left waiting out a backoff unsent. There is one throttle per
host per worker process, shared by all crawls of that host on that worker. It is not shared across worker
processes (see known risks).

**Adaptive throttle.** A 429, a 503, or a p95 response time over 3 s across the last 20 responses each:

- halve the host's concurrency (minimum 1);
- pause the host. With `Retry-After`, the pause is exactly that long (at least 1 s). Without it, the pause is an
  exponential backoff: 1 s, 2 s, 4 s … 60 s.

These choices are not in the spec:

- The pause is capped at 60 s. A `Retry-After` of hours does not stall the crawl.
- Each normal response halves the backoff. A short burst of 429s does not leave the host on a long pause.
- Concurrency recovers additively: up by 1 after 20 consecutive responses that are neither throttled nor slow.

Timing on the gate run, simulated with this throttle (3 lanes, 5 req/s, 1,000 URLs with the 10 `/slow/` pages
adjacent):

| `/slow/` behaviour | Simulated total |
| --- | --- |
| No slow pages | 200 s |
| 4 s TTFB on all 10, five answer 429 once (`Retry-After: 1`), one answers 503 (`Retry-After: 3600`) | ~297 s |

A server that keeps answering 429 costs more than that, and correctly so. Persistent `Retry-After: 30` on all 10
pages simulates to ~1,100 s.

**Retries.** A 429/503 page is requested again after the pause, at most 2 more times (`MAX_THROTTLE_RETRIES`),
under the same claim. Each extra request is counted in `crawl_urls.attempts` (`recordRetry`), but the budget is
charged only once. A page that still answers 429/503 ends `fetched` with the status and a reason such as
`HTTP 429 after 3 requests`. If `Retry-After` asks for more than 60 s, the request is not retried, and the reason
says so.

The server refused those requests, so retrying them does not break at-most-once. A request that may have reached
the server and was then lost is never retried: the URL ends `interrupted`.

**Failures** map to terminal states by error code:

| Error | Terminal state |
| --- | --- |
| `TIMEOUT` (including undici connect, headers or body timeouts) | `failed_timeout` |
| `DNS_FAILED` | `failed_dns` |
| `TLS` (Node/OpenSSL `CERT_*`, `ERR_TLS_*`, `ERR_SSL_*`, self-signed or unverifiable chains) | `failed_tls` |
| anything else | `failed_network` |

## Profiles

Defined once in `src/lib/crawl/profiles.ts` and read by the API, the New audit form, the add-site form, the homepage
form and the methodology page.

| Profile | Budget | Depth | Set per audit |
|---|---|---|---|
| Quick | 25 | 3 | nothing |
| Standard | 1,000 | 10 | nothing |
| Full-site | 50,000 by default | unlimited | budget (1 to 1,000,000) |
| Custom | 1,000 by default | 10 by default | budget, depth (0 to 100 or unlimited), include/exclude regex, subfolder, basic auth |

- Scope checks run in this order: subfolder (`out_of_scope`), exclude rules, then include rules (both `excluded_by_rule`).
  Rules are case-sensitive and tested against the normalised URL. The reason quotes the rule that matched.
- Basic auth is sent only to the crawl's own origin, never across a redirect to another origin. The password is encrypted
  with AES-256-GCM under `CRAWLER_SECRET_KEY`, bound to the crawl id as associated data, before the crawl row is written.
  The audit stores only the username. Without the key, the API refuses basic auth before creating the audit.
- The homepage form (`POST /api/live/audits/quick`) always runs Quick and allows 5 audits per client IP per hour. The
  window is a Redis sorted set (`rl:hero-audit:<ws>:<ip>`); denied attempts are not counted. If Redis is unreachable the
  in-process limiter takes over and the fallback is logged.
- With `CRAWLER_V2=false`, the in-request engine cannot run the larger profiles. Budget and depth are clamped to
  100 URLs and 3 clicks and the audit gets an `engine_limit` coverage note naming both. It ends `partial` only if the
  clamp cut something (a `page_limit` or `depth_limit` note also fired); a site covered completely stays `completed`. Scope
  rules and basic auth are refused while v2 is off.

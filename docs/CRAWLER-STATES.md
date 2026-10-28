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

- While the crawl runs, `depth` is the frontier depth: the minimum depth from a seed over every reference, null
  when only sitemaps found the URL. Merging takes `LEAST`. It orders claims and enforces the depth limit.
- When the crawl ends (completed, cancelled or failed), `finalizeUrls` replaces it with the **final click depth**,
  computed by one breadth-first pass over `url_edges` from the seeds: an `<a>`/`<area>` link (via `link`) is one
  click, a redirect hop is zero, and canonical, hreflang, alternate, pagination `<link>` and iframe references are not
  clicks. A URL that no link path from a seed reaches gets `depth = null` ("not linked from the start URL"), which
  includes sitemap-only pages and pages linked only from them. `depth_exceeded` reasons are rewritten from the final
  depth, which is never lower than the frontier depth.
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
- During the crawl, the frontier depth can still be too low (a sitemap-only page fetched after the link crawl counts
  as depth 0 for its children). The final click depth corrects this; reports and rules read only the final value.

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
*before* `commitToSend`, so a committed URL is never left waiting out a backoff unsent.

**Shared across workers.** The throttle state for a host lives in Redis (`crawl:host:{host}:state`, `:slots`,
`:latency`, `:crawls`; prefix `CRAWLER_THROTTLE_PREFIX`), and every decision is one atomic Lua script. Every crawl of the host
in every worker process draws from the same 3 slots, the same rate spacing, the same backoff and the same
Crawl-delay. Details:

- A slot is a lease scored by its expiry (60 s, above the 30 s request timeout). A slot held by a killed worker
  comes back when its lease expires.
- Time comes from Redis (`TIME`), so clock skew between worker machines cannot shorten the spacing.
- A lane waiting on a full host is woken at once by a release in its own process. Slots freed by another process
  are noticed by polling every 50 ms. There is no fairness between processes; a waiting worker gets a slot only when it
  polls at a moment one is free.
- While Redis is unreachable, throttle calls wait for it (`maxRetriesPerRequest: null`), so requests stop. The crawl
  never runs unthrottled.
- **Pruning.** A run adds its crawl ID to `:crawls` when it starts and removes it when it stops (completed,
  cancelled, failed, paused or shut down). If no other crawl is listed and no slot is held, the host's keys are
  deleted. If the host is still on a pause or spacing (backoff, `Retry-After`, Crawl-delay), the keys are instead set
  to expire exactly when it ends, so a crawl that starts right after does not skip it. Another crawl still running on
  the host keeps the state.
- **TTL.** Every write refreshes a 1 h idle TTL on all four keys (`DEFAULT_STATE_TTL_MS`). State left by a worker that
  was killed before it could detach disappears on its own. A crawl paused for over an hour starts its host from fresh
  state, and robots.txt is read again on every run, so Crawl-delay is restored.
- `HostThrottle.events` (the in-process log of slow-downs) keeps the last 100.
- The rate spacing applies to slot grants. Each request is sent after one Postgres commit, so gaps observed at the
  server vary by that commit's latency (tens of ms).
- `src/worker/crawl-worker.int.test.ts` runs two crawls of one host in two worker processes. With shared keys, at
  most 3 requests were in flight, and both crawls had requests in flight at once. In a control run with a separate
  budget per worker, the peak reached 6.

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

### Worker fetch policy

The worker fetches through the default SSRF policy (`src/lib/crawl/v2/fetch-policy.ts`), which blocks loopback and every
private or reserved address. For the fixture site and the worker integration tests, `CRAWLER_LOCAL_HOSTS` can map
named `*.test` hosts to loopback. That is honoured only when `NODE_ENV` is exactly `test`. Under any other value
(production, development or unset) the worker refuses to start. `npm run gate:p1` runs its workers with `NODE_ENV=test`.
`fetch-policy.test.ts` shows the production policy refusing a real local server, with 0 requests reaching it.

### Pause and cancel

The runner polls `crawls.status` every 500 ms (`STATUS_POLL_MS`). Every wait listens to that poll: the host
throttle's slot and backoff wait, the wait before a 429/503 retry, and the robots.txt and sitemap reads. Pause and
cancel therefore take effect within about 0.5 s, and within 2 s in every test, even while the host is held for a
60 s `Retry-After`.

- **Pause.** No new request starts. A request already in flight is allowed to finish and is recorded normally. Rows
  claimed but not yet sent go back to `discovered` for the resume.
- **Cancel** (and worker shutdown). Requests in flight are aborted as well. A request aborted by cancel ends
  `cancelled` with `The crawl was cancelled while this request was in flight; the response was not read.` One
  aborted by worker shutdown ends `interrupted`, as before.
- **A stop during a 429/503 retry wait** (pause, cancel or worker shutdown) returns the URL to `discovered` and refunds
  its budget charge (`requeueRefused`; logged as `crawl.requeued`). The server refused the request, so sending it
  again does not break at-most-once. A resume requests it again, charged once. On cancel, `finalizeUrls` then files
  it `cancelled` like any other unfetched URL.

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
- **Rule safety** (`src/lib/crawl/scope-rules.ts`). JavaScript regexes backtrack, so one rule such as `(a+)+$` could
  stall a worker on a single URL. The rules are checked twice: by the API, which names the rule, and again by the
  runner before it starts, for rows written without the API. The checks:
  - at most 20 rules of at most 200 characters each;
  - each rule must compile;
  - each rule must pass `safe-regex2`'s star-height check: no repeated group inside another repetition.

  That check counts `?` as a repetition, so `(en/.*)?` is refused although it is harmless. The error suggests
  `($|en/)` instead. It also misses overlapping alternation such as `^(a|a)*$`. A linear-time engine (RE2) would
  close that gap, but it is a native dependency.
- Basic auth is sent only to the crawl's own origin, never across a redirect to another origin. The password is encrypted
  with AES-256-GCM under `CRAWLER_SECRET_KEY`, bound to the crawl id as associated data, before the crawl row is written.
  The audit stores only the username. Without the key, the API refuses basic auth before creating the audit.
- The homepage form (`POST /api/live/audits/quick`) always runs Quick and allows 5 audits per client IP per hour. The
  window is a Redis sorted set (`rl:hero-audit:<ws>:<ip>`); denied attempts are not counted. If Redis is unreachable the
  in-process limiter takes over and the fallback is logged.
- **Client IP.** Next route handlers cannot see the socket address (`request.ip` was removed in Next 15, and Next copies
  the socket address into `X-Forwarded-For` only when the client did not send one). So the IP is read only from the
  header named in `TRUSTED_PROXY_HEADER`, which the reverse proxy in front of the app must set or overwrite. For a list
  header such as `X-Forwarded-For`, the rightmost entry is used: the one the proxy appended. The value must parse as an
  IP. With the setting unset, every forwarding header is ignored:
  - production: the homepage endpoint refuses with 503 `PROXY_NOT_CONFIGURED` ("proxy header not configured");
  - other environments: all clients share one bucket.
  The other in-process limits (`rateLimit`, already per workspace) use the same IP, or one shared bucket per key when
  there is none. That is stricter, never looser.
- With `CRAWLER_V2=false`, the in-request engine cannot run the larger profiles. Budget and depth are clamped to
  100 URLs and 3 clicks and the audit gets an `engine_limit` coverage note naming both. It ends `partial` only if the
  clamp cut something (a `page_limit` or `depth_limit` note also fired); a site covered completely stays `completed`. Scope
  rules and basic auth are refused while v2 is off.

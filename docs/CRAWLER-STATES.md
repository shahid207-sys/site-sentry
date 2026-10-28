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
| `cancelled` | `finalizeUrls` on cancel | `The crawl was cancelled before this URL was fetched.` |

## At-most-once

1. `reserve` claims up to N `discovered` rows with `FOR UPDATE SKIP LOCKED` in BFS order (depth ascending, sitemap-only
   URLs last) and moves them to `queued` with a lease. When a reservation expires, the row goes back to `discovered`,
   which is safe because nothing was sent.
2. `commitToSend` runs immediately before each request, in one transaction: it charges `crawls.fetches_committed`
   against the budget and moves the row to `fetching` with a fresh claim token. `reserve` never selects a `fetching` row.
3. `recordResult` runs in one transaction. It writes the page snapshot, the outgoing edges, the newly discovered URLs
   and the terminal state, all conditional on the claim token. If the token does not match, everything rolls back
   (`ClaimLostError`).
4. `sweep` runs at worker boot and periodically. It returns expired `queued` rows to `discovered` and moves expired
   `fetching` rows to `interrupted`.

BullMQ jobs only carry `{ crawlId }` as a trigger. The state above lives in Postgres, so a redelivered job can never
cause a second fetch.

## Depth and eligibility

- `depth` is the minimum link depth from a seed. It is null when only sitemaps found the URL. Merging takes `LEAST`.
- `discovered_via` is the sorted union of every source that found the URL.
- A row is eligible when its depth is within the profile's maximum, or a seed or sitemap lists it. Rows that are left
  over and beyond the depth limit end as `depth_exceeded`, and all other leftovers as `budget_exhausted`.

# Real-site validation (anonymised summary)

During development the crawler and rule catalog were run read-only against a real agency website (default politeness,
Standard profile: 1,000 URL budget, depth 10) with production fetch settings. The raw reports name the site and its
URLs, so they are kept privately and are not part of this repository. This is what they taught us.

## Setup

- `scripts/validate-site.ts` crawls a site you own or have permission to crawl and writes a JSON report. The pass
  criteria live in the gates (`npm run gate:p1` … `gate:p6`), which use the local fixture site and need no real site.
- Site size: about 1,000 pages crawled and a sitemap roughly nine times larger, so Standard coverage was about 7% and
  the health score was marked as partial coverage. A Deep crawl is needed for full coverage.

## Results

| Area | Result |
| --- | --- |
| Memory | Peak RSS 340–520 MB (the peak is the sitemap parse), flat while the frontier grew to about 14,400 URLs. The frontier lives in Postgres and raw HTML in the blob store. |
| Time | A page crawl took roughly 5–10 minutes. The resource phase (images and external links) added up to about 15 minutes at default per-host politeness. |
| Repeatability | Two audits of one site with one code version were compared run to run, with template groups, issue states and health score. |

## What validation found, and what we fixed

Every rule fix has a positive and a negative test and bumps the rule version (see `CONTRIBUTING.md`).

- **Crawler, start redirect.** An apex start URL that redirects to its `www` twin crawled only the apex and still
  showed "completed". The crawler now follows the start redirect and records it.
- **Crawler, deadlock.** Postgres `40P01` in `recordResult` when concurrent transactions inserted linked URLs out of
  order. Fixed by retrying the whole transaction (bounded), with a deterministic reproduction test.
- **LNK-001:** links to CDN or image-optimiser paths were reported as broken (hundreds of false positives); they are
  no longer judged.
- **CNT-009:** heading text glued across `<br>`, two-letter terms and word forms caused false "title and H1 share no terms".
- **META-012:** acronym-dense English (many "SEO") was detected as another language; no longer reported.
- **SD-002 / SD-003 / SD-004:** `x-input` / `x-output` Action properties were "unknown", and Google's Offer and
  ListItem property lists were applied outside Product offers and BreadcrumbLists.
- **IMG-003 / IMG-007:** brand-name alt text equal to a file stem, and images that fill their parent, were flagged.
- **LNK-014:** facet explosion counted URLs on other hosts.
- **SITE-001 (template detection):** wrapper `<div>`s that only some pages have split real templates apart.

## Reproducing

Run the validation script against your own site only, and set your own bot identity first (`docs/BOT.md`).

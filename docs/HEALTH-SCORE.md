# Priority and health score

How Site Sentry ranks issue groups and scores a crawl. Everything here is computed from stored data by
`src/lib/results/` when a crawl is analysed. The report and the API read the stored values. Nothing is recomputed
for display.

## Issue groups

A crawl's findings are grouped by rule. Each group stores:

- the affected URL count;
- the inconclusive URL count;
- the priority inputs below.

The breakdown by template is described in "Groups by template".

A rule that reports once per template (`groupByTemplate`) stores one finding per template. Its group still counts
every page: the analysis records one **occurrence** per rule × URL × evidence key (`finding_occurrences`), and
groups, reach and cross-audit states are counted over occurrences.

## Priority

```
score = Impact × Reach × Confidence weight          (0 to 5)
```

| Input | Values |
| --- | --- |
| Impact | The rule's `impact`, 1–5: the SEO consequence if the finding is true. |
| Confidence weight | verified 1.0, heuristic 0.6, advisory 0.3 (the rule's confidence). |
| Reach | `ln(1 + affected) / ln(1 + indexable)`, clamped to 0–1; 0 when the crawl has no indexable page or the group has no issue. |

- **Indexable pages:** crawled HTML pages answering 200, without noindex, whose canonical is absent or points to
  the page itself (`isIndexable` in `src/lib/rules/contract.ts`).
- **Affected pages:** the sum, over the group's issue occurrences, of each occurrence's reach pages, capped at
  the number of indexable pages. An occurrence counts as follows:
  - **The finding stands for several pages** (`evidence.pages`): that page count. This covers a resource used on
    N pages, or a template-wide finding.
  - **The subject is an indexable page:** 1, counted once per URL.
  - **The subject is a URL of the crawl that is not an HTML page:** 1, counted once per URL. Examples: a 404, a
    redirect.
  - **The subject is an HTML page that is not indexable:** 0. Fixing it changes nothing in search.
  - **The subject is not a URL of the crawl:** the whole site. Examples: robots.txt, a sitemap, llms.txt. Affected
    then equals the number of indexable pages, so reach is 1.

Reach is log-scaled so that breadth counts without swamping impact. With 1,000 indexable pages:

| Affected pages | 1 | 10 | 100 | 1,000 |
| --- | --- | --- | --- | --- |
| Reach | 0.10 | 0.35 | 0.67 | 1.00 |

| Priority | Score |
| --- | --- |
| Critical | ≥ 3.5 |
| High | ≥ 2.5 |
| Medium | ≥ 1.5 |
| Low | ≥ 0.5 |
| Info | < 0.5 |

Worked example: a verified impact-4 rule on 100 of 1,000 indexable pages scores 4 × 0.668 × 1.0 = 2.67, which is
High. The same rule as a heuristic scores 4 × 0.668 × 0.6 = 1.60, which is Medium.

Code: `src/lib/results/priority.ts` (formula and bands), `src/lib/results/occurrences.ts` (reach pages, groups).

## Groups by template

Each issue group is split by template (`issue_group_templates`). Every split stores:

- the affected URL count for that template;
- the first 5 affected URLs in byte order.

URLs outside any template are stored under template `''`. The group itself also stores:

- `template_count`: the number of distinct templates among its affected URLs;
- `sample_urls`: its first 5 affected URLs.

## Health score

The health score runs from 0 to 100 and is computed only over the rules that ran in the crawl. A rule with
status `needs_config` or `error` in `rule_runs` counts neither for nor against the score.

```
category score = 100 × (1 − Σ group score / Σ (impact × confidence weight))   over the category's rules that ran
health         = Σ (weight × category score) / Σ weight                        over categories with a rule that ran
```

- **Group score:** the issue group's priority score from above, or 0 when the rule found nothing.
- **Category maximum:** `impact × confidence weight`, summed over the category's rules that ran. This is the
  deduction if every rule of the category hit every indexable page.
- **Rounding:** category and overall scores are rounded to one decimal.
- **Excluded categories:** a category with no rule that ran is left out of the score and out of the weights.
- **Inconclusive results:** they deduct nothing.
- **History rules** (SITE-004 regressions, SITE-005 new URLs with a Critical issue) are left out. Their findings
  summarise other rules' results, which already deduct. They still get issue groups with a priority score, and they
  run only when the project has an earlier analysed audit.
- **Performance and accessibility** (Phase 5) have no published weight: docs/SPEC.md gives none. Their issues are
  reported and prioritised like any other, but they are not in the health score until weights are agreed.

| Category | Weight |
| --- | --- |
| Indexability | 25 |
| Content | 15 |
| Metadata | 12 |
| Links | 12 |
| Structured data | 8 |
| Images | 8 |
| International | 6 |
| Security | 6 |
| AI search | 4 |
| Site | 4 |

**Coverage** is the share of eligible URLs that were answered:

- **Answered** URLs have one of these states: `fetched`, `analysed`, `redirected`, `non_html`, `oversized`.
- **Eligible** URLs are every URL found, minus those the site owner or the audit's own rules ruled out:
  `blocked_robots`, `excluded_by_rule`, `cdn_managed`.

When coverage is below 50%, the score is stored with `partialCoverage: true` and the report shows it as "partial
coverage" instead of a confident number.

Worked example: four rules ran.

| Category | Rules that ran | Calculation | Score |
| --- | --- | --- | --- |
| Indexability | A verified impact-5 rule with group score 2.5, and a heuristic impact-4 rule that found nothing | 100 × (1 − 2.5 / (5 + 2.4)) | 66.2 |
| Metadata | An advisory impact-3 rule with group score 0.45 | 100 × (1 − 0.45 / 0.9) | 50.0 |
| Links | A clean verified rule | | 100 |

Overall health is (25 × 66.2 + 12 × 50 + 12 × 100) / 49 = 70.5. The worked example is
`src/lib/results/health.test.ts`.

Stored in `crawls.health`, with per-category weight, rules that ran, deduction, maximum and score.

Code: `src/lib/results/health.ts`, `src/lib/results/coverage.ts`.

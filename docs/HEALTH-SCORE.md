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

# SiteSentry

SEO operations workspace: audit public sites with deterministic checks, investigate the evidence, turn findings into fix tasks, re-check the live page against frozen acceptance criteria, and catch regressions between audits.

## Run

Requires Node 20.19+ (developed on Node 24).

```bash
npm install
npm run dev        # http://localhost:3000  (public site; workspace at /live)
npm test           # unit tests: rules, SSRF guard, comparison, exports, sample seed (no network)
npm run build      # production build + type-check
npm run test:e2e   # Playwright against a running server (E2E_BASE_URL, default http://localhost:3000)
```

The E2E suite uses your installed Chrome (`E2E_CHANNEL=chrome`) and only writes to the sample workspace, which it resets before and after. `e2e/live-sandbox.spec.ts` exercises the live workspace's write paths and is skipped unless `E2E_LIVE_SANDBOX=1`. Run it against a server started with an empty, throwaway `SITE_SENTRY_DATA_DIR`; it refuses to run if the live workspace already has sites, and removes only what it creates.

## Public site

`src/app/(marketing)/` holds the public pages: `/` (homepage with a quick-audit form), `/features`, `/how-it-works`, `/sample-audit` and `/methodology`. They are statically rendered. Nothing on them is hand-written audit data:

- The homepage dashboard card and the interactive `/sample-audit` page (overview, issues with evidence and fixes, pages, recommendations, JSON download) read `getSampleShowcase()` (`src/lib/sample/showcase.ts`). It builds the sample workspace with the real engine and caches the result for the build. Both are labelled as sample data.
- The smaller workflow previews use `src/lib/sample/preview.ts`, which runs the real rules over one fixture page.

**Health score.** `src/lib/audit/health.ts` computes the score as 100 − 10 per high, − 3 per medium and − 1 per low open issue type (each check counted once, at its worst severity), with a minimum of 0. The bands are: 80 and above is good, 60–79 needs work, below 60 is poor. The score appears on the overview, the Sites table, the homepage and the sample audit, and `/methodology` explains it with a worked example. A site has no score until its first audit finishes.

The quick-audit form validates the address in the browser (`src/lib/public-url.ts`), then uses the same API as the workspace: it adds the site to the live workspace (or reuses it if it already exists), starts a single-URL audit (10 pages, 1 click deep, link checks off) and opens its progress page. All fetch-safety rules below still apply on the server.

`/app`, `/app/fix-queue` and `/app/*` redirect to the live workspace, so either URL style works. The workspace itself stays at `/live` and `/sample`, which keeps real and sample data on separate, clearly labelled routes.

## Workspaces

- **`/live`**: your sites. Stored in `.data/live/` (gitignored).
- **`/sample`**: two fictional sites with four audits, six tasks and verification history, produced by running the real engine over bundled fixtures with a fixed clock (`src/lib/sample/`). Every sample screen is labelled. Sites and settings are read-only on the server. Tasks and audits can be created and are discarded by **Settings → Reset sample workspace**. The **sample site simulator** switches the fixtures between *Original*, *Partly fixed*, *Fully fixed* and *Offline*, to show passing, failing and inconclusive verification.

## Pages

| Route | Purpose |
|---|---|
| `/[ws]` | Overview: sites, pages inspected, open issue types (grouped by check) and verified fixes; priority work; regressions, resolved, first-detected and not-re-checked issues since the previous audit; next actions; recent audit activity |
| `/[ws]/sites`, `/[ws]/sites/[id]` | Add sites; per-site dashboard, important URLs (type, labels, intended indexing, expected canonical), audit history |
| `/[ws]/audits`, `/new`, `/[id]`, `/[id]/compare` | Audit history; setup (single URL, URL list or sitemap, limits, categories) with a preview of what will run; live step-by-step progress; results with filters, sort, search, evidence drawer and CSV/JSON export; coverage-aware comparison. Audits can be deleted one at a time (recycle-bin button on each row and on the audit page) or all at once for a site |
| `/[ws]/issues`, `/[ws]/issues/[fingerprint]?site=` | Issues tracked across audits by fingerprint, grouped by check by default (`?view=list` shows one row per page, `?rule=` filters to one check); investigation view with timeline, verification attempts and related issues |
| `/[ws]/tasks`, `/[ws]/tasks/[id]` | Fix Queue with filters, sorting and bulk move/assign; task page with workflow, verification, notes, checklist and activity |
| `/[ws]/reports`, `/[id]`, `/handoff?site=` | Print-ready audit report and developer handoff (save as PDF from the print dialog) |
| `/[ws]/settings` | Thin-content threshold, multiple-h1 convention, per-check severity overrides, sample simulator, storage and scan policy |

Workflow status (Open → Triaged → In progress → Ready to verify → Resolved / Won't fix) is set by people. Verification status (passing / failing / inconclusive / partial) changes only when SiteSentry re-fetches the page. A resolved task that fails a re-check, or whose finding a later audit detects again, is reopened as a regression. An issue is **resolved** only when a later audit re-examined its whole scope and no longer found it. Absence from an incomplete audit is reported as **not re-checked**.

**Deleting audits.** Deleting one audit removes its findings and snapshots; comparisons and issue history are rebuilt from the audits that remain, and fix tasks are kept because each task stores its own copy of the findings. *Delete audit history* (on the Audits page filtered to a site, or in the site's Danger zone) removes every audit of that site and its fix tasks, but keeps the site, its important URLs and settings. Running audits must be cancelled first. Both actions ask for confirmation and cannot be undone. In the sample workspace, **Reset sample workspace** restores deleted audits.

**Instances and issue types.** A finding instance is one check failing on one page (one fingerprint). The overview and Issues page group instances by site and check into issue types, so 25 images without dimensions show as one row with 25 affected pages. Grouping is display-only: fingerprints, tasks and verification still work per instance.

**Regression vs first detected.** Comparison is coverage-aware. A finding counts as a regression only if the previous audit inspected the same page with the same check (each `RuleResult` records the checks it ran in `checked`) and didn't find it. If the previous audit was narrower (fewer pages, fewer categories, or an older engine without that check), the finding is *first detected*, and the overview says the baseline was narrower. Audits imported from the v1 store are treated as having run only the v1 title, canonical and indexability checks.

## API

Every route is under `/api/[ws]/…` (`ws` = `live` | `sample`). Bodies are validated with zod. Errors return `{error: {code, message}}` with 400/403/404/409/413/429/503, and never include stack traces.

`overview` · `sites` (GET, POST) · `sites/:id` (GET, PATCH, DELETE) · `sites/:id/audits` (DELETE: clear the site's audit history) · `sites/:id/pages` (PUT) · `sites/:id/pages/:pageId` (DELETE) · `audits` (GET, POST) · `audits/:id` (GET, DELETE) · `audits/:id/step` (POST: one bounded crawl step) · `audits/:id/cancel` · `audits/:id/compare?base=` · `audits/:id/export?format=csv|json&<same filters as the table>` · `issues?site=` · `issues/:fingerprint?site=` · `tasks` (GET, POST) · `tasks/bulk` · `tasks/:id` (GET, PATCH, DELETE) · `tasks/:id/verify` · `settings` (GET, PUT) · `sample` (PUT, sample only). Also `GET /api/health`.

Audits have no hidden background queue. The progress page calls `step` repeatedly. Each step does at most about 8 s of work and saves its state, so an interrupted audit resumes when its page is opened again, and that fits serverless time limits.

## Layout

```
src/lib/audit/        pure rule engine: rules/, site/ (cross-page rules), compare, issues, priority, fingerprint, catalog
src/lib/crawl/        step-based crawler, robots.txt, sitemaps, URL identity
src/lib/fetch/        SSRF-safe fetching
src/lib/workflow/     sites, tasks, verification (deps injected)
src/lib/store/        Store interface; JSON-file and in-memory implementations; v1 migration
src/lib/sample/       fixture sites, fixture fetcher, deterministic seed
src/lib/server/       read models for the API (server-only)
src/lib/export.ts     CSV (formula-injection safe) and JSON exports; filters.ts is shared by the table and the export
src/app/api/          route handlers (thin; validation and error mapping in _lib/handler.ts)
src/app/(marketing)/  public pages
src/app/[ws]/         workspace pages: thin server shells around client views
src/components/       ui.tsx (design-system primitives), overlays.tsx, domain.tsx, shell/, views/, marketing/
e2e/                  Playwright journeys and responsive checks
```

### Design system

Light interface defined by tokens in `src/app/globals.css`, shared by the public site and the workspace: background `#F7F8FA`, surface `#FFFFFF`, border `#E2E8F0`, text `#172033` / `#475569` / `#5B6779`, coral accent `#F15F46` for primary actions (with `#C2412B` for coral text, which needs the darker shade for contrast). Every text token is at least 4.5:1 on every surface. Geist is used for UI text, and Geist Mono only for rule codes, URLs and evidence. Severity, workflow, verification and change states always pair an icon with text. Form inputs are 40 px tall. Panels use 16 px radii with soft shadows, and key figures sit in icon stat cards. Wide tables switch to stacked rows below 1280 px (1024 px for most pages), and the public navbar collapses to a menu below 1024 px. Printing hides the app chrome. Reduced-motion preferences are respected.

## Fetch safety

- Only `http`/`https` on ports 80/443, with no credentials in the URL and no `localhost`, `.local` or `.internal` hosts.
- Every resolved address is checked against private, loopback, link-local (incl. `169.254.169.254`), CGNAT, multicast and reserved ranges. On DNS64/NAT64 networks, `64:ff9b::/96` and `::ffff:` addresses are judged by their embedded IPv4.
- The same check runs again inside the socket's DNS lookup (undici `Agent`), so a DNS answer that changes between the check and the connection is still refused.
- Redirects are followed manually (max 5) and every hop is re-validated.
- 10 s timeout; 2 MB HTML, 5 MB sitemap and 512 KB robots.txt caps; robots.txt is respected for SiteSentryBot.
- `SITE_SENTRY_LIVE_SCANS=disabled` turns live fetching off. `SITE_SENTRY_ALLOWED_HOSTS=a.com,b.org` restricts it to those hosts and their subdomains.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `SITE_SENTRY_DATA_DIR` | `.data` (or `/tmp/site-sentry` on Vercel) | Where JSON data is stored |
| `SITE_SENTRY_LIVE_SCANS` | `enabled` | `disabled` blocks live fetching; the sample workspace still works |
| `SITE_SENTRY_ALLOWED_HOSTS` | unset | Optional allowlist for live scans |

## Known limitations

- JavaScript rendering (crawler v2 only; Standard renders one page per template, Full-site sampled or every page, Quick none) runs after the crawl. Its LCP/CLS are unthrottled lab numbers from one load, not field data; links that appear only after JavaScript are reported, not crawled. The in-request engine does not render.
- Charset comes from the `Content-Type` header only (no `<meta charset>` sniffing).
- JSON-file store: fine for one server process. On serverless hosts data in `/tmp` is ephemeral (Settings says so); use a persistent volume or a database adapter behind the `Store` interface.
- The rate limiter is in-memory and per process.
- There are no user accounts. Anyone who can reach the server can use both workspaces, and the homepage quick-audit form adds sites to the shared live workspace (capped at 50 sites; adding sites and starting audits are rate-limited per client IP by an in-memory limiter). Put the server behind authentication, or set `SITE_SENTRY_ALLOWED_HOSTS` or `SITE_SENTRY_LIVE_SCANS=disabled`, before exposing it publicly.
- Quick audits from the homepage don't status-check outbound links. Run a full audit from the workspace for that.
- Unknown top-level paths (for example `/nope`) render the not-found page with `noindex`, but with HTTP 200, because the `[ws]` segment matches any path and Cache Components rules out `dynamicParams = false`.
- Findings on pages over 2 MB (truncated) cannot be tracked, because a re-check of a truncated page is always inconclusive.

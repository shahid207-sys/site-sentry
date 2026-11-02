# SiteSentry

Open-source technical SEO auditing you run yourself. SiteSentry crawls a website, runs a catalog of deterministic
checks over frozen page snapshots, shows the evidence behind each finding, turns findings into fix tasks, re-checks
the live page against acceptance criteria, and tells you what regressed between audits. Every number it shows is
traceable to a page, a rule and a snapshot.

> Status: early. Phases 1–5 and the local part of Phase 6 of the [spec](docs/SPEC.md) are built; see the [roadmap](#roadmap).

<!-- Screenshots: add images under docs/images/ and link them here, e.g. ![Audit overview](docs/images/overview.png) -->
*Screenshots: coming soon.*

## Features

- **Crawler** with named URL states and honest coverage (what was found, crawled, skipped, and why), `robots.txt`,
  sitemaps, redirects, per-host politeness, pause/resume and crash recovery. Audit profiles: Quick, Standard, Full-site, Custom.
- **Rule catalog** across indexing, metadata, content, links, images, structured data, international, security, AI
  crawler access, performance and accessibility. Rules are deterministic, versioned and carry evidence and confidence.
- **Rendering** (optional): headless Chromium for JavaScript-only content, a raw-versus-rendered diff, lab performance
  metrics (labelled as lab data, never as field data) and axe accessibility checks.
- **Prioritisation and health score** with template grouping, so one broken template is one issue, not 300.
- **History**: issues tracked across audits, coverage-aware comparison, regressions versus first detections.
- **Fix workflow**: tasks with frozen acceptance criteria and re-verification against the live page.
- **Reports and sharing**: print-ready reports, password-protected share links, CSV/JSON export.
- **Scheduled audits** with signed webhook alerts.
- **SSRF-safe fetching**: every request, including the browser's, goes through one guarded fetcher.
- **Self-hosted**: your data stays in your own Postgres. See [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md).

Not built yet: integrations that need third-party accounts (for example Search Console), and user accounts. The app has
no login; do not expose it to the internet without putting authentication in front of it.

## Quick start

With Docker (web app, crawl worker, analysis worker, Postgres and Redis):

```bash
git clone https://github.com/shahid207-sys/site-sentry.git
cd site-sentry
docker compose up -d --build
# open http://localhost:3000
```

Configuration, upgrades and backups: [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md).

For development (Node 20.19+, developed on Node 24):

```bash
npm ci
cp .env.example .env.local
docker compose up -d postgres redis
npm run db:migrate
npm run dev        # http://localhost:3000
npm run worker     # in a second terminal
```

More in [CONTRIBUTING.md](CONTRIBUTING.md).

## Architecture

```
 browser ──► Next.js app (UI + API) ──► Postgres  (crawl state, snapshots, findings, history)
                    │                       ▲
                    └──► Redis (BullMQ) ────┤
                            │               │
              ┌─────────────┴───────┐       │
              ▼                     ▼       │
       crawl worker           analysis worker
   (fetch, robots, sitemaps,   (rule engine over snapshots,
    render with Chromium)       issues, health, alerts) ──────┘
              │
              ▼
    blob store (raw HTML) ── shared volume
```

- `src/lib/crawl/` crawler, robots.txt, sitemaps, URL identity; `src/lib/fetch/` SSRF-safe fetching.
- `src/lib/snapshot/` page snapshots; `src/lib/rules/` the rule catalog and analysis queue.
- `src/lib/render/` Playwright render pool; `src/lib/schedule/` scheduled audits and alerts.
- `src/worker/` the worker processes; `src/app/` pages and API routes; `fixtures/` the fixture site that proves every rule.

Further reading: [docs/SPEC.md](docs/SPEC.md) (product and engineering spec), [docs/ARCHITECTURE-CURRENT.md](docs/ARCHITECTURE-CURRENT.md),
[docs/CRAWLER-STATES.md](docs/CRAWLER-STATES.md), [docs/HEALTH-SCORE.md](docs/HEALTH-SCORE.md),
[docs/APP-REFERENCE.md](docs/APP-REFERENCE.md) (routes, API, workspaces) and [docs/BOT.md](docs/BOT.md).

## The crawler is a polite guest

It obeys `robots.txt`, rate-limits per host and refuses internal addresses. Site owners can block or slow it: see
[docs/BOT.md](docs/BOT.md). Set your own `CRAWLER_BOT_NAME` and `CRAWLER_BOT_URL` before auditing sites you do not own,
and only audit sites you own or have permission to audit.

## Roadmap

From the [spec](docs/SPEC.md#roadmap-and-gates). A phase is done when its gate passes.

| Phase | Scope | Gate | State |
| --- | --- | --- | --- |
| P1 | Crawler and coverage | all fixture URLs found; resume after crash; SSRF safe | built |
| P2 | Snapshots and rules | every rule hits its fixtures; zero findings on `/clean/` | built |
| P3 | Prioritisation, history, reports | report counts equal database counts; Verify resolves only re-checked URLs | built |
| P4 | UI/UX rebuild | accessibility 95+, fast 50k-row tables, full journey passes | built |
| P5 | Rendering and performance | JS-only pages detected; lab never labelled as field | built |
| P6 | Integrations and scheduling | scheduled audits and signed alerts are built; integrations that need real accounts (for example Search Console) are not | partly built |

## License

[GNU Affero General Public License v3.0](LICENSE). If you run a modified SiteSentry as a network service, the AGPL
requires you to offer its users the source of your modified version. Contributions are accepted under the same license.

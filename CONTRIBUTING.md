# Contributing to SiteSentry

Thanks for helping. SiteSentry is licensed under the [AGPL-3.0](LICENSE); by contributing you agree your contribution
is licensed under the same terms. Please read the [Code of Conduct](CODE_OF_CONDUCT.md). For security problems, do not
open an issue: follow [SECURITY.md](SECURITY.md).

## Setup

Requirements: Node 20.19+ (we develop and run CI on Node 24), Docker (for Postgres 16 and Redis 7).

```bash
git clone <your fork>
cd site-sentry
npm ci
cp .env.example .env.local        # defaults match docker-compose.yml
docker compose up -d postgres redis
npm run db:migrate
npx playwright install chromium-headless-shell   # only for the rendering phase, its tests and gate:p5
npm run dev                        # http://localhost:3000   (workspace at /live, sample data at /sample)
npm run worker                     # crawl worker (needed when CRAWLER_V2=true); also runs analysis and rendering
```

Next.js in this repo is a newer major version than most documentation you will find. Read the relevant guide in
`node_modules/next/dist/docs/` before changing routing, caching or config (see `AGENTS.md`).

## Test commands

| Command | What it runs | Needs |
| --- | --- | --- |
| `npm run lint` | ESLint | |
| `npm run typecheck` | `tsc --noEmit` | |
| `npm test` | Unit tests (Vitest): rules, SSRF guard, comparison, exports | nothing |
| `npm run test:int` | Integration tests: crawler, worker, store, API routes | Postgres and Redis |
| `npm run coverage` | Unit tests with coverage thresholds | |
| `npm run build` | Production build | |
| `npm run test:e2e` | Playwright against a running server | a server, Chrome |
| `npm run gate:p1` … `gate:p6` | Phase gates (below) | Postgres, Redis; some need `npm run build` and Chromium |

Before opening a PR run lint, typecheck, `npm test` and `npm run test:int`. CI runs those plus the build on every PR.

## Gates

Each roadmap phase has a gate (`scripts/gate-pN.ts`) that crawls the local fixture site, a purpose-built site of about
1,200 URLs (`fixtures/site/`), and fails unless the phase's promises hold (see `docs/SPEC.md`, "Roadmap and gates").
Gates are heavy (minutes, Chromium, Lighthouse), so CI runs them only on manual dispatch (Actions → ci → Run workflow →
tick "gates"). Run the gate for the area you changed before asking for review, for example `npm run gate:p2b` after
a rule change. If you change behaviour a gate asserts, update the gate in the same PR and say why.

## The fixture rule: every rule needs a positive and a negative fixture

No rule is "working" unless the fixture proves it. A new or changed rule (`src/lib/rules/`) must come with:

1. a **positive** fixture: a page (or site) that has the defect, and a test showing the rule reports it, with its
   evidence, severity and confidence;
2. a **negative** fixture: a page that looks similar but is fine, and a test showing the rule stays silent. The clean
   section (`/clean/`) must keep producing zero findings;
3. for a fix to a false positive: a test of the case that was wrongly reported, plus a test that the real defect is still reported;
4. a bumped rule version when the output of an existing rule changes.

Fixtures live in `fixtures/site/` (defects in `defects.ts` / `defects-2b.ts`, structure in `definition.ts`). Use
`example.com`, `*.test` or similar reserved names; never commit a real third-party site's pages, crawl exports or
reports (`.gitignore` blocks the usual places).

## Commit style

- Short imperative subject, 72 characters or fewer, no trailing period. Prefix with the phase when work belongs to a
  roadmap phase (`P5: render modes per profile`). The body says why, not what.
- One logical change per commit; tests and docs in the same commit as the code they cover.
- Do not commit secrets, `.env*` files (except `.env.example`), `.data/`, or generated reports and PDFs.

## Pull requests

Fill in the PR template. Keep PRs focused. Describe how you tested the change, link the issue, and say if it changes
a rule's output, the database schema (add a migration with `npm run db:generate`), or an environment variable (update
`.env.example` and the docs). A maintainer will review; CI must be green.

## Reporting false positives

A rule that reports something wrong is a bug. Use the "False positive" issue template and include the URL pattern, the
HTML involved (trimmed), and why the finding is wrong. A reproducible snippet is worth more than a live URL.

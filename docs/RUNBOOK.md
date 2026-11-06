# Runbook: running SiteSentry locally

Crawler v2 is the default engine. An audit started from the UI is a job for the workers, so they must be running, or
the audit stays queued.

## First time

```bash
npm ci
cp .env.example .env.local
docker compose up -d postgres redis
npm run db:migrate
npx playwright install chromium-headless-shell   # rendering (Standard, Full-site and Custom audits) and PDF reports
```

## Every time

```bash
docker compose up -d postgres redis
npm run db:migrate     # after pulling new migrations
npm run dev:all        # http://localhost:3000/live
```

`npm run dev:all` loads `.env.local` and starts these three, with a `[app]`, `[crawl]` or `[analysis]` prefix on each
line of output. Ctrl+C stops all three, and so does any one of them exiting. It stops straight away if Postgres or Redis
is not reachable.

| Process | Runs | Does |
| --- | --- | --- |
| app | `next dev` | UI and API |
| crawl | `ANALYSIS_WORKER=off tsx src/worker/crawl-worker.ts` | Fetches pages, checks links and images, renders the sampled pages in-process |
| analysis | `tsx src/worker/analysis-worker.ts` | Runs the rules, grouping and scoring, then the AI analysis job when the project has it on |

## The same thing in three terminals

The workers do not read `.env.local` by themselves. `--env-file` loads it, and works on Node 20.6 or later:

```bash
npm run dev
ANALYSIS_WORKER=off node --env-file=.env.local --import tsx src/worker/crawl-worker.ts
node --env-file=.env.local --import tsx src/worker/analysis-worker.ts
```

In PowerShell, set the variable first: `$env:ANALYSIS_WORKER = "off"`.

`npm run worker` on its own also works: that one process then runs crawling, analysis and rendering together.

## Engines

| `CRAWLER_V2` | Engine |
| --- | --- |
| unset or `true` | Crawler v2 (this runbook) |
| `false` (explicit) | The legacy in-request engine: no workers, at most 100 pages and 3 clicks deep |

## AI analysis

Off by default, per project: **Sites > the site > Edit site > AI analysis**. It runs as a queue job on the analysis worker
after the rules finish, and only for audits started after it was turned on. Set `GEMINI_API_KEY` in `.env.local` and
restart the workers (or `AI_PROVIDER=anthropic` with `ANTHROPIC_API_KEY`). A 429 or 503 from Gemini is retried with backoff, by the wait it names. Optional: `AI_ANALYSIS_MODEL` (default `gemini-flash-latest`, or `claude-sonnet-5-5` for anthropic), `AI_MAX_INPUT_TOKENS` (default 60,000,
the cap per audit), `AI_MAX_OUTPUT_TOKENS` (default 16,000).

A finished analysis is cached by audit ID and is never paid for twice. To run it on an audit that already finished, while
the project has it on, press **Run AI analysis** on the audit's overview, or:

```bash
node --env-file=.env.local --import tsx scripts/ai-analyse.ts <auditId>
```

The worker logs `ai.grounded` with how many items and citations the validator dropped.

## Memory

On a small machine run one heavy process at a time: stop `dev:all` before `npm run build`, `npm run test:int` or any
`npm run gate:*`. Gates start their own workers and use their own databases.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| The audit stays "queued" | The crawl worker is not running | `npm run dev:all`, or check its `[crawl]` lines |
| The crawl finished but "Analysis has not finished" stays | The analysis worker is not running | Check its `[analysis]` lines |
| `relation ... does not exist` | The database is behind the code | `npm run db:migrate` |
| AI analysis says "not configured" | The provider's API key is not set on the workers | Set it, restart, run it again from the overview |
| Worker refuses to start: `CRAWLER_LOCAL_HOSTS` | That test-only setting is in your env | Remove it |

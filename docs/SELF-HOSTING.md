# Self-hosting SiteSentry

`docker-compose.yml` runs the whole stack on one machine:

| Service | What it does |
| --- | --- |
| `app` | The Next.js web app and API, on `127.0.0.1:3000` |
| `crawl-worker` | Crawls sites, and renders sampled pages with headless Chromium |
| `analysis-worker` | Runs the rule engine over the crawl's page snapshots, computes issues and health, sends alerts |
| `postgres` | Postgres 16: crawl state, snapshots, findings, history, and the app's own data |
| `redis` | Redis 7 (BullMQ job queues, with append-only persistence) |
| `migrate` | One-shot: applies database migrations, then exits. The app and workers wait for it |

## Requirements

Docker with Compose v2, about 4 GB of RAM free (each rendering browser needs 150–300 MB) and a few GB of disk.
The first build downloads Chromium and the dependencies; it took about 13 minutes on a laptop, later builds reuse the cache.

## Start

```bash
git clone https://github.com/shahid207-sys/site-sentry.git
cd site-sentry
cp .env.example .env     # optional; see "Configuration"
docker compose up -d --build
docker compose ps        # migrate should say "exited (0)", the rest "running"
```

Open <http://localhost:3000>. The workspace is at `/live`. Logs: `docker compose logs -f crawl-worker`.

## Configuration

Compose reads a `.env` file next to `docker-compose.yml` (not `.env.local`). These variables are passed to the app and both workers:

| Variable | Default | Meaning |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | `sitesentry` | Password of the database user. **Change it before the first start**; changing it later does not change an existing database volume. |
| `CRAWLER_BOT_NAME` | `SiteSentryBot` | The bot's robots.txt token and user-agent name. See [BOT.md](BOT.md). |
| `CRAWLER_BOT_URL` | unset | A page saying who runs this crawler, shown in the user-agent. **Set it before auditing sites you do not own.** |
| `CRAWLER_SECRET_KEY` | unset | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts basic-auth credentials for custom crawls and webhook signing secrets. Without it those features are refused. Keep it: losing it makes stored secrets unreadable. |
| `APP_URL` | `http://localhost:3000` | Public address of the app, used in alert links. |
| `TRUSTED_PROXY_HEADER` | unset | Header your reverse proxy or CDN sets to the client IP; see [Deployment checklist](#deployment-checklist) for the value per host. With `x-forwarded-for` the rightmost entry is used, so the proxy must append to or overwrite it. **Until it is set, the homepage quick-audit form is unavailable on a public host** (visitors see "Free audits are temporarily unavailable"; the log and the admin view of `/api/health` give the reason). Requests to `localhost` still work, sharing one rate-limit bucket. The workspace at `/live` works either way. Only set it behind a proxy you control: clients can forge the header otherwise. |
| `ADMIN_TOKEN` | unset | Bearer token for the admin view of `/api/health` (`curl -H "Authorization: Bearer $ADMIN_TOKEN" …/api/health`), which adds configuration problems such as a missing `TRUSTED_PROXY_HEADER`. Unset: nobody gets the admin view. |

More settings (worker concurrency, per-host politeness, rendering) are in [`.env.example`](../.env.example); to use one, add it to
the `environment:` block of the relevant service.

## Deployment checklist

Before serving the app on a public hostname:

1. `POSTGRES_PASSWORD` changed before the first start, and `CRAWLER_SECRET_KEY` set and backed up.
2. `CRAWLER_BOT_URL` and `APP_URL` set to your public addresses.
3. **`TRUSTED_PROXY_HEADER` set to the header your host writes the visitor's IP to.** Without it the homepage free audit is
   unavailable to visitors.

   | Host | `TRUSTED_PROXY_HEADER` |
   | --- | --- |
   | Vercel | `x-forwarded-for` (Vercel overwrites it with the client IP; `x-real-ip` holds the same value) |
   | Cloudflare (proxied, orange cloud) | `cf-connecting-ip` |
   | nginx / Caddy / Traefik you run | `x-forwarded-for`, with the proxy appending the client address (nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`) |

   Behind Cloudflare, make sure the origin only accepts traffic from Cloudflare, or clients can send their own
   `cf-connecting-ip`.
4. `ADMIN_TOKEN` set, then check `curl -H "Authorization: Bearer $ADMIN_TOKEN" https://your-host/api/health`:
   `admin.quickAudit.clientAddress` should be `"configured"`.
5. An authenticating proxy in front of the app (see the next section).

## Security: read this before exposing it

- **The app has no user accounts or login.** Anyone who can reach port 3000 can add sites, start crawls from your
  machine and read every report. The compose file therefore publishes it on `127.0.0.1` only.
- To share it, put a reverse proxy that enforces authentication (basic auth, OAuth proxy, VPN, tailnet) in front of it, and
  change the `ports:` mapping or use the proxy's network. Set `TRUSTED_PROXY_HEADER` to match your proxy.
- The crawler fetches whatever URL it is given, from your network. It refuses private, loopback, link-local and metadata
  addresses (SSRF guard), but still treat the host as one that makes outbound web requests on users' behalf.
  `SITE_SENTRY_ALLOWED_HOSTS=a.com,b.org` (add it to `environment:`) restricts live scans to those hosts.
- Postgres and Redis are published on `127.0.0.1` only (ports 5433 and 6379) for development tools. If other software on
  the host uses those ports, or you do not need host access, delete their `ports:` entries. Never publish them on a public interface.
- Only audit sites you own or have permission to audit, and read [BOT.md](BOT.md).

## Data and backups

State lives in three Docker volumes: `pgdata` (Postgres), `redisdata` (queues) and `appdata` (`/data`: raw HTML blobs and app files).

```bash
# Backup (Postgres is the important one; back up appdata too, since snapshots point to the blobs)
docker compose exec -T postgres pg_dump -U sitesentry sitesentry | gzip > sitesentry-$(date +%F).sql.gz
docker run --rm -v site-sentry_appdata:/data -v "$PWD":/backup alpine tar czf /backup/appdata-$(date +%F).tgz -C /data .

# Restore into a fresh stack: start only postgres, then
gunzip -c sitesentry-DATE.sql.gz | docker compose exec -T postgres psql -U sitesentry sitesentry
```

(The volume prefix `site-sentry_` is the compose project name, which is the directory name; check `docker volume ls`.)

## Upgrading

```bash
git pull
docker compose up -d --build     # rebuilds the image; migrate runs again before the app and workers restart
```

Migrations are forward-only: take a backup first.

## Running a worker on another machine

Both workers only need `DATABASE_URL`, `REDIS_URL` and the same `/data` blob volume (or an S3-style store when one is added).
Scale analysis with `ANALYSIS_CONCURRENCY`, crawling with `CRAWL_WORKER_CONCURRENCY`, and rendering with
`RENDER_BROWSERS` (1–4). Set `RENDER_WORKER: "off"` on the crawl worker and run `npm run worker:render` as a separate service to render elsewhere.

## Stop and remove

```bash
docker compose down        # stops; keeps data
docker compose down -v     # also deletes the volumes (all audits)
```

## Troubleshooting

- `migrate` exits non-zero: `docker compose logs migrate`; usually Postgres has a different password from `POSTGRES_PASSWORD` (it was set on first start).
- Audits stay "queued": check `docker compose ps` and `docker compose logs crawl-worker`; the worker needs Redis.
- Pages never get rendered: the render phase runs inside `crawl-worker`; Quick audits do not render at all.
- The homepage says "Free audits are temporarily unavailable" (503 `PROXY_NOT_CONFIGURED`): on a public host this is expected until `TRUSTED_PROXY_HEADER` is set (see [Deployment checklist](#deployment-checklist)); the app log and the admin view of `/api/health` say why. Start audits from `/live` meanwhile. On `localhost` the form works without it.
- Port 5433 or 6379 already in use: edit the `ports:` entries as described above.

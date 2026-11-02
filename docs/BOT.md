# The SiteSentry crawler (bot)

SiteSentry audits websites by fetching their pages. This page says what the bot does and how a site owner can slow it
or keep it out. If you landed here from your server logs: someone pointed a SiteSentry installation at your site.
SiteSentry is self-hosted software, so each installation is run by a different person or company, and **the project
maintainers do not operate a hosted crawler and cannot see who ran a given crawl**. Ask the operator named in the
user-agent's info URL (if they set one), or just block it as below.

## What it does

- Fetches public pages over `http`/`https` from a start URL, its sitemaps and the links it finds, up to a per-audit
  page budget (1,000 pages for a Standard audit by default).
- Reads `robots.txt` first and obeys it for its product token (`SiteSentryBot` unless the operator changed it), falling
  back to the `*` group. It honours `Crawl-delay` (capped at 60 s).
- Is polite by default: at most 3 requests in flight and 5 requests per second per host, a 10 s connect timeout, and a
  adaptive back-off when a site answers 429 or 503 or slows down (honouring `Retry-After`; pauses are capped at 60 s, with at most 2 retries per page).
- Only reads. It sends `GET` and `HEAD` requests, never submits forms, logs in, or executes anything on your server.
- Optionally renders a sample of pages in headless Chromium to see JavaScript-generated content. Every request the
  browser makes goes through the same policy and robots.txt check. The browser user-agent contains the bot token at the end.
- Refuses to fetch private, loopback, link-local and other internal addresses (SSRF guard), so it cannot be used to
  probe a site's internal network.

## How to recognise it

The `User-Agent` header is:

```
SiteSentryBot/1.0
SiteSentryBot/1.0 (+https://operator.example/bot)     <- when the operator set CRAWLER_BOT_URL
```

The rendering browser sends a normal mobile Chrome string with the same `SiteSentryBot/1.0 …` token appended.
Operators can change the name and URL, so match on your logs rather than on this page if the name differs.

## How to block or slow it

In `robots.txt` (replace the name if the user-agent in your logs differs):

```
# Keep the bot out entirely
User-agent: SiteSentryBot
Disallow: /

# Or only keep it out of part of the site
User-agent: SiteSentryBot
Disallow: /private/

# Or slow it down (seconds between requests)
User-agent: SiteSentryBot
Crawl-delay: 5
```

Takes effect on the next crawl; the bot reads `robots.txt` at the start of every crawl and for each rendered page.
Following RFC 9309, a `robots.txt` that answers 4xx means "allow all" and one that answers 5xx or cannot be reached means "disallow all" for that crawl.

If you cannot edit `robots.txt`, block the user-agent token at your web server, CDN or firewall (for example, return
403 for requests whose `User-Agent` contains `SiteSentryBot`). A page that answers 403 or 429 is recorded in the audit with
that status; 429 and 503 are retried at most twice, after the pause the server asks for.

## For operators of an installation

Set your own identity so site owners can reach you. There is deliberately no default info URL, because the project
does not own a domain you can point people to.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CRAWLER_BOT_NAME` | `SiteSentryBot` | robots.txt product token and the name in the user-agent. 1–40 characters: letters, digits, `.`, `_`, `-`, starting with a letter. |
| `CRAWLER_BOT_URL` | unset | Absolute `http(s)` URL of a page that says who runs this crawler and how to contact you. Added to the user-agent as `(+URL)`. |

Both are read at start-up, so set them for the web app and for every worker (the compose file passes them to all
services). A page at `CRAWLER_BOT_URL` should say who you are, why you crawl, that you obey `robots.txt`, and where to
send complaints. You may copy the "What it does" and "How to block" sections of this page. Only crawl sites you own or
have permission to audit.

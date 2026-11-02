# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** Report it privately through GitHub security advisories:
on the repository page choose **Security → Report a vulnerability**. If that option is not available to you, open a
public issue that only asks the maintainers for a private way to talk, without details.

Include what you found, the version or commit, steps to reproduce (a request or a short script is ideal) and the impact
you expect. We aim to acknowledge a report within 5 working days and to tell you what we plan to do within 14 days.
We will credit you in the advisory unless you prefer not to be named.

## What is in scope

SiteSentry fetches URLs that users give it, so the following matter most:

- **SSRF**: any way to make the crawler, the renderer (headless Chromium), a webhook delivery, or a share/report
  feature fetch or reach a private, loopback, link-local, metadata (`169.254.169.254`) or otherwise internal address, or
  to make the DNS, redirect, port or scheme checks (`src/lib/fetch/`, `src/lib/crawl/v2/blocklist.ts`) return the wrong answer.
  This includes DNS rebinding, redirects, IPv4-in-IPv6 forms, and requests the browser makes on its own.
- Authentication and authorisation gaps in the app and API (including report share links and their passwords or tokens).
- Leakage or weak handling of stored secrets (custom-crawl basic-auth credentials, webhook signing secrets).
- Injection (SQL, CSV/formula, HTML/XSS in rendered evidence or exports), request forgery, and path traversal in the blob store.
- Resource exhaustion that one unauthenticated request can trigger (crawl budget, memory, queue flooding), and
  circumventing `robots.txt` or the per-host rate limits.
- Vulnerabilities in the Docker and compose setup that expose Postgres or Redis by default.

## Out of scope

- Findings that need a malicious or compromised operator or an already-privileged host.
- Missing hardening on a deployment you configured differently from `docs/SELF-HOSTING.md`, for example exposing the
  app publicly with no authentication in front of it (documented: the app has no user accounts).
- Reports from automated scanners without a demonstrated impact; denial of service by sheer traffic volume.
- The content of sites being audited, and the findings SiteSentry reports about them.
- Vulnerabilities in third-party dependencies that do not affect SiteSentry; report those upstream.

## Supported versions

Only the latest release and the default branch receive security fixes.

## Testing guidance

Test only against your own installation. Do not point a SiteSentry instance, or any scanner, at systems you do not own
or have permission to test.

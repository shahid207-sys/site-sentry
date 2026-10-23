# Site Sentry

Technical SEO audit-to-fix verification. Enter a public URL, run deterministic checks, inspect the evidence, and create a fix task.

## Run

Requires Node 20.19+ (developed on Node 24).

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # rule + SSRF-guard unit tests (no network)
npm run build      # production build + type-check
```

Click **Load sample audit** to see the full workflow without hitting the network. Sample results are produced by running the bundled fixture (`src/lib/sample/sample-page.ts`) through the same rules, and are labelled **SAMPLE DATA** everywhere they appear.

API: `POST /api/audit` with `{"url": "https://example.com"}` or `{"sample": true}`.

## Layout

```
src/lib/audit/        pure, UI-free rule engine
  types.ts            Finding / RuleResult / AuditResult
  parse.ts            Cheerio wrapper
  rules/title.ts      title check (missing, empty, multiple, length heuristics)
  run.ts              rule registry: HTML -> RuleResult[]
  audit.ts            live (fetch + rules) and sample audits
src/lib/fetch/
  safe-fetch.ts       URL validation, DNS check, manual redirects, timeout, size cap
  ip-guard.ts         private/reserved IP blocklist (v4, v6, mapped, NAT64)
src/lib/tasks/        fix-task model + Markdown export
src/app/api/audit/    route handler
src/components/       dashboard UI
```

To add a rule: write `($: CheerioAPI) => RuleResult` in `src/lib/audit/rules/`, add a test next to it, and register it in `run.ts`.

## Fetch safety

- Only `http`/`https` on ports 80/443, with no credentials in the URL and no `localhost`, `.local` or `.internal` hosts.
- Every resolved address is checked against private, loopback, link-local (incl. `169.254.169.254`), CGNAT, multicast and reserved ranges. On DNS64/NAT64 networks, `64:ff9b::/96` and `::ffff:` addresses are judged by their embedded IPv4.
- The same check runs again inside the socket's DNS lookup (undici `Agent`), so a DNS answer that changes between the check and the connection is still refused.
- Redirects are followed manually (max 5) and every hop is re-validated.
- 10s total timeout and a 2 MB body cap. Only `text/html` / `application/xhtml+xml` responses are accepted, and non-2xx responses are reported as errors, never as findings.

## Known MVP limitations

- Raw HTML only, with no JavaScript rendering, so titles set client-side are not seen.
- Charset comes from the `Content-Type` header only (no `<meta charset>` sniffing).
- Fix tasks live in React state and are lost on reload.

# Site Sentry

Technical SEO audit-to-fix verification: run deterministic checks on a public URL, inspect the evidence, create a fix task, then re-scan to prove the fix against the original acceptance criteria.

## Run

Requires Node 20.19+ (developed on Node 24).

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # rule + SSRF-guard unit tests (no network)
npm run build      # production build + type-check
```

Click **Load sample audit** to run the whole loop without a site you control. Sample results come from bundled fixtures (`src/lib/sample/sample-page.ts`) run through the same rules, and are labelled **SAMPLE** everywhere. The **Sample site simulator** switches the demo page between *Original (broken)*, *Fix deployed* and *Site offline*, so you can show all three re-scan outcomes.

Tracked findings are stored in `.data/store.json` (gitignored). Delete that file to reset.

## Evidence-to-resolution workflow

1. **Audit:** `POST /api/audit` with `{url}` or `{sample:true}`. Each rule observes structured *facts*, and each check that fires produces a finding with: rule code, page URL, observed, expected, evidence (HTML/header snippets + facts), severity, recommendations and **acceptance criteria**.
2. **Expectations:** canonical and indexability checks need the owner's intent (expected canonical URL, index/noindex). Until it is set they report `needs_config` with what they observed, never a guess. `PUT /api/expectations` with `{pageUrl, canonicalUrl?, indexability?}`.
3. **Fix task:** `POST /api/findings` with `{auditId, ruleCode}`. Copied from the server's stored audit, never from client-sent evidence. Freezes the finding, the original observation, the expectations and the acceptance criteria (as data, with parameters such as `{max: 60}`).
4. **Re-scan:** `POST /api/findings/:id/verify` (no body). Fetches the page again and evaluates the *stored* criteria with deterministic evaluators. No LLM is involved.

| Outcome | When | Status effect |
|---|---|---|
| `resolved` | every stored criterion passes | → resolved |
| `still_failing` | any criterion fails | → open (reopens a resolved finding as a regression) |
| `inconclusive` | fetch failed (timeout, DNS, 4xx/5xx, non-HTML, blocked), page truncated, URL now redirects to a different page, unknown criterion, unexpected error | unchanged |

Every attempt is appended with its observation, per-criterion results and reason; the original observation is never modified. There is no endpoint that sets status directly.

Invariant (tested for every check): if a check *detects* a problem on some facts, at least one of its acceptance criteria fails on those same facts, so detection and verification can't disagree.

Other endpoints: `GET /api/findings`, `GET|PUT /api/sample-state` (sample only).

## Layout

```
src/lib/audit/        pure, UI-free rule engine
  types.ts            Finding / RuleResult / TrackedFinding / VerificationAttempt
  rule.ts             RuleDef + CheckDef (detect, criteria, describe), criterion evaluation
  rules/              title, canonical, indexability (+ tests)
  run.ts              rule + criterion-evaluator registries
src/lib/workflow/
  verify.ts           pure: evaluateAttempt, applyAttempt (the only status transition)
  service.ts          audit, track, verify, expectations (deps injected for tests)
  pages.ts            live fetcher + sample site simulator
src/lib/fetch/        SSRF-safe fetching
src/lib/store/        Store interface, JSON-file and in-memory implementations
src/lib/tasks/        fix-task Markdown export
src/app/api/          route handlers
src/components/       dashboard UI
```

To add a rule: write a `RuleDef` in `src/lib/audit/rules/` (observe → facts, checks with detect/criteria/describe, and criterion evaluators), register both in `run.ts`, and add tests. The invariant test in `run.test.ts` covers new checks automatically once you add fact cases.

## Fetch safety

- Only `http`/`https` on ports 80/443, with no credentials in the URL and no `localhost`, `.local` or `.internal` hosts.
- Every resolved address is checked against private, loopback, link-local (incl. `169.254.169.254`), CGNAT, multicast and reserved ranges. On DNS64/NAT64 networks, `64:ff9b::/96` and `::ffff:` addresses are judged by their embedded IPv4.
- The same check runs again inside the socket's DNS lookup (undici `Agent`), so a DNS answer that changes between the check and the connection is still refused.
- Redirects are followed manually (max 5) and every hop is re-validated.
- 10s total timeout and a 2 MB body cap. Only `text/html` / `application/xhtml+xml` responses are accepted, and non-2xx responses are reported as errors, never as findings.

## Known MVP limitations

- Raw HTML only, with no JavaScript rendering, so titles set client-side are not seen.
- Charset comes from the `Content-Type` header only (no `<meta charset>` sniffing).
- JSON-file store: fine for one local process; use a database for multi-instance or serverless deploys.
- Indexability reads robots meta and X-Robots-Tag, not robots.txt; any user-agent prefix in X-Robots-Tag is treated as applying.
- Canonical reads the HTML link only, not the `Link:` HTTP header.
- Findings on pages over 2 MB (truncated) cannot be tracked, because a re-scan of a truncated page is always inconclusive.

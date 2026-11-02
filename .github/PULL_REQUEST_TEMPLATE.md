## What and why

<!-- What does this change, and why? Link the issue. -->

## How I tested

- [ ] `npm run lint`, `npm run typecheck`, `npm test`
- [ ] `npm run test:int` (Postgres and Redis)
- [ ] Gate(s) run for the area touched: <!-- e.g. gate:p2b, or n/a -->

## Checklist

- [ ] New or changed rule: a positive and a negative fixture and test, and the rule version bumped if its output changed
- [ ] Schema change: migration added with `npm run db:generate`
- [ ] New environment variable: added to `.env.example` and the docs
- [ ] No secrets, `.env*` files, crawl exports, reports or third-party site data committed
- [ ] I agree my contribution is licensed under AGPL-3.0

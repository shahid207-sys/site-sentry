// Phase 2b gate: the shared Phase 2 gate (gate-p2.ts) requiring every implemented rule to fire, plus the 2b checks
// (SITE-001 on /products/, resource budgets counted at the server, no /.env content stored).
// Run: npm run gate:p2b   (needs `docker compose up -d postgres redis`; uses its own database, sitesentry_gate2b)
import { runGate } from "./gate-p2";

runGate("2b").catch((e) => {
  console.error(e);
  process.exit(1);
});

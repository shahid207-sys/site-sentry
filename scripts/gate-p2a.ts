// Phase 2a gate: the shared Phase 2 gate (gate-p2.ts) requiring the IDX, META, CNT and AIS rules to fire.
// Run: npm run gate:p2a   (needs `docker compose up -d`; uses its own database, sitesentry_gate2a)
import { runGate } from "./gate-p2";

runGate("2a").catch((e) => {
  console.error(e);
  process.exit(1);
});

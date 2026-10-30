// The scheduled-audit tick: every SCHEDULER_TICK_MS (default 60 s) launch the schedules that are due. It runs only
// where scheduled audits can (crawler v2 on) and can be turned off per instance with SCHEDULER=off, e.g. to run the
// scheduler on one instance only (claiming is safe with several: a due slot is claimed by exactly one).
import { crawlerV2Enabled } from "./lib/crawl/v2/flag";

const g = globalThis as { __ssScheduler?: ReturnType<typeof setInterval> };

if (process.env.SCHEDULER !== "off" && crawlerV2Enabled("live") && !g.__ssScheduler) {
  const every = Number(process.env.SCHEDULER_TICK_MS) > 0 ? Number(process.env.SCHEDULER_TICK_MS) : 60_000;
  let busy = false;
  let lastError = "";
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const { runDueSchedules } = await import("./lib/server/schedules");
      const r = await runDueSchedules();
      for (const l of r.launched) console.log(JSON.stringify({ t: new Date().toISOString(), event: "schedule.launched", ...l }));
      for (const f of r.failed) console.log(JSON.stringify({ t: new Date().toISOString(), event: "schedule.launch_failed", ...f }));
      lastError = "";
    } catch (e) {
      // Once per distinct error (a database without migration 0018 would otherwise log every tick).
      const message = (e as Error).message;
      if (message !== lastError) console.error(JSON.stringify({ t: new Date().toISOString(), event: "schedule.tick_failed", message }));
      lastError = message;
    } finally {
      busy = false;
    }
  };
  g.__ssScheduler = setInterval(() => void tick(), every);
  g.__ssScheduler.unref?.();
}

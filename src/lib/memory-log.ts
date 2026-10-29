// Process memory sampling for long-running jobs (worker, gates): RSS and V8 heap every interval, appended as JSON lines
// to a file, with the peak kept. Past `limitBytes` of RSS it writes one heap snapshot next to the log and calls onLimit,
// so a leak is caught with evidence before it starves the machine.
import { appendFileSync } from "node:fs";
import path from "node:path";
import { writeHeapSnapshot } from "node:v8";

export interface MemoryPeak {
  rss: number;
  heapUsed: number;
  atSec: number;
}

const mb = (n: number) => Math.round(n / 1048576);

export function startMemoryLog(opts: { file: string; label: string; everyMs?: number; limitBytes?: number; onLimit?: (rss: number, snapshot: string | null) => void }) {
  const t0 = Date.now();
  const peak: MemoryPeak = { rss: 0, heapUsed: 0, atSec: 0 };
  let tripped = false;
  const sample = () => {
    const m = process.memoryUsage();
    const atSec = Math.round((Date.now() - t0) / 1000);
    if (m.rss > peak.rss) Object.assign(peak, { rss: m.rss, atSec });
    peak.heapUsed = Math.max(peak.heapUsed, m.heapUsed);
    const line = { t: new Date().toISOString(), label: opts.label, pid: process.pid, s: atSec, rssMb: mb(m.rss), heapUsedMb: mb(m.heapUsed), heapTotalMb: mb(m.heapTotal), externalMb: mb(m.external), arrayBuffersMb: mb(m.arrayBuffers) };
    try {
      appendFileSync(opts.file, JSON.stringify(line) + "\n");
    } catch {
      // the log is diagnostic; a failed write must not stop the job
    }
    if (opts.limitBytes && m.rss > opts.limitBytes && !tripped) {
      tripped = true;
      let snapshot: string | null = null;
      try {
        snapshot = writeHeapSnapshot(path.join(path.dirname(opts.file), `${opts.label}-${process.pid}-${atSec}s.heapsnapshot`));
      } catch {
        snapshot = null;
      }
      opts.onLimit?.(m.rss, snapshot);
    }
  };
  sample();
  const timer = setInterval(sample, opts.everyMs ?? 10_000);
  timer.unref();
  return {
    peak,
    stop() {
      clearInterval(timer);
      sample();
      return peak;
    },
  };
}

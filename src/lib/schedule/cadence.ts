// When a scheduled audit runs next (docs/SPEC.md "Scheduled audits (daily, weekly, monthly)"). All times are UTC: a
// schedule runs at `hourUtc`:00 every day, on one weekday every week, or on one day of the month (1–28, so every month
// has it). Pure: the scheduler passes the clock in.

export const CADENCES = ["daily", "weekly", "monthly"] as const;
export type Cadence = (typeof CADENCES)[number];

export interface ScheduleTiming {
  cadence: Cadence;
  /** 0–23, UTC. */
  hourUtc: number;
  /** 0 (Sunday) – 6, weekly only. */
  weekday?: number | null;
  /** 1–28, monthly only. */
  monthday?: number | null;
}

/** Why a timing is invalid, or null. */
export function timingProblem(t: ScheduleTiming): string | null {
  if (!CADENCES.includes(t.cadence)) return "Choose daily, weekly or monthly.";
  if (!Number.isInteger(t.hourUtc) || t.hourUtc < 0 || t.hourUtc > 23) return "The hour must be 0–23 (UTC).";
  if (t.cadence === "weekly" && !(Number.isInteger(t.weekday) && t.weekday! >= 0 && t.weekday! <= 6)) return "Choose the weekday of a weekly audit.";
  if (t.cadence === "monthly" && !(Number.isInteger(t.monthday) && t.monthday! >= 1 && t.monthday! <= 28)) return "The day of a monthly audit must be 1–28.";
  return null;
}

/** The first run time strictly after `after`. */
export function nextRun(t: ScheduleTiming, after: Date): Date {
  const problem = timingProblem(t);
  if (problem) throw new Error(problem);
  const d = new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate(), t.hourUtc));
  if (t.cadence === "daily") {
    if (d <= after) d.setUTCDate(d.getUTCDate() + 1);
    return d;
  }
  if (t.cadence === "weekly") {
    d.setUTCDate(d.getUTCDate() + ((t.weekday! - d.getUTCDay() + 7) % 7));
    if (d <= after) d.setUTCDate(d.getUTCDate() + 7);
    return d;
  }
  d.setUTCDate(t.monthday!);
  if (d <= after) d.setUTCMonth(d.getUTCMonth() + 1, t.monthday!);
  return d;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Daily at 06:00 UTC", "Weekly on Monday at 06:00 UTC", "Monthly on day 1 at 06:00 UTC". */
export function describeTiming(t: ScheduleTiming): string {
  const at = `at ${String(t.hourUtc).padStart(2, "0")}:00 UTC`;
  if (t.cadence === "daily") return `Daily ${at}`;
  if (t.cadence === "weekly") return `Weekly on ${WEEKDAYS[t.weekday ?? 0]} ${at}`;
  return `Monthly on day ${t.monthday} ${at}`;
}

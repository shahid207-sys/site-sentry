import { createSchedule, listSiteSchedules, ScheduleBody } from "@/lib/server/schedules";
import { body, rateLimit, route } from "../../_lib/handler";

export const GET = route<{ ws: string }>(async (req, { ws }) => listSiteSchedules(ws, req.nextUrl.searchParams.get("site") ?? undefined));

/** The response's webhookSecret is shown once: only its encrypted form is stored. */
export const POST = route<{ ws: string }>(async (req, { ws }) => {
  rateLimit(req, `schedule:${ws}`, 20, 60_000);
  return createSchedule(ws, await body(req, ScheduleBody));
});

import { removeSchedule, SchedulePatch, updateSchedule } from "@/lib/server/schedules";
import { body, route } from "../../../_lib/handler";

type P = { ws: string; id: string };

/** { enabled } pauses or resumes; { runNow: true } runs it at the next scheduler tick. */
export const PATCH = route<P>(async (req, { ws, id }) => updateSchedule(ws, id, await body(req, SchedulePatch)));

export const DELETE = route<P>(async (_req, { ws, id }) => removeSchedule(ws, id));

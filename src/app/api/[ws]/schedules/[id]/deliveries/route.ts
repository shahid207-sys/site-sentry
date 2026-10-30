import { scheduleDeliveries } from "@/lib/server/schedules";
import { route } from "../../../../_lib/handler";

export const GET = route<{ ws: string; id: string }>(async (_req, { ws, id }) => scheduleDeliveries(ws, id));

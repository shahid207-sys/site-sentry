import { ruleCatalog } from "@/lib/server/results";
import { route } from "../../_lib/handler";

/** Every implemented rule with its title, category, impact, confidence and why / fix / acceptance text. */
export const GET = route<{ ws: string }>(async () => ruleCatalog());

// JSON-LD entities of a page, for the structured data rules (SD). A block's parsed value can be one entity, an array
// of entities, or an object with @graph; each entity can nest more entities as property values.

export type Entity = Record<string, unknown>;

export interface EntityRef {
  entity: Entity;
  /** schema.org types of the entity, without a "schema:" or schema.org URL prefix. */
  types: string[];
  /** Property path from the top-level entity ("" for a top-level one), e.g. "offers" or "review.reviewRating". */
  path: string;
  /** Index of the JSON-LD block it came from. */
  block: number;
  /** The entity it is nested in; null at the top level. */
  parent: EntityRef | null;
}

const PREFIX = /^(?:https?:\/\/schema\.org\/|schema:)/i;
export const typeName = (t: string) => t.replace(PREFIX, "");

const isEntity = (v: unknown): v is Entity => !!v && typeof v === "object" && !Array.isArray(v);

export function typesOf(e: Entity): string[] {
  const t = e["@type"];
  return (Array.isArray(t) ? t : t === undefined ? [] : [t]).filter((x): x is string => typeof x === "string").map(typeName);
}

/** Is @context schema.org (or absent, which search engines read as schema.org when the types are)? */
export function schemaOrgContext(ctx: unknown): boolean {
  if (ctx === undefined || ctx === null) return true;
  if (typeof ctx === "string") return /schema\.org/i.test(ctx);
  if (Array.isArray(ctx)) return ctx.some(schemaOrgContext);
  if (isEntity(ctx)) return typeof ctx["@vocab"] === "string" ? /schema\.org/i.test(ctx["@vocab"]) : true;
  return false;
}

const topLevel = (parsed: unknown): { entity: Entity; context: unknown }[] => {
  const out: { entity: Entity; context: unknown }[] = [];
  const add = (v: unknown, context: unknown) => {
    if (Array.isArray(v)) return v.forEach((x) => add(x, context));
    if (!isEntity(v)) return;
    const ctx = v["@context"] ?? context;
    if (Array.isArray(v["@graph"])) return (v["@graph"] as unknown[]).forEach((x) => add(x, ctx));
    out.push({ entity: v, context: ctx });
  };
  add(parsed, undefined);
  return out;
};

/** Every entity of the parsed blocks, top-level first then nested, depth-first; only schema.org contexts. */
export function entities(blocks: { parsed: unknown; error: string | null }[]): EntityRef[] {
  const out: EntityRef[] = [];
  const walk = (entity: Entity, path: string, block: number, parent: EntityRef | null, depth: number) => {
    const ref: EntityRef = { entity, types: typesOf(entity), path, block, parent };
    out.push(ref);
    if (depth > 8) return;
    for (const [k, v] of Object.entries(entity)) {
      if (k.startsWith("@")) continue;
      for (const x of Array.isArray(v) ? v : [v]) if (isEntity(x)) walk(x, path ? `${path}.${k}` : k, block, ref, depth + 1);
    }
  };
  blocks.forEach((b, i) => {
    if (b.error) return;
    for (const t of topLevel(b.parsed)) if (schemaOrgContext(t.context)) walk(t.entity, "", i, null, 0);
  });
  return out;
}

/** A property value counts as present when it is not null, "", or an empty array. */
const present = (v: unknown) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length);

/** Value(s) at a dotted path; arrays along the way are searched (any element). */
export function valuesAt(e: Entity, path: string): unknown[] {
  let cur: unknown[] = [e];
  for (const key of path.split(".")) {
    const next: unknown[] = [];
    for (const c of cur) {
      for (const x of Array.isArray(c) ? c : [c]) {
        if (isEntity(x) && present(x[key])) next.push(...(Array.isArray(x[key]) ? (x[key] as unknown[]) : [x[key]]));
      }
    }
    cur = next;
  }
  return cur.filter(present);
}

/**
 * The properties of `required` missing from `e`. "a|b" is satisfied by either; a dotted path whose parent is absent
 * is reported as the parent ("reviewRating", not "reviewRating.ratingValue").
 */
export function missing(e: Entity, required: string[]): string[] {
  const out = new Set<string>();
  for (const req of required) {
    const alts = req.split("|");
    if (alts.some((a) => valuesAt(e, a).length)) continue;
    const parents = alts.map((a) => (a.includes(".") && !valuesAt(e, a.split(".")[0]).length ? a.split(".")[0] : a));
    out.add(parents.length === 1 ? parents[0] : parents.join(" or "));
  }
  return [...out];
}

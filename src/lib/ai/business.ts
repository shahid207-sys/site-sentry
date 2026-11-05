// The business behind the site, as its own structured data states it: name and address from LocalBusiness or
// Organization JSON-LD. The AI analyst uses it so a rewrite names the real location instead of inventing one.
import { entities, type Entity } from "../rules/jsonld";

export interface BusinessFacts {
  name: string | null;
  types: string[];
  street: string | null;
  locality: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  areaServed: string[];
  /** The page whose JSON-LD this came from. */
  sourceUrl: string;
}

/** LocalBusiness and its subtypes (Store, ProfessionalService, Restaurant…) end in one of these; Organization too. */
const BUSINESS_TYPE = /(LocalBusiness|Organization|Organisation|Corporation|Business|Store|Service|Shop|Agency|Restaurant|Company)$/;

const str = (v: unknown): string | null => {
  if (typeof v === "string") return v.replace(/\s+/g, " ").trim().replace(/,$/, "") || null;
  if (typeof v === "number") return String(v);
  if (v && typeof v === "object" && !Array.isArray(v)) return str((v as Entity).name);
  return null;
};
const list = (v: unknown): string[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).map(str).filter((x): x is string => !!x);

function addressOf(e: Entity): Pick<BusinessFacts, "street" | "locality" | "region" | "postalCode" | "country"> | null {
  const raw = Array.isArray(e.address) ? e.address[0] : e.address;
  if (typeof raw === "string") return raw.trim() ? { street: raw.trim(), locality: null, region: null, postalCode: null, country: null } : null;
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Entity;
  const out = { street: str(a.streetAddress), locality: str(a.addressLocality), region: str(a.addressRegion), postalCode: str(a.postalCode), country: str(a.addressCountry) };
  return Object.values(out).some(Boolean) ? out : null;
}

/**
 * The best business entity across pages, in the order given (the homepage first): a LocalBusiness with an address
 * beats an Organization with one, which beats either without. Null when no page states one.
 */
export function businessFacts(pages: { url: string; jsonLd: { parsed: unknown; error: string | null }[] | null }[]): BusinessFacts | null {
  let best: { score: number; facts: BusinessFacts } | null = null;
  for (const p of pages) {
    for (const ref of entities(p.jsonLd ?? [])) {
      const types = ref.types.filter((t) => BUSINESS_TYPE.test(t));
      if (!types.length) continue;
      const address = addressOf(ref.entity);
      const local = ref.types.some((t) => t !== "Organization" && t !== "Corporation");
      const score = (address ? 2 : 0) + (local ? 1 : 0);
      if (best && best.score >= score) continue;
      best = {
        score,
        facts: { name: str(ref.entity.name), types: ref.types, street: null, locality: null, region: null, postalCode: null, country: null, ...address, areaServed: list(ref.entity.areaServed).slice(0, 10), sourceUrl: p.url },
      };
    }
  }
  return best?.facts ?? null;
}

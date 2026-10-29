// Structured data rules (docs/SPEC.md catalog, SD), over the page's JSON-LD blocks. Vocabulary from the vendored
// schema.org file (data/schema-org.ts); Google's required/recommended properties and deprecations from the vendored
// table (data/google-structured-data.ts). Meeting Google's lists is necessary for a rich result, not sufficient:
// no rule or message claims a page is eligible.
import { finding, type Finding, type PageRule, type PageView } from "./contract";
import { DEPRECATED_TYPES, GOOGLE_TYPES, LOCAL_BUSINESS_SUBTYPES, type GoogleType } from "./data/google-structured-data";
import { SCHEMA_PROPERTIES, SCHEMA_TYPES } from "./data/schema-org";
import { entities, missing, valuesAt, type EntityRef } from "./jsonld";
import { homeUrl, isHtml200 } from "./util";

const page = (r: Omit<PageRule, "scope" | "category">): PageRule => ({ scope: "page", category: "structured_data", ...r });

const EVIDENCE_CAP = 20;
const NO_ELIGIBILITY = "Meeting Google's required properties does not by itself make a page eligible for a rich result.";

/** The Google table entry for a type; LocalBusiness subtypes use LocalBusiness's. */
function googleType(t: string): { name: string; spec: GoogleType } | null {
  if (GOOGLE_TYPES[t]) return { name: t, spec: GOOGLE_TYPES[t] };
  if (LOCAL_BUSINESS_SUBTYPES.includes(t)) return { name: "LocalBusiness", spec: GOOGLE_TYPES.LocalBusiness };
  return null;
}

/**
 * Nested entities the Google table checks, and where Google's lists apply to them: an Offer only as a Product's
 * `offers` (product snippets; an Offer in a service's OfferCatalog has no price requirement), a ListItem only in a
 * BreadcrumbList. Reviews and ratings apply wherever they are nested. Top-level types are checked only at the top.
 */
const PRODUCT_TYPES = new Set(["Product", "ProductGroup", "IndividualProduct", "ProductModel", "Vehicle", "Car"]);
const lastKey = (ref: EntityRef) => ref.path.split(".").pop() ?? "";
const NESTED_CHECKED: Record<string, (ref: EntityRef) => boolean> = {
  Offer: (ref) => lastKey(ref) === "offers" && ref.parent!.types.some((t) => PRODUCT_TYPES.has(t)),
  AggregateOffer: (ref) => lastKey(ref) === "offers" && ref.parent!.types.some((t) => PRODUCT_TYPES.has(t)),
  ListItem: (ref) => lastKey(ref) === "itemListElement" && ref.parent!.types.includes("BreadcrumbList"),
  Review: () => true,
  AggregateRating: () => true,
};

/** Entities to check against Google's lists, with the properties that apply where they sit. */
function googleChecks(p: PageView): { ref: EntityRef; type: string; spec: GoogleType; drop: Set<string> }[] {
  const out: { ref: EntityRef; type: string; spec: GoogleType; drop: Set<string> }[] = [];
  for (const ref of entities(p.jsonLd)) {
    for (const t of ref.types) {
      const g = googleType(t);
      if (!g) continue;
      const nested = ref.parent !== null;
      if (nested ? !NESTED_CHECKED[g.name]?.(ref) : g.spec.nestedOnly) continue;
      // A review or rating nested in the item it reviews needs no itemReviewed.
      out.push({ ref, type: t, spec: g.spec, drop: new Set(nested ? ["itemReviewed"] : []) });
    }
  }
  return out;
}

const where = (ref: EntityRef) => (ref.path ? `${ref.path} of block ${ref.block + 1}` : `block ${ref.block + 1}`);

const SD001 = page({
  id: "SD-001",
  version: 1,
  confidence: "verified",
  impact: 3,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p)) return [];
    const bad = p.jsonLd.map((b, i) => ({ block: i + 1, error: b.error })).filter((b) => b.error);
    return bad.length ? [finding(SD001, p.url, `${bad.length} JSON-LD block(s) do not parse; search engines ignore them.`, { blocks: bad })] : [];
  },
  explain: {
    why: "A JSON-LD block that is not valid JSON is ignored entirely.",
    fix: "Fix the syntax (trailing commas, unescaped quotes, comments) and validate the block.",
    acceptance: "Every JSON-LD block on the page parses.",
    docs: "https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data",
  },
});

const SD002 = page({
  id: "SD-002",
  version: 2,
  confidence: "verified",
  impact: 2,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p)) return [];
    const types = new Set<string>();
    const props = new Set<string>();
    for (const ref of entities(p.jsonLd)) {
      for (const t of ref.types) if (!SCHEMA_TYPES.has(t)) types.add(t);
      // Prefixed names (og:x, ex:y) and absolute IRIs belong to other vocabularies. "<property>-input" and
      // "<property>-output" are schema.org Action annotations (schema.org/docs/actions.html), e.g. SearchAction's
      // "query-input".
      for (const k of Object.keys(ref.entity)) if (!k.startsWith("@") && !k.includes(":") && !SCHEMA_PROPERTIES.has(k.replace(/-(input|output)$/, ""))) props.add(k);
    }
    if (!types.size && !props.size) return [];
    return [finding(SD002, p.url, `Unknown schema.org ${[types.size ? `type(s): ${[...types].join(", ")}` : "", props.size ? `propert(ies): ${[...props].join(", ")}` : ""].filter(Boolean).join("; ")}.`, { types: [...types], properties: [...props].slice(0, EVIDENCE_CAP) })];
  },
  explain: {
    why: "Misspelled or invented types and properties are ignored by search engines.",
    fix: "Use the exact schema.org name (case-sensitive), or remove the property.",
    acceptance: "Every type and property is in the schema.org vocabulary.",
    docs: "https://schema.org/docs/full.html",
  },
});

const SD003 = page({
  id: "SD-003",
  version: 2,
  confidence: "verified",
  impact: 3,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p)) return [];
    const gaps = googleChecks(p)
      .map((c) => ({ type: c.type, at: where(c.ref), missing: missing(c.ref.entity, c.spec.required.filter((r) => !c.drop.has(r))), source: c.spec.source }))
      .filter((g) => g.missing.length);
    if (!gaps.length) return [];
    return [finding(SD003, p.url, `${gaps.map((g) => `${g.type} (${g.at}) lacks ${g.missing.join(", ")}`).join("; ")}. Google lists these as required.`, { gaps: gaps.slice(0, EVIDENCE_CAP), note: NO_ELIGIBILITY })];
  },
  explain: {
    why: "Google does not use markup for a feature when a required property is missing.",
    fix: "Add the missing properties with values that match the visible content.",
    acceptance: "Every Google-documented type on the page has all its required properties.",
    docs: "https://developers.google.com/search/docs/appearance/structured-data/search-gallery",
  },
});

const SD004 = page({
  id: "SD-004",
  version: 2,
  confidence: "heuristic",
  impact: 1,
  needs: ["raw"],
  // Recommended properties come from the template that renders the type: one finding per schema type per template
  // group, with every page counted in evidence.pages, not one per page.
  groupByTemplate: true,
  evaluate({ page: p }) {
    if (!isHtml200(p)) return [];
    const byType = new Map<string, { at: string[]; missing: Set<string>; source: string }>();
    for (const c of googleChecks(p)) {
      const m = missing(c.ref.entity, c.spec.recommended);
      if (!m.length) continue;
      const g = byType.get(c.type) ?? { at: [], missing: new Set<string>(), source: c.spec.source };
      g.at.push(where(c.ref));
      for (const x of m) g.missing.add(x);
      byType.set(c.type, g);
    }
    return [...byType].map(([type, g]) => {
      const miss = [...g.missing];
      return finding(SD004, p.url, `${type} (${g.at.join(", ")}) lacks recommended ${miss.join(", ")}.`, { groupKey: type, type, at: g.at.slice(0, EVIDENCE_CAP), missing: miss, source: g.source, note: NO_ELIGIBILITY });
    });
  },
  explain: {
    why: "Recommended properties give search engines more to show and understand; they are optional.",
    fix: "Add the recommended properties the page has real values for.",
    acceptance: "Every Google-documented type on the pages of the template has its recommended properties, or the pages have no value for them.",
    docs: "https://developers.google.com/search/docs/appearance/structured-data/search-gallery",
  },
});

/** Types a page describes once: two blocks of one of these that disagree contradict each other. */
const SINGLETON_TYPES = new Set(["Organization", "WebSite", "WebPage", "Article", "NewsArticle", "BlogPosting", ...LOCAL_BUSINESS_SUBTYPES]);
const scalar = (v: unknown) => (typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v).trim() : null);

const SD005 = page({
  id: "SD-005",
  version: 1,
  confidence: "heuristic",
  impact: 2,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p)) return [];
    const groups = new Map<string, EntityRef[]>();
    for (const ref of entities(p.jsonLd)) {
      if (ref.parent) continue;
      const id = typeof ref.entity["@id"] === "string" ? `id:${ref.entity["@id"]}` : null;
      const t = ref.types.find((x) => SINGLETON_TYPES.has(x));
      const key = id ?? (t ? `type:${t}` : null);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(ref);
    }
    const conflicts: { subject: string; property: string; values: string[] }[] = [];
    for (const [key, refs] of groups) {
      if (refs.length < 2) continue;
      const keys = new Set(refs.flatMap((r) => Object.keys(r.entity).filter((k) => !k.startsWith("@"))));
      for (const k of keys) {
        const values = [...new Set(refs.map((r) => scalar(r.entity[k])).filter((v): v is string => v !== null))];
        if (values.length > 1) conflicts.push({ subject: key.replace(/^(type|id):/, ""), property: k, values });
      }
    }
    if (!conflicts.length) return [];
    return [finding(SD005, p.url, `Duplicate structured data disagrees: ${conflicts.slice(0, 3).map((c) => `${c.subject}.${c.property} is ${c.values.map((v) => `"${v}"`).join(" vs ")}`).join("; ")}.`, { conflicts: conflicts.slice(0, EVIDENCE_CAP) })];
  },
  explain: {
    why: "Two blocks describing the same thing with different values (often a theme plus a plugin) leave search engines to guess.",
    fix: "Keep one block per entity (or merge them with one @id), and remove the plugin or theme output you do not want.",
    acceptance: "No two blocks of the same entity disagree on a property.",
  },
});

/** "4.5", "4,5", "1234", "1,234": forms a rating number can take in page text. */
function numberForms(v: string): string[] {
  const n = Number(v);
  if (!Number.isFinite(n)) return [v];
  const forms = new Set([v, String(n), n.toLocaleString("en-US"), String(n).replace(".", ",")]);
  if (Number.isInteger(n)) forms.add(n.toFixed(1));
  return [...forms];
}

const SD006 = page({
  id: "SD-006",
  version: 1,
  confidence: "heuristic",
  impact: 3,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p)) return [];
    const text = [p.mainText, ...p.titles, ...p.outline.map((h) => h.text)].join(" ");
    const hidden: { type: string; property: string; value: string }[] = [];
    for (const ref of entities(p.jsonLd)) {
      if (!ref.types.some((t) => t === "AggregateRating" || t === "Rating")) continue;
      for (const prop of ["ratingValue", "reviewCount", "ratingCount"]) {
        for (const v of valuesAt(ref.entity, prop).map(scalar)) {
          if (v === null) continue;
          const seen = numberForms(v).some((f) => new RegExp(`(^|[^\\d.,])${f.replace(/[.,]/g, "\\$&")}(?![\\d]|[.,]\\d)`).test(text));
          if (!seen) hidden.push({ type: ref.types[0], property: prop, value: v });
        }
      }
    }
    if (!hidden.length) return [];
    return [finding(SD006, p.url, `Rating markup not shown in the page's text: ${hidden.map((h) => `${h.property} ${h.value}`).join(", ")}.`, { hidden: hidden.slice(0, EVIDENCE_CAP) })];
  },
  explain: {
    why: "Google's structured data policies require marked-up ratings and reviews to be visible to users; hidden markup can earn a manual action.",
    fix: "Show the rating and review count on the page, or remove the markup.",
    acceptance: "Every marked-up rating value and count appears in the page's text.",
    docs: "https://developers.google.com/search/docs/appearance/structured-data/sd-policies",
  },
});

/** Organization and its common subtypes (any LocalBusiness subtype counts too). */
const ORGANIZATION_TYPES = new Set([
  "Organization",
  "Corporation",
  "NGO",
  "OnlineBusiness",
  "OnlineStore",
  "EducationalOrganization",
  "GovernmentOrganization",
  "MedicalOrganization",
  "NewsMediaOrganization",
  "SportsOrganization",
  "Airline",
  "Consortium",
  "LibrarySystem",
  "PerformingGroup",
  "ResearchOrganization",
  ...LOCAL_BUSINESS_SUBTYPES,
]);

const SD007 = page({
  id: "SD-007",
  version: 1,
  confidence: "advisory",
  impact: 1,
  needs: ["raw"],
  evaluate({ page: p, crawl }) {
    if (!isHtml200(p) || p.url !== homeUrl(crawl.origin)) return [];
    if (entities(p.jsonLd).some((r) => r.types.some((t) => ORGANIZATION_TYPES.has(t)))) return [];
    return [finding(SD007, p.url, "The home page has no Organization or LocalBusiness structured data.", {})];
  },
  explain: {
    why: "Organization markup on the home page helps search engines connect the site to its logo, name and profiles.",
    fix: "Add an Organization (or LocalBusiness subtype) block with name, url and logo to the home page.",
    acceptance: "The home page has an Organization or LocalBusiness entity.",
    docs: "https://developers.google.com/search/docs/appearance/structured-data/organization",
  },
});

/** Path segments of a URL ("/a/b/" → 2). */
const segments = (url: string) => new URL(url).pathname.split("/").filter(Boolean).length;
export const DEEP_PAGE_SEGMENTS = 3; // "deep": two parent levels (/a/b/page); a flat /section/page has little trail to show

const SD008 = page({
  id: "SD-008",
  version: 1,
  confidence: "advisory",
  impact: 1,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p) || segments(p.url) < DEEP_PAGE_SEGMENTS) return [];
    if (entities(p.jsonLd).some((r) => r.types.includes("BreadcrumbList"))) return [];
    return [finding(SD008, p.url, `A page ${segments(p.url)} levels deep with no BreadcrumbList structured data.`, { segments: segments(p.url) })];
  },
  explain: {
    why: "Breadcrumb markup shows the page's place in the site in search results instead of a raw URL.",
    fix: "Add a BreadcrumbList matching the visible breadcrumb trail.",
    acceptance: "Pages two or more levels deep have a BreadcrumbList.",
    docs: "https://developers.google.com/search/docs/appearance/structured-data/breadcrumb",
  },
});

const SD009 = page({
  id: "SD-009",
  version: 1,
  confidence: "verified",
  impact: 3,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p)) return [];
    const bad: { at: string; problem: string }[] = [];
    for (const ref of entities(p.jsonLd)) {
      if (!ref.types.includes("Product")) continue;
      if (!valuesAt(ref.entity, "offers").length) bad.push({ at: where(ref), problem: "no offers" });
      else if (!["offers.price", "offers.lowPrice", "offers.priceSpecification.price"].some((x) => valuesAt(ref.entity, x).length)) bad.push({ at: where(ref), problem: "offers without a price" });
    }
    return bad.length ? [finding(SD009, p.url, `Product markup ${bad.map((b) => `(${b.at}) has ${b.problem}`).join("; ")}.`, { products: bad.slice(0, EVIDENCE_CAP) })] : [];
  },
  explain: {
    why: "Product results show price and availability from offers; without them a product snippet has little to show.",
    fix: "Add offers with price, priceCurrency and availability (or AggregateOffer with lowPrice).",
    acceptance: "Every Product has offers with a price.",
    docs: "https://developers.google.com/search/docs/appearance/structured-data/product-snippet",
  },
});

const SD010 = page({
  id: "SD-010",
  version: 1,
  confidence: "advisory",
  impact: 1,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p)) return [];
    const found = [...new Set(entities(p.jsonLd).flatMap((r) => r.types).filter((t) => DEPRECATED_TYPES[t]))];
    if (!found.length) return [];
    const out: Finding[] = [finding(SD010, p.url, `Uses ${found.join(", ")}, which Google no longer shows as a rich result.`, { types: found.map((t) => ({ type: t, ...DEPRECATED_TYPES[t] })) })];
    return out;
  },
  explain: {
    why: "Markup for retired rich results costs maintenance and page weight for no search feature.",
    fix: "Remove the markup, or keep it only if another consumer you rely on reads it.",
    acceptance: "No type Google has retired from rich results.",
    docs: "https://developers.google.com/search/updates",
  },
});

export const SD_RULES = [SD001, SD002, SD003, SD004, SD005, SD006, SD007, SD008, SD009, SD010];

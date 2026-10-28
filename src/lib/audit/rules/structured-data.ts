import { excerpt } from "../parse";
import type { CriterionEvaluator, RuleDef } from "../rule";
import { num } from "../rule";

/**
 * Site Sentry's own minimal list of properties per type. This is a basic completeness check,
 * NOT Schema.org validation and NOT Google rich-result eligibility.
 */
export const REQUIRED_PROPERTIES: Record<string, string[]> = {
  Organization: ["name", "url"],
  LocalBusiness: ["name", "address"],
  Product: ["name"],
  Offer: ["price", "priceCurrency"],
  Article: ["headline"],
  NewsArticle: ["headline"],
  BlogPosting: ["headline"],
  BreadcrumbList: ["itemListElement"],
  FAQPage: ["mainEntity"],
  WebSite: ["name", "url"],
  Event: ["name", "startDate"],
};

export type StructuredDataFacts = {
  jsonLdBlocks: number;
  jsonLdInvalid: number;
  /** First parse error with its position, e.g. "Unexpected token } in JSON at position 41". */
  jsonLdFirstError: string | null;
  /** Distinct @type values found, comma-separated. */
  schemaTypes: string | null;
  /** Count of missing basic properties across all typed nodes. */
  missingProperties: number;
  /** e.g. "Product: name; Organization: url". */
  missingPropertyList: string | null;
};

type Node = Record<string, unknown>;

function collectNodes(value: unknown, out: Node[], depth = 0) {
  if (depth > 8 || out.length > 200) return;
  if (Array.isArray(value)) value.forEach((v) => collectNodes(v, out, depth + 1));
  else if (value && typeof value === "object") {
    const node = value as Node;
    if (node["@type"]) out.push(node);
    for (const [k, v] of Object.entries(node)) if (k !== "@context") collectNodes(v, out, depth + 1);
  }
}

const typesOf = (n: Node) => (Array.isArray(n["@type"]) ? n["@type"] : [n["@type"]]).filter((t): t is string => typeof t === "string");
const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

export const structuredDataEvaluators: Record<string, CriterionEvaluator> = {
  "jsonld.valid": (f) => ({
    passed: num(f.jsonLdInvalid) === 0,
    actual: num(f.jsonLdInvalid) ? `${f.jsonLdInvalid} invalid block(s): ${f.jsonLdFirstError}` : `${f.jsonLdBlocks} block(s), all valid JSON`,
  }),
  "jsonld.required-properties": (f) => ({
    passed: num(f.missingProperties) === 0,
    actual: f.missingPropertyList ? `missing ${f.missingPropertyList}` : "no missing basic properties",
  }),
};

export const structuredDataRule: RuleDef<StructuredDataFacts> = {
  id: "structured-data",
  name: "Structured data (JSON-LD)",
  category: "structured-data",

  observe({ $ }) {
    const blocks = $('script[type="application/ld+json" i]').toArray();
    let invalid = 0;
    let firstError: string | null = null;
    const snippets: string[] = [];
    const nodes: Node[] = [];
    for (const el of blocks) {
      const raw = $(el).text();
      try {
        collectNodes(JSON.parse(raw), nodes);
      } catch (e) {
        invalid++;
        const msg = (e as Error).message;
        firstError ??= msg.slice(0, 200);
        snippets.push(`Invalid JSON-LD (${msg.slice(0, 120)}): ${excerpt(raw, 240)}`);
      }
    }
    const types = [...new Set(nodes.flatMap(typesOf))];
    const missing: string[] = [];
    for (const n of nodes) {
      for (const t of typesOf(n)) {
        for (const prop of REQUIRED_PROPERTIES[t] ?? []) if (isEmpty(n[prop])) missing.push(`${t}: ${prop}`);
      }
    }
    const uniqueMissing = [...new Set(missing)];
    if (types.length) snippets.unshift(`Types found: ${types.join(", ")}`);
    if (uniqueMissing.length) snippets.push(`Missing basic properties: ${uniqueMissing.join("; ")}`);
    return {
      facts: {
        jsonLdBlocks: blocks.length,
        jsonLdInvalid: invalid,
        jsonLdFirstError: firstError,
        schemaTypes: types.length ? types.join(", ") : null,
        missingProperties: missing.length,
        missingPropertyList: uniqueMissing.length ? uniqueMissing.slice(0, 10).join("; ") : null,
      },
      snippets: snippets.length ? snippets : [blocks.length ? `${blocks.length} JSON-LD block(s)` : "No JSON-LD blocks"],
    };
  },

  checks: [
    {
      code: "structured-data/invalid-json",
      severity: "medium",
      kind: "defect",
      certainty: "verified",
      why: "A JSON-LD block that is not valid JSON is ignored entirely, so none of its structured data is read.",
      detect: (f) => f.jsonLdInvalid > 0,
      criteria: () => [{ id: "jsonld.valid", description: "Every JSON-LD block parses as valid JSON", params: {} }],
      describe: (f) => ({
        title: "Malformed JSON-LD",
        message: `${f.jsonLdInvalid} of ${f.jsonLdBlocks} JSON-LD block(s) are not valid JSON.`,
        observed: f.jsonLdFirstError ?? "parse error",
        expected: "Valid JSON in every application/ld+json script",
        recommendations: ["Fix the syntax error (often a trailing comma or an unescaped quote from a CMS field).", "Generate JSON-LD with a JSON serializer rather than string templates."],
        diagnosis: "Trailing commas and unescaped quotes in CMS-provided text are the most common causes.",
      }),
    },
    {
      code: "structured-data/missing-properties",
      severity: "low",
      kind: "warning",
      certainty: "heuristic",
      why: "Some properties are needed for structured data to be useful. This is Site Sentry's basic completeness list, not a rich-result eligibility test; use Google's Rich Results Test for that.",
      detect: (f) => f.missingProperties > 0,
      criteria: () => [{ id: "jsonld.required-properties", description: "Typed JSON-LD nodes include Site Sentry's basic properties", params: {} }],
      describe: (f) => ({
        title: "Structured data is missing basic properties",
        message: `Missing: ${f.missingPropertyList}.`,
        observed: f.missingPropertyList ?? "",
        expected: "Basic properties present for each supported type",
        recommendations: ["Add the missing properties to the JSON-LD.", "Confirm eligibility for specific rich results with Google's Rich Results Test."],
      }),
    },
  ],
};

// Crawl profiles (docs/SPEC.md "Crawler engine → Crawl profiles"): the one place budgets and depths are defined.
// Pure and client-safe: the API, both audit forms, the hero form and the methodology page all read from here.

export const PROFILE_IDS = ["quick", "standard", "full", "custom"] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];

export interface CrawlProfile {
  id: ProfileId;
  label: string;
  /** URL budget: requests the crawl may send. Full-site and Custom take a user-set value; this is the default. */
  budget: number;
  /** Clicks from the start URL; null = unlimited. Custom takes a user-set value; this is the default. */
  maxDepth: number | null;
  budgetEditable: boolean;
  depthEditable: boolean;
  /** Include/exclude regex, subfolder and basic auth. */
  scopeRules: boolean;
  use: string;
}

export const PROFILES: Record<ProfileId, CrawlProfile> = {
  quick: { id: "quick", label: "Quick", budget: 25, maxDepth: 3, budgetEditable: false, depthEditable: false, scopeRules: false, use: "Pre-sales check, single section, public hero form" },
  standard: { id: "standard", label: "Standard", budget: 1_000, maxDepth: 10, budgetEditable: false, depthEditable: false, scopeRules: false, use: "Monthly client audit" },
  full: { id: "full", label: "Full-site", budget: 50_000, maxDepth: null, budgetEditable: true, depthEditable: false, scopeRules: false, use: "Migrations, large e-commerce" },
  custom: { id: "custom", label: "Custom", budget: 1_000, maxDepth: 10, budgetEditable: true, depthEditable: true, scopeRules: true, use: "Include/exclude regex, subfolder-only, staging with auth" },
};

/** Validation bounds for user-set values (not profile caps): keep a typo from queueing a crawl of a billion URLs. */
export const MAX_BUDGET = 1_000_000;
export const MAX_DEPTH = 100;
export const MAX_SCOPE_RULES = 20;
export const MAX_RULE_LENGTH = 500;

/** Spec "Collaboration and accounts": the public hero form runs Quick only, 5 audits per IP per hour. */
export const HERO_PROFILE: ProfileId = "quick";
export const HERO_RATE_LIMIT = { audits: 5, windowMs: 60 * 60 * 1000 } as const;

/**
 * The in-request engine used while CRAWLER_V2=false keeps every page in the JSON store, so it cannot run the larger
 * profiles. Budgets above this are clamped there, and the audit says so. Crawler v2 has no such ceiling.
 */
export const LEGACY_ENGINE_LIMITS = { maxPages: 100, maxDepth: 3, maxListUrls: 100, linkChecks: 60 } as const;

export interface ScopeRules {
  /** A URL must match at least one, when any are given (regex source, tested against the normalised URL). */
  include: string[];
  /** A URL matching any is excluded. */
  exclude: string[];
  /** Path prefix such as "/blog/"; URLs outside it are out of scope. */
  subfolder?: string;
}

export interface ProfileRequest {
  profile: ProfileId;
  budget?: number;
  maxDepth?: number | null;
}

/** The budget and depth a request asks for under its profile. Throws on values the profile does not accept. */
export function resolveProfile(req: ProfileRequest): { profile: ProfileId; budget: number; maxDepth: number | null } {
  const p = PROFILES[req.profile];
  if (req.budget !== undefined && !p.budgetEditable && req.budget !== p.budget) {
    throw new Error(`The ${p.label} profile has a fixed budget of ${p.budget} URLs.`);
  }
  if (req.maxDepth !== undefined && !p.depthEditable && req.maxDepth !== p.maxDepth) {
    throw new Error(`The ${p.label} profile has a fixed depth (${p.maxDepth ?? "unlimited"}).`);
  }
  const budget = p.budgetEditable ? (req.budget ?? p.budget) : p.budget;
  const maxDepth = p.depthEditable && req.maxDepth !== undefined ? req.maxDepth : p.maxDepth;
  if (!Number.isInteger(budget) || budget < 1 || budget > MAX_BUDGET) throw new Error(`Budget must be 1–${MAX_BUDGET.toLocaleString("en")} URLs.`);
  if (maxDepth !== null && (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > MAX_DEPTH)) throw new Error(`Depth must be 0–${MAX_DEPTH}, or unlimited.`);
  return { profile: req.profile, budget, maxDepth };
}

/** Why a regex is unusable, or null. Patterns are compiled without flags, so matching is case-sensitive. */
export function regexProblem(source: string): string | null {
  if (!source) return "Empty pattern.";
  if (source.length > MAX_RULE_LENGTH) return `Longer than ${MAX_RULE_LENGTH} characters.`;
  try {
    new RegExp(source);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** "/blog" → "/blog/". Null when it is not a usable path prefix. */
export function normaliseSubfolder(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  if (!t.startsWith("/") || /[?#\s]/.test(t) || t.includes("..")) return null;
  return t.endsWith("/") ? t : `${t}/`;
}

/** One line for lists and previews, e.g. "Standard · 1,000 URLs · 10 clicks". */
export function describeLimits(budget: number, maxDepth: number | null): string {
  const depth = maxDepth === null ? "unlimited depth" : maxDepth === 0 ? "no link following" : `${maxDepth} click${maxDepth === 1 ? "" : "s"} deep`;
  return `${budget.toLocaleString("en")} URLs · ${depth}`;
}

// robots.txt parsing and matching per RFC 9309. Pure.

export interface RobotsRule {
  allow: boolean;
  path: string;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  /** Crawl-delay in seconds (not part of RFC 9309, widely used); the last valid value in the group wins. */
  crawlDelay?: number;
}

export interface ParsedRobots {
  groups: RobotsGroup[];
  sitemaps: string[];
  /** Lines that could not be understood, kept as evidence. */
  invalidLines: string[];
}

export function parseRobots(text: string): ParsedRobots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  const invalidLines: string[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;

  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) {
      if (invalidLines.length < 20) invalidLines.push(raw.slice(0, 200));
      continue;
    }
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === "allow" || key === "disallow") {
      if (!current) continue; // rules before any user-agent line are ignored
      // An empty Disallow means "allow everything" and adds no rule.
      if (value === "" ) continue;
      current.rules.push({ allow: key === "allow", path: value });
    } else if (key === "sitemap") {
      if (value) sitemaps.push(value);
    } else if (key === "crawl-delay") {
      if (!current) continue;
      const seconds = /^\d+(\.\d+)?$/.test(value) ? Number(value) : NaN;
      if (Number.isFinite(seconds)) current.crawlDelay = seconds;
      else if (invalidLines.length < 20) invalidLines.push(raw.slice(0, 200));
    }
    // host, etc. are accepted and ignored.
  }
  return { groups, sitemaps, invalidLines };
}

/** The groups that apply to a crawler: every group naming it, or the "*" groups when none does. */
function groupsFor(robots: ParsedRobots, userAgent: string): RobotsGroup[] | null {
  const token = userAgent.toLowerCase();
  const named = robots.groups.filter((g) => g.agents.some((a) => a !== "*" && token.startsWith(a)));
  if (named.length) return named;
  const star = robots.groups.filter((g) => g.agents.includes("*"));
  return star.length ? star : null;
}

/** Rules for a crawler: the most specific matching group, merged when several groups name it; "*" otherwise. */
export function rulesFor(robots: ParsedRobots, userAgent: string): RobotsRule[] | null {
  return groupsFor(robots, userAgent)?.flatMap((g) => g.rules) ?? null;
}

/** Crawl-delay in seconds for a crawler, from the same groups as its rules; the longest when merged groups disagree. */
export function crawlDelayFor(robots: ParsedRobots, userAgent: string): number | null {
  const delays = (groupsFor(robots, userAgent) ?? []).flatMap((g) => (g.crawlDelay === undefined ? [] : [g.crawlDelay]));
  return delays.length ? Math.max(...delays) : null;
}

function patternToRegex(path: string): RegExp {
  const anchored = path.endsWith("$");
  const body = (anchored ? path.slice(0, -1) : path)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

function encodePath(p: string): string {
  // Compare in a consistent percent-encoded form.
  try {
    return encodeURI(decodeURI(p));
  } catch {
    return p;
  }
}

export interface RobotsDecision {
  allowed: boolean;
  /** The rule that decided, e.g. "Disallow: /private" — or null when no rule matched. */
  matchedRule: string | null;
}

/** Longest matching rule wins; Allow wins a tie. No matching rule = allowed. */
export function isAllowed(robots: ParsedRobots, userAgent: string, url: string): RobotsDecision {
  let pathAndQuery: string;
  try {
    const u = new URL(url);
    pathAndQuery = `${u.pathname}${u.search}`;
  } catch {
    return { allowed: false, matchedRule: null };
  }
  if (pathAndQuery === "/robots.txt") return { allowed: true, matchedRule: null };
  const rules = rulesFor(robots, userAgent);
  if (!rules) return { allowed: true, matchedRule: null };

  const target = encodePath(pathAndQuery);
  let best: RobotsRule | null = null;
  for (const rule of rules) {
    if (!patternToRegex(encodePath(rule.path)).test(target)) continue;
    if (
      !best ||
      rule.path.length > best.path.length ||
      (rule.path.length === best.path.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }
  if (!best) return { allowed: true, matchedRule: null };
  return { allowed: best.allow, matchedRule: `${best.allow ? "Allow" : "Disallow"}: ${best.path}` };
}

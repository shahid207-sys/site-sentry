// robots.txt parsing and matching per RFC 9309. Pure.

export interface RobotsRule {
  allow: boolean;
  path: string;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
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
    }
    // crawl-delay, host, etc. are accepted and ignored.
  }
  return { groups, sitemaps, invalidLines };
}

/** Rules for a crawler: the most specific matching group, merged when several groups name it; "*" otherwise. */
export function rulesFor(robots: ParsedRobots, userAgent: string): RobotsRule[] | null {
  const token = userAgent.toLowerCase();
  const named = robots.groups.filter((g) => g.agents.some((a) => a !== "*" && token.startsWith(a)));
  if (named.length) return named.flatMap((g) => g.rules);
  const star = robots.groups.filter((g) => g.agents.includes("*"));
  if (star.length) return star.flatMap((g) => g.rules);
  return null;
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

// AI-search readiness rules (docs/SPEC.md catalog, AIS).
import { finding, inconclusive, NeedsConfig, type SiteRule } from "./contract";
import { skippedByRobots } from "./probe-types";
import { homeUrl, robotsUrl } from "./util";

const site = (r: Omit<SiteRule, "scope" | "category">): SiteRule => ({ scope: "site", category: "ai_search", ...r });

/** The AI crawlers the spec names, by robots.txt user-agent token. */
export const AI_BOTS = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "PerplexityBot", "Google-Extended", "Applebot-Extended"] as const;

/** Per-bot verdict for the home page, or null when robots.txt gives no usable answer (unreachable, 5xx). */
function botAccess(crawl: Parameters<SiteRule["evaluate"]>[0]["crawl"]) {
  const r = crawl.robots;
  if (!r || (r.outcome !== "parsed" && r.outcome !== "allow_all")) return null;
  const home = homeUrl(crawl.origin);
  return AI_BOTS.map((bot) => ({ bot, allowed: crawl.robotsAllows(home, bot) }));
}

const AIS001 = site({
  id: "AIS-001",
  version: 1,
  confidence: "advisory",
  impact: 2,
  needs: ["headers"],
  evaluate({ crawl }) {
    const access = botAccess(crawl);
    if (!access) return [];
    const blocked = access.filter((a) => a.allowed === false).map((a) => a.bot);
    const msg = blocked.length ? `robots.txt blocks ${blocked.join(", ")} from the home page.` : "robots.txt allows every listed AI crawler on the home page.";
    return [finding(AIS001, robotsUrl(crawl.origin), msg, { bots: access, outcome: crawl.robots!.outcome })];
  },
  explain: { why: "AI search tools only cite pages their crawlers may fetch; this reports what robots.txt currently says.", fix: "Decide which AI crawlers you want and set robots.txt to match.", acceptance: "The report matches your intent for each AI crawler." },
});

const AIS002 = site({
  id: "AIS-002",
  version: 1,
  confidence: "verified",
  impact: 3,
  needs: ["headers"],
  evaluate({ crawl }) {
    const intent = crawl.intent.aiCrawlers;
    if (!intent) throw new NeedsConfig("aiCrawlers");
    if (intent !== "allow") return [];
    const access = botAccess(crawl);
    if (!access) return [];
    return access.filter((a) => a.allowed === false).map((a) => finding(AIS002, robotsUrl(crawl.origin), `robots.txt blocks ${a.bot}, but AI crawlers should be allowed.`, { bot: a.bot, intent }));
  },
  explain: { why: "The audit settings say AI crawlers should be allowed, but robots.txt blocks one; its AI search product cannot cite the site.", fix: "Remove the Disallow for that user-agent in robots.txt (or change the audit setting).", acceptance: "robots.txt allows every listed AI crawler on the home page." },
});

/** Why llms.txt is malformed, or null. The llmstxt.org format starts with an H1 ("# Name") and is Markdown, not HTML. */
export function llmsTxtProblem(body: string, contentType: string | undefined): string | null {
  if (contentType && /html/i.test(contentType)) return `served as ${contentType.split(";")[0]}, not plain text or Markdown`;
  const first = body.split(/\r?\n/).find((l) => l.trim());
  if (!first) return "empty file";
  if (!/^# \S/.test(first)) return "does not start with an H1 title (\"# Name\")";
  return null;
}

const AIS003 = site({
  id: "AIS-003",
  version: 2,
  confidence: "advisory",
  impact: 1,
  needs: ["headers"],
  evaluate({ crawl }) {
    const p = crawl.probes.find((x) => x.kind === "llms_txt");
    if (skippedByRobots(p)) return [inconclusive(AIS003, p.url, "probe_skipped_robots", `llms.txt not checked: ${p.skipped}.`)];
    if (!p || p.skipped) return [];
    if (p.status !== 200) return [finding(AIS003, p.url, p.error ? `llms.txt could not be fetched: ${p.error.message}` : `No llms.txt (HTTP ${p.status}).`, { status: p.status, reason: "missing" })];
    const problem = llmsTxtProblem(p.body ?? "", p.contentType);
    return problem ? [finding(AIS003, p.url, `llms.txt is malformed: ${problem}.`, { reason: "malformed", contentType: p.contentType ?? null, firstLine: (p.body ?? "").split(/\r?\n/).find((l) => l.trim())?.slice(0, 120) ?? null })] : [];
  },
  explain: { why: "llms.txt is an emerging convention that points AI tools at a site's key content; it is optional and ignored by Google Search.", fix: "Publish /llms.txt in Markdown starting with \"# Site name\" and a short summary.", acceptance: "/llms.txt returns 200 and starts with an H1 title.", docs: "https://llmstxt.org/" },
});

export const AIS_RULES = [AIS001, AIS002, AIS003];

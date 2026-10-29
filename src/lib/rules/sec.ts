// Security rules (docs/SPEC.md catalog, SEC). SEC-003 reads the tls_cert probe (a handshake, no request); SEC-006
// reads the env_file and git_head probes, which store only whether the body matched a signature, never the body.
// Header rules (SEC-004, SEC-005) judge the start page: these headers are set server-wide, so one finding stands for
// the site instead of one per page.
import { finding, inconclusive, type Finding, type PageRule, type PageView, type SiteRule } from "./contract";
import { skippedByRobots } from "./probe-types";
import { homeUrl, isHtml200 } from "./util";

const page = (r: Omit<PageRule, "scope" | "category">): PageRule => ({ scope: "page", category: "security", ...r });
const site = (r: Omit<SiteRule, "scope" | "category">): SiteRule => ({ scope: "site", category: "security", ...r });

const EVIDENCE_CAP = 20;
/** Spec: certificate expiring within 21 days. */
export const CERT_WARN_DAYS = 21;
const DAY = 86_400_000;

const SEC001 = page({
  id: "SEC-001",
  version: 1,
  confidence: "verified",
  impact: 4,
  needs: ["headers"],
  evaluate({ page: p }) {
    return isHtml200(p) && p.finalUrl.startsWith("http:") ? [finding(SEC001, p.url, "The page is served over plain HTTP.", { finalUrl: p.finalUrl })] : [];
  },
  explain: {
    why: "Browsers mark HTTP pages not secure, traffic can be read or altered in transit, and HTTPS is a ranking signal.",
    fix: "Serve the site over HTTPS and redirect every HTTP URL to its HTTPS version with a 301.",
    acceptance: "The page is served over HTTPS.",
  },
});

/** http: URLs the page loads (not links it offers): scripts, styles, images, video, iframes. */
function insecureResources(p: PageView): { url: string; kind: string }[] {
  const out = new Map<string, string>();
  const add = (u: string | null | undefined, kind: string) => {
    if (u && u.startsWith("http:") && !out.has(u)) out.set(u, kind);
  };
  for (const u of p.facts?.renderResources ?? []) add(u, "script or stylesheet");
  for (const i of p.images) add(i.resolved, "image");
  for (const v of p.facts?.videos ?? []) {
    add(v.src, "video");
    add(v.poster, "video poster");
  }
  for (const l of p.links) if (l.via === "iframe") add(l.href, "iframe");
  return [...out].map(([url, kind]) => ({ url, kind }));
}

const SEC002 = page({
  id: "SEC-002",
  version: 1,
  confidence: "verified",
  impact: 3,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p) || !p.finalUrl.startsWith("https:")) return [];
    const bad = insecureResources(p);
    return bad.length ? [finding(SEC002, p.url, `An HTTPS page loads ${bad.length} resource(s) over HTTP (mixed content).`, { count: bad.length, resources: bad.slice(0, EVIDENCE_CAP) })] : [];
  },
  explain: {
    why: "Browsers block mixed scripts, styles and frames, and warn on mixed images: the page breaks or looks insecure.",
    fix: "Load every resource over HTTPS (or protocol-relative from an HTTPS host).",
    acceptance: "No resource the page loads uses http:.",
  },
});

const SEC003 = site({
  id: "SEC-003",
  version: 1,
  confidence: "verified",
  impact: 5,
  needs: ["headers"],
  evaluate({ crawl }) {
    const probe = crawl.probes.find((p) => p.kind === "tls_cert");
    if (!probe) return [];
    if (!probe.cert) {
      if (!probe.error) return [];
      return [inconclusive(SEC003, probe.url, "ambiguous_status", `The certificate could not be read: ${probe.error.message}`, { error: probe.error.code })];
    }
    const c = probe.cert;
    const now = Date.parse(crawl.startedAt);
    const left = Math.floor((Date.parse(c.validTo) - now) / DAY);
    const ev = { subject: c.subject, issuer: c.issuer, validTo: c.validTo, daysLeft: left, authorizationError: c.authorizationError };
    if (Date.parse(c.validTo) <= now) return [finding(SEC003, probe.url, `The TLS certificate expired on ${c.validTo.slice(0, 10)}.`, ev)];
    if (left < CERT_WARN_DAYS) return [finding(SEC003, probe.url, `The TLS certificate expires on ${c.validTo.slice(0, 10)}, in ${left} day(s).`, ev)];
    return [];
  },
  explain: {
    why: "An expired certificate makes browsers block the whole site with a security warning.",
    fix: "Renew the certificate (and automate renewal, e.g. ACME), then reload the server.",
    acceptance: `The certificate is valid for more than ${CERT_WARN_DAYS} days.`,
  },
});

const isHome = (p: PageView, origin: string) => p.url === homeUrl(origin);

const SEC004 = page({
  id: "SEC-004",
  version: 1,
  confidence: "heuristic",
  impact: 1,
  needs: ["headers"],
  evaluate({ page: p, crawl }) {
    if (!isHtml200(p) || !isHome(p, crawl.origin) || !p.finalUrl.startsWith("https:")) return [];
    const hsts = p.headers["strict-transport-security"];
    const maxAge = /max-age\s*=\s*"?(\d+)/i.exec(hsts ?? "");
    if (maxAge && Number(maxAge[1]) > 0) return [];
    return [finding(SEC004, p.url, hsts ? `Strict-Transport-Security has max-age=0 ("${hsts}").` : "No Strict-Transport-Security header.", { header: hsts ?? null })];
  },
  explain: {
    why: "Without HSTS, the first visit can be downgraded to HTTP by an attacker.",
    fix: "Send Strict-Transport-Security: max-age=31536000; includeSubDomains on HTTPS responses.",
    acceptance: "HTTPS responses carry HSTS with a positive max-age.",
  },
});

const SEC005 = page({
  id: "SEC-005",
  version: 1,
  confidence: "advisory",
  impact: 1,
  needs: ["headers"],
  evaluate({ page: p, crawl }) {
    if (!isHtml200(p) || !isHome(p, crawl.origin)) return [];
    const h = p.headers;
    const csp = h["content-security-policy"];
    const missing: string[] = [];
    if (!/^\s*nosniff\s*$/i.test(h["x-content-type-options"] ?? "")) missing.push("X-Content-Type-Options: nosniff");
    if (!/^\s*(deny|sameorigin)\s*$/i.test(h["x-frame-options"] ?? "") && !/frame-ancestors/i.test(csp ?? "")) missing.push("frame protection (X-Frame-Options or CSP frame-ancestors)");
    if (!csp) missing.push("Content-Security-Policy");
    return missing.length ? [finding(SEC005, p.url, `Missing security header(s): ${missing.join(", ")}.`, { missing })] : [];
  },
  explain: {
    why: "These headers block MIME sniffing, clickjacking and many script injection attacks.",
    fix: "Send X-Content-Type-Options: nosniff, X-Frame-Options (or CSP frame-ancestors) and a Content-Security-Policy.",
    acceptance: "All three protections are present.",
  },
});

const EXPOSED: Record<string, string> = { env_file: "an environment file (KEY=value lines)", git_head: "a Git repository HEAD (ref: refs/…)" };

const SEC006 = site({
  id: "SEC-006",
  version: 1,
  confidence: "verified",
  impact: 5,
  needs: ["headers"],
  evaluate({ crawl }) {
    const out: Finding[] = [];
    for (const p of crawl.probes) {
      if (p.kind !== "env_file" && p.kind !== "git_head") continue;
      if (skippedByRobots(p)) {
        out.push(inconclusive(SEC006, p.url, "probe_skipped_robots", "Not checked: robots.txt disallows the path.", {}));
        continue;
      }
      // Flagged only on a 200 whose body matched the signature; only the match is stored, never the content.
      if (p.status === 200 && p.secret) out.push(finding(SEC006, p.url, `Publicly readable: the response is ${EXPOSED[p.kind]}.`, { status: 200, pattern: p.secret.pattern, matchedLines: p.secret.lines }));
    }
    return out;
  },
  explain: {
    why: "An exposed .env leaks credentials; an exposed .git lets anyone download the source code and its history.",
    fix: "Block the paths at the server (deny dotfiles), remove the files from the web root, and rotate any exposed secrets.",
    acceptance: "Both paths return 403/404, or a page that is not the file.",
  },
});

export const SEC_RULES = [SEC001, SEC002, SEC003, SEC004, SEC005, SEC006];

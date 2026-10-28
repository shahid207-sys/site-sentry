// Finding filters shared by the results table and the exports, so an export always matches what is on screen. Pure.
import type { ChangeKind } from "./audit/compare";
import type { AuditFinding, RuleCategory, Severity } from "./audit/types";

export interface FindingFilter {
  severity?: Severity[];
  category?: RuleCategory[];
  rule?: string;
  change?: ChangeKind[];
  q?: string;
  url?: string;
}

export type FindingSort = "priority" | "severity" | "rule" | "url";

const SEV_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export function parseFilter(sp: URLSearchParams): FindingFilter {
  const list = (k: string) => sp.get(k)?.split(",").map((s) => s.trim()).filter(Boolean);
  return {
    severity: list("severity") as Severity[] | undefined,
    category: list("category") as RuleCategory[] | undefined,
    rule: sp.get("rule") ?? undefined,
    change: list("change") as ChangeKind[] | undefined,
    q: sp.get("q") ?? undefined,
    url: sp.get("url") ?? undefined,
  };
}

export function filterToParams(f: FindingFilter, sort?: FindingSort): URLSearchParams {
  const p = new URLSearchParams();
  if (f.severity?.length) p.set("severity", f.severity.join(","));
  if (f.category?.length) p.set("category", f.category.join(","));
  if (f.rule) p.set("rule", f.rule);
  if (f.change?.length) p.set("change", f.change.join(","));
  if (f.q) p.set("q", f.q);
  if (f.url) p.set("url", f.url);
  if (sort && sort !== "priority") p.set("sort", sort);
  return p;
}

export function applyFilter(list: AuditFinding[], f: FindingFilter, changes: Record<string, ChangeKind> | null, sort: FindingSort = "priority"): AuditFinding[] {
  const q = f.q?.trim().toLowerCase();
  const out = list.filter((x) => {
    if (f.severity?.length && !f.severity.includes(x.priority.severity)) return false;
    if (f.category?.length && !f.category.includes(x.category)) return false;
    if (f.rule && x.ruleCode !== f.rule) return false;
    if (f.change?.length && !(changes && f.change.includes(changes[x.fingerprint]))) return false;
    if (f.url && x.pageUrl !== f.url) return false;
    if (q) {
      const hay = `${x.title} ${x.ruleCode} ${x.pageUrl} ${x.observed} ${x.message}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const by: Record<FindingSort, (a: AuditFinding, b: AuditFinding) => number> = {
    priority: (a, b) => a.priority.level - b.priority.level || b.priority.score - a.priority.score || a.ruleCode.localeCompare(b.ruleCode) || a.pageUrl.localeCompare(b.pageUrl),
    severity: (a, b) => SEV_RANK[a.priority.severity] - SEV_RANK[b.priority.severity] || a.ruleCode.localeCompare(b.ruleCode),
    rule: (a, b) => a.ruleCode.localeCompare(b.ruleCode) || a.pageUrl.localeCompare(b.pageUrl),
    url: (a, b) => a.pageUrl.localeCompare(b.pageUrl) || a.priority.level - b.priority.level,
  };
  return out.sort(by[sort] ?? by.priority);
}

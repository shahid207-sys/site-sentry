"use client";
// Labels and badges for v2 (Phase 3) results: issue group priority, issue state, URL state. Every one is an icon
// plus a text label, never colour alone (SPEC "Design system": accessibility).
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleHelp,
  Info,
  OctagonAlert,
  RotateCcw,
  TriangleAlert,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import type { IssueState } from "@/lib/db/schema";
import type { Priority } from "@/lib/results/priority";
import { cx } from "../ui";

export const PRIORITIES: Priority[] = ["critical", "high", "medium", "low", "info"];

const PRIORITY: Record<Priority, { label: string; icon: LucideIcon; tone: string }> = {
  critical: { label: "Critical", icon: OctagonAlert, tone: "bg-p-critical-soft text-p-critical" },
  high: { label: "High", icon: CircleAlert, tone: "bg-p-high-soft text-p-high" },
  medium: { label: "Medium", icon: TriangleAlert, tone: "bg-p-medium-soft text-p-medium" },
  low: { label: "Low", icon: CircleDashed, tone: "bg-p-low-soft text-p-low" },
  info: { label: "Info", icon: Info, tone: "bg-p-info-soft text-p-info" },
};

export const priorityLabel = (p: Priority) => PRIORITY[p].label;
/** Text colour class of a priority (for icons and counts next to a label). */
export const priorityText = (p: Priority) => PRIORITY[p].tone.split(" ")[1];

function Pill({ icon: Icon, tone, children, title }: { icon: LucideIcon; tone: string; children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 text-xs font-medium [&_svg]:size-3.5", tone)}>
      <Icon aria-hidden />
      {children}
    </span>
  );
}

export function PriorityBadge({ priority, score }: { priority: Priority; score?: number }) {
  const p = PRIORITY[priority];
  return (
    <Pill icon={p.icon} tone={p.tone} title={score === undefined ? undefined : `Priority score ${score.toFixed(2)}`}>
      {p.label}
    </Pill>
  );
}

/** A priority icon with an accessible name, for dense rows where the label sits in its own column. */
export function PriorityIcon({ priority }: { priority: Priority }) {
  const p = PRIORITY[priority];
  const Icon = p.icon;
  return <Icon className={cx("size-4 shrink-0", priorityText(priority))} role="img" aria-label={`${p.label} priority`} />;
}

export const ISSUE_STATES: IssueState[] = ["new", "regressed", "persistent", "not_rechecked", "inconclusive", "resolved"];

const STATE: Record<IssueState, { label: string; icon: LucideIcon; tone: string; title: string }> = {
  new: { label: "New", icon: CircleDot, tone: "bg-sev-high-soft text-sev-high", title: "First seen in this audit" },
  regressed: { label: "Regressed", icon: RotateCcw, tone: "bg-sev-high-soft text-sev-high", title: "Was resolved, found again" },
  persistent: { label: "Persistent", icon: CircleAlert, tone: "bg-sev-medium-soft text-sev-medium", title: "Also found in the previous audit" },
  not_rechecked: { label: "Not re-checked", icon: Undo2, tone: "bg-elevated text-fg-2 border border-line", title: "This audit did not re-examine it: it may or may not be fixed" },
  inconclusive: { label: "Inconclusive", icon: CircleHelp, tone: "bg-elevated text-fg-2 border border-line", title: "Observed, but the check could not decide" },
  resolved: { label: "Resolved", icon: CircleCheck, tone: "bg-ok-soft text-ok", title: "Re-checked and no longer found" },
};

export const stateLabel = (s: IssueState) => STATE[s].label;

export function IssueStateBadge({ state, verified }: { state: IssueState; verified?: boolean }) {
  const s = STATE[state];
  return (
    <Pill icon={s.icon} tone={s.tone} title={verified ? "Resolved by a fix verification (targeted re-crawl)" : s.title}>
      {s.label}
      {verified ? <span className="opacity-75">· verified</span> : null}
    </Pill>
  );
}

/** URL states of the crawler (docs/CRAWLER-STATES.md), in plain words. */
export const URL_STATE_LABEL: Record<string, string> = {
  discovered: "Discovered",
  queued: "Queued",
  fetching: "Fetching",
  fetched: "Fetched",
  analysed: "Analysed",
  redirected: "Redirected",
  non_html: "Not HTML",
  oversized: "Oversized",
  blocked_robots: "Blocked by robots.txt",
  excluded_by_rule: "Excluded by scope rule",
  out_of_scope: "Out of scope",
  cdn_managed: "CDN-managed path",
  budget_exhausted: "Budget reached",
  depth_exceeded: "Too deep",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
  failed_timeout: "Timed out",
  failed_network: "Network error",
  failed_dns: "DNS error",
  failed_tls: "TLS error",
};

export const urlStateLabel = (s: string) => URL_STATE_LABEL[s] ?? s.replace(/_/g, " ");

const CATEGORY: Record<string, string> = {
  indexability: "Indexability",
  metadata: "Metadata",
  content: "Content",
  ai_search: "AI search",
  links: "Links",
  international: "International",
  images: "Images",
  structured_data: "Structured data",
  security: "Security",
  site: "Site-wide",
  performance: "Performance",
  accessibility: "Accessibility",
};

export const categoryLabel = (c: string) => CATEGORY[c] ?? c;

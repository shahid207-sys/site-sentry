// Persisted domain entities. Shaped like relational tables (id-keyed, referencing each other by id)
// so a SQL adapter can replace the JSON store behind the same Store interface.
import type {
  AuditFinding,
  AuditSource,
  ExpectationKey,
  Finding,
  ItemVerification,
  Observation,
  PageExpectations,
  RedirectHop,
  RuleCategory,
  RuleConfig,
  RuleResult,
  Severity,
  VerificationOutcome,
} from "./audit/types";
import type { PageLinks } from "./crawl/extract";
import type { ProfileId, ScopeRules } from "./crawl/profiles";

export type Workspace = AuditSource; // "live" | "sample"

export interface Site {
  id: string;
  name: string;
  /** "https://www.example.com" */
  origin: string;
  createdAt: string;
  /** Optional sitemap URL; defaults to robots.txt declarations, then /sitemap.xml. */
  sitemapUrl?: string;
  notes?: string;
  /** White-label for this site's reports. */
  branding?: Branding;
}

/** Report white-label: shown on the cover and in the header of every report of the site. */
export interface Branding {
  agencyName?: string;
  /** "#rrggbb" */
  brandColor?: string;
  /** data:image/png|jpeg|svg+xml;base64,… (never a remote URL: the PDF renderer would fetch it). */
  logoDataUrl?: string;
}

export type PageType = "home" | "service" | "location" | "product" | "category" | "article" | "landing" | "contact" | "other";

/** A configured (important) URL and what the owner intends for it. */
export interface PageIntent {
  id: string;
  siteId: string;
  /** Normalised absolute URL. */
  url: string;
  pageType: PageType;
  /** Free-form labels: service, location, campaign… */
  labels: string[];
  indexability?: "index" | "noindex";
  canonicalUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export type AuditMode = "single" | "list" | "sitemap";

export interface AuditConfig {
  mode: AuditMode;
  /** Seed URLs (single/list), normalised. */
  urls: string[];
  /** Sitemap to read (sitemap mode). */
  sitemapUrl?: string;
  /** Crawl profile (docs/SPEC.md); absent on audits created before profiles existed. */
  profile?: ProfileId;
  /** URL budget. */
  maxPages: number;
  /** 0 = only the given URLs; n = also follow internal links that many clicks deep; null = unlimited (crawler v2). */
  maxDepth: number | null;
  /** Custom profile scope rules (crawler v2). Basic auth is never stored here; it lives encrypted on the crawl. */
  scope?: ScopeRules;
  /** Custom profile: the crawl sends basic auth as this user (the password is not stored on the audit). */
  authUser?: string;
  /** Whether AI crawlers should be allowed (AIS-002, crawler v2). Unset: the rule reports that it needs this setting. */
  aiCrawlers?: "allow" | "block";
  categories: RuleCategory[];
  /** Check the status of internal link and image targets that were not crawled (bounded). */
  checkLinks: boolean;
  /** Include the site's important URLs as seeds. */
  includeImportant: boolean;
}

/** completed_empty: the crawl finished but no HTML page was fetched to analyse (crawler v2); `emptyReason` says why. */
export type AuditStatus = "running" | "completed" | "completed_empty" | "partial" | "failed" | "cancelled";
export type AuditPhase = "robots" | "sitemap" | "pages" | "links" | "finalize" | "done";

export interface QueueItem {
  url: string;
  depth: number;
  via: "seed" | "sitemap" | "important" | "link";
}

export interface LinkCheck {
  url: string;
  kind: "link" | "image";
  status: number | null;
  finalUrl: string | null;
  redirectCount: number;
  error?: { code: string; message: string };
  checkedAt: string;
}

export interface RobotsSnapshot {
  url: string;
  fetchedAt: string;
  status: number | null;
  /** ok: parsed; missing: 4xx (everything allowed); error: 5xx/unreachable (treated as disallow-all for traversal). */
  outcome: "ok" | "missing" | "error";
  error?: { code: string; message: string };
  /** Raw text (capped) so decisions can be re-derived and shown as evidence. */
  body: string;
  sitemaps: string[];
}

export interface SitemapSnapshot {
  url: string;
  /** Where Site Sentry learned of it. */
  via: "config" | "robots" | "default" | "audit";
  fetchedAt: string;
  status: number | null;
  contentType: string;
  error?: { code: string; message: string };
  kind: "urlset" | "sitemapindex" | "unknown" | null;
  errors: string[];
  /** Page URLs found (normalised, capped). */
  urls: string[];
  urlCount: number;
  children: { url: string; status: number | null; errors: string[]; urlCount: number; error?: { code: string; message: string } }[];
}

export type SnapshotOutcome =
  | "inspected" // 2xx HTML, all selected rules ran
  | "http_error" // 4xx/5xx; only the HTTP rule ran
  | "non_html" // 2xx but not HTML (PDF, image…)
  | "fetch_failed" // network error, timeout, blocked
  | "robots_blocked" // not fetched: robots.txt disallows Site Sentry
  | "redirect_duplicate" // redirected to a page inspected under another URL
  | "external_redirect"; // redirected off-site; not inspected

/** Immutable record of one URL in one audit. */
export interface PageSnapshot {
  auditId: string;
  /** Normalised requested URL. */
  url: string;
  finalUrl: string;
  depth: number;
  via: QueueItem["via"];
  fetchedAt: string;
  outcome: SnapshotOutcome;
  status: number | null;
  redirectChain: RedirectHop[];
  contentType: string;
  bytes: number;
  truncated: boolean;
  elapsedMs: number | null;
  error?: { code: string; message: string };
  robotsRule?: string;
  expectations: PageExpectations;
  rules: RuleResult[];
  links: PageLinks | null;
  summary: {
    title: string | null;
    description: string | null;
    h1: string | null;
    wordCount: number | null;
    noindex: boolean | null;
    canonical: string | null;
    canonicalSelf: boolean | null;
  };
}

export interface CoverageNote {
  code: "page_limit" | "depth_limit" | "robots_error" | "sitemap_unavailable" | "link_check_limit" | "cancelled" | "truncated" | "graph_incomplete" | "time_limit" | "engine_limit";
  message: string;
}

export interface AuditRun {
  id: string;
  siteId: string;
  source: Workspace;
  createdAt: string;
  startedAt: string;
  finishedAt: string | null;
  /** Last time a step made progress; a stale running audit can be resumed. */
  heartbeatAt: string;
  /** A step holds this lease while it runs, so two callers never crawl the same audit at once. */
  leaseUntil: string | null;
  cancelRequested: boolean;
  /** Link-check queue has been built (it is built once, after the page crawl). */
  linkQueueBuilt: boolean;
  status: AuditStatus;
  phase: AuditPhase;
  config: AuditConfig;
  queue: QueueItem[];
  /** Normalised URLs already queued or done (prevents re-queueing). */
  seen: string[];
  linkQueue: { url: string; kind: "link" | "image" }[];
  linkChecks: Record<string, LinkCheck>;
  robots: RobotsSnapshot | null;
  sitemap: SitemapSnapshot | null;
  progress: { planned: number; done: number; inspected: number; failed: number; skipped: number; linksChecked: number };
  coverage: CoverageNote[];
  /** Fatal error for failed audits. */
  error?: { code: string; message: string };
  /** Why a completed_empty audit has nothing to analyse. */
  emptyReason?: string;
  /** Counts by severity of the final findings; set when finalised. */
  findingCounts?: Record<Severity, number>;
  /** Rule config in force for this audit (frozen for comparisons). */
  ruleConfig: RuleConfig;
  /** Set when crawler v2 runs this audit (CRAWLER_V2=true): the crawl itself lives in Postgres. */
  crawler?: CrawlerV2Ref;
}

/** Link from a JSON-store audit to its crawler v2 crawl, with the state last read from the crawls table. */
export interface CrawlerV2Ref {
  version: 2;
  crawlId: string;
  status: "queued" | "running" | "paused" | "cancelling" | "completed" | "cancelled" | "failed";
  /** URL counts per state (docs/CRAWLER-STATES.md). */
  states: Record<string, number>;
  /** The start URL redirected to the same site's www/non-www or http/https twin, and the crawl moved there. */
  startRedirect?: { from: string; to: string };
  /** Fetched HTML pages whose raw HTML could not be stored (page_snapshots.blob_status = 'blob_missing'). */
  blobMissing?: number;
  syncedAt: string;
}

export type WorkflowStatus = "open" | "triaged" | "in_progress" | "ready_to_verify" | "resolved" | "wont_fix";
export type VerificationStatus = "unverified" | "passing" | "failing" | "inconclusive" | "partial";

export const WORKFLOW_STATUSES: { id: WorkflowStatus; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "triaged", label: "Triaged" },
  { id: "in_progress", label: "In progress" },
  { id: "ready_to_verify", label: "Ready to verify" },
  { id: "resolved", label: "Resolved" },
  { id: "wont_fix", label: "Won't fix" },
];

/** Allowed workflow moves. Verification status is separate and only changes by re-checking the site. */
export const TRANSITIONS: Record<WorkflowStatus, WorkflowStatus[]> = {
  open: ["triaged", "in_progress", "wont_fix"],
  triaged: ["open", "in_progress", "wont_fix"],
  in_progress: ["triaged", "ready_to_verify", "wont_fix"],
  ready_to_verify: ["in_progress", "resolved", "wont_fix"],
  resolved: ["open", "ready_to_verify"],
  wont_fix: ["open"],
};

/** One finding covered by a task, frozen at task creation. */
export interface TaskItem {
  fingerprint: string;
  auditId: string;
  finding: AuditFinding;
  originalObservation: Observation;
  /** Latest verification of this item. */
  lastOutcome: VerificationOutcome | null;
}

export interface TaskVerification {
  id: string;
  at: string;
  outcome: VerificationStatus;
  reason: string;
  items: ItemVerification[];
}

export interface TaskEvent {
  at: string;
  kind: "created" | "status" | "owner" | "edited" | "verified" | "reopened" | "regression";
  from?: string;
  to?: string;
  note?: string;
}

export interface ManualCheck {
  id: string;
  text: string;
  done: boolean;
}

export interface FixTask {
  id: string;
  siteId: string;
  source: Workspace;
  createdAt: string;
  updatedAt: string;
  title: string;
  owner: string | null;
  notes: string;
  /** User-written checks. NOT machine-verified; the frozen criteria on each item are. */
  manualChecks: ManualCheck[];
  workflowStatus: WorkflowStatus;
  wontFixReason: string | null;
  verificationStatus: VerificationStatus;
  items: TaskItem[];
  verifications: TaskVerification[];
  history: TaskEvent[];
}

export interface WorkspaceSettings {
  ruleConfig: RuleConfig;
  /** Base severity overrides by rule code. */
  severityOverrides: Record<string, Severity>;
}

export interface StoreDataV2 {
  schemaVersion: 2;
  sites: Record<string, Site>;
  pages: Record<string, PageIntent>;
  /** Audit metadata and crawl state. Snapshots and findings are stored per audit (see Store.readAudit). */
  audits: Record<string, AuditRun>;
  tasks: Record<string, FixTask>;
  settings: WorkspaceSettings;
  /** Sample workspace only: which version of the simulated sites is "deployed". */
  sampleState?: SampleState;
  /** Sample workspace only: seed version, so a changed seed re-seeds. */
  seedVersion?: string;
}

export type SampleState = "original" | "current" | "fixed" | "offline";

export type { ExpectationKey, Finding };

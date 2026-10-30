// Crawl subsystem tables (docs/SPEC.md "Core data model"). Everything else stays in the JSON store until Phase 3.
// Migrations are generated from this file with `npm run db:generate` into ./drizzle.
import { sql } from "drizzle-orm";
import { bigserial, bigint, boolean, check, index, integer, jsonb, pgTable, primaryKey, real, smallint, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { ACTIVE_STATES, TERMINAL_STATES } from "../crawl/v2/types";

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

export const CRAWL_STATUSES = ["queued", "running", "paused", "cancelling", "completed", "cancelled", "failed"] as const;
export type CrawlStatus = (typeof CRAWL_STATUSES)[number];

export const CRAWL_KINDS = ["audit", "verify"] as const;
export type CrawlKind = (typeof CRAWL_KINDS)[number];

export const crawls = pgTable(
  "crawls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The JSON-store audit this crawl belongs to (workspace + audit id). */
    workspace: text("workspace").notNull(),
    auditId: text("audit_id").notNull(),
    /**
     * The project (store site id) the crawl audits; crawls of one workspace and project form its history (issue
     * states, comparisons). Null on crawls created before Phase 3: their project is their site origin.
     */
    siteId: text("site_id"),
    /**
     * 'audit': a crawl of the site. 'verify': a fix verification that re-fetches one issue group's URLs
     * (config.verify); it writes issue states only for that group's fingerprints and is never an audit itself
     * (no comparison base, no overview, no health).
     */
    kind: text("kind").$type<CrawlKind>().notNull().default("audit"),
    siteOrigin: text("site_origin").notNull(),
    profile: text("profile").notNull(),
    /** Snapshot of the resolved crawl config (profile values plus overrides) at start. */
    config: jsonb("config").notNull(),
    status: text("status").$type<CrawlStatus>().notNull().default("queued"),
    /** Max URLs to fetch; null = unlimited. */
    budget: integer("budget"),
    /** Max link depth; null = unlimited. */
    maxDepth: integer("max_depth"),
    /** Fetches committed against the budget (incremented in the commit-to-send transaction). */
    fetchesCommitted: integer("fetches_committed").notNull().default(0),
    /** robots.txt as fetched: { url, status, outcome, body, sitemaps, crawlDelay }. */
    robots: jsonb("robots"),
    /** One record per sitemap document read, failed or skipped. */
    sitemaps: jsonb("sitemaps").notNull().default(sql`'[]'::jsonb`),
    discoveryDone: boolean("discovery_done").notNull().default(false),
    /** Where the start URL redirected before the crawl began (StartRedirect in runner.ts); null until checked. */
    startRedirect: jsonb("start_redirect"),
    /** Crawl-level probe results (src/lib/rules/probe-types.ts). */
    probes: jsonb("probes").notNull().default(sql`'[]'::jsonb`),
    /** Resource phase (external links, images) summary: CrawlResourcesSummary in src/lib/crawl/v2/resources.ts. */
    resources: jsonb("resources"),
    /** Analysis job progress: { status, startedAt, finishedAt, pages, findings, error }. */
    analysis: jsonb("analysis"),
    /** Health score written by the analysis job: Health in src/lib/results/health.ts. */
    health: jsonb("health"),
    /**
     * Render phase progress (RenderProgress in src/lib/render/run.ts): { mode, status, planned, rendered, timeouts,
     * errors, startedAt, finishedAt, error }. Null until the render job starts; a crawl whose config.render is
     * sampled or full is analysed only once its status is done or failed.
     */
    render: jsonb("render"),
    error: jsonb("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("crawls_audit_uq").on(t.workspace, t.auditId),
    index("crawls_status_idx").on(t.status),
    check("crawls_status_ck", sql`${t.status} in (${list(CRAWL_STATUSES)})`),
    check("crawls_kind_ck", sql`${t.kind} in (${list(CRAWL_KINDS)})`),
  ],
);

export const crawlUrls = pgTable(
  "crawl_urls",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    crawlId: uuid("crawl_id")
      .notNull()
      .references(() => crawls.id, { onDelete: "cascade" }),
    /** The URL as first found (evidence). */
    url: text("url").notNull(),
    normalisedUrl: text("normalised_url").notNull(),
    state: text("state").notNull().default("discovered"),
    /** Why the URL is in its terminal state; required once terminal. */
    reason: text("reason"),
    /** Minimum link depth from a seed; null when only sitemaps found it. */
    depth: integer("depth"),
    discoveredVia: text("discovered_via").array().notNull(),
    statusCode: integer("status_code"),
    contentType: text("content_type"),
    redirectTarget: text("redirect_target"),
    redirectHops: integer("redirect_hops").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    /** DOM-skeleton fingerprint of the page (templates.fingerprint), set by the site pass. */
    templateId: text("template_id"),
    /** Site pass (analysis): distinct crawled pages with an <a href> here, clicks from the start URL, internal PageRank 0–100. */
    inbound: integer("inbound"),
    linkDepth: integer("link_depth"),
    pagerank: real("pagerank"),
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    claimToken: text("claim_token"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    elapsedMs: integer("elapsed_ms"),
    bytes: integer("bytes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("crawl_urls_crawl_url_uq").on(t.crawlId, t.normalisedUrl),
    // Claim order: breadth-first by depth (sitemap-only URLs last), then discovery order.
    index("crawl_urls_claim_idx").on(t.crawlId, t.state, t.depth, t.id),
    index("crawl_urls_lease_idx").on(t.state, t.leaseUntil),
    check("crawl_urls_state_ck", sql`${t.state} in (${list([...ACTIVE_STATES, ...TERMINAL_STATES])})`),
    // Every terminal URL has a reason; active URLs have none.
    check("crawl_urls_reason_ck", sql`(${t.state} in (${list(TERMINAL_STATES)})) = (${t.reason} is not null)`),
  ],
);

export const urlEdges = pgTable(
  "url_edges",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    crawlId: uuid("crawl_id")
      .notNull()
      .references(() => crawls.id, { onDelete: "cascade" }),
    fromUrl: text("from_url").notNull(),
    toUrl: text("to_url").notNull(),
    /** Discovery source of this reference: link, canonical, pagination, hreflang, alternate, iframe, redirect. */
    via: text("via").notNull(),
    anchor: text("anchor"),
    rel: text("rel"),
    location: text("location"),
    nofollow: boolean("nofollow").notNull().default(false),
  },
  (t) => [index("url_edges_to_idx").on(t.crawlId, t.toUrl), index("url_edges_from_idx").on(t.crawlId, t.fromUrl)],
);

export const RESOURCE_KINDS = ["external_link", "image"] as const;
export const RESOURCE_STATES = ["queued", "started", "done", "skipped", "interrupted"] as const;

/**
 * External links and images referenced by crawled pages, checked in the resource phase after the URL crawl
 * (src/lib/crawl/v2/resources.ts). One row per crawl × kind × URL; planned rows over the budget are kept as skipped.
 */
export const resources = pgTable(
  "resources",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    crawlId: uuid("crawl_id")
      .notNull()
      .references(() => crawls.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    url: text("url").notNull(),
    host: text("host").notNull(),
    /** queued → started (request about to be sent) → done; or skipped (skip_code); started left by a dead worker → interrupted. */
    state: text("state").notNull().default("queued"),
    skipCode: text("skip_code"),
    /** HEAD, or GET when HEAD was refused; with a Range header for image dimensions. */
    method: text("method"),
    status: integer("status"),
    contentType: text("content_type"),
    /** Bytes from Content-Length, or the total in Content-Range; null when the server sent neither. */
    bytes: bigint("bytes", { mode: "number" }),
    width: integer("width"),
    height: integer("height"),
    error: jsonb("error"),
    /** Distinct crawled pages that reference it, and the first few. */
    referrers: integer("referrers").notNull().default(0),
    samplePages: jsonb("sample_pages").notNull().default(sql`'[]'::jsonb`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("resources_crawl_kind_url_uq").on(t.crawlId, t.kind, t.url),
    index("resources_crawl_state_idx").on(t.crawlId, t.kind, t.state, t.id),
    check("resources_kind_ck", sql`${t.kind} in (${list(RESOURCE_KINDS)})`),
    check("resources_state_ck", sql`${t.state} in (${list(RESOURCE_STATES)})`),
  ],
);

/** DOM-skeleton clusters of a crawl's HTML pages (site pass). */
export const templates = pgTable(
  "templates",
  {
    crawlId: uuid("crawl_id")
      .notNull()
      .references(() => crawls.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull(),
    pageCount: integer("page_count").notNull(),
    sampleUrl: text("sample_url").notNull(),
  },
  (t) => [primaryKey({ columns: [t.crawlId, t.fingerprint] })],
);

/**
 * One row per fetched URL: the spec's PageSnapshot (src/lib/snapshot/types.ts). Raw HTML lives gzipped in the blob
 * store; raw_html_key points at it. Extraction fields are null/empty for responses without an HTML body.
 */
export const pageSnapshots = pgTable(
  "page_snapshots",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    crawlId: uuid("crawl_id")
      .notNull()
      .references(() => crawls.id, { onDelete: "cascade" }),
    urlId: bigint("url_id", { mode: "number" })
      .notNull()
      .references(() => crawlUrls.id, { onDelete: "cascade" }),
    requestedUrl: text("requested_url"),
    finalUrl: text("final_url").notNull(),
    statusCode: integer("status_code").notNull(),
    contentType: text("content_type").notNull(),
    /** Redirect hops that led here, filled by analysis from the redirect edges. */
    redirectChain: jsonb("redirect_chain").notNull().default(sql`'[]'::jsonb`),
    headers: jsonb("headers").notNull(),
    rawHtmlKey: text("raw_html_key"),
    /** "stored" when raw_html_key points at the HTML, "blob_missing" when the write failed twice; null without an HTML body. */
    blobStatus: text("blob_status"),
    bytes: integer("bytes").notNull(),
    truncated: boolean("truncated").notNull(),
    elapsedMs: integer("elapsed_ms").notNull(),
    head: jsonb("head").notNull().default(sql`'[]'::jsonb`),
    canonicals: jsonb("canonicals").notNull().default(sql`'[]'::jsonb`),
    robots: jsonb("robots"),
    /** First document title (titles[0]), kept as a column for duplicate grouping. */
    title: text("title"),
    titles: jsonb("titles").notNull().default(sql`'[]'::jsonb`),
    description: text("description"),
    descriptions: jsonb("descriptions").notNull().default(sql`'[]'::jsonb`),
    outline: jsonb("outline").notNull().default(sql`'[]'::jsonb`),
    mainText: text("main_text"),
    wordCount: integer("word_count"),
    language: jsonb("language"),
    links: jsonb("links").notNull().default(sql`'[]'::jsonb`),
    images: jsonb("images").notNull().default(sql`'[]'::jsonb`),
    jsonLd: jsonb("json_ld").notNull().default(sql`'[]'::jsonb`),
    /** sha256 of the body as read. */
    contentHash: text("content_hash"),
    /** sha256 of the normalised main-content text (null under 50 words). */
    textHash: text("text_hash"),
    simhash: text("simhash"),
    templateFingerprint: text("template_fingerprint"),
    /** Template shape as 32-bit path hashes (src/lib/snapshot/template.ts); null before Phase 3. */
    templateShape: jsonb("template_shape"),
    timings: jsonb("timings"),
    facts: jsonb("facts"),
    outlinkCount: integer("outlink_count").notNull().default(0),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("page_snapshots_url_uq").on(t.urlId), index("page_snapshots_crawl_idx").on(t.crawlId, t.id)],
);

export const RENDER_STATUSES = ["rendered", "timeout", "error"] as const;
export type RenderStatus = (typeof RENDER_STATUSES)[number];

/**
 * One headless-browser render of a crawled HTML page (src/lib/render): what JavaScript changed, lab metrics, the
 * page's requests and its accessibility violations. The rendered DOM is in object storage (rendered_html_key); the
 * facts rules compare with the raw snapshot are extracted into `extract` by the render job, so analysis reads no blob.
 */
export const pageRenders = pgTable(
  "page_renders",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    crawlId: uuid("crawl_id")
      .notNull()
      .references(() => crawls.id, { onDelete: "cascade" }),
    urlId: bigint("url_id", { mode: "number" })
      .notNull()
      .references(() => crawlUrls.id, { onDelete: "cascade" }),
    /** The URL rendered (the snapshot's final URL) and where the page ended (history.pushState). */
    url: text("url").notNull(),
    finalUrl: text("final_url").notNull(),
    status: text("status").$type<RenderStatus>().notNull(),
    error: text("error"),
    renderedHtmlKey: text("rendered_html_key"),
    elapsedMs: integer("elapsed_ms").notNull(),
    /** RenderMetrics: LCP, CLS, LCP element, DOM size. Always lab data (source "lab"). */
    metrics: jsonb("metrics"),
    /** Facts extracted from the rendered DOM: RenderedExtract in src/lib/render/run.ts. */
    extract: jsonb("extract"),
    /** The page's requests (capped) and their totals. */
    requests: jsonb("requests").notNull().default(sql`'[]'::jsonb`),
    requestTotals: jsonb("request_totals"),
    scriptLinks: jsonb("script_links"),
    scriptNavigations: jsonb("script_navigations").notNull().default(sql`'[]'::jsonb`),
    /** axe-core violations per rule; null when axe could not run. */
    a11y: jsonb("a11y"),
    consoleErrors: integer("console_errors").notNull().default(0),
    renderedAt: timestamp("rendered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("page_renders_url_uq").on(t.urlId),
    index("page_renders_crawl_idx").on(t.crawlId, t.id),
    check("page_renders_status_ck", sql`${t.status} in (${list(RENDER_STATUSES)})`),
  ],
);

/** Rule registry (docs/SPEC.md "Core data model"): synced from src/lib/rules/registry.ts by each analysis run. */
export const rules = pgTable("rules", {
  id: text("id").primaryKey(),
  version: integer("version").notNull(),
  category: text("category").notNull(),
  scope: text("scope").notNull(),
  confidence: text("confidence").notNull(),
  impact: smallint("impact").notNull(),
  /** The rule's inputs (contract Need[]): a "rendered" rule re-checks a URL only where the URL was rendered. */
  needs: jsonb("needs").notNull().default(sql`'[]'::jsonb`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One per rule × URL × evidence. Written by the analysis job; a re-run replaces a crawl's findings. */
export const findings = pgTable(
  "findings",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    crawlId: uuid("crawl_id")
      .notNull()
      .references(() => crawls.id, { onDelete: "cascade" }),
    ruleId: text("rule_id").notNull(),
    ruleVersion: integer("rule_version").notNull(),
    url: text("url").notNull(),
    confidence: text("confidence").notNull(),
    message: text("message").notNull(),
    /** issue | inconclusive (the rule could not judge: e.g. its probe was skipped by robots.txt). */
    outcome: text("outcome").notNull().default("issue"),
    evidence: jsonb("evidence").notNull(),
    /** hash(rule id, normalised URL, evidence key) (src/lib/rules/fingerprint.ts); null on findings stored before Phase 3. */
    fingerprint: text("fingerprint"),
    evidenceKey: text("evidence_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("findings_crawl_rule_idx").on(t.crawlId, t.ruleId), index("findings_crawl_url_idx").on(t.crawlId, t.url), index("findings_crawl_fp_idx").on(t.crawlId, t.fingerprint)],
);

/**
 * What a crawl observed, one row per rule × URL × evidence key: a finding, or for a rule that reports per template
 * group, each page of the group. Issue groups, reach and the cross-audit states are computed from these rows.
 */
export const findingOccurrences = pgTable(
  "finding_occurrences",
  {
    crawlId: uuid("crawl_id")
      .notNull()
      .references(() => crawls.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull(),
    ruleId: text("rule_id").notNull(),
    url: text("url").notNull(),
    evidenceKey: text("evidence_key").notNull(),
    /** The page's template (crawl_urls.template_id) when the subject is a crawled page. */
    templateId: text("template_id"),
    /** issue | inconclusive */
    outcome: text("outcome").notNull(),
    /**
     * Indexable pages this occurrence counts toward reach: 1 or 0 for a page subject (indexable or not), the
     * evidence's page count for a resource or a template-wide finding, null for a site-wide subject (robots.txt).
     */
    reachPages: integer("reach_pages"),
  },
  (t) => [primaryKey({ columns: [t.crawlId, t.fingerprint] }), index("finding_occurrences_rule_idx").on(t.crawlId, t.ruleId)],
);

/** Finding states across audits (docs/SPEC.md "Finding states across audits"). */
export const ISSUE_STATES = ["new", "persistent", "resolved", "regressed", "not_rechecked", "inconclusive"] as const;
export type IssueState = (typeof ISSUE_STATES)[number];

/**
 * Each finding fingerprint's state in a crawl: every occurrence of the crawl, plus the previous audit's open
 * fingerprints this crawl did not observe (resolved when it re-checked them, else not_rechecked).
 */
export const issueStates = pgTable(
  "issue_states",
  {
    crawlId: uuid("crawl_id")
      .notNull()
      .references(() => crawls.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull(),
    ruleId: text("rule_id").notNull(),
    url: text("url").notNull(),
    evidenceKey: text("evidence_key").notNull(),
    templateId: text("template_id"),
    /** The occurrence's outcome in this crawl; null when it was carried over (not observed this time). */
    outcome: text("outcome"),
    state: text("state").$type<IssueState>().notNull(),
    /** When the fingerprint was first observed in this project. */
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    /**
     * Whether the subject is a URL of the crawl inventory (a page, a redirect, a 404), rather than robots.txt, a
     * sitemap, llms.txt or a probe (finding_occurrences.reach_pages null). Set when observed, carried over unchanged.
     * A site rule re-checks a URL subject only when the checking crawl answered that URL (states.ts rechecked).
     */
    pageSubject: boolean("page_subject").notNull().default(true),
  },
  (t) => [
    primaryKey({ columns: [t.crawlId, t.fingerprint] }),
    index("issue_states_fp_idx").on(t.fingerprint),
    index("issue_states_crawl_state_idx").on(t.crawlId, t.state),
    check("issue_states_state_ck", sql`${t.state} in (${list(ISSUE_STATES)})`),
  ],
);

/**
 * Read-only share links to an audit's report (src/lib/report/shares.ts). The token is shown once and stored only
 * as its SHA-256; the optional password only as a scrypt hash.
 */
export const reportShares = pgTable(
  "report_shares",
  {
    id: uuid("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    workspace: text("workspace").notNull(),
    auditId: text("audit_id").notNull(),
    crawlId: uuid("crawl_id")
      .notNull()
      .references(() => crawls.id, { onDelete: "cascade" }),
    /** scrypt$<salt b64url>$<hash b64url>; null: no password. */
    passwordHash: text("password_hash"),
    /** Null: never expires. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("report_shares_token_idx").on(t.tokenHash), index("report_shares_audit_idx").on(t.workspace, t.auditId)],
);

/** One per crawl and rule: the issue group, with the priority inputs (docs/HEALTH-SCORE.md) and the score. */
export const issueGroups = pgTable(
  "issue_groups",
  {
    crawlId: uuid("crawl_id")
      .notNull()
      .references(() => crawls.id, { onDelete: "cascade" }),
    ruleId: text("rule_id").notNull(),
    category: text("category").notNull(),
    impact: smallint("impact").notNull(),
    confidence: text("confidence").notNull(),
    confidenceWeight: real("confidence_weight").notNull(),
    /** Reach inputs: affected indexable pages over the crawl's indexable pages, and the log-scaled share. */
    affectedPages: integer("affected_pages").notNull(),
    indexablePages: integer("indexable_pages").notNull(),
    reach: real("reach").notNull(),
    score: real("score").notNull(),
    /** critical | high | medium | low | info */
    priority: text("priority").notNull(),
    /** Distinct subject URLs with an issue, and with an inconclusive result. */
    affectedUrls: integer("affected_urls").notNull(),
    inconclusiveUrls: integer("inconclusive_urls").notNull(),
    /** Distinct templates among the affected pages (subjects that are not crawled pages have none). */
    templateCount: integer("template_count").notNull().default(0),
    /** The first affected URLs in sort order (SAMPLE_URLS). */
    sampleUrls: jsonb("sample_urls").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  },
  (t) => [primaryKey({ columns: [t.crawlId, t.ruleId] })],
);

/** An issue group split by template: rule, then template (template_id '' = subjects outside any template). */
export const issueGroupTemplates = pgTable(
  "issue_group_templates",
  {
    crawlId: uuid("crawl_id")
      .notNull()
      .references(() => crawls.id, { onDelete: "cascade" }),
    ruleId: text("rule_id").notNull(),
    templateId: text("template_id").notNull(),
    affectedUrls: integer("affected_urls").notNull(),
    sampleUrls: jsonb("sample_urls").$type<string[]>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.crawlId, t.ruleId, t.templateId] })],
);

/** Per rule, per analysis run: did it run, on how many inputs, how many findings, how long. */
export const ruleRuns = pgTable(
  "rule_runs",
  {
    crawlId: uuid("crawl_id")
      .notNull()
      .references(() => crawls.id, { onDelete: "cascade" }),
    ruleId: text("rule_id").notNull(),
    ruleVersion: integer("rule_version").notNull(),
    /** ran | needs_config | error */
    status: text("status").notNull(),
    /** Pages evaluated (page rules) or 1 (site rules). */
    evaluated: integer("evaluated").notNull(),
    findings: integer("findings").notNull(),
    totalMs: real("total_ms").notNull(),
    detail: text("detail"),
  },
  (t) => [primaryKey({ columns: [t.crawlId, t.ruleId] })],
);

// ---------- app store (was .data/<workspace>/state.json): one row per entity, the entity itself in `data` ----------
// The columns beside `data` are copies for queries; `data` is what the app reads (src/lib/store/pg-store.ts).

/** A workspace ("live", "sample") and its settings. */
export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  schemaVersion: integer("schema_version").notNull().default(2),
  settings: jsonb("settings").notNull(),
  sampleState: text("sample_state"),
  seedVersion: text("seed_version"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

const storeRow = <C extends Record<string, ReturnType<typeof text>>>(name: string, extra: C) =>
  pgTable(
    name,
    {
      workspace: text("workspace")
        .notNull()
        .references(() => workspaces.id, { onDelete: "cascade" }),
      id: text("id").notNull(),
      ...extra,
      data: jsonb("data").notNull(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [primaryKey({ columns: [t.workspace, t.id] })],
  );

export const sites = storeRow("sites", { origin: text("origin").notNull() });
export const pageIntents = storeRow("page_intents", { siteId: text("site_id").notNull(), url: text("url").notNull() });
export const audits = storeRow("audits", { siteId: text("site_id").notNull(), status: text("status").notNull(), createdAt: text("created_at").notNull() });
export const tasks = storeRow("tasks", { siteId: text("site_id").notNull(), workflowStatus: text("workflow_status").notNull() });

/** An audit's snapshots and findings (was .data/<workspace>/audits/<id>.json). */
export const auditResults = pgTable(
  "audit_results",
  {
    workspace: text("workspace")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    auditId: text("audit_id").notNull(),
    snapshots: jsonb("snapshots").notNull(),
    findings: jsonb("findings").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspace, t.auditId] })],
);

/**
 * Fix board column of an issue group (subject "rule:<id>"), and a person's call on one fingerprint (subject
 * "fp:<fingerprint>": marked fixed, or ignored with a reason). Kept per project, so it carries over to the next audit
 * of the site. Triage never changes issue states, counts or the health score: only a crawl does (states.ts).
 */
export const TRIAGE_STATUSES = ["todo", "in_progress", "ready", "fixed", "ignored"] as const;
export type TriageStatus = (typeof TRIAGE_STATUSES)[number];
export const issueTriage = pgTable(
  "issue_triage",
  {
    workspace: text("workspace").notNull(),
    /** projectKey of the audits it applies to (crawls.site_id, else the site origin). */
    project: text("project").notNull(),
    subject: text("subject").notNull(),
    status: text("status").$type<TriageStatus>().notNull(),
    assignee: text("assignee"),
    /** Why it was ignored (required for "ignored"), or a note. */
    note: text("note"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspace, t.project, t.subject] }),
    check("issue_triage_status_ck", sql`${t.status} in (${list(TRIAGE_STATUSES)})`),
    check("issue_triage_subject_ck", sql`${t.subject} ~ '^(rule|fp):.+'`),
  ],
);

/** Audit log of triage changes: who set what, when. */
export const triageEvents = pgTable(
  "triage_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workspace: text("workspace").notNull(),
    project: text("project").notNull(),
    subject: text("subject").notNull(),
    /** Status, assignee and note after the change, and before it (null: first change). */
    after: jsonb("after").notNull(),
    before: jsonb("before"),
    actor: text("actor").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("triage_events_subject_idx").on(t.workspace, t.project, t.subject, t.id)],
);

/**
 * A scheduled audit of one site (docs/SPEC.md "Scheduled audits (daily, weekly, monthly) with regression diffing and
 * alerts"). `request` is the audit request the wizard would send (AuditRequest); the scheduler launches it when
 * `next_run_at` passes. The webhook secret signs alert bodies (HMAC-SHA256) and is stored encrypted with
 * CRAWLER_SECRET_KEY, scoped to the schedule.
 */
export const SCHEDULE_CADENCES = ["daily", "weekly", "monthly"] as const;
export const auditSchedules = pgTable(
  "audit_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspace: text("workspace").notNull(),
    siteId: text("site_id").notNull(),
    request: jsonb("request").notNull(),
    cadence: text("cadence").$type<(typeof SCHEDULE_CADENCES)[number]>().notNull(),
    hourUtc: smallint("hour_utc").notNull(),
    weekday: smallint("weekday"),
    monthday: smallint("monthday"),
    webhookUrl: text("webhook_url"),
    webhookSecret: text("webhook_secret"),
    enabled: boolean("enabled").notNull().default(true),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_schedules_due_idx").on(t.enabled, t.nextRunAt),
    index("audit_schedules_site_idx").on(t.workspace, t.siteId),
    check("audit_schedules_cadence_ck", sql`${t.cadence} in (${list(SCHEDULE_CADENCES)})`),
    check("audit_schedules_hour_ck", sql`${t.hourUtc} between 0 and 23`),
    check("audit_schedules_weekday_ck", sql`(${t.cadence} <> 'weekly') or (${t.weekday} between 0 and 6)`),
    check("audit_schedules_monthday_ck", sql`(${t.cadence} <> 'monthly') or (${t.monthday} between 1 and 28)`),
    check("audit_schedules_webhook_ck", sql`(${t.webhookUrl} is null) = (${t.webhookSecret} is null)`),
  ],
);

/** One launch of a schedule: the audit it started, or why it could not start. */
export const scheduleRuns = pgTable(
  "schedule_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    scheduleId: uuid("schedule_id")
      .notNull()
      .references(() => auditSchedules.id, { onDelete: "cascade" }),
    workspace: text("workspace").notNull(),
    auditId: text("audit_id"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("schedule_runs_schedule_idx").on(t.scheduleId, t.id), index("schedule_runs_audit_idx").on(t.workspace, t.auditId), check("schedule_runs_outcome_ck", sql`(${t.auditId} is null) <> (${t.error} is null)`)],
);

/**
 * The regression check of one scheduled audit after its analysis: sent (the receiver answered 2xx), failed (after the
 * retries), or skipped (nothing got worse, no earlier audit, or no webhook). One row per schedule and crawl, so a
 * redelivered analysis job never alerts twice.
 */
export const ALERT_STATUSES = ["sent", "failed", "skipped"] as const;
export const alertDeliveries = pgTable(
  "alert_deliveries",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    scheduleId: uuid("schedule_id")
      .notNull()
      .references(() => auditSchedules.id, { onDelete: "cascade" }),
    crawlId: uuid("crawl_id").notNull(),
    baseCrawlId: uuid("base_crawl_id"),
    status: text("status").$type<(typeof ALERT_STATUSES)[number]>().notNull(),
    httpStatus: integer("http_status"),
    attempts: integer("attempts").notNull().default(0),
    detail: text("detail").notNull(),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("alert_deliveries_schedule_crawl_uq").on(t.scheduleId, t.crawlId), check("alert_deliveries_status_ck", sql`${t.status} in (${list(ALERT_STATUSES)})`)],
);

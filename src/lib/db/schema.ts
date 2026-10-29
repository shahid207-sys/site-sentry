// Crawl subsystem tables (docs/SPEC.md "Core data model"). Everything else stays in the JSON store until Phase 3.
// Migrations are generated from this file with `npm run db:generate` into ./drizzle.
import { sql } from "drizzle-orm";
import { bigserial, bigint, boolean, check, index, integer, jsonb, pgTable, primaryKey, real, smallint, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { ACTIVE_STATES, TERMINAL_STATES } from "../crawl/v2/types";

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

export const CRAWL_STATUSES = ["queued", "running", "paused", "cancelling", "completed", "cancelled", "failed"] as const;
export type CrawlStatus = (typeof CRAWL_STATUSES)[number];

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

/** Rule registry (docs/SPEC.md "Core data model"): synced from src/lib/rules/registry.ts by each analysis run. */
export const rules = pgTable("rules", {
  id: text("id").primaryKey(),
  version: integer("version").notNull(),
  category: text("category").notNull(),
  scope: text("scope").notNull(),
  confidence: text("confidence").notNull(),
  impact: smallint("impact").notNull(),
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
  },
  (t) => [
    primaryKey({ columns: [t.crawlId, t.fingerprint] }),
    index("issue_states_fp_idx").on(t.fingerprint),
    index("issue_states_crawl_state_idx").on(t.crawlId, t.state),
    check("issue_states_state_ck", sql`${t.state} in (${list(ISSUE_STATES)})`),
  ],
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

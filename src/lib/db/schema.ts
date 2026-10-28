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
    /** Crawl-level probe results (src/lib/rules/probe-types.ts). */
    probes: jsonb("probes").notNull().default(sql`'[]'::jsonb`),
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
    templateId: text("template_id"),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("findings_crawl_rule_idx").on(t.crawlId, t.ruleId), index("findings_crawl_url_idx").on(t.crawlId, t.url)],
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

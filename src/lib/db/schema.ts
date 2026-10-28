// Crawl subsystem tables (docs/SPEC.md "Core data model"). Everything else stays in the JSON store until Phase 3.
// Migrations are generated from this file with `npm run db:generate` into ./drizzle.
import { sql } from "drizzle-orm";
import { bigserial, bigint, boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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

/** Phase 1 subset of the spec's page snapshot; Phase 2 adds head tags, headings, text stats and storage keys. */
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
    finalUrl: text("final_url").notNull(),
    statusCode: integer("status_code").notNull(),
    contentType: text("content_type").notNull(),
    headers: jsonb("headers").notNull(),
    bytes: integer("bytes").notNull(),
    truncated: boolean("truncated").notNull(),
    elapsedMs: integer("elapsed_ms").notNull(),
    /** sha256 of the body as read. */
    contentHash: text("content_hash"),
    outlinkCount: integer("outlink_count").notNull().default(0),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("page_snapshots_url_uq").on(t.urlId), index("page_snapshots_crawl_idx").on(t.crawlId)],
);

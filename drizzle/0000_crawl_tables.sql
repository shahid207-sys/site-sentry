CREATE TABLE "crawl_urls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"crawl_id" uuid NOT NULL,
	"url" text NOT NULL,
	"normalised_url" text NOT NULL,
	"state" text DEFAULT 'discovered' NOT NULL,
	"reason" text,
	"depth" integer,
	"discovered_via" text[] NOT NULL,
	"status_code" integer,
	"content_type" text,
	"redirect_target" text,
	"redirect_hops" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"template_id" text,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"claim_token" text,
	"fetched_at" timestamp with time zone,
	"elapsed_ms" integer,
	"bytes" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crawl_urls_state_ck" CHECK ("crawl_urls"."state" in ('discovered', 'queued', 'fetching', 'fetched', 'analysed', 'blocked_robots', 'out_of_scope', 'excluded_by_rule', 'budget_exhausted', 'depth_exceeded', 'redirected', 'failed_timeout', 'failed_dns', 'failed_tls', 'failed_network', 'interrupted', 'non_html', 'oversized', 'cancelled')),
	CONSTRAINT "crawl_urls_reason_ck" CHECK (("crawl_urls"."state" in ('fetched', 'analysed', 'blocked_robots', 'out_of_scope', 'excluded_by_rule', 'budget_exhausted', 'depth_exceeded', 'redirected', 'failed_timeout', 'failed_dns', 'failed_tls', 'failed_network', 'interrupted', 'non_html', 'oversized', 'cancelled')) = ("crawl_urls"."reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "crawls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace" text NOT NULL,
	"audit_id" text NOT NULL,
	"site_origin" text NOT NULL,
	"profile" text NOT NULL,
	"config" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"budget" integer,
	"max_depth" integer,
	"fetches_committed" integer DEFAULT 0 NOT NULL,
	"robots" jsonb,
	"sitemaps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"discovery_done" boolean DEFAULT false NOT NULL,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	CONSTRAINT "crawls_status_ck" CHECK ("crawls"."status" in ('queued', 'running', 'paused', 'cancelling', 'completed', 'cancelled', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "page_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"crawl_id" uuid NOT NULL,
	"url_id" bigint NOT NULL,
	"final_url" text NOT NULL,
	"status_code" integer NOT NULL,
	"content_type" text NOT NULL,
	"headers" jsonb NOT NULL,
	"bytes" integer NOT NULL,
	"truncated" boolean NOT NULL,
	"elapsed_ms" integer NOT NULL,
	"content_hash" text,
	"outlink_count" integer DEFAULT 0 NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "url_edges" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"crawl_id" uuid NOT NULL,
	"from_url" text NOT NULL,
	"to_url" text NOT NULL,
	"via" text NOT NULL,
	"anchor" text,
	"rel" text,
	"location" text,
	"nofollow" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crawl_urls" ADD CONSTRAINT "crawl_urls_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD CONSTRAINT "page_snapshots_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD CONSTRAINT "page_snapshots_url_id_crawl_urls_id_fk" FOREIGN KEY ("url_id") REFERENCES "public"."crawl_urls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "url_edges" ADD CONSTRAINT "url_edges_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "crawl_urls_crawl_url_uq" ON "crawl_urls" USING btree ("crawl_id","normalised_url");--> statement-breakpoint
CREATE INDEX "crawl_urls_claim_idx" ON "crawl_urls" USING btree ("crawl_id","state","depth","id");--> statement-breakpoint
CREATE INDEX "crawl_urls_lease_idx" ON "crawl_urls" USING btree ("state","lease_until");--> statement-breakpoint
CREATE UNIQUE INDEX "crawls_audit_uq" ON "crawls" USING btree ("workspace","audit_id");--> statement-breakpoint
CREATE INDEX "crawls_status_idx" ON "crawls" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "page_snapshots_url_uq" ON "page_snapshots" USING btree ("url_id");--> statement-breakpoint
CREATE INDEX "page_snapshots_crawl_idx" ON "page_snapshots" USING btree ("crawl_id");--> statement-breakpoint
CREATE INDEX "url_edges_to_idx" ON "url_edges" USING btree ("crawl_id","to_url");--> statement-breakpoint
CREATE INDEX "url_edges_from_idx" ON "url_edges" USING btree ("crawl_id","from_url");
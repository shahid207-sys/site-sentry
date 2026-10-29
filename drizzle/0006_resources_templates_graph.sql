CREATE TABLE "resources" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"crawl_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"url" text NOT NULL,
	"host" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"skip_code" text,
	"method" text,
	"status" integer,
	"content_type" text,
	"bytes" bigint,
	"width" integer,
	"height" integer,
	"error" jsonb,
	"referrers" integer DEFAULT 0 NOT NULL,
	"sample_pages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resources_kind_ck" CHECK ("resources"."kind" in ('external_link', 'image')),
	CONSTRAINT "resources_state_ck" CHECK ("resources"."state" in ('queued', 'started', 'done', 'skipped', 'interrupted'))
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"crawl_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"page_count" integer NOT NULL,
	"sample_url" text NOT NULL,
	CONSTRAINT "templates_crawl_id_fingerprint_pk" PRIMARY KEY("crawl_id","fingerprint")
);
--> statement-breakpoint
ALTER TABLE "crawl_urls" ADD COLUMN "inbound" integer;--> statement-breakpoint
ALTER TABLE "crawl_urls" ADD COLUMN "link_depth" integer;--> statement-breakpoint
ALTER TABLE "crawl_urls" ADD COLUMN "pagerank" real;--> statement-breakpoint
ALTER TABLE "crawls" ADD COLUMN "resources" jsonb;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "resources_crawl_kind_url_uq" ON "resources" USING btree ("crawl_id","kind","url");--> statement-breakpoint
CREATE INDEX "resources_crawl_state_idx" ON "resources" USING btree ("crawl_id","kind","state","id");
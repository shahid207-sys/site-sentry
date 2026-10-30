CREATE TABLE "page_renders" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"crawl_id" uuid NOT NULL,
	"url_id" bigint NOT NULL,
	"url" text NOT NULL,
	"final_url" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"rendered_html_key" text,
	"elapsed_ms" integer NOT NULL,
	"metrics" jsonb,
	"extract" jsonb,
	"requests" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"request_totals" jsonb,
	"script_links" jsonb,
	"script_navigations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"a11y" jsonb,
	"console_errors" integer DEFAULT 0 NOT NULL,
	"rendered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_renders_status_ck" CHECK ("page_renders"."status" in ('rendered', 'timeout', 'error'))
);
--> statement-breakpoint
ALTER TABLE "crawls" ADD COLUMN "render" jsonb;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "needs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "page_renders" ADD CONSTRAINT "page_renders_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_renders" ADD CONSTRAINT "page_renders_url_id_crawl_urls_id_fk" FOREIGN KEY ("url_id") REFERENCES "public"."crawl_urls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "page_renders_url_uq" ON "page_renders" USING btree ("url_id");--> statement-breakpoint
CREATE INDEX "page_renders_crawl_idx" ON "page_renders" USING btree ("crawl_id","id");
CREATE TABLE "ai_analyses" (
	"audit_id" text PRIMARY KEY NOT NULL,
	"crawl_id" uuid NOT NULL,
	"status" text NOT NULL,
	"model" text,
	"analysis" jsonb,
	"dropped" jsonb,
	"usage" jsonb,
	"detail" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_analyses_status_ck" CHECK ("ai_analyses"."status" in ('queued', 'done', 'failed', 'not_configured', 'over_budget'))
);
--> statement-breakpoint
ALTER TABLE "ai_analyses" ADD CONSTRAINT "ai_analyses_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_analyses_crawl_idx" ON "ai_analyses" USING btree ("crawl_id");
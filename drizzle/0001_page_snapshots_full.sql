DROP INDEX "page_snapshots_crawl_idx";--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD COLUMN "requested_url" text;--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD COLUMN "redirect_chain" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD COLUMN "raw_html_key" text;--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD COLUMN "head" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD COLUMN "canonicals" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD COLUMN "robots" jsonb;--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD COLUMN "titles" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD COLUMN "descriptions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD COLUMN "outline" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD COLUMN "main_text" text;--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD COLUMN "word_count" integer;--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD COLUMN "language" jsonb;--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD COLUMN "links" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD COLUMN "images" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD COLUMN "json_ld" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD COLUMN "text_hash" text;--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD COLUMN "simhash" text;--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD COLUMN "template_fingerprint" text;--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD COLUMN "timings" jsonb;--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD COLUMN "facts" jsonb;--> statement-breakpoint
CREATE INDEX "page_snapshots_crawl_idx" ON "page_snapshots" USING btree ("crawl_id","id");
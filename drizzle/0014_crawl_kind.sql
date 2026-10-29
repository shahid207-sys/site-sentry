ALTER TABLE "crawls" ADD COLUMN "kind" text DEFAULT 'audit' NOT NULL;--> statement-breakpoint
ALTER TABLE "crawls" ADD CONSTRAINT "crawls_kind_ck" CHECK ("crawls"."kind" in ('audit', 'verify'));
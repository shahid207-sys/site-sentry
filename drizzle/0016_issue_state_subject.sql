ALTER TABLE "issue_states" ADD COLUMN "page_subject" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- Backfill: a state is about a site-wide subject when the fingerprint was observed with no crawl-inventory URL.
UPDATE "issue_states" s SET "page_subject" = false WHERE EXISTS (SELECT 1 FROM "finding_occurrences" o WHERE o."fingerprint" = s."fingerprint" AND o."reach_pages" IS NULL);

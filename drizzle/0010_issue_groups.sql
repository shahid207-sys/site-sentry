CREATE TABLE "finding_occurrences" (
	"crawl_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"rule_id" text NOT NULL,
	"url" text NOT NULL,
	"evidence_key" text NOT NULL,
	"template_id" text,
	"outcome" text NOT NULL,
	"reach_pages" integer,
	CONSTRAINT "finding_occurrences_crawl_id_fingerprint_pk" PRIMARY KEY("crawl_id","fingerprint")
);
--> statement-breakpoint
CREATE TABLE "issue_groups" (
	"crawl_id" uuid NOT NULL,
	"rule_id" text NOT NULL,
	"category" text NOT NULL,
	"impact" smallint NOT NULL,
	"confidence" text NOT NULL,
	"confidence_weight" real NOT NULL,
	"affected_pages" integer NOT NULL,
	"indexable_pages" integer NOT NULL,
	"reach" real NOT NULL,
	"score" real NOT NULL,
	"priority" text NOT NULL,
	"affected_urls" integer NOT NULL,
	"inconclusive_urls" integer NOT NULL,
	CONSTRAINT "issue_groups_crawl_id_rule_id_pk" PRIMARY KEY("crawl_id","rule_id")
);
--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "fingerprint" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "evidence_key" text;--> statement-breakpoint
ALTER TABLE "finding_occurrences" ADD CONSTRAINT "finding_occurrences_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_groups" ADD CONSTRAINT "issue_groups_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finding_occurrences_rule_idx" ON "finding_occurrences" USING btree ("crawl_id","rule_id");--> statement-breakpoint
CREATE INDEX "findings_crawl_fp_idx" ON "findings" USING btree ("crawl_id","fingerprint");
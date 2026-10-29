CREATE TABLE "issue_group_templates" (
	"crawl_id" uuid NOT NULL,
	"rule_id" text NOT NULL,
	"template_id" text NOT NULL,
	"affected_urls" integer NOT NULL,
	"sample_urls" jsonb NOT NULL,
	CONSTRAINT "issue_group_templates_crawl_id_rule_id_template_id_pk" PRIMARY KEY("crawl_id","rule_id","template_id")
);
--> statement-breakpoint
ALTER TABLE "issue_groups" ADD COLUMN "template_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_groups" ADD COLUMN "sample_urls" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_group_templates" ADD CONSTRAINT "issue_group_templates_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;
CREATE TABLE "issue_states" (
	"crawl_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"rule_id" text NOT NULL,
	"url" text NOT NULL,
	"evidence_key" text NOT NULL,
	"template_id" text,
	"outcome" text,
	"state" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "issue_states_crawl_id_fingerprint_pk" PRIMARY KEY("crawl_id","fingerprint"),
	CONSTRAINT "issue_states_state_ck" CHECK ("issue_states"."state" in ('new', 'persistent', 'resolved', 'regressed', 'not_rechecked', 'inconclusive'))
);
--> statement-breakpoint
ALTER TABLE "crawls" ADD COLUMN "site_id" text;--> statement-breakpoint
ALTER TABLE "issue_states" ADD CONSTRAINT "issue_states_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_states_fp_idx" ON "issue_states" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "issue_states_crawl_state_idx" ON "issue_states" USING btree ("crawl_id","state");
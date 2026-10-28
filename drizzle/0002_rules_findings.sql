CREATE TABLE "findings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"crawl_id" uuid NOT NULL,
	"rule_id" text NOT NULL,
	"rule_version" integer NOT NULL,
	"url" text NOT NULL,
	"confidence" text NOT NULL,
	"message" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rule_runs" (
	"crawl_id" uuid NOT NULL,
	"rule_id" text NOT NULL,
	"rule_version" integer NOT NULL,
	"status" text NOT NULL,
	"evaluated" integer NOT NULL,
	"findings" integer NOT NULL,
	"total_ms" real NOT NULL,
	"detail" text,
	CONSTRAINT "rule_runs_crawl_id_rule_id_pk" PRIMARY KEY("crawl_id","rule_id")
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"category" text NOT NULL,
	"scope" text NOT NULL,
	"confidence" text NOT NULL,
	"impact" smallint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crawls" ADD COLUMN "probes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "crawls" ADD COLUMN "analysis" jsonb;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_runs" ADD CONSTRAINT "rule_runs_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "findings_crawl_rule_idx" ON "findings" USING btree ("crawl_id","rule_id");--> statement-breakpoint
CREATE INDEX "findings_crawl_url_idx" ON "findings" USING btree ("crawl_id","url");
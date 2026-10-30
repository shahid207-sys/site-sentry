CREATE TABLE "alert_deliveries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"schedule_id" uuid NOT NULL,
	"crawl_id" uuid NOT NULL,
	"base_crawl_id" uuid,
	"status" text NOT NULL,
	"http_status" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"detail" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_deliveries_status_ck" CHECK ("alert_deliveries"."status" in ('sent', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "audit_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace" text NOT NULL,
	"site_id" text NOT NULL,
	"request" jsonb NOT NULL,
	"cadence" text NOT NULL,
	"hour_utc" smallint NOT NULL,
	"weekday" smallint,
	"monthday" smallint,
	"webhook_url" text,
	"webhook_secret" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_schedules_cadence_ck" CHECK ("audit_schedules"."cadence" in ('daily', 'weekly', 'monthly')),
	CONSTRAINT "audit_schedules_hour_ck" CHECK ("audit_schedules"."hour_utc" between 0 and 23),
	CONSTRAINT "audit_schedules_weekday_ck" CHECK (("audit_schedules"."cadence" <> 'weekly') or ("audit_schedules"."weekday" between 0 and 6)),
	CONSTRAINT "audit_schedules_monthday_ck" CHECK (("audit_schedules"."cadence" <> 'monthly') or ("audit_schedules"."monthday" between 1 and 28)),
	CONSTRAINT "audit_schedules_webhook_ck" CHECK (("audit_schedules"."webhook_url" is null) = ("audit_schedules"."webhook_secret" is null))
);
--> statement-breakpoint
CREATE TABLE "schedule_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"schedule_id" uuid NOT NULL,
	"workspace" text NOT NULL,
	"audit_id" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_runs_outcome_ck" CHECK (("schedule_runs"."audit_id" is null) <> ("schedule_runs"."error" is null))
);
--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_schedule_id_audit_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."audit_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_schedule_id_audit_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."audit_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alert_deliveries_schedule_crawl_uq" ON "alert_deliveries" USING btree ("schedule_id","crawl_id");--> statement-breakpoint
CREATE INDEX "audit_schedules_due_idx" ON "audit_schedules" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "audit_schedules_site_idx" ON "audit_schedules" USING btree ("workspace","site_id");--> statement-breakpoint
CREATE INDEX "schedule_runs_schedule_idx" ON "schedule_runs" USING btree ("schedule_id","id");--> statement-breakpoint
CREATE INDEX "schedule_runs_audit_idx" ON "schedule_runs" USING btree ("workspace","audit_id");
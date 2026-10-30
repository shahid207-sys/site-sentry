CREATE TABLE "issue_triage" (
	"workspace" text NOT NULL,
	"project" text NOT NULL,
	"subject" text NOT NULL,
	"status" text NOT NULL,
	"assignee" text,
	"note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_triage_workspace_project_subject_pk" PRIMARY KEY("workspace","project","subject"),
	CONSTRAINT "issue_triage_status_ck" CHECK ("issue_triage"."status" in ('todo', 'in_progress', 'ready', 'fixed', 'ignored')),
	CONSTRAINT "issue_triage_subject_ck" CHECK ("issue_triage"."subject" ~ '^(rule|fp):.+')
);
--> statement-breakpoint
CREATE TABLE "triage_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace" text NOT NULL,
	"project" text NOT NULL,
	"subject" text NOT NULL,
	"after" jsonb NOT NULL,
	"before" jsonb,
	"actor" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "triage_events_subject_idx" ON "triage_events" USING btree ("workspace","project","subject","id");
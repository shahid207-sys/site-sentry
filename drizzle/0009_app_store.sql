CREATE TABLE "audit_results" (
	"workspace" text NOT NULL,
	"audit_id" text NOT NULL,
	"snapshots" jsonb NOT NULL,
	"findings" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_results_workspace_audit_id_pk" PRIMARY KEY("workspace","audit_id")
);
--> statement-breakpoint
CREATE TABLE "audits" (
	"workspace" text NOT NULL,
	"id" text NOT NULL,
	"site_id" text NOT NULL,
	"status" text NOT NULL,
	"created_at" text NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audits_workspace_id_pk" PRIMARY KEY("workspace","id")
);
--> statement-breakpoint
CREATE TABLE "page_intents" (
	"workspace" text NOT NULL,
	"id" text NOT NULL,
	"site_id" text NOT NULL,
	"url" text NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_intents_workspace_id_pk" PRIMARY KEY("workspace","id")
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"workspace" text NOT NULL,
	"id" text NOT NULL,
	"origin" text NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sites_workspace_id_pk" PRIMARY KEY("workspace","id")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"workspace" text NOT NULL,
	"id" text NOT NULL,
	"site_id" text NOT NULL,
	"workflow_status" text NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_workspace_id_pk" PRIMARY KEY("workspace","id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"schema_version" integer DEFAULT 2 NOT NULL,
	"settings" jsonb NOT NULL,
	"sample_state" text,
	"seed_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_results" ADD CONSTRAINT "audit_results_workspace_workspaces_id_fk" FOREIGN KEY ("workspace") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audits" ADD CONSTRAINT "audits_workspace_workspaces_id_fk" FOREIGN KEY ("workspace") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_intents" ADD CONSTRAINT "page_intents_workspace_workspaces_id_fk" FOREIGN KEY ("workspace") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_workspace_workspaces_id_fk" FOREIGN KEY ("workspace") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspace_workspaces_id_fk" FOREIGN KEY ("workspace") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
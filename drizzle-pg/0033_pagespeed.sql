CREATE TABLE "pagespeed_result_issues" (
	"id" text PRIMARY KEY NOT NULL,
	"result_id" text NOT NULL,
	"audit_key" text NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"severity" text NOT NULL,
	"display_value" text,
	"impact_ms" real,
	"impact_bytes" real
);
--> statement-breakpoint
CREATE TABLE "pagespeed_results" (
	"id" text PRIMARY KEY NOT NULL,
	"sweep_id" text NOT NULL,
	"url" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"fetched_at" text,
	"performance" integer,
	"accessibility" integer,
	"best_practices" integer,
	"seo" integer,
	"lcp_ms" real,
	"cls" real,
	"tbt_ms" real,
	"fcp_ms" real,
	"speed_index_ms" real,
	"field_scope" text,
	"field_overall" text,
	"field_lcp_ms" real,
	"field_inp_ms" real,
	"field_cls" real
);
--> statement-breakpoint
CREATE TABLE "pagespeed_sweeps" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"start_url" text NOT NULL,
	"status" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"urls_total" integer DEFAULT 0 NOT NULL,
	"urls_done" integer DEFAULT 0 NOT NULL,
	"urls_failed" integer DEFAULT 0 NOT NULL,
	"resume_at" text,
	"error" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"started_at" text,
	"heartbeat_at" text,
	"completed_at" text
);
--> statement-breakpoint
CREATE TABLE "pagespeed_usage" (
	"day" text PRIMARY KEY NOT NULL,
	"used" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pagespeed_result_issues" ADD CONSTRAINT "pagespeed_result_issues_result_id_pagespeed_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."pagespeed_results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pagespeed_results" ADD CONSTRAINT "pagespeed_results_sweep_id_pagespeed_sweeps_id_fk" FOREIGN KEY ("sweep_id") REFERENCES "public"."pagespeed_sweeps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pagespeed_sweeps" ADD CONSTRAINT "pagespeed_sweeps_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pagespeed_result_issues_result_idx" ON "pagespeed_result_issues" USING btree ("result_id");--> statement-breakpoint
CREATE INDEX "pagespeed_result_issues_audit_key_idx" ON "pagespeed_result_issues" USING btree ("audit_key");--> statement-breakpoint
CREATE UNIQUE INDEX "pagespeed_results_sweep_url_idx" ON "pagespeed_results" USING btree ("sweep_id","url");--> statement-breakpoint
CREATE INDEX "pagespeed_results_sweep_status_idx" ON "pagespeed_results" USING btree ("sweep_id","status");--> statement-breakpoint
CREATE INDEX "pagespeed_sweeps_project_idx" ON "pagespeed_sweeps" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "pagespeed_sweeps_status_idx" ON "pagespeed_sweeps" USING btree ("status");
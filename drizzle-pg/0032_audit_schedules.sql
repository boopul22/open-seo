CREATE TABLE "audit_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"start_url" text NOT NULL,
	"max_pages" integer NOT NULL,
	"created_by_user_id" text NOT NULL,
	"next_run_at" text NOT NULL,
	"last_run_at" text,
	"last_audit_id" text,
	"previous_audit_id" text,
	"last_skip_reason" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_schedules" ADD CONSTRAINT "audit_schedules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_schedules" ADD CONSTRAINT "audit_schedules_last_audit_id_audits_id_fk" FOREIGN KEY ("last_audit_id") REFERENCES "public"."audits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_schedules" ADD CONSTRAINT "audit_schedules_previous_audit_id_audits_id_fk" FOREIGN KEY ("previous_audit_id") REFERENCES "public"."audits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_schedules_project_id_idx" ON "audit_schedules" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "audit_schedules_next_run_at_idx" ON "audit_schedules" USING btree ("next_run_at");
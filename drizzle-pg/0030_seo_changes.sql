CREATE TABLE "seo_change_checkpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"change_id" text NOT NULL,
	"kind" text NOT NULL,
	"window_start" text NOT NULL,
	"window_end" text NOT NULL,
	"due_at" text NOT NULL,
	"status" text NOT NULL,
	"measured_at" text,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seo_change_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"checkpoint_id" text NOT NULL,
	"target_id" text,
	"device" text NOT NULL,
	"clicks" integer NOT NULL,
	"impressions" integer NOT NULL,
	"ctr" real NOT NULL,
	"position" real NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seo_change_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"change_id" text NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seo_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"shipped_at" text NOT NULL,
	"timezone" text NOT NULL,
	"ship_date" text NOT NULL,
	"type" text NOT NULL,
	"summary" text NOT NULL,
	"title_before" text,
	"title_after" text,
	"meta_description_before" text,
	"meta_description_after" text,
	"commit_hash" text,
	"deploy_id" text,
	"pr_url" text,
	"author" text NOT NULL,
	"author_kind" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"notes" text,
	"status" text NOT NULL,
	"reverted_at" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "seo_change_checkpoints" ADD CONSTRAINT "seo_change_checkpoints_change_id_seo_changes_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."seo_changes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_change_metrics" ADD CONSTRAINT "seo_change_metrics_checkpoint_id_seo_change_checkpoints_id_fk" FOREIGN KEY ("checkpoint_id") REFERENCES "public"."seo_change_checkpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_change_metrics" ADD CONSTRAINT "seo_change_metrics_target_id_seo_change_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."seo_change_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_change_targets" ADD CONSTRAINT "seo_change_targets_change_id_seo_changes_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."seo_changes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_changes" ADD CONSTRAINT "seo_changes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "seo_change_checkpoints_change_kind_idx" ON "seo_change_checkpoints" USING btree ("change_id","kind");--> statement-breakpoint
CREATE INDEX "seo_change_checkpoints_status_due_idx" ON "seo_change_checkpoints" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "seo_change_metrics_checkpoint_idx" ON "seo_change_metrics" USING btree ("checkpoint_id");--> statement-breakpoint
CREATE UNIQUE INDEX "seo_change_targets_change_kind_value_idx" ON "seo_change_targets" USING btree ("change_id","kind","value");--> statement-breakpoint
CREATE INDEX "seo_changes_project_ship_date_idx" ON "seo_changes" USING btree ("project_id","ship_date");
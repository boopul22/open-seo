CREATE TABLE "gsc_index_sweeps" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"site_url" text NOT NULL,
	"kind" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"total_urls" integer DEFAULT 0 NOT NULL,
	"inspected_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"resume_at" text,
	"error" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"finished_at" text
);
--> statement-breakpoint
CREATE TABLE "gsc_index_urls" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"url" text NOT NULL,
	"in_sitemap" boolean DEFAULT false NOT NULL,
	"in_search_analytics" boolean DEFAULT false NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"discovered_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"requested_at" text,
	"last_inspected_at" text,
	"last_inspection_id" text,
	"coverage_state_since" text
);
--> statement-breakpoint
CREATE TABLE "gsc_inspection_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"site_url" text NOT NULL,
	"day" text NOT NULL,
	"used" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gsc_sitemap_contents" (
	"id" text PRIMARY KEY NOT NULL,
	"sitemap_id" text NOT NULL,
	"type" text NOT NULL,
	"submitted" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gsc_sitemaps" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"path" text NOT NULL,
	"parent_path" text,
	"type" text,
	"is_pending" boolean DEFAULT false NOT NULL,
	"is_sitemaps_index" boolean DEFAULT false NOT NULL,
	"last_submitted" text,
	"last_downloaded" text,
	"errors" integer DEFAULT 0 NOT NULL,
	"warnings" integer DEFAULT 0 NOT NULL,
	"fetched_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gsc_url_inspection_links" (
	"id" text PRIMARY KEY NOT NULL,
	"inspection_id" text NOT NULL,
	"kind" text NOT NULL,
	"url" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gsc_url_inspections" (
	"id" text PRIMARY KEY NOT NULL,
	"url_id" text NOT NULL,
	"inspected_at" text NOT NULL,
	"error" text,
	"verdict" text,
	"coverage_state" text,
	"robots_txt_state" text,
	"indexing_state" text,
	"page_fetch_state" text,
	"last_crawl_time" text,
	"crawled_as" text,
	"google_canonical" text,
	"user_canonical" text,
	"rich_results_verdict" text,
	"mobile_usability_verdict" text,
	"inspection_link" text,
	"page_title" text,
	"page_meta_description" text,
	"page_http_status" integer
);
--> statement-breakpoint
CREATE TABLE "gsc_url_rich_result_issues" (
	"id" text PRIMARY KEY NOT NULL,
	"inspection_id" text NOT NULL,
	"rich_result_type" text NOT NULL,
	"item_name" text,
	"issue_message" text,
	"severity" text
);
--> statement-breakpoint
ALTER TABLE "gsc_index_sweeps" ADD CONSTRAINT "gsc_index_sweeps_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_index_urls" ADD CONSTRAINT "gsc_index_urls_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_sitemap_contents" ADD CONSTRAINT "gsc_sitemap_contents_sitemap_id_gsc_sitemaps_id_fk" FOREIGN KEY ("sitemap_id") REFERENCES "public"."gsc_sitemaps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_sitemaps" ADD CONSTRAINT "gsc_sitemaps_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_url_inspection_links" ADD CONSTRAINT "gsc_url_inspection_links_inspection_id_gsc_url_inspections_id_fk" FOREIGN KEY ("inspection_id") REFERENCES "public"."gsc_url_inspections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_url_inspections" ADD CONSTRAINT "gsc_url_inspections_url_id_gsc_index_urls_id_fk" FOREIGN KEY ("url_id") REFERENCES "public"."gsc_index_urls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_url_rich_result_issues" ADD CONSTRAINT "gsc_url_rich_result_issues_inspection_id_gsc_url_inspections_id_fk" FOREIGN KEY ("inspection_id") REFERENCES "public"."gsc_url_inspections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gsc_index_sweeps_project_idx" ON "gsc_index_sweeps" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "gsc_index_sweeps_one_active_per_project_idx" ON "gsc_index_sweeps" USING btree ("project_id") WHERE "gsc_index_sweeps"."status" IN ('queued', 'collecting', 'running', 'waiting_quota');--> statement-breakpoint
CREATE UNIQUE INDEX "gsc_index_urls_project_url_idx" ON "gsc_index_urls" USING btree ("project_id","url");--> statement-breakpoint
CREATE INDEX "gsc_index_urls_queue_idx" ON "gsc_index_urls" USING btree ("project_id","last_inspected_at");--> statement-breakpoint
CREATE UNIQUE INDEX "gsc_inspection_usage_site_day_idx" ON "gsc_inspection_usage" USING btree ("site_url","day");--> statement-breakpoint
CREATE UNIQUE INDEX "gsc_sitemap_contents_sitemap_type_idx" ON "gsc_sitemap_contents" USING btree ("sitemap_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "gsc_sitemaps_project_path_idx" ON "gsc_sitemaps" USING btree ("project_id","path");--> statement-breakpoint
CREATE INDEX "gsc_url_inspection_links_inspection_idx" ON "gsc_url_inspection_links" USING btree ("inspection_id");--> statement-breakpoint
CREATE INDEX "gsc_url_inspections_url_idx" ON "gsc_url_inspections" USING btree ("url_id","inspected_at");--> statement-breakpoint
CREATE INDEX "gsc_url_rich_result_issues_inspection_idx" ON "gsc_url_rich_result_issues" USING btree ("inspection_id");
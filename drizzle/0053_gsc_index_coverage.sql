CREATE TABLE `gsc_index_sweeps` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`site_url` text NOT NULL,
	`kind` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`total_urls` integer DEFAULT 0 NOT NULL,
	`inspected_count` integer DEFAULT 0 NOT NULL,
	`error_count` integer DEFAULT 0 NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`resume_at` text,
	`error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gsc_index_sweeps_project_idx` ON `gsc_index_sweeps` (`project_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `gsc_index_sweeps_one_active_per_project_idx` ON `gsc_index_sweeps` (`project_id`) WHERE "gsc_index_sweeps"."status" IN ('queued', 'collecting', 'running', 'waiting_quota');--> statement-breakpoint
CREATE TABLE `gsc_index_urls` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`url` text NOT NULL,
	`in_sitemap` integer DEFAULT false NOT NULL,
	`in_search_analytics` integer DEFAULT false NOT NULL,
	`impressions` integer DEFAULT 0 NOT NULL,
	`discovered_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`requested_at` text,
	`last_inspected_at` text,
	`last_inspection_id` text,
	`coverage_state_since` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gsc_index_urls_project_url_idx` ON `gsc_index_urls` (`project_id`,`url`);--> statement-breakpoint
CREATE INDEX `gsc_index_urls_queue_idx` ON `gsc_index_urls` (`project_id`,`last_inspected_at`);--> statement-breakpoint
CREATE TABLE `gsc_inspection_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`site_url` text NOT NULL,
	`day` text NOT NULL,
	`used` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gsc_inspection_usage_site_day_idx` ON `gsc_inspection_usage` (`site_url`,`day`);--> statement-breakpoint
CREATE TABLE `gsc_sitemap_contents` (
	`id` text PRIMARY KEY NOT NULL,
	`sitemap_id` text NOT NULL,
	`type` text NOT NULL,
	`submitted` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`sitemap_id`) REFERENCES `gsc_sitemaps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gsc_sitemap_contents_sitemap_type_idx` ON `gsc_sitemap_contents` (`sitemap_id`,`type`);--> statement-breakpoint
CREATE TABLE `gsc_sitemaps` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`path` text NOT NULL,
	`parent_path` text,
	`type` text,
	`is_pending` integer DEFAULT false NOT NULL,
	`is_sitemaps_index` integer DEFAULT false NOT NULL,
	`last_submitted` text,
	`last_downloaded` text,
	`errors` integer DEFAULT 0 NOT NULL,
	`warnings` integer DEFAULT 0 NOT NULL,
	`fetched_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gsc_sitemaps_project_path_idx` ON `gsc_sitemaps` (`project_id`,`path`);--> statement-breakpoint
CREATE TABLE `gsc_url_inspection_links` (
	`id` text PRIMARY KEY NOT NULL,
	`inspection_id` text NOT NULL,
	`kind` text NOT NULL,
	`url` text NOT NULL,
	FOREIGN KEY (`inspection_id`) REFERENCES `gsc_url_inspections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gsc_url_inspection_links_inspection_idx` ON `gsc_url_inspection_links` (`inspection_id`);--> statement-breakpoint
CREATE TABLE `gsc_url_inspections` (
	`id` text PRIMARY KEY NOT NULL,
	`url_id` text NOT NULL,
	`inspected_at` text NOT NULL,
	`error` text,
	`verdict` text,
	`coverage_state` text,
	`robots_txt_state` text,
	`indexing_state` text,
	`page_fetch_state` text,
	`last_crawl_time` text,
	`crawled_as` text,
	`google_canonical` text,
	`user_canonical` text,
	`rich_results_verdict` text,
	`mobile_usability_verdict` text,
	`inspection_link` text,
	`page_title` text,
	`page_meta_description` text,
	`page_http_status` integer,
	FOREIGN KEY (`url_id`) REFERENCES `gsc_index_urls`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gsc_url_inspections_url_idx` ON `gsc_url_inspections` (`url_id`,`inspected_at`);--> statement-breakpoint
CREATE TABLE `gsc_url_rich_result_issues` (
	`id` text PRIMARY KEY NOT NULL,
	`inspection_id` text NOT NULL,
	`rich_result_type` text NOT NULL,
	`item_name` text,
	`issue_message` text,
	`severity` text,
	FOREIGN KEY (`inspection_id`) REFERENCES `gsc_url_inspections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gsc_url_rich_result_issues_inspection_idx` ON `gsc_url_rich_result_issues` (`inspection_id`);
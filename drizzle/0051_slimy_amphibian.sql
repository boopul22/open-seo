CREATE TABLE `youtube_keyword_queries` (
	`id` text PRIMARY KEY NOT NULL,
	`keyword` text NOT NULL,
	`region_code` text DEFAULT 'US' NOT NULL,
	`sample_size` integer NOT NULL,
	`median_views` integer NOT NULL,
	`average_views` integer NOT NULL,
	`median_views_per_day` integer NOT NULL,
	`captured_at` text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `youtube_keyword_queries_keyword_region_idx` ON `youtube_keyword_queries` (`keyword`,`region_code`);--> statement-breakpoint
CREATE INDEX `youtube_keyword_queries_captured_at_idx` ON `youtube_keyword_queries` (`captured_at`);--> statement-breakpoint
CREATE TABLE `youtube_keyword_videos` (
	`id` text PRIMARY KEY NOT NULL,
	`query_id` text NOT NULL,
	`video_id` text NOT NULL,
	`title` text NOT NULL,
	`channel_id` text NOT NULL,
	`channel_title` text NOT NULL,
	`views` integer,
	`published_at` text,
	`duration_seconds` integer,
	`position` integer NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`query_id`) REFERENCES `youtube_keyword_queries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `youtube_keyword_videos_query_position_idx` ON `youtube_keyword_videos` (`query_id`,`position`);--> statement-breakpoint
CREATE INDEX `youtube_keyword_videos_video_idx` ON `youtube_keyword_videos` (`video_id`);
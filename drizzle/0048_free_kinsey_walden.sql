CREATE TABLE `youtube_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`channel_title` text NOT NULL,
	`channel_handle` text,
	`channel_thumbnail_url` text,
	`uploads_playlist_id` text,
	`connected_by_user_id` text NOT NULL,
	`youtube_account_id` text NOT NULL,
	`connected_account_email` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `youtube_connections_project_idx` ON `youtube_connections` (`project_id`);--> statement-breakpoint
CREATE INDEX `youtube_connections_organization_idx` ON `youtube_connections` (`organization_id`);--> statement-breakpoint
CREATE INDEX `youtube_connections_connector_idx` ON `youtube_connections` (`connected_by_user_id`,`youtube_account_id`);
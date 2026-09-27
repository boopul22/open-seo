CREATE TABLE `audit_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`start_url` text NOT NULL,
	`max_pages` integer NOT NULL,
	`created_by_user_id` text NOT NULL,
	`next_run_at` text NOT NULL,
	`last_run_at` text,
	`last_audit_id` text,
	`previous_audit_id` text,
	`last_skip_reason` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`last_audit_id`) REFERENCES `audits`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`previous_audit_id`) REFERENCES `audits`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_schedules_project_id_idx` ON `audit_schedules` (`project_id`);--> statement-breakpoint
CREATE INDEX `audit_schedules_next_run_at_idx` ON `audit_schedules` (`next_run_at`);
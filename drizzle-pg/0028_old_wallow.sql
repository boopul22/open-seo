CREATE TABLE "youtube_channel_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"subscriber_count" integer,
	"video_count" integer,
	"view_count" integer,
	"captured_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "youtube_research_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"channel_title" text NOT NULL,
	"channel_handle" text,
	"channel_thumbnail_url" text,
	"uploads_playlist_id" text,
	"subscriber_count" integer,
	"video_count" integer,
	"view_count" integer,
	"last_refreshed_at" text,
	"added_by_user_id" text NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "youtube_video_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"video_id" text NOT NULL,
	"view_count" integer,
	"like_count" integer,
	"comment_count" integer,
	"captured_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "youtube_research_channels" ADD CONSTRAINT "youtube_research_channels_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "youtube_research_channels" ADD CONSTRAINT "youtube_research_channels_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "youtube_channel_snapshots_channel_idx" ON "youtube_channel_snapshots" USING btree ("channel_id","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "youtube_research_channels_project_channel_idx" ON "youtube_research_channels" USING btree ("project_id","channel_id");--> statement-breakpoint
CREATE INDEX "youtube_research_channels_organization_idx" ON "youtube_research_channels" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "youtube_research_channels_channel_idx" ON "youtube_research_channels" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "youtube_video_snapshots_video_idx" ON "youtube_video_snapshots" USING btree ("video_id","captured_at");--> statement-breakpoint
CREATE INDEX "youtube_video_snapshots_channel_idx" ON "youtube_video_snapshots" USING btree ("channel_id","captured_at");
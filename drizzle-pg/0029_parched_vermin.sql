CREATE TABLE "youtube_keyword_queries" (
	"id" text PRIMARY KEY NOT NULL,
	"keyword" text NOT NULL,
	"region_code" text DEFAULT 'US' NOT NULL,
	"sample_size" integer NOT NULL,
	"median_views" integer NOT NULL,
	"average_views" integer NOT NULL,
	"median_views_per_day" integer NOT NULL,
	"captured_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "youtube_keyword_videos" (
	"id" text PRIMARY KEY NOT NULL,
	"query_id" text NOT NULL,
	"video_id" text NOT NULL,
	"title" text NOT NULL,
	"channel_id" text NOT NULL,
	"channel_title" text NOT NULL,
	"views" integer,
	"published_at" text,
	"duration_seconds" integer,
	"position" integer NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "youtube_keyword_videos" ADD CONSTRAINT "youtube_keyword_videos_query_id_youtube_keyword_queries_id_fk" FOREIGN KEY ("query_id") REFERENCES "public"."youtube_keyword_queries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "youtube_keyword_queries_keyword_region_idx" ON "youtube_keyword_queries" USING btree ("keyword","region_code");--> statement-breakpoint
CREATE INDEX "youtube_keyword_queries_captured_at_idx" ON "youtube_keyword_queries" USING btree ("captured_at");--> statement-breakpoint
CREATE INDEX "youtube_keyword_videos_query_position_idx" ON "youtube_keyword_videos" USING btree ("query_id","position");--> statement-breakpoint
CREATE INDEX "youtube_keyword_videos_video_idx" ON "youtube_keyword_videos" USING btree ("video_id");
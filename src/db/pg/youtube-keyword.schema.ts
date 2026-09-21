import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Keep this definition structurally identical to ../youtube-keyword.schema.ts.
const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// One cached keyword sample per normalized keyword + region. A row is rewritten
// when the cache TTL lapses; capturedAt is what the TTL check reads.
export const youtubeKeywordQueries = pgTable(
  "youtube_keyword_queries",
  {
    id: text("id").primaryKey(),
    // Normalized lowercase, trimmed, whitespace-collapsed; the cache key.
    keyword: text("keyword").notNull(),
    regionCode: text("region_code").notNull().default("US"),
    sampleSize: integer("sample_size").notNull(),
    medianViews: integer("median_views").notNull(),
    averageViews: integer("average_views").notNull(),
    medianViewsPerDay: integer("median_views_per_day").notNull(),
    capturedAt: text("captured_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("youtube_keyword_queries_keyword_region_idx").on(
      table.keyword,
      table.regionCode,
    ),
    index("youtube_keyword_queries_captured_at_idx").on(table.capturedAt),
  ],
);

// Videos from the cached search sample, in YouTube result order. Rows are
// replaced wholesale with their parent query on refresh (delete then insert).
export const youtubeKeywordVideos = pgTable(
  "youtube_keyword_videos",
  {
    id: text("id").primaryKey(),
    queryId: text("query_id")
      .notNull()
      .references(() => youtubeKeywordQueries.id, { onDelete: "cascade" }),
    videoId: text("video_id").notNull(),
    title: text("title").notNull(),
    channelId: text("channel_id").notNull(),
    channelTitle: text("channel_title").notNull(),
    views: integer("views"),
    publishedAt: text("published_at"),
    durationSeconds: integer("duration_seconds"),
    // 0-based rank in the search result order.
    position: integer("position").notNull(),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (table) => [
    index("youtube_keyword_videos_query_position_idx").on(
      table.queryId,
      table.position,
    ),
    index("youtube_keyword_videos_video_idx").on(table.videoId),
  ],
);

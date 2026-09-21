import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { projects } from "./app.schema";
import { organization } from "./better-auth-schema";

// Channels a project tracks for research, alongside (not instead of) the owned
// youtube_connections row. Unlike the connection, these are public channels the
// project does not own; they are read with the connected grant's token.
export const youtubeResearchChannels = sqliteTable(
  "youtube_research_channels",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // Canonical channel ID ("UC..."); never the handle, which owners can change.
    channelId: text("channel_id").notNull(),
    channelTitle: text("channel_title").notNull(),
    channelHandle: text("channel_handle"),
    channelThumbnailUrl: text("channel_thumbnail_url"),
    uploadsPlaylistId: text("uploads_playlist_id"),
    subscriberCount: integer("subscriber_count"),
    videoCount: integer("video_count"),
    viewCount: integer("view_count"),
    lastRefreshedAt: text("last_refreshed_at"),
    addedByUserId: text("added_by_user_id").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("youtube_research_channels_project_channel_idx").on(
      table.projectId,
      table.channelId,
    ),
    index("youtube_research_channels_organization_idx").on(
      table.organizationId,
    ),
    index("youtube_research_channels_channel_idx").on(table.channelId),
  ],
);

// Point-in-time channel totals, one row per refresh, used to chart growth.
export const youtubeChannelSnapshots = sqliteTable(
  "youtube_channel_snapshots",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id").notNull(),
    subscriberCount: integer("subscriber_count"),
    videoCount: integer("video_count"),
    viewCount: integer("view_count"),
    capturedAt: text("captured_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    index("youtube_channel_snapshots_channel_idx").on(
      table.channelId,
      table.capturedAt,
    ),
  ],
);

// Point-in-time video totals, one row per refresh per video. Two consecutive
// rows yield the views-per-hour velocity shown on research tables.
export const youtubeVideoSnapshots = sqliteTable(
  "youtube_video_snapshots",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id").notNull(),
    videoId: text("video_id").notNull(),
    viewCount: integer("view_count"),
    likeCount: integer("like_count"),
    commentCount: integer("comment_count"),
    capturedAt: text("captured_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    index("youtube_video_snapshots_video_idx").on(
      table.videoId,
      table.capturedAt,
    ),
    index("youtube_video_snapshots_channel_idx").on(
      table.channelId,
      table.capturedAt,
    ),
  ],
);

import { and, asc, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  youtubeChannelSnapshots,
  youtubeResearchChannels,
  youtubeVideoSnapshots,
} from "@/db/schema";

export type YoutubeResearchChannel =
  typeof youtubeResearchChannels.$inferSelect;
export type YoutubeChannelSnapshot =
  typeof youtubeChannelSnapshots.$inferSelect;
export type YoutubeVideoSnapshot = typeof youtubeVideoSnapshots.$inferSelect;

// D1 caps bound parameters per statement at ~100: an IN list plus one predicate
// must stay below that, and a 7-column row insert tops out at 12 rows.
const IN_LIST_BATCH_SIZE = 90;
const VIDEO_SNAPSHOT_INSERT_BATCH_SIZE = 12;
// Upper bound on snapshot rows read for velocity. Each refresh writes one row
// per sampled video, so this comfortably covers a few refreshes of 100 videos.
const VIDEO_SNAPSHOT_LOOKBACK = 1000;

async function listByProject(
  projectId: string,
): Promise<YoutubeResearchChannel[]> {
  return db
    .select()
    .from(youtubeResearchChannels)
    .where(eq(youtubeResearchChannels.projectId, projectId));
}

async function getByProjectAndChannel(
  projectId: string,
  channelId: string,
): Promise<YoutubeResearchChannel | null> {
  const rows = await db
    .select()
    .from(youtubeResearchChannels)
    .where(
      and(
        eq(youtubeResearchChannels.projectId, projectId),
        eq(youtubeResearchChannels.channelId, channelId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function countByProject(projectId: string): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(youtubeResearchChannels)
    .where(eq(youtubeResearchChannels.projectId, projectId));
  return rows[0]?.value ?? 0;
}

async function upsert(input: {
  projectId: string;
  organizationId: string;
  channelId: string;
  channelTitle: string;
  channelHandle: string | null;
  channelThumbnailUrl: string | null;
  uploadsPlaylistId: string | null;
  subscriberCount: number | null;
  videoCount: number | null;
  viewCount: number | null;
  lastRefreshedAt: string | null;
  addedByUserId: string;
}): Promise<YoutubeResearchChannel> {
  const [row] = await db
    .insert(youtubeResearchChannels)
    .values({ id: crypto.randomUUID(), ...input })
    .onConflictDoUpdate({
      target: [
        youtubeResearchChannels.projectId,
        youtubeResearchChannels.channelId,
      ],
      set: {
        organizationId: input.organizationId,
        channelTitle: input.channelTitle,
        channelHandle: input.channelHandle,
        channelThumbnailUrl: input.channelThumbnailUrl,
        uploadsPlaylistId: input.uploadsPlaylistId,
        subscriberCount: input.subscriberCount,
        videoCount: input.videoCount,
        viewCount: input.viewCount,
        lastRefreshedAt: input.lastRefreshedAt,
        // addedByUserId keeps the original adder; re-adding only refreshes data.
        updatedAt: sql`(current_timestamp)`,
      },
    })
    .returning();
  if (!row) throw new Error("Failed to upsert youtube_research_channel");
  return row;
}

async function deleteByProjectAndChannel(
  projectId: string,
  channelId: string,
): Promise<void> {
  await db
    .delete(youtubeResearchChannels)
    .where(
      and(
        eq(youtubeResearchChannels.projectId, projectId),
        eq(youtubeResearchChannels.channelId, channelId),
      ),
    );
}

async function updateStats(input: {
  id: string;
  channelTitle: string;
  channelHandle: string | null;
  channelThumbnailUrl: string | null;
  uploadsPlaylistId: string | null;
  subscriberCount: number | null;
  videoCount: number | null;
  viewCount: number | null;
  lastRefreshedAt: string;
}): Promise<YoutubeResearchChannel> {
  const { id, ...fields } = input;
  const [row] = await db
    .update(youtubeResearchChannels)
    .set({ ...fields, updatedAt: sql`(current_timestamp)` })
    .where(eq(youtubeResearchChannels.id, id))
    .returning();
  if (!row) throw new Error("Failed to update youtube_research_channel");
  return row;
}

async function insertChannelSnapshot(input: {
  channelId: string;
  subscriberCount: number | null;
  videoCount: number | null;
  viewCount: number | null;
  capturedAt?: string;
}): Promise<void> {
  await db
    .insert(youtubeChannelSnapshots)
    .values({ id: crypto.randomUUID(), ...input });
}

async function insertVideoSnapshots(
  rows: {
    channelId: string;
    videoId: string;
    viewCount: number | null;
    likeCount: number | null;
    commentCount: number | null;
    capturedAt?: string;
  }[],
): Promise<void> {
  for (
    let index = 0;
    index < rows.length;
    index += VIDEO_SNAPSHOT_INSERT_BATCH_SIZE
  ) {
    const chunk = rows.slice(index, index + VIDEO_SNAPSHOT_INSERT_BATCH_SIZE);
    await db
      .insert(youtubeVideoSnapshots)
      .values(chunk.map((row) => ({ id: crypto.randomUUID(), ...row })));
  }
}

async function listRecentVideoSnapshots(
  videoIds: string[],
): Promise<YoutubeVideoSnapshot[]> {
  if (videoIds.length === 0) return [];
  const rows: YoutubeVideoSnapshot[] = [];
  for (let index = 0; index < videoIds.length; index += IN_LIST_BATCH_SIZE) {
    const chunk = videoIds.slice(index, index + IN_LIST_BATCH_SIZE);
    rows.push(
      ...(await db
        .select()
        .from(youtubeVideoSnapshots)
        .where(inArray(youtubeVideoSnapshots.videoId, chunk))
        .orderBy(desc(youtubeVideoSnapshots.capturedAt))
        .limit(VIDEO_SNAPSHOT_LOOKBACK)),
    );
  }
  return rows;
}

async function listChannelSnapshots(
  channelId: string,
  limit: number,
): Promise<YoutubeChannelSnapshot[]> {
  return db
    .select()
    .from(youtubeChannelSnapshots)
    .where(eq(youtubeChannelSnapshots.channelId, channelId))
    .orderBy(desc(youtubeChannelSnapshots.capturedAt))
    .limit(limit);
}

/** Snapshot series for one video since a cutoff, oldest first so callers can
 *  walk consecutive pairs for deltas and velocity. */
async function listVideoSnapshotSeries(
  videoId: string,
  sinceIso: string,
): Promise<YoutubeVideoSnapshot[]> {
  return db
    .select()
    .from(youtubeVideoSnapshots)
    .where(
      and(
        eq(youtubeVideoSnapshots.videoId, videoId),
        gte(youtubeVideoSnapshots.capturedAt, sinceIso),
      ),
    )
    .orderBy(asc(youtubeVideoSnapshots.capturedAt))
    .limit(VIDEO_SNAPSHOT_LOOKBACK);
}

export const YoutubeResearchRepository = {
  listByProject,
  getByProjectAndChannel,
  countByProject,
  upsert,
  deleteByProjectAndChannel,
  updateStats,
  insertChannelSnapshot,
  insertVideoSnapshots,
  listRecentVideoSnapshots,
  listChannelSnapshots,
  listVideoSnapshotSeries,
};

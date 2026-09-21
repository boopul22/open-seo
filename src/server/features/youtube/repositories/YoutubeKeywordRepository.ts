import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import { youtubeKeywordQueries, youtubeKeywordVideos } from "@/db/schema";

export type YoutubeKeywordQuery = typeof youtubeKeywordQueries.$inferSelect;
export type YoutubeKeywordVideo = typeof youtubeKeywordVideos.$inferSelect;

export type KeywordVideoInput = {
  videoId: string;
  title: string;
  channelId: string;
  channelTitle: string;
  views: number | null;
  publishedAt: string | null;
  durationSeconds: number | null;
  position: number;
};

async function getQuery(
  keyword: string,
  regionCode: string,
): Promise<YoutubeKeywordQuery | null> {
  const rows = await db
    .select()
    .from(youtubeKeywordQueries)
    .where(
      and(
        eq(youtubeKeywordQueries.keyword, keyword),
        eq(youtubeKeywordQueries.regionCode, regionCode),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function listVideos(queryId: string): Promise<YoutubeKeywordVideo[]> {
  return db
    .select()
    .from(youtubeKeywordVideos)
    .where(eq(youtubeKeywordVideos.queryId, queryId))
    .orderBy(asc(youtubeKeywordVideos.position));
}

/**
 * Write one cached keyword sample: upsert the parent row for (keyword,
 * regionCode), then atomically replace its child video rows. The parent upsert
 * must land first to mint the queryId the children reference.
 */
async function replaceQuery(input: {
  keyword: string;
  regionCode: string;
  sampleSize: number;
  medianViews: number;
  averageViews: number;
  medianViewsPerDay: number;
  capturedAt: string;
  videos: KeywordVideoInput[];
}): Promise<YoutubeKeywordQuery> {
  const [row] = await db
    .insert(youtubeKeywordQueries)
    .values({
      id: crypto.randomUUID(),
      keyword: input.keyword,
      regionCode: input.regionCode,
      sampleSize: input.sampleSize,
      medianViews: input.medianViews,
      averageViews: input.averageViews,
      medianViewsPerDay: input.medianViewsPerDay,
      capturedAt: input.capturedAt,
    })
    .onConflictDoUpdate({
      target: [youtubeKeywordQueries.keyword, youtubeKeywordQueries.regionCode],
      set: {
        sampleSize: input.sampleSize,
        medianViews: input.medianViews,
        averageViews: input.averageViews,
        medianViewsPerDay: input.medianViewsPerDay,
        capturedAt: input.capturedAt,
      },
    })
    .returning();
  if (!row) throw new Error("Failed to upsert youtube_keyword_query");

  // Samples are capped at KEYWORD_SAMPLE_SIZE (25), so one ordered batch keeps
  // the delete + inserts atomic without exceeding D1's per-statement limits.
  await runBatch((tx) => [
    tx
      .delete(youtubeKeywordVideos)
      .where(eq(youtubeKeywordVideos.queryId, row.id)),
    ...input.videos.map((video) =>
      tx
        .insert(youtubeKeywordVideos)
        .values({ id: crypto.randomUUID(), queryId: row.id, ...video }),
    ),
  ]);
  return row;
}

export const YoutubeKeywordRepository = {
  getQuery,
  listVideos,
  replaceQuery,
};

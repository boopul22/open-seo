import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { youtubeConnections } from "@/db/schema";

export type YoutubeConnection = typeof youtubeConnections.$inferSelect;

async function getByProjectId(
  projectId: string,
): Promise<YoutubeConnection | null> {
  const rows = await db
    .select()
    .from(youtubeConnections)
    .where(eq(youtubeConnections.projectId, projectId))
    .limit(1);
  return rows[0] ?? null;
}

async function upsert(input: {
  projectId: string;
  organizationId: string;
  channelId: string;
  channelTitle: string;
  channelHandle: string | null;
  channelThumbnailUrl: string | null;
  uploadsPlaylistId: string | null;
  connectedByUserId: string;
  youtubeAccountId: string;
  connectedAccountEmail: string | null;
}): Promise<YoutubeConnection> {
  const [row] = await db
    .insert(youtubeConnections)
    .values({ id: crypto.randomUUID(), ...input })
    .onConflictDoUpdate({
      target: youtubeConnections.projectId,
      set: {
        organizationId: input.organizationId,
        channelId: input.channelId,
        channelTitle: input.channelTitle,
        channelHandle: input.channelHandle,
        channelThumbnailUrl: input.channelThumbnailUrl,
        uploadsPlaylistId: input.uploadsPlaylistId,
        connectedByUserId: input.connectedByUserId,
        youtubeAccountId: input.youtubeAccountId,
        connectedAccountEmail: sql`case
          when ${youtubeConnections.connectedByUserId} = ${input.connectedByUserId}
            and ${youtubeConnections.youtubeAccountId} = ${input.youtubeAccountId}
          then coalesce(${input.connectedAccountEmail}, ${youtubeConnections.connectedAccountEmail})
          else ${input.connectedAccountEmail}
        end`,
        updatedAt: sql`(current_timestamp)`,
      },
    })
    .returning();
  if (!row) throw new Error("Failed to upsert youtube_connection");
  return row;
}

async function deleteByProjectId(projectId: string): Promise<void> {
  await db
    .delete(youtubeConnections)
    .where(eq(youtubeConnections.projectId, projectId));
}

export const YoutubeConnectionRepository = {
  getByProjectId,
  upsert,
  deleteByProjectId,
};

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { account } from "@/db/schema";
import { AppError } from "@/server/lib/errors";
import {
  createYoutubeDataClient,
  type YoutubeChannel,
} from "@/server/lib/youtubeClient";
import {
  YoutubeDataApiError,
  YoutubeTokenError,
} from "@/server/lib/youtubeErrors";
import { YOUTUBE_OAUTH_PROVIDER_ID } from "@/shared/youtube";
import {
  YoutubeConnectionRepository,
  type YoutubeConnection,
} from "@/server/features/youtube/repositories/YoutubeConnectionRepository";

async function getConnection(
  projectId: string,
): Promise<YoutubeConnection | null> {
  return YoutubeConnectionRepository.getByProjectId(projectId);
}

async function listGrantsForUser(userId: string) {
  return db
    .select({ id: account.id, accountId: account.accountId })
    .from(account)
    .where(
      and(
        eq(account.userId, userId),
        eq(account.providerId, YOUTUBE_OAUTH_PROVIDER_ID),
      ),
    );
}

async function userHasGrant(userId: string): Promise<boolean> {
  const grants = await listGrantsForUser(userId);
  return grants.length > 0;
}

function requiresReconnect(error: unknown): boolean {
  return (
    error instanceof YoutubeTokenError ||
    (error instanceof YoutubeDataApiError && error.status === 401)
  );
}

/** Every channel reachable from each of the user's google-youtube grants,
 *  with a per-grant status so the picker can offer reconnect when a token is
 *  dead instead of hiding the account. */
async function listChannelsForUserWithGrantStatus(userId: string) {
  const grants = await listGrantsForUser(userId);
  const accounts = await Promise.all(
    grants.map(async (grant) => {
      const client = createYoutubeDataClient({
        userId,
        youtubeAccountId: grant.accountId,
      });
      try {
        const channels = await client.listMyChannels();
        let email: string | null = null;
        try {
          email = await client.getUserInfoEmail();
        } catch {
          email = null;
        }
        return {
          accountId: grant.accountId,
          email,
          requiresReconnect: false,
          channelsUnavailable: false,
          channels,
        };
      } catch (error) {
        const reconnect = requiresReconnect(error);
        if (!reconnect) {
          console.error("youtube.channel_discovery_failed", {
            errorName: error instanceof Error ? error.name : "UnknownError",
            status:
              error instanceof YoutubeDataApiError ? error.status : undefined,
          });
        }
        return {
          accountId: grant.accountId,
          email: null,
          requiresReconnect: reconnect,
          channelsUnavailable: !reconnect,
          channels: [] as YoutubeChannel[],
        };
      }
    }),
  );
  return { accounts };
}

async function setChannel(input: {
  projectId: string;
  organizationId: string;
  accountId: string;
  channelId: string;
  userId: string;
}): Promise<YoutubeConnection> {
  const grants = await listGrantsForUser(input.userId);
  if (!grants.some((grant) => grant.accountId === input.accountId)) {
    throw new AppError(
      "NOT_FOUND",
      "That Google account isn't connected to your OpenSEO account.",
    );
  }

  const client = createYoutubeDataClient({
    userId: input.userId,
    youtubeAccountId: input.accountId,
  });
  const channels = await client.listMyChannels();
  const channel = channels.find(
    (candidate) => candidate.channelId === input.channelId,
  );
  if (!channel) {
    throw new AppError(
      "NOT_FOUND",
      "That YouTube channel isn't available on your connected Google account.",
    );
  }

  let connectedAccountEmail: string | null = null;
  try {
    connectedAccountEmail = await client.getUserInfoEmail();
  } catch {
    connectedAccountEmail = null;
  }

  return YoutubeConnectionRepository.upsert({
    projectId: input.projectId,
    organizationId: input.organizationId,
    channelId: channel.channelId,
    channelTitle: channel.title,
    channelHandle: channel.handle,
    channelThumbnailUrl: channel.thumbnailUrl,
    uploadsPlaylistId: channel.uploadsPlaylistId,
    connectedByUserId: input.userId,
    youtubeAccountId: input.accountId,
    connectedAccountEmail,
  });
}

async function disconnect(input: { projectId: string }): Promise<void> {
  await YoutubeConnectionRepository.deleteByProjectId(input.projectId);
}

export const YoutubeService = {
  getConnection,
  userHasGrant,
  listChannelsForUserWithGrantStatus,
  setChannel,
  disconnect,
};

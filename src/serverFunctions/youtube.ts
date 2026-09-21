import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { waitUntil } from "cloudflare:workers";
import { z } from "zod";
import { hasSelfHostedGoogleOAuthConfig } from "@/server/features/google/oauth-config";
import {
  createSelfHostedGoogleAuthorizationUrl,
  YOUTUBE_INTEGRATION,
} from "@/server/features/google/selfHostedOAuth";
import { YoutubeAnalyticsService } from "@/server/features/youtube/services/YoutubeAnalyticsService";
import { YoutubeService } from "@/server/features/youtube/services/YoutubeService";
import { AppError } from "@/server/lib/errors";
import { YoutubeReportError } from "@/server/lib/youtubeErrors";
import { hasOrgPermission } from "@/lib/org-permissions";
import { requireOrgPermission } from "@/server/auth/org-gate";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import { captureServerEvent } from "@/server/lib/posthog";
import { getPublicOrigin } from "@/server/mcp/public-origin";
import {
  requireAuthenticatedContext,
  requireProjectContext,
} from "@/serverFunctions/middleware";

const projectScopedSchema = z.object({ projectId: z.string().min(1) });
const setChannelSchema = projectScopedSchema.extend({
  accountId: z.string().min(1),
  channelId: z.string().regex(/^UC[A-Za-z0-9_-]{22}$/),
});
const startSelfHostedLinkSchema = z.object({
  callbackURL: z.string().min(1),
});
const channelReportSchema = projectScopedSchema.extend({
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export const getYoutubeConnection = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) => {
    const [connection, currentUserHasGrant, hosted, youtubeConfigured] =
      await Promise.all([
        YoutubeService.getConnection(context.projectId),
        YoutubeService.userHasGrant(context.userId),
        isHostedServerAuthMode(),
        hasSelfHostedGoogleOAuthConfig(),
      ]);
    return {
      connected: Boolean(connection),
      canManage: hasOrgPermission(context.role, { integration: ["manage"] }),
      currentUserHasGrant,
      googleOAuthConfigured: hosted || youtubeConfigured,
      channelId: connection?.channelId ?? null,
      channelTitle: connection?.channelTitle ?? null,
      channelHandle: connection?.channelHandle ?? null,
      connectedByEmail: connection?.connectedAccountEmail ?? null,
      connectedAt: connection?.createdAt ?? null,
    };
  });

export const listYoutubeChannels = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) => {
    const [channelList, connection] = await Promise.all([
      YoutubeService.listChannelsForUserWithGrantStatus(context.userId),
      YoutubeService.getConnection(context.projectId),
    ]);
    return {
      accounts: channelList.accounts.map((grant) => ({
        ...grant,
        channels: grant.channels.map((channel) => ({
          ...channel,
          isSelected:
            connection?.youtubeAccountId === grant.accountId &&
            connection.channelId === channel.channelId,
        })),
      })),
    };
  });

/** Channel discovery for the create-project flow, before a project exists. */
export const listYoutubeChannelsForUser = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .handler(async ({ context }) => {
    const channelList = await YoutubeService.listChannelsForUserWithGrantStatus(
      context.userId,
    );
    return { accounts: channelList.accounts };
  });

export const setYoutubeChannel = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(setChannelSchema)
  .handler(async ({ data, context }) => {
    requireOrgPermission(context, { integration: ["manage"] });
    const connection = await YoutubeService.setChannel({
      projectId: context.projectId,
      organizationId: context.organizationId,
      accountId: data.accountId,
      channelId: data.channelId,
      userId: context.userId,
    });
    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "youtube:channel_select",
        organizationId: context.organizationId,
        properties: {
          project_id: context.projectId,
          channel_id: connection.channelId,
        },
      }),
    );
    return {
      connected: true as const,
      channelId: connection.channelId,
      channelTitle: connection.channelTitle,
      channelHandle: connection.channelHandle,
      connectedByEmail: connection.connectedAccountEmail,
      connectedAt: connection.createdAt,
    };
  });

export const disconnectYoutube = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) => {
    requireOrgPermission(context, { integration: ["manage"] });
    await YoutubeService.disconnect({ projectId: context.projectId });
    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "youtube:disconnect",
        organizationId: context.organizationId,
        properties: { project_id: context.projectId },
      }),
    );
    return { connected: false as const };
  });

/** Overview totals for the connection card: current vs previous period plus a
 *  daily views trend, over the default (last 28 complete days) range. */
export const getYoutubeChannelOverview = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(channelReportSchema)
  .handler(async ({ data, context }) => {
    try {
      const overview = await YoutubeAnalyticsService.getChannelOverview({
        projectId: context.projectId,
        startDate: data.startDate,
        endDate: data.endDate,
      });
      return { connected: true as const, ...overview };
    } catch (error) {
      // Not connected, a dead grant, or a channel the account lost access to:
      // the card falls back to its connect state instead of retrying a report
      // that can never succeed. Other errors are real faults.
      if (
        error instanceof YoutubeReportError &&
        (error.code === "youtube_not_connected" ||
          error.code === "youtube_reconnect_required" ||
          error.code === "youtube_channel_inaccessible")
      ) {
        return { connected: false as const };
      }
      if (
        error instanceof YoutubeReportError &&
        error.code === "youtube_quota_exhausted"
      ) {
        throw new AppError("RATE_LIMITED");
      }
      throw error;
    }
  });

export const startSelfHostedYoutubeLink = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(startSelfHostedLinkSchema)
  .handler(async ({ data, context }) => ({
    url: await createSelfHostedGoogleAuthorizationUrl({
      integration: YOUTUBE_INTEGRATION,
      user: {
        userId: context.userId,
        userEmail: context.userEmail,
      },
      callbackURL: data.callbackURL,
      publicOrigin: getPublicOrigin(getRequest()),
    }),
  }));

/** Live channel header: subscriber/video/view totals from the Data API. */
export const getYoutubeChannelInfo = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) =>
    YoutubeAnalyticsService.getChannelInfo({ projectId: context.projectId }),
  );

/** Videos ranked by views (or watch time) over the report range. */
export const getYoutubeTopVideos = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    channelReportSchema.extend({
      limit: z.number().int().min(1).max(50).optional().default(10),
      sort: z.enum(["views", "watch_time"]).optional().default("views"),
    }),
  )
  .handler(async ({ data, context }) =>
    YoutubeAnalyticsService.getTopVideos({
      projectId: context.projectId,
      startDate: data.startDate,
      endDate: data.endDate,
      limit: data.limit,
      sort: data.sort,
    }),
  );

/** Views and watch time by YouTube traffic source over the report range. */
export const getYoutubeTrafficSources = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    channelReportSchema.extend({
      limit: z.number().int().min(1).max(25).optional().default(10),
    }),
  )
  .handler(async ({ data, context }) =>
    YoutubeAnalyticsService.getTrafficSources({
      projectId: context.projectId,
      startDate: data.startDate,
      endDate: data.endDate,
      limit: data.limit,
    }),
  );

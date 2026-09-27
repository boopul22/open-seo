import { createServerFn } from "@tanstack/react-start";
import { waitUntil } from "cloudflare:workers";
import { z } from "zod";
import { requireOrgPermission } from "@/server/auth/org-gate";
import { YoutubeResearchService } from "@/server/features/youtube/services/YoutubeResearchService";
import { captureServerEvent } from "@/server/lib/posthog";
import { requireProjectContext } from "@/serverFunctions/middleware";

// Type-only re-exports so client code can type its rows without importing the
// server service module at runtime.
export type {
  ResearchChannelRow,
  VideoRow,
} from "@/server/features/youtube/services/YoutubeResearchService";

const projectScopedSchema = z.object({ projectId: z.string().min(1) });
const channelRefSchema = z.string().trim().min(1).max(300);
const channelIdSchema = z.string().regex(/^UC[A-Za-z0-9_-]{22}$/);
const windowDaysSchema = z.number().int().min(1).max(3650);

export const addYoutubeResearchChannel = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema.extend({ channel: channelRefSchema }))
  .handler(async ({ data, context }) => {
    requireOrgPermission(context, { integration: ["manage"] });
    const channel = await YoutubeResearchService.addResearchChannel({
      projectId: context.projectId,
      organizationId: context.organizationId,
      channel: data.channel,
      userId: context.userId,
    });
    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "youtube:research_channel_add",
        organizationId: context.organizationId,
        properties: {
          project_id: context.projectId,
          channel_id: channel.channelId,
        },
      }),
    );
    return { channel };
  });

export const removeYoutubeResearchChannel = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    projectScopedSchema.extend({ channelId: z.string().min(1).max(64) }),
  )
  .handler(async ({ data, context }) => {
    requireOrgPermission(context, { integration: ["manage"] });
    await YoutubeResearchService.removeResearchChannel({
      projectId: context.projectId,
      channelId: data.channelId,
    });
    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "youtube:research_channel_remove",
        organizationId: context.organizationId,
        properties: {
          project_id: context.projectId,
          channel_id: data.channelId,
        },
      }),
    );
    return { removed: true as const };
  });

export const listYoutubeResearchChannels = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) => {
    const channels = await YoutubeResearchService.listResearchChannels(
      context.projectId,
    );
    return { channels };
  });

export const refreshYoutubeResearchChannels = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) => {
    requireOrgPermission(context, { integration: ["manage"] });
    const result = await YoutubeResearchService.refreshResearchChannels({
      projectId: context.projectId,
      userId: context.userId,
    });
    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "youtube:research_refresh",
        organizationId: context.organizationId,
        properties: {
          project_id: context.projectId,
          channel_count: result.channels.length,
        },
      }),
    );
    return result;
  });

export const listYoutubeChannelVideos = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    projectScopedSchema.extend({
      channelId: channelIdSchema,
      limit: z.number().int().min(1).max(200).optional(),
      sort: z.enum(["views", "newest", "outlier"]).optional(),
    }),
  )
  .handler(async ({ data, context }) =>
    YoutubeResearchService.listChannelVideos({
      projectId: context.projectId,
      channelId: data.channelId,
      limit: data.limit,
      sort: data.sort,
      userId: context.userId,
    }),
  );

export const getYoutubeOutliers = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    projectScopedSchema.extend({
      channelId: channelIdSchema.optional(),
      windowDays: windowDaysSchema.optional(),
      limit: z.number().int().min(1).max(100).optional(),
      minScore: z.number().min(0).max(1000).optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const rows = await YoutubeResearchService.getOutliers({
      projectId: context.projectId,
      channelId: data.channelId,
      windowDays: data.windowDays,
      limit: data.limit,
      minScore: data.minScore,
      userId: context.userId,
    });
    return { rows };
  });

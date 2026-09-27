import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { YoutubePerformanceService } from "@/server/features/youtube/services/YoutubePerformanceService";
import { requireProjectContext } from "@/serverFunctions/middleware";

// Type-only re-exports so client code can type its rows without importing the
// server service module at runtime.
export type {
  YoutubeChannelGrowth,
  YoutubeVideoTrendPoint,
} from "@/server/features/youtube/services/YoutubePerformanceService";

const projectScopedSchema = z.object({ projectId: z.string().min(1) });
const videoIdSchema = z.string().regex(/^[A-Za-z0-9_-]{11}$/);
const channelIdSchema = z.string().regex(/^UC[A-Za-z0-9_-]{22}$/);
const trendDaysSchema = z.number().int().min(7).max(365).default(90);
const playlistLimitSchema = z.number().int().min(1).max(50).optional();

export const getYoutubeVideoTrend = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    projectScopedSchema.extend({
      videoId: videoIdSchema,
      days: trendDaysSchema,
    }),
  )
  .handler(async ({ data, context }) =>
    YoutubePerformanceService.getVideoTrend({
      projectId: context.projectId,
      videoId: data.videoId,
      days: data.days,
    }),
  );

export const getYoutubeChannelGrowth = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    projectScopedSchema.extend({ channelId: channelIdSchema.optional() }),
  )
  .handler(async ({ data, context }) =>
    YoutubePerformanceService.getChannelGrowth({
      projectId: context.projectId,
      channelId: data.channelId,
    }),
  );

export const getYoutubeBestPublishDays = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) =>
    YoutubePerformanceService.getBestPublishDays({
      projectId: context.projectId,
    }),
  );

export const listYoutubePlaylists = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    projectScopedSchema.extend({
      channelId: channelIdSchema.optional(),
      mine: z.boolean().optional(),
      maxResults: playlistLimitSchema,
    }),
  )
  .handler(async ({ data, context }) =>
    YoutubePerformanceService.listPlaylistsForChannel({
      projectId: context.projectId,
      channelId: data.channelId,
      mine: data.mine,
      maxResults: data.maxResults,
      userId: context.userId,
    }),
  );

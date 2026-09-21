/* eslint-disable max-lines -- all YouTube research MCP tools are intentionally kept in one module */
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { requireOrgPermission } from "@/server/auth/org-gate";
import {
  MAX_RESEARCH_CHANNELS,
  YoutubeResearchService,
  type ChannelComparisonRow,
  type OutlierRow,
  type ResearchChannelRow,
  type VideoRow,
} from "@/server/features/youtube/services/YoutubeResearchService";
import { YoutubeService } from "@/server/features/youtube/services/YoutubeService";
import { AppError, asAppError } from "@/server/lib/errors";
import {
  asYoutubeReportError,
  YoutubeReportError,
} from "@/server/lib/youtubeErrors";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { looseObjectOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import {
  formatMcpTable,
  readPath,
  truncatedCell,
  type McpTableColumn,
} from "@/server/mcp/table";
import { buildDashboardUrl } from "@/server/mcp/urls";

const errorDetailSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    retryAfterSeconds: z.number().nullable().optional(),
    actionUrl: z.string().optional(),
  })
  .passthrough();

// The MCP SDK can only publish and validate a top-level object schema, so the
// ok/error branches share one object with per-status required fields enforced
// by a refinement (same shape the YouTube Analytics tools use).
function youtubeEnvelopeSchema(okShape: Record<string, z.ZodType>) {
  const requiredOkFields = Object.entries(okShape)
    .filter(([, field]) => !field.safeParse(undefined).success)
    .map(([key]) => key);
  const optionalShape = Object.fromEntries(
    Object.entries(okShape).map(([key, field]) => [key, field.optional()]),
  );
  return z
    .object({
      status: z.enum(["ok", "error"]),
      ...optionalShape,
      error: errorDetailSchema.optional(),
    })
    .passthrough()
    .superRefine((value, ctx) => {
      if (value.status === "error") {
        if (value.error === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["error"],
            message: "error is required when status is error",
          });
        }
        return;
      }
      for (const key of requiredOkFields) {
        if ((value as Record<string, unknown>)[key] === undefined) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is required when status is ok`,
          });
        }
      }
    });
}

const videoRowsSchema = z.array(z.record(z.string(), z.unknown()));

const listVideosOutputSchema = youtubeEnvelopeSchema({
  channel: looseObjectOutputSchema,
  stats: looseObjectOutputSchema,
  videos: videoRowsSchema,
});

const outliersOutputSchema = youtubeEnvelopeSchema({
  rows: videoRowsSchema,
});

const channelStatsOutputSchema = youtubeEnvelopeSchema({
  channel: looseObjectOutputSchema,
  sampleSize: z.number(),
  medianViews: z.number(),
  averageViews: z.number(),
  viewsPerDayMedian: z.number(),
  uploadsPerWeek: z.number(),
  recentVideos: videoRowsSchema,
});

const comparisonOutputSchema = youtubeEnvelopeSchema({
  rows: videoRowsSchema,
});

const trendingOutputSchema = youtubeEnvelopeSchema({
  rows: videoRowsSchema,
});

const researchChannelOutputSchema = youtubeEnvelopeSchema({
  channel: looseObjectOutputSchema,
});

const removeResearchChannelOutputSchema = youtubeEnvelopeSchema({
  removed: z.literal(true),
});

const researchChannelsOutputSchema = youtubeEnvelopeSchema({
  channels: videoRowsSchema,
  cap: z.number(),
});

const refreshResearchChannelsOutputSchema = youtubeEnvelopeSchema({
  channels: videoRowsSchema,
  refreshedAt: z.string(),
});

type ProjectArgs = { projectId: string };

type ProjectContext = {
  auth: { organizationId: string; userId: string };
  baseUrl: string;
};

function actionUrl(
  baseUrl: string,
  projectId: string,
  code: string,
): string | undefined {
  if (
    code === "youtube_not_connected" ||
    code === "youtube_reconnect_required" ||
    code === "youtube_channel_inaccessible" ||
    code === "youtube_quota_exhausted"
  ) {
    return buildDashboardUrl(baseUrl, `/p/${projectId}/settings/integrations`);
  }
  return undefined;
}

type EnvelopeError = {
  code: string;
  message: string;
  retryAfterSeconds: number | null;
};

// The research service maps YouTube token and Data API faults to AppErrors
// before they reach a tool, so re-translate its fixed connection messages onto
// the youtube_* codes clients already branch on (and that carry an actionUrl).
// The patterns track YoutubeResearchService.mapUpstreamErrors; keep in sync.
const APP_ERROR_CODE_MATCHERS: Array<{ pattern: RegExp; code: string }> = [
  { pattern: /connect a youtube account/i, code: "youtube_not_connected" },
  { pattern: /connection has expired/i, code: "youtube_reconnect_required" },
  {
    pattern: /denied access to this channel/i,
    code: "youtube_channel_inaccessible",
  },
  { pattern: /quota is exhausted/i, code: "youtube_quota_exhausted" },
];

function toEnvelopeError(error: AppError): EnvelopeError {
  const matched = APP_ERROR_CODE_MATCHERS.find(({ pattern }) =>
    pattern.test(error.message),
  );
  return {
    code: matched?.code ?? error.code.toLowerCase(),
    message: error.message,
    retryAfterSeconds: null,
  };
}

function errorResponse(
  args: ProjectArgs,
  context: ProjectContext,
  error: unknown,
): CallToolResult {
  let mapped: EnvelopeError;
  const reportError = asYoutubeReportError(error);
  if (reportError instanceof YoutubeReportError) {
    mapped = {
      code: reportError.code,
      message: reportError.message,
      retryAfterSeconds: reportError.retryAfterSeconds,
    };
  } else {
    const appError = asAppError(error);
    if (!appError) throw error;
    mapped = toEnvelopeError(appError);
  }
  const url = actionUrl(context.baseUrl, args.projectId, mapped.code);
  return mcpResponse({
    text: `${mapped.message}${url ? ` Continue here: ${url}` : ""}`,
    meta: buildProjectMeta(context, args.projectId),
    structuredContent: {
      status: "error",
      error: {
        code: mapped.code,
        message: mapped.message,
        retryAfterSeconds: mapped.retryAfterSeconds,
        actionUrl: url,
      },
    },
  });
}

const youtubeChannelIdSchema = z.string().regex(/^UC[A-Za-z0-9_-]{22}$/);

const channelRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .describe("YouTube channel URL, @handle, or UC channel ID.");

const windowDaysSchema = z
  .number()
  .int()
  .min(30)
  .max(730)
  .optional()
  .default(180)
  .describe(
    "Only consider videos published within this many days. Defaults to 180.",
  );

const videoFormatSchema = z
  .enum(["all", "shorts", "long"])
  .optional()
  .default("all")
  .describe(
    "Filter by video length: shorts keeps videos of 3 minutes or less; long keeps longer videos (videos with an unknown duration count as long); all keeps everything. Defaults to all.",
  );

type VideoFormat = z.infer<typeof videoFormatSchema>;

/** Shorts are 3 minutes or less; a null duration means the upstream row had no
 *  contentDetails (e.g. a search snippet), which counts as long. */
function filterRowsByFormat<T extends { durationSeconds: number | null }>(
  rows: T[],
  format: VideoFormat,
): T[] {
  if (format === "shorts") {
    return rows.filter(
      (row) => row.durationSeconds !== null && row.durationSeconds <= 180,
    );
  }
  if (format === "long") {
    return rows.filter(
      (row) => row.durationSeconds === null || row.durationSeconds > 180,
    );
  }
  return rows;
}

function channelLabel(channel: {
  channelTitle: string;
  channelHandle: string | null;
}): string {
  return channel.channelHandle
    ? `${channel.channelTitle} (${channel.channelHandle})`
    : channel.channelTitle;
}

/** The project's connected channel, used when a tool omits channelId. */
async function resolveOwnedChannelId(projectId: string): Promise<string> {
  const connection = await YoutubeService.getConnection(projectId);
  if (!connection) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Connect a YouTube account before researching channels.",
    );
  }
  return connection.channelId;
}

/** How many channels an outlier scan covers: the one requested, or every
 *  tracked channel plus the connected channel (the service's own target set). */
async function countScoringTargets(
  projectId: string,
  channelId: string | undefined,
): Promise<number> {
  if (channelId) return 1;
  const [channels, connection] = await Promise.all([
    YoutubeResearchService.listResearchChannels(projectId),
    YoutubeService.getConnection(projectId),
  ]);
  const ownedIsSeparate =
    connection !== null &&
    !channels.some((channel) => channel.channelId === connection.channelId);
  return channels.length + (ownedIsSeparate ? 1 : 0);
}

const VIDEO_COLUMNS: McpTableColumn<VideoRow>[] = [
  { header: "title", value: (row) => row.title, format: truncatedCell(60) },
  { header: "views", value: (row) => row.views },
  { header: "viewsPerDay", value: (row) => row.viewsPerDay },
  { header: "outlierScore", value: (row) => row.outlierScore },
  { header: "vph", value: (row) => row.vph },
  { header: "publishedAt", value: (row) => row.publishedAt },
];

const OUTLIER_COLUMNS: McpTableColumn<OutlierRow>[] = [
  { header: "channelTitle", value: (row) => row.channelTitle },
  { header: "title", value: (row) => row.title, format: truncatedCell(60) },
  { header: "views", value: (row) => row.views },
  { header: "outlierScore", value: (row) => row.outlierScore },
  { header: "velocityScore", value: (row) => row.velocityScore },
  { header: "viewsPerDay", value: (row) => row.viewsPerDay },
  { header: "publishedAt", value: (row) => row.publishedAt },
];

const COMPARISON_COLUMNS: McpTableColumn<ChannelComparisonRow>[] = [
  {
    header: "channel",
    value: (row) => row.channel.channelTitle,
    format: truncatedCell(40),
  },
  { header: "subscribers", value: (row) => row.subscriberCount },
  { header: "videos", value: (row) => row.videoCount },
  { header: "uploadsLast30Days", value: (row) => row.uploadsLast30Days },
  { header: "medianViews", value: (row) => row.medianViews },
  { header: "outlierCount", value: (row) => row.outlierCount },
  {
    header: "topVideo",
    value: (row) => row.topVideo?.title ?? null,
    format: truncatedCell(50),
  },
];

const TRENDING_COLUMNS: McpTableColumn<VideoRow>[] = [
  { header: "title", value: (row) => row.title, format: truncatedCell(60) },
  { header: "channelTitle", value: (row) => readPath(row, "channelTitle") },
  { header: "views", value: (row) => row.views },
  { header: "publishedAt", value: (row) => row.publishedAt },
];

const RESEARCH_CHANNEL_COLUMNS: McpTableColumn<ResearchChannelRow>[] = [
  {
    header: "channel",
    value: (row) => row.channelTitle,
    format: truncatedCell(40),
  },
  { header: "channelId", value: (row) => row.channelId },
  { header: "subscribers", value: (row) => row.subscriberCount },
  { header: "videos", value: (row) => row.videoCount },
  { header: "views", value: (row) => row.viewCount },
  { header: "lastRefreshedAt", value: (row) => row.lastRefreshedAt },
];

const listVideosInputSchema = z.strictObject({
  projectId: projectIdSchema,
  channelId: youtubeChannelIdSchema
    .optional()
    .describe(
      "UC channel ID to list. Defaults to the project's connected YouTube channel.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(50)
    .describe("Maximum videos to return. Defaults to 50."),
  sort: z
    .enum(["views", "newest", "outlier"])
    .optional()
    .default("views")
    .describe(
      "Sort order: views (default) by lifetime views, newest by publish date, outlier by outlier score. Applied before limit.",
    ),
  format: videoFormatSchema,
});
type ListVideosArgs = z.infer<typeof listVideosInputSchema>;

export const listYoutubeVideosTool = {
  name: "list_youtube_videos",
  config: {
    title: "List YouTube videos",
    description:
      "List a YouTube channel's recent uploads with views, views per day, outlier score, and views per hour (once two snapshots exist), sorted by views, newest, or outlier score. Defaults to the project's connected channel; pass a channelId to read another channel already tracked for the project. An optional format filter keeps only Shorts (3 minutes or less) or only long videos; videos with an unknown duration count as long. Read-only and uses no OpenSEO credits.",
    inputSchema: listVideosInputSchema,
    outputSchema: listVideosOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: ListVideosArgs, context) => {
    try {
      const channelId =
        args.channelId ?? (await resolveOwnedChannelId(args.projectId));
      const result = await YoutubeResearchService.listChannelVideos({
        projectId: args.projectId,
        channelId,
        limit: args.limit,
        sort: args.sort,
        userId: context.auth.userId,
      });
      const stats = result.stats;
      const videos = filterRowsByFormat(result.videos, args.format);
      const summary = `${channelLabel(result.channel)} · ${stats.sampleSize} uploads sampled · ${stats.medianViews} median views · ${stats.viewsPerDayMedian} median views/day · ${stats.uploadsPerWeek} uploads/week, sorted by ${args.sort}${args.format === "all" ? "" : `, ${args.format} filter: ${videos.length} of ${result.videos.length} shown`}.`;
      const text =
        videos.length > 0
          ? `${summary}\n${formatMcpTable(videos, VIDEO_COLUMNS)}`
          : `${summary} No videos returned${args.format === "all" ? "." : ` after the ${args.format} filter.`}`;
      return mcpResponse({
        text,
        meta: buildProjectMeta(context, args.projectId),
        structuredContent: { status: "ok", ...result, videos },
      });
    } catch (error) {
      return errorResponse(args, context, error);
    }
  }),
};

const outliersInputSchema = z.strictObject({
  projectId: projectIdSchema,
  channelId: youtubeChannelIdSchema
    .optional()
    .describe(
      "Limit the scan to one tracked or connected UC channel ID. Defaults to every channel tracked for the project.",
    ),
  windowDays: windowDaysSchema,
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(25)
    .describe("Maximum outlier rows to return. Defaults to 25."),
  minScore: z
    .number()
    .min(1)
    .optional()
    .default(1.5)
    .describe(
      "Minimum outlier score. 1 is the channel's median video, 1.5 is the default, and 2 or more is a clear breakout.",
    ),
  format: videoFormatSchema,
});
type OutliersArgs = z.infer<typeof outliersInputSchema>;

export const getYoutubeOutliersTool = {
  name: "get_youtube_outliers",
  config: {
    title: "Get YouTube outliers",
    description:
      "Find breakout videos across the project's tracked YouTube channels (or one channel). The outlier score is a video's lifetime views divided by the median views of its channel's recent uploads: 1.0 is typical and 2.0 or more is a breakout. Defaults to the last 180 days with a minimum score of 1.5. An optional format filter keeps only Shorts (3 minutes or less) or only long videos; videos with an unknown duration count as long. Read-only and uses no OpenSEO credits.",
    inputSchema: outliersInputSchema,
    outputSchema: outliersOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: OutliersArgs, context) => {
    try {
      const [scannedChannels, outliers] = await Promise.all([
        countScoringTargets(args.projectId, args.channelId),
        YoutubeResearchService.getOutliers({
          projectId: args.projectId,
          channelId: args.channelId,
          windowDays: args.windowDays,
          limit: args.limit,
          minScore: args.minScore,
          userId: context.auth.userId,
        }),
      ]);
      const rows = filterRowsByFormat(outliers, args.format);
      const formatNote =
        args.format === "all"
          ? ""
          : ` ${args.format} filter: ${rows.length} of ${outliers.length} shown.`;
      const summary =
        outliers.length > 0
          ? `Scanned ${scannedChannels} channel(s): ${outliers.length} outlier video(s) scoring at least ${args.minScore}x their channel's median views in the last ${args.windowDays} days.${formatNote}`
          : `Scanned ${scannedChannels} channel(s): no videos scored at least ${args.minScore}x their channel's median views in the last ${args.windowDays} days.`;
      const text =
        rows.length > 0
          ? `${summary}\n${formatMcpTable(rows, OUTLIER_COLUMNS)}`
          : summary;
      return mcpResponse({
        text,
        meta: buildProjectMeta(context, args.projectId),
        structuredContent: { status: "ok", rows },
      });
    } catch (error) {
      return errorResponse(args, context, error);
    }
  }),
};

const channelStatsInputSchema = z.strictObject({
  projectId: projectIdSchema,
  channel: channelRefSchema,
});
type ChannelStatsArgs = z.infer<typeof channelStatsInputSchema>;

export const getYoutubeChannelStatsTool = {
  name: "get_youtube_channel_stats",
  config: {
    title: "Get YouTube channel stats",
    description:
      "Read a public YouTube channel's recent-upload statistics — sample size, median and average views, median views per day, and uploads per week — plus its most recent videos with views per day and outlier scores. Accepts a channel URL, @handle, or UC channel ID. Read-only and uses no OpenSEO credits.",
    inputSchema: channelStatsInputSchema,
    outputSchema: channelStatsOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: ChannelStatsArgs, context) => {
    try {
      const result = await YoutubeResearchService.getChannelStats({
        projectId: args.projectId,
        channel: args.channel,
        userId: context.auth.userId,
      });
      const summary = `${channelLabel(result.channel)} · ${result.sampleSize} uploads sampled · median ${result.medianViews} views · average ${result.averageViews} views · ${result.viewsPerDayMedian} median views/day · ${result.uploadsPerWeek} uploads/week`;
      const text =
        result.recentVideos.length > 0
          ? `${summary}\n${formatMcpTable(result.recentVideos, VIDEO_COLUMNS)}`
          : `${summary} No recent uploads found.`;
      return mcpResponse({
        text,
        meta: buildProjectMeta(context, args.projectId),
        structuredContent: { status: "ok", ...result },
      });
    } catch (error) {
      return errorResponse(args, context, error);
    }
  }),
};

const compareChannelsInputSchema = z.strictObject({
  projectId: projectIdSchema,
  channels: z
    .array(channelRefSchema)
    .min(2)
    .max(5)
    .describe(
      "2-5 YouTube channels to compare. Each is a channel URL, @handle, or UC channel ID.",
    ),
  windowDays: windowDaysSchema,
});
type CompareChannelsArgs = z.infer<typeof compareChannelsInputSchema>;

export const compareYoutubeChannelsTool = {
  name: "compare_youtube_channels",
  config: {
    title: "Compare YouTube channels",
    description:
      "Compare 2-5 YouTube channels side by side: subscribers, video count, uploads in the last 30 days, median views, breakout count (videos at 2x or more of the channel median), and top video. Accepts channel URLs, @handles, or UC channel IDs. Read-only and uses no OpenSEO credits.",
    inputSchema: compareChannelsInputSchema,
    outputSchema: comparisonOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: CompareChannelsArgs, context) => {
    try {
      const rows = await YoutubeResearchService.compareChannels({
        projectId: args.projectId,
        channels: args.channels,
        windowDays: args.windowDays,
        userId: context.auth.userId,
      });
      const summary = `Compared ${rows.length} channel(s); breakout count uses a ${args.windowDays}-day window and a 2x median-views threshold.`;
      const text =
        rows.length > 0
          ? `${summary}\n${formatMcpTable(rows, COMPARISON_COLUMNS)}`
          : `${summary} No channels could be compared.`;
      return mcpResponse({
        text,
        meta: buildProjectMeta(context, args.projectId),
        structuredContent: { status: "ok", rows },
      });
    } catch (error) {
      return errorResponse(args, context, error);
    }
  }),
};

const trendingInputSchema = z.strictObject({
  projectId: projectIdSchema,
  regionCode: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional()
    .default("US")
    .describe(
      "ISO 3166-1 alpha-2 region code for the chart (e.g. US, GB, IN). Defaults to US.",
    ),
  videoCategoryId: z
    .string()
    .min(1)
    .max(16)
    .optional()
    .describe(
      "Optional YouTube video category ID to restrict the chart (for example 20 for Gaming).",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(25)
    .describe("Maximum videos to return. Defaults to 25."),
});
type TrendingArgs = z.infer<typeof trendingInputSchema>;

export const getYoutubeTrendingVideosTool = {
  name: "get_youtube_trending_videos",
  config: {
    title: "Get YouTube trending videos",
    description:
      "Read YouTube's most-popular chart for a region, optionally limited to one video category. This is YouTube's public most-popular chart, not personalised recommendations. Read-only and uses no OpenSEO credits.",
    inputSchema: trendingInputSchema,
    outputSchema: trendingOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: TrendingArgs, context) => {
    try {
      const rows = await YoutubeResearchService.getTrendingVideos({
        projectId: args.projectId,
        regionCode: args.regionCode,
        videoCategoryId: args.videoCategoryId,
        limit: args.limit,
        userId: context.auth.userId,
      });
      const scope = args.videoCategoryId
        ? `${args.regionCode}, category ${args.videoCategoryId}`
        : args.regionCode;
      const summary = `YouTube most-popular chart for ${scope}: ${rows.length} video(s). This is YouTube's most-popular chart, not personalised recommendations.`;
      const text =
        rows.length > 0
          ? `${summary}\n${formatMcpTable(rows, TRENDING_COLUMNS)}`
          : summary;
      return mcpResponse({
        text,
        meta: buildProjectMeta(context, args.projectId),
        structuredContent: { status: "ok", rows },
      });
    } catch (error) {
      return errorResponse(args, context, error);
    }
  }),
};

const addResearchChannelInputSchema = z.strictObject({
  projectId: projectIdSchema,
  channel: channelRefSchema,
});
type AddResearchChannelArgs = z.infer<typeof addResearchChannelInputSchema>;

export const addYoutubeResearchChannelTool = {
  name: "add_youtube_research_channel",
  config: {
    title: "Add YouTube research channel",
    description:
      "Add a YouTube channel to the project's research list so its uploads can be scored for outliers, up to 20 channels per project. Accepts a channel URL, @handle, or UC channel ID. Mutating: writes to the project and requires an owner or admin. Uses no OpenSEO credits.",
    inputSchema: addResearchChannelInputSchema,
    outputSchema: researchChannelOutputSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: AddResearchChannelArgs, context) => {
    requireOrgPermission(context.auth, { integration: ["manage"] });
    try {
      const channel = await YoutubeResearchService.addResearchChannel({
        projectId: args.projectId,
        organizationId: context.auth.organizationId,
        channel: args.channel,
        userId: context.auth.userId,
      });
      return mcpResponse({
        text: `Added ${channelLabel(channel)} (${channel.channelId}) to the project's research channels.`,
        meta: buildProjectMeta(context, args.projectId),
        structuredContent: { status: "ok", channel },
      });
    } catch (error) {
      return errorResponse(args, context, error);
    }
  }),
};

const removeResearchChannelInputSchema = z.strictObject({
  projectId: projectIdSchema,
  channelId: youtubeChannelIdSchema.describe(
    "UC channel ID to remove, from list_youtube_research_channels. Removing a channel that is not tracked is a no-op.",
  ),
});
type RemoveResearchChannelArgs = z.infer<
  typeof removeResearchChannelInputSchema
>;

export const removeYoutubeResearchChannelTool = {
  name: "remove_youtube_research_channel",
  config: {
    title: "Remove YouTube research channel",
    description:
      "Remove a YouTube channel from the project's research list; stored history is kept and removing a channel that is not tracked is a no-op. Mutating: writes to the project and requires an owner or admin. Uses no OpenSEO credits.",
    inputSchema: removeResearchChannelInputSchema,
    outputSchema: removeResearchChannelOutputSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(
    async (args: RemoveResearchChannelArgs, context) => {
      requireOrgPermission(context.auth, { integration: ["manage"] });
      try {
        await YoutubeResearchService.removeResearchChannel({
          projectId: args.projectId,
          channelId: args.channelId,
        });
        return mcpResponse({
          text: `Removed ${args.channelId} from the project's research channels.`,
          meta: buildProjectMeta(context, args.projectId),
          structuredContent: { status: "ok", removed: true as const },
        });
      } catch (error) {
        return errorResponse(args, context, error);
      }
    },
  ),
};

const listResearchChannelsInputSchema = z.strictObject({
  projectId: projectIdSchema,
});
type ListResearchChannelsArgs = z.infer<typeof listResearchChannelsInputSchema>;

export const listYoutubeResearchChannelsTool = {
  name: "list_youtube_research_channels",
  config: {
    title: "List YouTube research channels",
    description:
      "List the YouTube channels tracked for this project with their subscriber, video, and view counts and last refresh time. A project can track up to 20 channels. Counts stay stale until refresh_youtube_research_channels pulls them from YouTube again. Read-only and uses no OpenSEO credits.",
    inputSchema: listResearchChannelsInputSchema,
    outputSchema: researchChannelsOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(
    async (args: ListResearchChannelsArgs, context) => {
      try {
        const channels = await YoutubeResearchService.listResearchChannels(
          args.projectId,
        );
        const summary = `${channels.length} of ${MAX_RESEARCH_CHANNELS} research channels tracked (limit ${MAX_RESEARCH_CHANNELS} per project).`;
        const text =
          channels.length > 0
            ? `${summary}\n${formatMcpTable(channels, RESEARCH_CHANNEL_COLUMNS)}`
            : `${summary} Add one with add_youtube_research_channel.`;
        return mcpResponse({
          text,
          meta: buildProjectMeta(context, args.projectId),
          structuredContent: {
            status: "ok",
            channels,
            cap: MAX_RESEARCH_CHANNELS,
          },
        });
      } catch (error) {
        return errorResponse(args, context, error);
      }
    },
  ),
};

const refreshResearchChannelsInputSchema = z.strictObject({
  projectId: projectIdSchema,
});
type RefreshResearchChannelsArgs = z.infer<
  typeof refreshResearchChannelsInputSchema
>;

export const refreshYoutubeResearchChannelsTool = {
  name: "refresh_youtube_research_channels",
  config: {
    title: "Refresh YouTube research channels",
    description:
      "Pull fresh YouTube Data API stats for every research channel on the project and store channel and video snapshots. get_youtube_video_trend and get_youtube_channel_growth read those snapshots, so call this before measuring growth. A project with no research channels returns an empty list — add one with add_youtube_research_channel first. Mutating: writes snapshots and requires an owner or admin. Uses no OpenSEO credits. YouTube Data API quota applies.",
    inputSchema: refreshResearchChannelsInputSchema,
    outputSchema: refreshResearchChannelsOutputSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(
    async (args: RefreshResearchChannelsArgs, context) => {
      requireOrgPermission(context.auth, { integration: ["manage"] });
      try {
        const result = await YoutubeResearchService.refreshResearchChannels({
          projectId: args.projectId,
          userId: context.auth.userId,
        });
        const summary = `Refreshed ${result.channels.length} research channel(s) at ${result.refreshedAt}.`;
        const text =
          result.channels.length > 0
            ? `${summary}\n${formatMcpTable(result.channels, RESEARCH_CHANNEL_COLUMNS)}`
            : `${summary} Add one with add_youtube_research_channel.`;
        return mcpResponse({
          text,
          meta: buildProjectMeta(context, args.projectId),
          structuredContent: {
            status: "ok",
            channels: result.channels,
            refreshedAt: result.refreshedAt,
          },
        });
      } catch (error) {
        return errorResponse(args, context, error);
      }
    },
  ),
};

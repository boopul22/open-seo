/* eslint-disable max-lines -- all YouTube performance MCP tools are intentionally kept in one module */
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  YOUTUBE_VIDEO_ID_PATTERN,
  YoutubePerformanceService,
  type YoutubeChannelGrowthPoint,
  type YoutubePublishDay,
  type YoutubeVideoTrendPoint,
} from "@/server/features/youtube/services/YoutubePerformanceService";
import type { AppError } from "@/server/lib/errors";
import { asAppError } from "@/server/lib/errors";
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
// by a refinement (the same shape the other YouTube tools use).
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

const trendOutputSchema = youtubeEnvelopeSchema({
  videoId: z.string(),
  points: z.array(z.record(z.string(), z.unknown())),
  warnings: z.array(z.string()),
});

const growthOutputSchema = youtubeEnvelopeSchema({
  channel: looseObjectOutputSchema,
  points: z.array(z.record(z.string(), z.unknown())),
  warnings: z.array(z.string()),
});

const bestPublishDaysOutputSchema = youtubeEnvelopeSchema({
  channel: looseObjectOutputSchema,
  range: looseObjectOutputSchema,
  weekdays: z.array(z.record(z.string(), z.unknown())),
  bestDay: z.string().nullable(),
  notes: z.array(z.string()),
});

const playlistsOutputSchema = youtubeEnvelopeSchema({
  channelId: z.string().nullable(),
  playlists: z.array(z.record(z.string(), z.unknown())),
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

// The performance service maps upstream YouTube faults to AppErrors with fixed
// messages, so re-translate those onto the youtube_* codes clients branch on
// (and that carry an actionUrl). Patterns track
// YoutubePerformanceService.mapUpstreamError; keep in sync.
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

const videoIdSchema = z
  .string()
  .regex(YOUTUBE_VIDEO_ID_PATTERN)
  .describe("11-character YouTube video ID, e.g. 'dQw4w9WgXcQ'.");

const youtubeChannelIdSchema = z
  .string()
  .regex(/^UC[A-Za-z0-9_-]{22}$/)
  .describe("UC-prefixed YouTube channel ID.");

const TREND_COLUMNS: McpTableColumn<YoutubeVideoTrendPoint>[] = [
  { header: "capturedAt", value: (row) => row.capturedAt },
  { header: "viewCount", value: (row) => row.viewCount },
  { header: "deltaViews", value: (row) => row.deltaViews },
  { header: "vph", value: (row) => row.vph },
];

const GROWTH_COLUMNS: McpTableColumn<YoutubeChannelGrowthPoint>[] = [
  { header: "capturedAt", value: (row) => row.capturedAt },
  { header: "subscriberCount", value: (row) => row.subscriberCount },
  { header: "videoCount", value: (row) => row.videoCount },
  { header: "viewCount", value: (row) => row.viewCount },
  { header: "deltaSubscribers", value: (row) => row.deltaSubscribers },
  { header: "deltaViews", value: (row) => row.deltaViews },
];

const PUBLISH_DAY_COLUMNS: McpTableColumn<YoutubePublishDay>[] = [
  { header: "weekday", value: (row) => row.weekday },
  { header: "views", value: (row) => row.views },
  { header: "watchMinutes", value: (row) => row.estimatedMinutesWatched },
  { header: "uploads", value: (row) => row.uploads },
  { header: "avgViewsPerUpload", value: (row) => row.averageViewsPerUpload },
];

type PlaylistRow = Awaited<
  ReturnType<typeof YoutubePerformanceService.listPlaylistsForChannel>
>["playlists"][number];

const PLAYLIST_COLUMNS: McpTableColumn<PlaylistRow>[] = [
  { header: "title", value: (row) => row.title, format: truncatedCell(60) },
  { header: "items", value: (row) => row.itemCount },
  { header: "publishedAt", value: (row) => row.publishedAt },
  { header: "playlistId", value: (row) => row.playlistId },
];

type VideoTrendResult = Awaited<
  ReturnType<typeof YoutubePerformanceService.getVideoTrend>
>;
type ChannelGrowthResult = Awaited<
  ReturnType<typeof YoutubePerformanceService.getChannelGrowth>
>;
type PlaylistsResult = Awaited<
  ReturnType<typeof YoutubePerformanceService.listPlaylistsForChannel>
>;

/** End-to-end views/hour across the stored series; null until two usable
 *  readings at least an hour apart exist. */
function impliedVph(points: YoutubeVideoTrendPoint[]): number | null {
  const first = points.at(0);
  const last = points.at(-1);
  if (!first || !last || first === last) return null;
  if (first.viewCount === null || last.viewCount === null) return null;
  const firstMs = Date.parse(first.capturedAt);
  const lastMs = Date.parse(last.capturedAt);
  if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs)) return null;
  const hours = (lastMs - firstMs) / 3_600_000;
  if (hours < 1) return null;
  return Math.round(((last.viewCount - first.viewCount) / hours) * 100) / 100;
}

function numberOrDash(value: number | null): string {
  return value === null ? "—" : String(value);
}

function videoTrendText(result: VideoTrendResult): string {
  const first = result.points.at(0);
  const last = result.points.at(-1);
  const viewsSpan =
    first && last
      ? `views ${numberOrDash(first.viewCount)} → ${numberOrDash(last.viewCount)}`
      : "no view snapshots stored";
  const lines = [
    `${result.points.length} snapshot(s) for video ${result.videoId} · ${viewsSpan} · implied ${numberOrDash(impliedVph(result.points))} views/hour.`,
  ];
  if (result.points.length > 0) {
    lines.push(formatMcpTable(result.points, TREND_COLUMNS));
  }
  if (result.warnings.includes("insufficient_snapshots")) {
    lines.push(
      "Not enough snapshots yet to measure a trend: refresh research channels over time to build this series (each refresh appends one snapshot per sampled video).",
    );
  }
  return lines.join("\n");
}

function channelGrowthText(result: ChannelGrowthResult): string {
  const first = result.points.at(0);
  const last = result.points.at(-1);
  const subscriberDelta =
    first?.subscriberCount != null && last?.subscriberCount != null
      ? last.subscriberCount - first.subscriberCount
      : null;
  const viewDelta =
    first?.viewCount != null && last?.viewCount != null
      ? last.viewCount - first.viewCount
      : null;
  const lines = [
    `${result.channel.channelTitle} (${result.channel.channelId}) · ${result.points.length} snapshot(s) · subscribers ${numberOrDash(subscriberDelta)} · views ${numberOrDash(viewDelta)} across the stored series.`,
  ];
  if (result.points.length > 0) {
    lines.push(formatMcpTable(result.points, GROWTH_COLUMNS));
  }
  if (result.warnings.includes("insufficient_snapshots")) {
    lines.push(
      "Not enough snapshots yet to measure growth: refresh research channels over time to build this series.",
    );
  }
  return lines.join("\n");
}

type BestPublishDaysResult = Awaited<
  ReturnType<typeof YoutubePerformanceService.getBestPublishDays>
>;

function bestPublishDaysText(result: BestPublishDaysResult): string {
  const lines = [
    `Audience watch activity by weekday for ${result.channel.channelTitle}, ${result.range.startDate} to ${result.range.endDate} · best day: ${result.bestDay ?? "no recorded watch activity"}.`,
    formatMcpTable(result.weekdays, PUBLISH_DAY_COLUMNS),
    ...result.notes,
  ];
  return lines.join("\n");
}

function playlistsText(result: PlaylistsResult): string {
  const scope = result.channelId ?? "the connected YouTube account";
  const lines = [`${result.playlists.length} playlist(s) for ${scope}.`];
  if (result.playlists.length > 0) {
    lines.push(formatMcpTable(result.playlists, PLAYLIST_COLUMNS));
  }
  return lines.join("\n");
}

const videoTrendInputSchema = z.strictObject({
  projectId: projectIdSchema,
  videoId: videoIdSchema,
  days: z
    .number()
    .int()
    .min(7)
    .max(365)
    .optional()
    .default(90)
    .describe("How many days of snapshots to include. Defaults to 90."),
});
type VideoTrendArgs = z.infer<typeof videoTrendInputSchema>;

export const getYoutubeVideoTrendTool = {
  name: "get_youtube_video_trend",
  config: {
    title: "Get YouTube video trend",
    description:
      "Read one YouTube video's stored view snapshots over time — view counts, deltas between refreshes, and views per hour — to measure growth and velocity. Snapshots only exist after refresh_youtube_research_channels; a series with one point means that refresh has not run twice yet. Read-only and uses no OpenSEO credits.",
    inputSchema: videoTrendInputSchema,
    outputSchema: trendOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: VideoTrendArgs, context) => {
    try {
      const result = await YoutubePerformanceService.getVideoTrend({
        projectId: args.projectId,
        videoId: args.videoId,
        days: args.days,
      });
      return mcpResponse({
        text: videoTrendText(result),
        meta: buildProjectMeta(context, args.projectId),
        structuredContent: { status: "ok", ...result },
      });
    } catch (error) {
      return errorResponse(args, context, error);
    }
  }),
};

const channelGrowthInputSchema = z.strictObject({
  projectId: projectIdSchema,
  channelId: youtubeChannelIdSchema
    .optional()
    .describe(
      "A tracked research channel's UC id. Defaults to the project's connected YouTube channel.",
    ),
});
type ChannelGrowthArgs = z.infer<typeof channelGrowthInputSchema>;

export const getYoutubeChannelGrowthTool = {
  name: "get_youtube_channel_growth",
  config: {
    title: "Get YouTube channel growth",
    description:
      "Read a YouTube channel's subscriber, video, and view growth from stored snapshots: per-refresh totals plus the delta between consecutive refreshes. Defaults to the project's connected channel; a tracked research channel's UC id may be passed instead. Snapshots are written by refresh_youtube_research_channels, and growth needs at least two refreshes. Read-only and uses no OpenSEO credits.",
    inputSchema: channelGrowthInputSchema,
    outputSchema: growthOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: ChannelGrowthArgs, context) => {
    try {
      const result = await YoutubePerformanceService.getChannelGrowth({
        projectId: args.projectId,
        channelId: args.channelId,
      });
      return mcpResponse({
        text: channelGrowthText(result),
        meta: buildProjectMeta(context, args.projectId),
        structuredContent: { status: "ok", ...result },
      });
    } catch (error) {
      return errorResponse(args, context, error);
    }
  }),
};

const bestPublishDaysInputSchema = z.strictObject({
  projectId: projectIdSchema,
});
type BestPublishDaysArgs = z.infer<typeof bestPublishDaysInputSchema>;

export const getYoutubeBestPublishDaysTool = {
  name: "get_youtube_best_publish_days",
  config: {
    title: "Get YouTube best publish days",
    description:
      "Owned channel only: show audience watch activity (views and watch time) by weekday over the last 90 complete days, alongside your upload counts and average views per upload by weekday. This is when YOUR existing audience watches, not a cross-channel 'best time to post' benchmark. Read-only and uses no OpenSEO credits.",
    inputSchema: bestPublishDaysInputSchema,
    outputSchema: bestPublishDaysOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: BestPublishDaysArgs, context) => {
    try {
      const result = await YoutubePerformanceService.getBestPublishDays({
        projectId: args.projectId,
      });
      return mcpResponse({
        text: bestPublishDaysText(result),
        meta: buildProjectMeta(context, args.projectId),
        structuredContent: { status: "ok", ...result },
      });
    } catch (error) {
      return errorResponse(args, context, error);
    }
  }),
};

const playlistsInputSchema = z.strictObject({
  projectId: projectIdSchema,
  channelId: youtubeChannelIdSchema
    .optional()
    .describe(
      "Any public UC channel ID. Omit to list the connected channel's own playlists (mine).",
    ),
  mine: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "List the connected account's own playlists when no channelId is given. Defaults to true.",
    ),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(25)
    .describe("Maximum playlists to return (1-50). Defaults to 25."),
});
type PlaylistsArgs = z.infer<typeof playlistsInputSchema>;

export const listYoutubePlaylistsTool = {
  name: "list_youtube_playlists",
  config: {
    title: "List YouTube playlists",
    description:
      "List YouTube playlists for the project's connected channel (mine, the default) or for any public channel by UC id, with title, item count, and creation date. Read-only and uses no OpenSEO credits.",
    inputSchema: playlistsInputSchema,
    outputSchema: playlistsOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: PlaylistsArgs, context) => {
    try {
      const result = await YoutubePerformanceService.listPlaylistsForChannel({
        projectId: args.projectId,
        channelId: args.channelId,
        mine: args.mine,
        maxResults: args.maxResults,
        userId: context.auth.userId,
      });
      return mcpResponse({
        text: playlistsText(result),
        meta: buildProjectMeta(context, args.projectId),
        structuredContent: { status: "ok", ...result },
      });
    } catch (error) {
      return errorResponse(args, context, error);
    }
  }),
};

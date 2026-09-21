/* eslint-disable max-lines -- all YouTube audience MCP tools are intentionally kept in one module */
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  YOUTUBE_AUDIENCE_DIMENSIONS,
  YoutubeAudienceService,
  type YoutubeAudienceDimension,
} from "@/server/features/youtube/services/YoutubeAudienceService";
import {
  asYoutubeReportError,
  YoutubeReportError,
} from "@/server/lib/youtubeErrors";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { looseObjectOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { formatMcpTable, type McpTableColumn } from "@/server/mcp/table";
import { buildDashboardUrl } from "@/server/mcp/urls";

const videoIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{11}$/)
  .describe("11-character YouTube video ID, e.g. 'dQw4w9WgXcQ'.");

const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(200)
  .optional()
  .default(25)
  .describe("Maximum rows to return (1-200). Defaults to 25.");

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
// by a refinement (same shape the GA4 and YouTube channel tools use).
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

const channelSchema = looseObjectOutputSchema;

const retentionOutputSchema = youtubeEnvelopeSchema({
  source: z.string(),
  channel: channelSchema,
  request: looseObjectOutputSchema,
  videoId: z.string(),
  averageViewPercentage: z.number().nullable(),
  views: z.number().nullable().optional(),
  points: z.array(z.record(z.string(), z.unknown())),
  rows: z.array(z.record(z.string(), z.unknown())),
});

const audienceBreakdownOutputSchema = youtubeEnvelopeSchema({
  source: z.string(),
  channel: channelSchema,
  request: looseObjectOutputSchema,
  rows: z.array(z.record(z.string(), z.unknown())),
});

const playbackLocationsOutputSchema = youtubeEnvelopeSchema({
  source: z.string(),
  channel: channelSchema,
  request: looseObjectOutputSchema,
  rows: z.array(z.record(z.string(), z.unknown())),
});

const videoTrafficOutputSchema = youtubeEnvelopeSchema({
  source: z.string(),
  channel: channelSchema,
  request: looseObjectOutputSchema,
  rows: z.array(z.record(z.string(), z.unknown())),
});

type ProjectContext = {
  auth: { organizationId: string };
  baseUrl: string;
};

type ProjectArgs = { projectId: string };

function actionUrl(
  baseUrl: string,
  projectId: string,
  code: string,
): string | undefined {
  if (
    code === "youtube_not_connected" ||
    code === "youtube_reconnect_required" ||
    code === "youtube_channel_inaccessible"
  ) {
    return buildDashboardUrl(baseUrl, `/p/${projectId}/settings/integrations`);
  }
  return undefined;
}

function errorResponse(
  args: ProjectArgs,
  context: ProjectContext,
  error: unknown,
): CallToolResult {
  const mapped = asYoutubeReportError(error);
  if (!(mapped instanceof YoutubeReportError)) throw mapped;
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

function channelLabel(channel: {
  channelTitle: string;
  channelHandle: string | null;
}): string {
  return channel.channelHandle
    ? `${channel.channelTitle} (${channel.channelHandle})`
    : channel.channelTitle;
}

function rangeLabel(result: {
  request: { resolvedRange: { startDate: string; endDate: string } };
}): string {
  const range = result.request.resolvedRange;
  return `${range.startDate} to ${range.endDate}`;
}

function percentCell(value: unknown): string {
  return typeof value === "number" ? `${value.toFixed(2)}%` : "—";
}

function secondsCell(value: unknown): string {
  return typeof value === "number" ? `${Math.round(value)}s` : "—";
}

type AudienceRow = Record<string, string | number | null>;

type RetentionPoint = Awaited<
  ReturnType<typeof YoutubeAudienceService.getVideoRetention>
>["points"][number];

const RETENTION_COLUMNS: McpTableColumn<RetentionPoint>[] = [
  {
    header: "ratio",
    value: (point) => point.ratio,
    format: (value) => (typeof value === "number" ? value.toFixed(4) : "—"),
  },
  { header: "audienceWatchRatio", value: (point) => point.audienceWatchRatio },
  {
    header: "relativeRetentionPerformance",
    value: (point) => point.relativeRetentionPerformance,
  },
];

function audienceColumns(
  dimension: YoutubeAudienceDimension,
): McpTableColumn<AudienceRow>[] {
  if (dimension === "ageGroup" || dimension === "gender") {
    return [
      { header: dimension, value: (row) => row[dimension] },
      {
        header: "viewerPercentage",
        value: (row) => row.viewerPercentage,
        format: percentCell,
      },
    ];
  }
  return [
    { header: dimension, value: (row) => row[dimension] },
    { header: "views", value: (row) => row.views },
    { header: "watchMinutes", value: (row) => row.estimatedMinutesWatched },
  ];
}

const PLAYBACK_LOCATION_COLUMNS: McpTableColumn<AudienceRow>[] = [
  { header: "playbackLocation", value: (row) => row.playbackLocation },
  {
    header: "playbackLocationDetail",
    value: (row) => row.playbackLocationDetail,
  },
  { header: "views", value: (row) => row.views },
  { header: "watchMinutes", value: (row) => row.estimatedMinutesWatched },
  {
    header: "avgViewSeconds",
    value: (row) => row.averageViewDuration,
    format: secondsCell,
  },
];

const VIDEO_TRAFFIC_COLUMNS: McpTableColumn<AudienceRow>[] = [
  { header: "trafficSource", value: (row) => row.trafficSource },
  { header: "views", value: (row) => row.views },
  { header: "watchMinutes", value: (row) => row.estimatedMinutesWatched },
  {
    header: "avgViewSeconds",
    value: (row) => row.averageViewDuration,
    format: secondsCell,
  },
];

const retentionInputSchema = z.strictObject({
  projectId: projectIdSchema,
  videoId: videoIdSchema,
});
type RetentionArgs = z.infer<typeof retentionInputSchema>;

export const getYoutubeVideoRetentionTool = {
  name: "get_youtube_video_retention",
  config: {
    title: "Get YouTube video retention",
    description:
      "Read the average audience retention curve for one video on the connected YouTube channel: audienceWatchRatio and relativeRetentionPerformance per elapsed-time bucket, plus the video's average view percentage. Defaults to the last 28 complete days. Read-only and uses no OpenSEO credits.",
    inputSchema: retentionInputSchema,
    outputSchema: retentionOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: RetentionArgs, context) => {
    try {
      const result = await YoutubeAudienceService.getVideoRetention({
        projectId: args.projectId,
        videoId: args.videoId,
      });
      const averageViewPercentage =
        result.averageViewPercentage === null
          ? "—"
          : `${result.averageViewPercentage}%`;
      const summary = `Retention for video ${result.videoId} on ${channelLabel(result.channel)}, ${rangeLabel(result)}: average view percentage ${averageViewPercentage}, ${result.points.length} point(s).`;
      const text =
        result.points.length > 0
          ? `${summary}\n${formatMcpTable(result.points, RETENTION_COLUMNS)}`
          : `${summary} No retention points for this range.`;
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

const audienceBreakdownInputSchema = z.strictObject({
  projectId: projectIdSchema,
  dimension: z
    .enum(YOUTUBE_AUDIENCE_DIMENSIONS)
    .describe(
      "Breakdown dimension: country, ageGroup, gender, deviceType, or subscribedStatus.",
    ),
  limit: limitSchema,
});
type AudienceBreakdownArgs = z.infer<typeof audienceBreakdownInputSchema>;

export const getYoutubeAudienceBreakdownTool = {
  name: "get_youtube_audience_breakdown",
  config: {
    title: "Get YouTube audience breakdown",
    description:
      "Break down the connected YouTube channel's audience by country, age group, gender, device type, or subscriber status (views and watch time; viewer percentage for age/gender) over the last 28 complete days by default. Read-only and uses no OpenSEO credits.",
    inputSchema: audienceBreakdownInputSchema,
    outputSchema: audienceBreakdownOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: AudienceBreakdownArgs, context) => {
    try {
      const result = await YoutubeAudienceService.getAudienceBreakdown({
        projectId: args.projectId,
        dimension: args.dimension,
        limit: args.limit,
      });
      const summary = `Audience by ${args.dimension} for ${channelLabel(result.channel)}, ${rangeLabel(result)}: ${result.rows.length} row(s).`;
      const text =
        result.rows.length > 0
          ? `${summary}\n${formatMcpTable(result.rows, audienceColumns(args.dimension))}`
          : `${summary} No rows for this range.`;
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

const playbackLocationsInputSchema = z.strictObject({
  projectId: projectIdSchema,
  limit: limitSchema,
  detail: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Include per-location detail rows (e.g. specific apps/sites within a location type). Detail mode returns up to 200 rows.",
    ),
});
type PlaybackLocationsArgs = z.infer<typeof playbackLocationsInputSchema>;

export const getYoutubePlaybackLocationsTool = {
  name: "get_youtube_playback_locations",
  config: {
    title: "Get YouTube playback locations",
    description:
      "Read where the connected YouTube channel's audience watched: views, watch time, and average view duration by playback location type, with optional per-location detail rows. Defaults to the last 28 complete days. Read-only and uses no OpenSEO credits.",
    inputSchema: playbackLocationsInputSchema,
    outputSchema: playbackLocationsOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: PlaybackLocationsArgs, context) => {
    try {
      const result = await YoutubeAudienceService.getPlaybackLocations({
        projectId: args.projectId,
        limit: args.limit,
        detail: args.detail,
      });
      const label = args.detail
        ? "Playback location details"
        : "Playback locations";
      const summary = `${label} for ${channelLabel(result.channel)}, ${rangeLabel(result)}: ${result.rows.length} row(s).`;
      const text =
        result.rows.length > 0
          ? `${summary}\n${formatMcpTable(result.rows, PLAYBACK_LOCATION_COLUMNS)}`
          : `${summary} No rows for this range.`;
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

const videoTrafficInputSchema = z.strictObject({
  projectId: projectIdSchema,
  videoId: videoIdSchema,
  limit: limitSchema,
});
type VideoTrafficArgs = z.infer<typeof videoTrafficInputSchema>;

export const getYoutubeVideoTrafficTool = {
  name: "get_youtube_video_traffic",
  config: {
    title: "Get YouTube video traffic sources",
    description:
      "Break down one video's YouTube views, watch time, and average view duration by traffic source (search, suggested, browse, external, etc.) over the last 28 complete days by default. Read-only and uses no OpenSEO credits.",
    inputSchema: videoTrafficInputSchema,
    outputSchema: videoTrafficOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: VideoTrafficArgs, context) => {
    try {
      const result = await YoutubeAudienceService.getVideoTraffic({
        projectId: args.projectId,
        videoId: args.videoId,
        limit: args.limit,
      });
      const summary = `Traffic sources for video ${args.videoId} on ${channelLabel(result.channel)}, ${rangeLabel(result)}: ${result.rows.length} row(s).`;
      const text =
        result.rows.length > 0
          ? `${summary}\n${formatMcpTable(result.rows, VIDEO_TRAFFIC_COLUMNS)}`
          : `${summary} No rows for this range.`;
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

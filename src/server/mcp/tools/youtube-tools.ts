/* eslint-disable max-lines -- all YouTube MCP tools are intentionally kept in one module */
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { YoutubeAnalyticsService } from "@/server/features/youtube/services/YoutubeAnalyticsService";
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

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Inclusive YYYY-MM-DD date. Provide both startDate and endDate.");

const commonReportInputSchema = {
  projectId: projectIdSchema,
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
} as const;

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
// by a refinement (same shape the GA4 tools use).
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

const channelToolOutputSchema = youtubeEnvelopeSchema({
  source: z.string(),
  channel: channelSchema,
  subscriberCount: z.number().nullable(),
  videoCount: z.number().nullable(),
  viewCount: z.number().nullable(),
  connectedEmail: z.string().nullable().optional(),
});

const overviewOutputSchema = youtubeEnvelopeSchema({
  source: z.string(),
  channel: channelSchema,
  request: looseObjectOutputSchema,
  current: looseObjectOutputSchema.nullable(),
  previous: looseObjectOutputSchema.nullable(),
  trend: z.array(z.record(z.string(), z.unknown())),
});

const topVideosOutputSchema = youtubeEnvelopeSchema({
  source: z.string(),
  channel: channelSchema,
  request: looseObjectOutputSchema,
  rows: z.array(z.record(z.string(), z.unknown())),
});

const trafficSourcesOutputSchema = youtubeEnvelopeSchema({
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

function metricNumber(
  row: Record<string, string | number | null> | null,
  key: string,
): number | null {
  const value = row?.[key];
  return typeof value === "number" ? value : null;
}

const OVERVIEW_ROWS = [
  "views",
  "estimatedMinutesWatched",
  "averageViewDuration",
  "averageViewPercentage",
  "subscribersGained",
  "subscribersLost",
  "likes",
  "comments",
  "shares",
] as const;

function overviewText(
  result: Awaited<
    ReturnType<typeof YoutubeAnalyticsService.getChannelOverview>
  >,
) {
  const summary = `YouTube overview for ${channelLabel(result.channel)}, ${rangeLabel(result)} (previous period ${result.request.previousRange.startDate} to ${result.request.previousRange.endDate}).`;
  if (!result.current) {
    return `${summary} No analytics rows for this range.`;
  }
  const rows = OVERVIEW_ROWS.map((metric) => ({
    metric,
    current: metricNumber(result.current, metric),
    previous: metricNumber(result.previous, metric),
  }));
  return `${summary}\n${formatMcpTable(rows, [
    { header: "metric", value: (row) => row.metric },
    { header: "current", value: (row) => row.current },
    { header: "previous", value: (row) => row.previous },
  ])}`;
}

type TopVideoRow = Awaited<
  ReturnType<typeof YoutubeAnalyticsService.getTopVideos>
>["rows"][number];

const TOP_VIDEO_COLUMNS: McpTableColumn<TopVideoRow>[] = [
  { header: "title", value: (row) => row.title ?? row.videoId ?? "—" },
  { header: "videoId", value: (row) => row.videoId },
  { header: "views", value: (row) => row.views },
  { header: "watchMinutes", value: (row) => row.estimatedMinutesWatched },
  {
    header: "avgViewSeconds",
    value: (row) => row.averageViewDuration,
    format: (value) =>
      typeof value === "number" ? `${Math.round(value)}s` : "—",
  },
  { header: "subscribersGained", value: (row) => row.subscribersGained },
  { header: "likes", value: (row) => row.likes },
  { header: "comments", value: (row) => row.comments },
];

type TrafficRow = Awaited<
  ReturnType<typeof YoutubeAnalyticsService.getTrafficSources>
>["rows"][number];

const TRAFFIC_COLUMNS: McpTableColumn<TrafficRow>[] = [
  { header: "trafficSource", value: (row) => row.trafficSource ?? "—" },
  { header: "views", value: (row) => row.views },
  { header: "watchMinutes", value: (row) => row.estimatedMinutesWatched },
];

const channelInputSchema = z.strictObject({ projectId: projectIdSchema });
type ChannelArgs = z.infer<typeof channelInputSchema>;

export const getYoutubeChannelTool = {
  name: "get_youtube_channel",
  config: {
    title: "Get YouTube channel",
    description:
      "Read the project's connected YouTube channel: title, handle, subscriber count, video count, and lifetime views. Read-only and uses no OpenSEO credits.",
    inputSchema: channelInputSchema,
    outputSchema: channelToolOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: ChannelArgs, context) => {
    try {
      const result = await YoutubeAnalyticsService.getChannelInfo({
        projectId: args.projectId,
      });
      const text = `${channelLabel(result.channel)} · ${result.subscriberCount ?? "—"} subscribers · ${result.videoCount ?? "—"} videos · ${result.viewCount ?? "—"} lifetime views`;
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

const overviewInputSchema = z.strictObject(commonReportInputSchema);
type OverviewArgs = z.infer<typeof overviewInputSchema>;

export const getYoutubeChannelOverviewTool = {
  name: "get_youtube_channel_overview",
  config: {
    title: "Get YouTube channel overview",
    description:
      "Read YouTube Analytics totals for the connected channel — views, watch time, average view duration/percentage, subscribers gained/lost, likes, comments, and shares — compared with the immediately preceding equal-length period, plus a daily views trend. Defaults to the last 28 complete days. Read-only and uses no OpenSEO credits.",
    inputSchema: overviewInputSchema,
    outputSchema: overviewOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: OverviewArgs, context) => {
    try {
      const result = await YoutubeAnalyticsService.getChannelOverview({
        projectId: args.projectId,
        startDate: args.startDate,
        endDate: args.endDate,
      });
      return mcpResponse({
        text: overviewText(result),
        meta: buildProjectMeta(context, args.projectId),
        structuredContent: { status: "ok", ...result },
      });
    } catch (error) {
      return errorResponse(args, context, error);
    }
  }),
};

const topVideosInputSchema = z.strictObject({
  ...commonReportInputSchema,
  limit: z.number().int().min(1).max(200).optional().default(25),
  sort: z.enum(["views", "watch_time"]).optional().default("views"),
});
type TopVideosArgs = z.infer<typeof topVideosInputSchema>;

export const getYoutubeTopVideosTool = {
  name: "get_youtube_top_videos",
  config: {
    title: "Get YouTube top videos",
    description:
      "Rank the connected channel's videos by views (or watch time) for a date range, with watch time, average view duration, subscribers gained, likes, and comments, enriched with video titles. Defaults to the last 28 complete days, top 25. Read-only and uses no OpenSEO credits.",
    inputSchema: topVideosInputSchema,
    outputSchema: topVideosOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: TopVideosArgs, context) => {
    try {
      const result = await YoutubeAnalyticsService.getTopVideos({
        projectId: args.projectId,
        startDate: args.startDate,
        endDate: args.endDate,
        limit: args.limit,
        sort: args.sort,
      });
      const summary = `Top videos for ${channelLabel(result.channel)}, ${rangeLabel(result)}: ${result.rows.length} row(s).`;
      const text =
        result.rows.length > 0
          ? `${summary}\n${formatMcpTable(result.rows, TOP_VIDEO_COLUMNS)}`
          : `${summary} No video rows for this range.`;
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

const trafficSourcesInputSchema = z.strictObject({
  ...commonReportInputSchema,
  limit: z.number().int().min(1).max(200).optional().default(25),
});
type TrafficSourcesArgs = z.infer<typeof trafficSourcesInputSchema>;

export const getYoutubeTrafficSourcesTool = {
  name: "get_youtube_traffic_sources",
  config: {
    title: "Get YouTube traffic sources",
    description:
      "Break down the connected channel's views and watch time by YouTube traffic source (search, suggested, browse, external, etc.) for a date range. Defaults to the last 28 complete days. Read-only and uses no OpenSEO credits.",
    inputSchema: trafficSourcesInputSchema,
    outputSchema: trafficSourcesOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: TrafficSourcesArgs, context) => {
    try {
      const result = await YoutubeAnalyticsService.getTrafficSources({
        projectId: args.projectId,
        startDate: args.startDate,
        endDate: args.endDate,
        limit: args.limit,
      });
      const summary = `Traffic sources for ${channelLabel(result.channel)}, ${rangeLabel(result)}: ${result.rows.length} row(s).`;
      const text =
        result.rows.length > 0
          ? `${summary}\n${formatMcpTable(result.rows, TRAFFIC_COLUMNS)}`
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

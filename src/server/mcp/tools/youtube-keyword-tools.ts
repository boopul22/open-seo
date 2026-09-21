/* eslint-disable max-lines -- all YouTube keyword MCP tools are intentionally kept in one module */
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { YoutubeKeywordService } from "@/server/features/youtube/services/YoutubeKeywordService";
import { asAppError, type AppError } from "@/server/lib/errors";
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
// by a refinement (same shape the other YouTube tools use).
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

const rowsSchema = z.array(z.record(z.string(), z.unknown()));

const keywordIdeasOutputSchema = youtubeEnvelopeSchema({
  seed: z.string(),
  ideas: rowsSchema,
  warnings: z.array(z.string()),
});

const keywordPerformanceOutputSchema = youtubeEnvelopeSchema({
  keyword: z.string(),
  regionCode: z.string(),
  capturedAt: z.string(),
  sampleSize: z.number(),
  medianViews: z.number(),
  averageViews: z.number(),
  medianViewsPerDay: z.number(),
  videos: rowsSchema,
});

const highPerformanceKeywordsOutputSchema = youtubeEnvelopeSchema({
  channel: looseObjectOutputSchema,
  keywords: rowsSchema,
});

const keywordGapOutputSchema = youtubeEnvelopeSchema({
  you: rowsSchema,
  competitor: rowsSchema,
  gaps: rowsSchema,
  competitorChannel: looseObjectOutputSchema,
});

const keywordComparisonOutputSchema = youtubeEnvelopeSchema({
  rows: rowsSchema,
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
    code === "youtube_reconnect_required" ||
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

// YoutubeKeywordService maps YouTube token and Data API faults to AppErrors
// before they reach a tool: FORBIDDEN for a dead connection, RATE_LIMITED for
// an exhausted quota, VALIDATION_ERROR for bad input. Re-translate those onto
// the youtube_* codes clients already branch on, so the connection and quota
// cases carry an actionUrl to the integrations page. Keep in sync with
// YoutubeKeywordService.mapUpstreamError.
function keywordErrorCode(error: AppError): string {
  if (error.code === "FORBIDDEN") return "youtube_reconnect_required";
  if (error.code === "RATE_LIMITED") return "youtube_quota_exhausted";
  if (error.code === "VALIDATION_ERROR" || error.code === "NOT_FOUND") {
    return "validation_error";
  }
  return "youtube_upstream_unavailable";
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
    mapped = {
      code: keywordErrorCode(appError),
      message: appError.message,
      retryAfterSeconds: null,
    };
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

const keywordTextSchema = z.string().trim().min(1).max(200);

const regionCodeSchema = z
  .string()
  .regex(/^[A-Z]{2}$/)
  .optional()
  .default("US")
  .describe(
    "ISO 3166-1 alpha-2 region code used for YouTube search context (e.g. US, GB, IN). Defaults to US.",
  );

type IdeasResult = Awaited<
  ReturnType<typeof YoutubeKeywordService.getKeywordIdeas>
>;
type PerformanceResult = Awaited<
  ReturnType<typeof YoutubeKeywordService.getKeywordPerformance>
>;
type PerformanceVideo = PerformanceResult["videos"][number];
type HighPerformanceResult = Awaited<
  ReturnType<typeof YoutubeKeywordService.getHighPerformanceKeywords>
>;
type ScoredTermRow = HighPerformanceResult["keywords"][number];
type GapResult = Awaited<
  ReturnType<typeof YoutubeKeywordService.getKeywordGap>
>;
type ComparisonResult = Awaited<
  ReturnType<typeof YoutubeKeywordService.compareKeywords>
>;
type ComparisonRow = ComparisonResult["rows"][number];
type ComparisonSuccessRow = Extract<ComparisonRow, { cached: boolean }>;
type ComparisonErrorRow = Extract<
  ComparisonRow,
  { error: "no_results" | "unavailable" }
>;

function channelLabel(channel: {
  channelTitle: string;
  channelHandle: string | null;
}): string {
  return channel.channelHandle
    ? `${channel.channelTitle} (${channel.channelHandle})`
    : channel.channelTitle;
}

function isComparisonError(row: ComparisonRow): row is ComparisonErrorRow {
  return "error" in row;
}

const PERFORMANCE_VIDEO_COLUMNS: McpTableColumn<PerformanceVideo>[] = [
  { header: "title", value: (row) => row.title, format: truncatedCell(60) },
  {
    header: "channel",
    value: (row) => row.channelTitle,
    format: truncatedCell(30),
  },
  { header: "views", value: (row) => row.views },
  { header: "viewsPerDay", value: (row) => row.viewsPerDay },
  { header: "position", value: (row) => row.position },
];

const TERM_COLUMNS: McpTableColumn<ScoredTermRow>[] = [
  { header: "term", value: (row) => row.term, format: truncatedCell(50) },
  { header: "videoCount", value: (row) => row.videoCount },
  { header: "medianOutlierScore", value: (row) => row.medianOutlierScore },
  { header: "averageViews", value: (row) => row.averageViews },
];

const COMPARISON_COLUMNS: McpTableColumn<ComparisonSuccessRow>[] = [
  { header: "keyword", value: (row) => row.keyword, format: truncatedCell(50) },
  { header: "cached", value: (row) => row.cached },
  { header: "sampleSize", value: (row) => row.sampleSize },
  { header: "medianViews", value: (row) => row.medianViews },
  { header: "medianViewsPerDay", value: (row) => row.medianViewsPerDay },
];

function ideasText(result: IdeasResult): string {
  const warnings =
    result.warnings.length > 0
      ? ` Warnings: ${result.warnings.join(", ")}.`
      : "";
  const summary = `YouTube keyword ideas for "${result.seed}": ${result.ideas.length} phrase(s). These are autocomplete and title/tag phrases, not search volume.`;
  if (result.ideas.length === 0) return `${summary}${warnings}`;
  const list = result.ideas
    .map((idea, index) => `${index + 1}. ${idea.phrase} (${idea.source})`)
    .join("\n");
  return `${summary}${warnings}\n${list}`;
}

function performanceText(result: PerformanceResult): string {
  const summary = `Keyword "${result.keyword}" (${result.regionCode}) · captured ${result.capturedAt} · ${result.sampleSize} video(s) sampled · median ${result.medianViews} views · median ${result.medianViewsPerDay} views/day.`;
  const top = result.videos.slice(0, 10);
  if (top.length === 0) return `${summary} No videos in the sample.`;
  return `${summary}\nTop ${top.length} of ${result.videos.length} sampled video(s):\n${formatMcpTable(top, PERFORMANCE_VIDEO_COLUMNS)}`;
}

function highPerformanceText(result: HighPerformanceResult): string {
  const summary = `Terms from ${channelLabel(result.channel)}'s best-performing uploads: ${result.keywords.length} term(s) ranked by median outlier score.`;
  if (result.keywords.length === 0) {
    return `${summary} No term appears on enough videos; lower minVideos to widen the scan.`;
  }
  return `${summary}\n${formatMcpTable(result.keywords, TERM_COLUMNS)}`;
}

function gapText(result: GapResult): string {
  const summary = `Keyword gaps vs ${channelLabel(result.competitorChannel)}: ${result.gaps.length} gap(s) from ${result.competitor.length} competitor term(s); your channel matched ${result.you.length} term(s).`;
  if (result.gaps.length === 0) {
    return `${summary} No uncovered terms at this threshold.`;
  }
  return `${summary}\n${formatMcpTable(result.gaps, TERM_COLUMNS)}`;
}

function comparisonText(result: ComparisonResult): string {
  const successes: ComparisonSuccessRow[] = [];
  const failures: ComparisonErrorRow[] = [];
  for (const row of result.rows) {
    if (isComparisonError(row)) failures.push(row);
    else successes.push(row);
  }
  const cachedCount = successes.filter((row) => row.cached).length;
  const summary = `Compared ${result.rows.length} keyword(s): ${cachedCount} from the 24h cache, ${successes.length - cachedCount} freshly sampled, ${failures.length} unavailable.`;
  const parts = [summary];
  if (successes.length > 0) {
    parts.push(formatMcpTable(successes, COMPARISON_COLUMNS));
  }
  for (const failure of failures) {
    parts.push(
      `${failure.keyword}: ${failure.error === "no_results" ? "no results found" : "search unavailable"}`,
    );
  }
  return parts.join("\n");
}

const keywordIdeasInputSchema = z.strictObject({
  projectId: projectIdSchema,
  seed: keywordTextSchema.describe(
    "Seed keyword or phrase to expand (1-200 characters).",
  ),
  regionCode: regionCodeSchema,
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(25)
    .describe("Maximum ideas to return. Defaults to 25."),
});
type KeywordIdeasArgs = z.infer<typeof keywordIdeasInputSchema>;

export const getYoutubeKeywordIdeasTool = {
  name: "get_youtube_keyword_ideas",
  config: {
    title: "Get YouTube keyword ideas",
    description:
      "Expand a seed keyword into YouTube keyword ideas: autocomplete suggestions plus terms harvested from the titles and tags of the seed's top-ranking videos. Ideas are phrase suggestions, not search volume or ranked keyword metrics. Read-only and uses no OpenSEO credits; the title/tag harvest spends 100 YouTube quota units.",
    inputSchema: keywordIdeasInputSchema,
    outputSchema: keywordIdeasOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: KeywordIdeasArgs, context) => {
    try {
      const result = await YoutubeKeywordService.getKeywordIdeas({
        projectId: args.projectId,
        userId: context.auth.userId,
        seed: args.seed,
        regionCode: args.regionCode,
        limit: args.limit,
      });
      return mcpResponse({
        text: ideasText(result),
        meta: buildProjectMeta(context, args.projectId),
        structuredContent: { status: "ok", ...result },
      });
    } catch (error) {
      return errorResponse(args, context, error);
    }
  }),
};

const keywordPerformanceInputSchema = z.strictObject({
  projectId: projectIdSchema,
  keyword: keywordTextSchema.describe(
    "Keyword to sample search results for (1-200 characters).",
  ),
  regionCode: regionCodeSchema,
  force: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Set true to ignore the 24-hour cache and re-sample, spending 100 YouTube quota units again. Defaults to false.",
    ),
});
type KeywordPerformanceArgs = z.infer<typeof keywordPerformanceInputSchema>;

export const getYoutubeKeywordPerformanceTool = {
  name: "get_youtube_keyword_performance",
  config: {
    title: "Get YouTube keyword performance",
    description:
      "Sample the top ~25 YouTube search results for a keyword and report their performance — median and average views and median views per day — with the sampled videos. Costs 100 YouTube quota units when not cached; results are cached 24 hours, so repeated calls are free. Set force=true to re-sample. Read-only and uses no OpenSEO credits.",
    inputSchema: keywordPerformanceInputSchema,
    outputSchema: keywordPerformanceOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: KeywordPerformanceArgs, context) => {
    try {
      const result = await YoutubeKeywordService.getKeywordPerformance({
        projectId: args.projectId,
        userId: context.auth.userId,
        keyword: args.keyword,
        regionCode: args.regionCode,
        force: args.force,
      });
      return mcpResponse({
        text: performanceText(result),
        meta: buildProjectMeta(context, args.projectId),
        structuredContent: { status: "ok", ...result },
      });
    } catch (error) {
      return errorResponse(args, context, error);
    }
  }),
};

const highPerformanceKeywordsInputSchema = z.strictObject({
  projectId: projectIdSchema,
  channelId: z
    .string()
    .regex(/^UC[A-Za-z0-9_-]{22}$/)
    .optional()
    .describe(
      "UC channel ID to score. Defaults to the project's connected channel; a channel already tracked for the project also works.",
    ),
  minVideos: z
    .number()
    .int()
    .min(2)
    .max(10)
    .optional()
    .default(2)
    .describe(
      "Minimum number of the channel's sampled uploads a term must appear on. Defaults to 2.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(25)
    .describe("Maximum terms to return. Defaults to 25."),
});
type HighPerformanceKeywordsArgs = z.infer<
  typeof highPerformanceKeywordsInputSchema
>;

export const getYoutubeHighPerformanceKeywordsTool = {
  name: "get_youtube_high_performance_keywords",
  config: {
    title: "Get YouTube high-performance keywords",
    description:
      "Find terms from the titles and tags of a channel's best-performing uploads, scored by the median outlier score of the videos containing them and filtered by how many uploads use them. Defaults to the project's own channel; pass a tracked research channel ID to score another channel. Read-only and uses no OpenSEO credits.",
    inputSchema: highPerformanceKeywordsInputSchema,
    outputSchema: highPerformanceKeywordsOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(
    async (args: HighPerformanceKeywordsArgs, context) => {
      try {
        const result = await YoutubeKeywordService.getHighPerformanceKeywords({
          projectId: args.projectId,
          userId: context.auth.userId,
          channelId: args.channelId,
          minVideos: args.minVideos,
          limit: args.limit,
        });
        return mcpResponse({
          text: highPerformanceText(result),
          meta: buildProjectMeta(context, args.projectId),
          structuredContent: { status: "ok", ...result },
        });
      } catch (error) {
        return errorResponse(args, context, error);
      }
    },
  ),
};

const keywordGapInputSchema = z.strictObject({
  projectId: projectIdSchema,
  competitorChannel: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe(
      "Competitor YouTube channel: full URL, @handle, or UC channel ID.",
    ),
  minVideos: z
    .number()
    .int()
    .min(2)
    .max(10)
    .optional()
    .default(2)
    .describe(
      "Minimum number of a channel's sampled uploads a term must appear on. Defaults to 2.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(25)
    .describe("Maximum gap terms to return. Defaults to 25."),
});
type KeywordGapArgs = z.infer<typeof keywordGapInputSchema>;

export const getYoutubeKeywordGapTool = {
  name: "get_youtube_keyword_gap",
  config: {
    title: "Get YouTube keyword gap",
    description:
      "Find terms a competitor's top uploads use that your channel does not, by scoring both channels' title and tag terms and subtracting the ones you already cover. Accepts a competitor channel URL, @handle, or UC channel ID. Read-only and uses no OpenSEO credits.",
    inputSchema: keywordGapInputSchema,
    outputSchema: keywordGapOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: KeywordGapArgs, context) => {
    try {
      const result = await YoutubeKeywordService.getKeywordGap({
        projectId: args.projectId,
        userId: context.auth.userId,
        competitorChannel: args.competitorChannel,
        minVideos: args.minVideos,
        limit: args.limit,
      });
      return mcpResponse({
        text: gapText(result),
        meta: buildProjectMeta(context, args.projectId),
        structuredContent: { status: "ok", ...result },
      });
    } catch (error) {
      return errorResponse(args, context, error);
    }
  }),
};

const compareKeywordsInputSchema = z.strictObject({
  projectId: projectIdSchema,
  keywords: z
    .array(keywordTextSchema)
    .min(2)
    .max(5)
    .describe("2-5 keywords to compare, each 1-200 characters."),
  regionCode: regionCodeSchema,
});
type CompareKeywordsArgs = z.infer<typeof compareKeywordsInputSchema>;

export const compareYoutubeKeywordsTool = {
  name: "compare_youtube_keywords",
  config: {
    title: "Compare YouTube keywords",
    description:
      "Compare 2-5 keywords side by side using their YouTube search-result performance: median views, median views per day, sample size, and whether each result came from the 24-hour cache. Uncached keywords cost 100 YouTube quota units each; a keyword that cannot be sampled is reported in the text without failing the call. Read-only and uses no OpenSEO credits.",
    inputSchema: compareKeywordsInputSchema,
    outputSchema: keywordComparisonOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: CompareKeywordsArgs, context) => {
    try {
      const result = await YoutubeKeywordService.compareKeywords({
        projectId: args.projectId,
        userId: context.auth.userId,
        keywords: args.keywords,
        regionCode: args.regionCode,
      });
      return mcpResponse({
        text: comparisonText(result),
        meta: buildProjectMeta(context, args.projectId),
        structuredContent: { status: "ok", ...result },
      });
    } catch (error) {
      return errorResponse(args, context, error);
    }
  }),
};

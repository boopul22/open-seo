import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { YoutubeCommunityService } from "@/server/features/youtube/services/YoutubeCommunityService";
import type {
  YoutubeCommentSummary,
  YoutubeVideoSummary,
} from "@/server/lib/youtubeClient";
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
// by a refinement (same shape the other YouTube and GA4 tools use).
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
    code === "youtube_reconnect_required"
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

const videoCommentsInputSchema = z.strictObject({
  projectId: projectIdSchema,
  videoId: z
    .string()
    .describe("YouTube video ID (exactly 11 characters, e.g. dQw4w9WgXcQ)."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(20)
    .describe("Maximum comment threads to return (1-100). Defaults to 20."),
  order: z
    .enum(["relevance", "time"])
    .optional()
    .default("relevance")
    .describe("Sort order for comments. Defaults to relevance."),
});
type VideoCommentsArgs = z.infer<typeof videoCommentsInputSchema>;

const videoCommentsOutputSchema = youtubeEnvelopeSchema({
  videoId: z.string(),
  comments: z.array(looseObjectOutputSchema),
  nextPageToken: z.string().nullable(),
});

const COMMENT_COLUMNS: McpTableColumn<YoutubeCommentSummary>[] = [
  { header: "author", value: (row) => row.authorDisplayName },
  { header: "likes", value: (row) => row.likeCount },
  { header: "snippet", value: (row) => row.text, format: truncatedCell(200) },
  { header: "publishedAt", value: (row) => row.publishedAt },
];

export const getYoutubeVideoCommentsTool = {
  name: "get_youtube_video_comments",
  config: {
    title: "Get YouTube video comments",
    description:
      "Read top-level comments on any YouTube video by ID: author, like count, comment text, and publish date, most relevant or newest first. Requires the project's connected YouTube account. Read-only and uses no OpenSEO credits.",
    inputSchema: videoCommentsInputSchema,
    outputSchema: videoCommentsOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: VideoCommentsArgs, context) => {
    try {
      const result = await YoutubeCommunityService.getVideoComments(args);
      const text =
        result.comments.length > 0
          ? `Comments on video ${result.videoId} (${result.comments.length}, ${args.order} order):\n${formatMcpTable(result.comments, COMMENT_COLUMNS)}`
          : `No comments returned for video ${result.videoId}.`;
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

const searchVideosInputSchema = z.strictObject({
  projectId: projectIdSchema,
  query: z.string().min(1).describe("YouTube search query."),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(25)
    .describe("Maximum results to return (1-50). Defaults to 25."),
  order: z
    .enum(["relevance", "date", "viewCount"])
    .optional()
    .default("relevance")
    .describe("Result ordering. Defaults to relevance."),
});
type SearchVideosArgs = z.infer<typeof searchVideosInputSchema>;

const searchVideosOutputSchema = youtubeEnvelopeSchema({
  query: z.string(),
  results: z.array(looseObjectOutputSchema),
  warnings: z.array(z.string()),
});

const SEARCH_COLUMNS: McpTableColumn<YoutubeVideoSummary>[] = [
  { header: "title", value: (row) => row.title },
  { header: "videoId", value: (row) => row.videoId },
  { header: "publishedAt", value: (row) => row.publishedAt },
  { header: "thumbnailUrl", value: (row) => row.thumbnailUrl },
];

export const searchYoutubeVideosTool = {
  name: "search_youtube_videos",
  config: {
    title: "Search YouTube videos",
    description:
      "Search YouTube for videos matching a query and return video IDs, titles, publish dates, and thumbnails. Costs 100 YouTube quota units per call (search.list), so use it sparingly. Results are search snippets only — no view, like, comment, or duration data. Read-only and uses no OpenSEO credits.",
    inputSchema: searchVideosInputSchema,
    outputSchema: searchVideosOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: SearchVideosArgs, context) => {
    try {
      const result = await YoutubeCommunityService.searchVideos(args);
      const summary = `YouTube search for "${result.query}" (${result.results.length} result(s), ${args.order} order).`;
      const warning =
        result.warnings.length > 0
          ? `\nWarning: ${result.warnings.join("; ")}.`
          : "";
      const text =
        result.results.length > 0
          ? `${summary}${warning}\n${formatMcpTable(result.results, SEARCH_COLUMNS)}`
          : `${summary} No results.${warning}`;
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

const keywordHintsInputSchema = z.strictObject({
  projectId: projectIdSchema,
  query: z.string().min(1).describe("Seed query to autocomplete."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(25)
    .describe("Maximum suggestions to return (1-50). Defaults to 25."),
});
type KeywordHintsArgs = z.infer<typeof keywordHintsInputSchema>;

const keywordHintsOutputSchema = youtubeEnvelopeSchema({
  query: z.string(),
  hints: z.array(z.string()),
  warnings: z.array(z.string()),
});

export const getYoutubeKeywordHintsTool = {
  name: "get_youtube_keyword_hints",
  config: {
    title: "Get YouTube keyword hints",
    description:
      "List YouTube autocomplete suggestions for a seed query. These are YouTube's search-box suggestions — query ideas, not search volume. Best-effort: the public autocomplete endpoint is unauthenticated and unavailable results come back as an empty list with a warning. Read-only and uses no OpenSEO credits.",
    inputSchema: keywordHintsInputSchema,
    outputSchema: keywordHintsOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: KeywordHintsArgs, context) => {
    try {
      const result = await YoutubeCommunityService.getKeywordHints(args);
      const warning =
        result.warnings.length > 0
          ? ` Warning: ${result.warnings.join("; ")}.`
          : "";
      const text =
        result.hints.length > 0
          ? `YouTube autocomplete suggestions for "${result.query}" (${result.hints.length}):${warning}\n${result.hints.map((hint) => `- ${hint}`).join("\n")}`
          : `No YouTube autocomplete suggestions for "${result.query}".${warning}`;
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

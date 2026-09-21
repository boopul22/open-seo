import {
  createYoutubeDataClient,
  type YoutubeCommentSummary,
  type YoutubeVideoSummary,
} from "@/server/lib/youtubeClient";
import {
  asYoutubeReportError,
  YoutubeReportError,
} from "@/server/lib/youtubeErrors";
import {
  clampSuggestLimit,
  parseSuggestBody,
  SUGGEST_URL,
} from "@/server/lib/youtubeSuggest";
import { YoutubeConnectionRepository } from "@/server/features/youtube/repositories/YoutubeConnectionRepository";

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const COMMENT_LIMIT_MAX = 100;
const COMMENT_LIMIT_DEFAULT = 20;
const SEARCH_LIMIT_MAX = 50;
const SEARCH_LIMIT_DEFAULT = 25;
const AUTOCOMPLETE_TIMEOUT_MS = 5_000;
const AUTOCOMPLETE_UNAVAILABLE = "autocomplete_unavailable";

/** search.list is billed at 100 quota units per call, so every caller is told. */
export const SEARCH_QUOTA_WARNING = "search.list costs 100 YouTube quota units";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}

async function withMappedErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw asYoutubeReportError(error);
  }
}

/** Resolve the project's owned connection, then run the operation with a Data
 *  API client bound to it. Community data is public but still needs a grant. */
async function withConnection<T>(
  projectId: string,
  operation: (client: ReturnType<typeof createYoutubeDataClient>) => Promise<T>,
): Promise<T> {
  return withMappedErrors(async () => {
    const connection =
      await YoutubeConnectionRepository.getByProjectId(projectId);
    if (!connection) {
      throw new YoutubeReportError(
        "youtube_not_connected",
        "YouTube is not connected for this project.",
      );
    }
    const client = createYoutubeDataClient({
      userId: connection.connectedByUserId,
      youtubeAccountId: connection.youtubeAccountId,
    });
    return operation(client);
  });
}

function requireVideoId(videoId: string): string {
  const trimmed = videoId.trim();
  if (!VIDEO_ID_PATTERN.test(trimmed)) {
    throw new YoutubeReportError(
      "validation_error",
      "Enter a valid 11-character YouTube video ID.",
    );
  }
  return trimmed;
}

function requireQuery(query: string): string {
  const trimmed = query.trim();
  if (trimmed === "") {
    throw new YoutubeReportError("validation_error", "Enter a search query.");
  }
  return trimmed;
}

async function getVideoComments(input: {
  projectId: string;
  videoId: string;
  limit?: number;
  order?: "relevance" | "time";
}): Promise<{
  videoId: string;
  comments: YoutubeCommentSummary[];
  nextPageToken: string | null;
}> {
  const videoId = requireVideoId(input.videoId);
  return withConnection(input.projectId, async (client) => {
    const { comments, nextPageToken } = await client.listCommentThreads({
      videoId,
      maxResults: clamp(
        input.limit ?? COMMENT_LIMIT_DEFAULT,
        1,
        COMMENT_LIMIT_MAX,
      ),
      order: input.order ?? "relevance",
    });
    return { videoId, comments, nextPageToken };
  });
}

async function searchVideos(input: {
  projectId: string;
  query: string;
  maxResults?: number;
  order?: "relevance" | "date" | "viewCount";
}): Promise<{
  query: string;
  results: YoutubeVideoSummary[];
  warnings: string[];
}> {
  const query = requireQuery(input.query);
  return withConnection(input.projectId, async (client) => {
    const results = await client.searchVideos({
      query,
      maxResults: clamp(
        input.maxResults ?? SEARCH_LIMIT_DEFAULT,
        1,
        SEARCH_LIMIT_MAX,
      ),
      order: input.order ?? "relevance",
    });
    return { query, results, warnings: [SEARCH_QUOTA_WARNING] };
  });
}

/** Public, unauthenticated autocomplete. Best-effort: any network or parse
 *  failure yields no hints plus a warning instead of an error. */
async function getKeywordHints(input: {
  projectId: string;
  query: string;
  limit?: number;
}): Promise<{ query: string; hints: string[]; warnings: string[] }> {
  const query = requireQuery(input.query);
  const limit = clampSuggestLimit(input.limit ?? SEARCH_LIMIT_DEFAULT);

  let body: string;
  try {
    const response = await fetch(SUGGEST_URL(query, limit), {
      signal: AbortSignal.timeout(AUTOCOMPLETE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { query, hints: [], warnings: [AUTOCOMPLETE_UNAVAILABLE] };
    }
    body = await response.text();
  } catch {
    return { query, hints: [], warnings: [AUTOCOMPLETE_UNAVAILABLE] };
  }

  const hints = parseSuggestBody(body);
  if (hints === null) {
    return { query, hints: [], warnings: [AUTOCOMPLETE_UNAVAILABLE] };
  }
  return { query, hints: hints.slice(0, limit), warnings: [] };
}

export const YoutubeCommunityService = {
  getVideoComments,
  searchVideos,
  getKeywordHints,
};

/* eslint-disable max-lines -- one keyword service covers autocomplete ideas, cached search samples, channel term scoring, and gaps */
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { account } from "@/db/schema";
import { AppError } from "@/server/lib/errors";
import {
  createYoutubeDataClient,
  type YoutubeChannel,
  type YoutubeVideoSummary,
} from "@/server/lib/youtubeClient";
import {
  YoutubeDataApiError,
  YoutubeTokenError,
} from "@/server/lib/youtubeErrors";
import { parseSuggestBody, SUGGEST_URL } from "@/server/lib/youtubeSuggest";
import { YOUTUBE_OAUTH_PROVIDER_ID } from "@/shared/youtube";
import {
  YoutubeConnectionRepository,
  type YoutubeConnection,
} from "@/server/features/youtube/repositories/YoutubeConnectionRepository";
import { YoutubeResearchRepository } from "@/server/features/youtube/repositories/YoutubeResearchRepository";
import {
  YoutubeKeywordRepository,
  type KeywordVideoInput,
  type YoutubeKeywordQuery,
  type YoutubeKeywordVideo,
} from "@/server/features/youtube/repositories/YoutubeKeywordRepository";
import {
  computeChannelStats,
  median,
  round2,
  scoreVideo,
  videoAgeDays,
} from "@/server/features/youtube/services/YoutubeOutlierMath";
import {
  extractTerms,
  normalizeKeyword,
  rankGaps,
  scoreTerms,
  type ScoredTerm,
} from "@/server/features/youtube/services/YoutubeKeywordTerms";

export const KEYWORD_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const KEYWORD_SAMPLE_SIZE = 25;
export const MAX_IDEA_SEED_LETTERS = 12;
const AUTOCOMPLETE_ENABLED = true;

const IDEA_SEARCH_SAMPLE_SIZE = 10;
const IDEA_LIMIT_DEFAULT = 25;
const IDEA_LIMIT_MAX = 50;
const KEYWORD_LIMIT_DEFAULT = 25;
const KEYWORD_LIMIT_MAX = 100;
const CHANNEL_UPLOAD_SAMPLE = 100;
const MIN_VIDEOS_PER_TERM = 2;
const AUTOCOMPLETE_TIMEOUT_MS = 5_000;
const DEFAULT_REGION_CODE = "US";

const AUTOCOMPLETE_UNAVAILABLE = "autocomplete_unavailable";
const SEARCH_UNAVAILABLE = "search_unavailable";

const IDEA_SEED_ALPHABET = "abcdefghijklmnopqrstuvwxyz";

const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;
const HANDLE_PATTERN = /^@[A-Za-z0-9._-]{3,30}$/;

export type KeywordIdeaSource = "autocomplete" | "tag" | "title";

export type KeywordIdea = {
  phrase: string;
  source: KeywordIdeaSource;
  position: number;
};

export type KeywordIdeas = {
  seed: string;
  ideas: KeywordIdea[];
  warnings: string[];
};

export type KeywordPerformanceVideo = {
  videoId: string;
  title: string;
  channelId: string;
  channelTitle: string;
  views: number | null;
  publishedAt: string | null;
  durationSeconds: number | null;
  position: number;
  viewsPerDay: number;
};

export type KeywordPerformance = {
  keyword: string;
  regionCode: string;
  capturedAt: string;
  sampleSize: number;
  medianViews: number;
  averageViews: number;
  medianViewsPerDay: number;
  videos: KeywordPerformanceVideo[];
};

export type KeywordChannel = {
  channelId: string;
  channelTitle: string;
  channelHandle: string | null;
  channelThumbnailUrl: string | null;
};

export type HighPerformanceKeywords = {
  channel: KeywordChannel;
  keywords: ScoredTerm[];
};

export type KeywordGap = {
  you: ScoredTerm[];
  competitor: ScoredTerm[];
  gaps: ScoredTerm[];
  competitorChannel: KeywordChannel;
};

export type KeywordComparisonRow =
  | {
      keyword: string;
      capturedAt: string;
      cached: boolean;
      medianViews: number;
      medianViewsPerDay: number;
      sampleSize: number;
    }
  | { keyword: string; error: "no_results" | "unavailable" };

export type KeywordComparison = { rows: KeywordComparisonRow[] };

type YoutubeCredentials = { userId: string; youtubeAccountId: string };

type ChannelRef =
  | { kind: "id"; channelId: string }
  | { kind: "handle"; handle: string };

type YoutubeClient = ReturnType<typeof createYoutubeDataClient>;

type KeywordTarget = {
  channel: KeywordChannel;
  uploadsPlaylistId: string | null;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/** Full URL, @handle, or UC... channel ID — the three ways a user names a channel. */
function parseChannelRef(input: string): ChannelRef | null {
  const value = input.trim();
  if (CHANNEL_ID_PATTERN.test(value)) return { kind: "id", channelId: value };
  if (HANDLE_PATTERN.test(value)) return { kind: "handle", handle: value };

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(?:www|m|music)\./, "");
  if (host !== "youtube.com" && host !== "youtu.be") return null;
  const [first, second] = url.pathname.split("/").filter(Boolean);
  if (first === "channel" && second && CHANNEL_ID_PATTERN.test(second)) {
    return { kind: "id", channelId: second };
  }
  if (first?.startsWith("@") && HANDLE_PATTERN.test(first)) {
    return { kind: "handle", handle: first };
  }
  if ((first === "c" || first === "user") && second) {
    const handle = `@${second}`;
    return HANDLE_PATTERN.test(handle) ? { kind: "handle", handle } : null;
  }
  return null;
}

async function listGrantsForUser(userId: string) {
  return db
    .select({ accountId: account.accountId })
    .from(account)
    .where(
      and(
        eq(account.userId, userId),
        eq(account.providerId, YOUTUBE_OAUTH_PROVIDER_ID),
      ),
    );
}

/** The project's selected channel grant when one exists, otherwise the calling
 *  user's own grant. Public channel data needs a token; either grant can read it. */
async function resolveCredentials(input: {
  projectId: string;
  userId?: string;
}): Promise<YoutubeCredentials> {
  const connection = await YoutubeConnectionRepository.getByProjectId(
    input.projectId,
  );
  if (connection) {
    return {
      userId: connection.connectedByUserId,
      youtubeAccountId: connection.youtubeAccountId,
    };
  }
  if (input.userId) {
    const grants = await listGrantsForUser(input.userId);
    const grant = grants[0];
    if (grant)
      return { userId: input.userId, youtubeAccountId: grant.accountId };
  }
  throw new AppError(
    "VALIDATION_ERROR",
    "Connect a YouTube account before researching channels.",
  );
}

async function resolveChannel(
  client: YoutubeClient,
  ref: ChannelRef,
): Promise<YoutubeChannel | null> {
  return ref.kind === "id"
    ? client.getChannel(ref.channelId)
    : client.getChannelByHandle(ref.handle);
}

function mapUpstreamError(error: unknown): AppError | null {
  if (error instanceof YoutubeTokenError) {
    return new AppError(
      "FORBIDDEN",
      "The YouTube connection has expired. Reconnect the Google account.",
    );
  }
  if (!(error instanceof YoutubeDataApiError)) return null;
  if (error.status === 401) {
    return new AppError(
      "FORBIDDEN",
      "The YouTube connection has expired. Reconnect the Google account.",
    );
  }
  if (error.status === 403) {
    return /quota/i.test(error.upstreamReason ?? "")
      ? new AppError(
          "RATE_LIMITED",
          "The YouTube API quota is exhausted. Try again after it resets.",
        )
      : new AppError("FORBIDDEN", "YouTube denied access to this channel.");
  }
  if (error.status === 429) {
    return new AppError(
      "RATE_LIMITED",
      "YouTube is rate limiting requests. Try again shortly.",
    );
  }
  if (error.status === 400 || error.status === 404) {
    return new AppError("VALIDATION_ERROR", error.message);
  }
  return new AppError(
    "UPSTREAM_UNAVAILABLE",
    "YouTube is temporarily unavailable.",
  );
}

async function withMappedErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AppError) throw error;
    const mapped = mapUpstreamError(error);
    if (mapped) throw mapped;
    throw error;
  }
}

/**
 * Channel identity for a search-result video, read off the video snippet.
 * Empty strings rather than dropping the video when YouTube omits it.
 */
type VideoSummaryWithChannel = YoutubeVideoSummary & {
  channelId?: string | null;
  channelTitle?: string | null;
};

function summaryChannel(summary: YoutubeVideoSummary): {
  channelId: string;
  channelTitle: string;
} {
  const extended: VideoSummaryWithChannel = summary;
  return {
    channelId: extended.channelId ?? "",
    channelTitle: extended.channelTitle ?? "",
  };
}

function channelFromConnection(connection: YoutubeConnection): KeywordChannel {
  return {
    channelId: connection.channelId,
    channelTitle: connection.channelTitle,
    channelHandle: connection.channelHandle,
    channelThumbnailUrl: connection.channelThumbnailUrl,
  };
}

function channelFromYoutube(channel: YoutubeChannel): KeywordChannel {
  return {
    channelId: channel.channelId,
    channelTitle: channel.title,
    channelHandle: channel.handle,
    channelThumbnailUrl: channel.thumbnailUrl,
  };
}

function isFresh(capturedAt: string, now: Date): boolean {
  const capturedMs = Date.parse(capturedAt);
  return (
    Number.isFinite(capturedMs) &&
    now.getTime() - capturedMs < KEYWORD_CACHE_TTL_MS
  );
}

function toPerformanceVideo(
  row: YoutubeKeywordVideo,
  now: Date,
): KeywordPerformanceVideo {
  return {
    videoId: row.videoId,
    title: row.title,
    channelId: row.channelId,
    channelTitle: row.channelTitle,
    views: row.views,
    publishedAt: row.publishedAt,
    durationSeconds: row.durationSeconds,
    position: row.position,
    viewsPerDay: round2((row.views ?? 0) / videoAgeDays(row.publishedAt, now)),
  };
}

function toPerformance(
  row: YoutubeKeywordQuery,
  videos: YoutubeKeywordVideo[],
  now: Date,
): KeywordPerformance {
  return {
    keyword: row.keyword,
    regionCode: row.regionCode,
    capturedAt: row.capturedAt,
    sampleSize: row.sampleSize,
    medianViews: row.medianViews,
    averageViews: row.averageViews,
    medianViewsPerDay: row.medianViewsPerDay,
    videos: videos.map((video) => toPerformanceVideo(video, now)),
  };
}

async function listChannelSummaries(
  client: YoutubeClient,
  uploadsPlaylistId: string,
  maxUploads: number,
): Promise<YoutubeVideoSummary[]> {
  const videoIds = await client.listUploadedVideoIds(
    uploadsPlaylistId,
    maxUploads,
  );
  const summaryById = await client.listVideoSummaries(videoIds);
  return videoIds
    .map((videoId) => summaryById.get(videoId))
    .filter((summary): summary is YoutubeVideoSummary => summary !== undefined);
}

/** Score one channel's newest uploads into ranked keyword terms. One sample
 *  feeds both the baseline and the per-video scores, mirroring the research
 *  service's sampling. */
async function scoreChannelTerms(
  client: YoutubeClient,
  uploadsPlaylistId: string | null,
  now: Date,
): Promise<ScoredTerm[]> {
  if (!uploadsPlaylistId) return [];
  const summaries = await listChannelSummaries(
    client,
    uploadsPlaylistId,
    CHANNEL_UPLOAD_SAMPLE,
  );
  const stats = computeChannelStats(
    summaries.map((summary) => ({
      views: summary.viewCount,
      publishedAt: summary.publishedAt,
    })),
    now,
  );
  return scoreTerms(
    summaries.map((summary) => ({
      videoId: summary.videoId,
      terms: extractTerms({ title: summary.title, tags: summary.tags }),
      outlierScore: scoreVideo(
        { views: summary.viewCount, publishedAt: summary.publishedAt },
        stats,
        now,
      ).outlierScore,
      views: summary.viewCount,
    })),
  );
}

/** The owned connection, else a tracked research channel, else the owned
 *  connection by default — the same resolution order as the research service. */
async function resolveTargetChannel(
  projectId: string,
  channelId: string | undefined,
): Promise<KeywordTarget> {
  const connection =
    await YoutubeConnectionRepository.getByProjectId(projectId);
  if (channelId) {
    if (connection?.channelId === channelId) {
      return {
        channel: channelFromConnection(connection),
        uploadsPlaylistId: connection.uploadsPlaylistId,
      };
    }
    const stored = await YoutubeResearchRepository.getByProjectAndChannel(
      projectId,
      channelId,
    );
    if (stored) {
      return {
        channel: {
          channelId: stored.channelId,
          channelTitle: stored.channelTitle,
          channelHandle: stored.channelHandle,
          channelThumbnailUrl: stored.channelThumbnailUrl,
        },
        uploadsPlaylistId: stored.uploadsPlaylistId,
      };
    }
    throw new AppError(
      "NOT_FOUND",
      "That channel isn't tracked for this project.",
    );
  }
  if (!connection) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Connect a YouTube account before researching channels.",
    );
  }
  return {
    channel: channelFromConnection(connection),
    uploadsPlaylistId: connection.uploadsPlaylistId,
  };
}

async function liveUploadsPlaylistId(
  client: YoutubeClient,
  channelId: string,
  known: string | null,
): Promise<string | null> {
  if (known) return known;
  const channel = await client.getChannel(channelId);
  return channel?.uploadsPlaylistId ?? null;
}

/** Public, unauthenticated autocomplete. Best-effort: any network or parse
 *  failure yields no hints plus a warning instead of an error. */
async function fetchSuggestions(
  query: string,
  limit: number,
): Promise<string[] | null> {
  try {
    const response = await fetch(SUGGEST_URL(query, limit), {
      signal: AbortSignal.timeout(AUTOCOMPLETE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return parseSuggestBody(await response.text());
  } catch {
    return null;
  }
}

async function collectAutocomplete(
  seed: string,
  limit: number,
): Promise<{ suggestions: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  if (!AUTOCOMPLETE_ENABLED) return { suggestions: [], warnings };

  const letters = IDEA_SEED_ALPHABET.slice(0, MAX_IDEA_SEED_LETTERS).split("");
  const suggestions: string[] = [];
  let unavailable = false;
  for (const query of [seed, ...letters.map((letter) => `${seed} ${letter}`)]) {
    const hints = await fetchSuggestions(query, limit);
    if (hints === null) {
      unavailable = true;
      continue;
    }
    suggestions.push(...hints);
  }
  if (unavailable) warnings.push(AUTOCOMPLETE_UNAVAILABLE);
  return { suggestions, warnings };
}

/** Quota note: the search step costs 100 YouTube quota units, and only runs
 *  when autocomplete ideas are being enriched with tag/title phrases. */
async function harvestSearchPhrases(input: {
  projectId: string;
  userId?: string;
  seed: string;
  regionCode: string;
}): Promise<{ tags: string[]; titles: string[] }> {
  const credentials = await resolveCredentials(input);
  const client = createYoutubeDataClient(credentials);
  const videoIds = await client.searchVideoIds({
    query: input.seed,
    maxResults: IDEA_SEARCH_SAMPLE_SIZE,
    regionCode: input.regionCode,
  });
  if (videoIds.length === 0) return { tags: [], titles: [] };
  const summaryById = await client.listVideoSummaries(videoIds);
  const summaries = videoIds
    .map((videoId) => summaryById.get(videoId))
    .filter((summary): summary is YoutubeVideoSummary => summary !== undefined);
  return {
    tags: summaries.flatMap((summary) =>
      extractTerms({ title: "", tags: summary.tags }),
    ),
    titles: summaries.flatMap((summary) =>
      extractTerms({ title: summary.title }),
    ),
  };
}

async function getKeywordIdeas(input: {
  projectId: string;
  userId?: string;
  seed: string;
  regionCode?: string;
  limit?: number;
}): Promise<KeywordIdeas> {
  const seed = normalizeKeyword(input.seed);
  if (seed === "") {
    throw new AppError("VALIDATION_ERROR", "Enter a keyword to research.");
  }
  const limit = clamp(input.limit ?? IDEA_LIMIT_DEFAULT, 1, IDEA_LIMIT_MAX);
  const regionCode = (input.regionCode ?? DEFAULT_REGION_CODE).toUpperCase();

  const autocomplete = await collectAutocomplete(seed, limit);
  const warnings = [...autocomplete.warnings];

  const candidates: { phrase: string; source: KeywordIdeaSource }[] = [];
  const add = (phrase: string, source: KeywordIdeaSource) => {
    const normalized = normalizeKeyword(phrase);
    if (normalized !== "") candidates.push({ phrase: normalized, source });
  };
  for (const suggestion of autocomplete.suggestions) {
    add(suggestion, "autocomplete");
  }

  try {
    const harvested = await harvestSearchPhrases({
      projectId: input.projectId,
      userId: input.userId,
      seed,
      regionCode,
    });
    for (const term of harvested.tags) add(term, "tag");
    for (const term of harvested.titles) add(term, "title");
  } catch {
    warnings.push(SEARCH_UNAVAILABLE);
  }

  // Autocomplete suggestions win ties, then tags, then titles; the position is
  // the phrase's first slot in the deduped list.
  const seen = new Set<string>();
  const ideas: KeywordIdea[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.phrase)) continue;
    seen.add(candidate.phrase);
    ideas.push({
      phrase: candidate.phrase,
      source: candidate.source,
      position: ideas.length,
    });
    if (ideas.length >= limit) break;
  }
  return { seed, ideas, warnings };
}

async function resolveKeywordPerformance(input: {
  projectId: string;
  userId?: string;
  keyword: string;
  regionCode: string;
  force?: boolean;
}): Promise<{ performance: KeywordPerformance; cached: boolean }> {
  const now = new Date();
  if (!input.force) {
    const cached = await YoutubeKeywordRepository.getQuery(
      input.keyword,
      input.regionCode,
    );
    if (cached && isFresh(cached.capturedAt, now)) {
      const videos = await YoutubeKeywordRepository.listVideos(cached.id);
      return { performance: toPerformance(cached, videos, now), cached: true };
    }
  }

  const credentials = await resolveCredentials(input);
  const client = createYoutubeDataClient(credentials);
  const videoIds = await client.searchVideoIds({
    query: input.keyword,
    maxResults: KEYWORD_SAMPLE_SIZE,
    regionCode: input.regionCode,
  });
  if (videoIds.length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "YouTube returned no videos for that keyword.",
    );
  }
  const summaryById = await client.listVideoSummaries(videoIds);
  const videos: KeywordPerformanceVideo[] = [];
  videoIds.forEach((videoId, position) => {
    const summary = summaryById.get(videoId);
    if (!summary) return;
    const channel = summaryChannel(summary);
    videos.push({
      videoId,
      title: summary.title,
      channelId: channel.channelId,
      channelTitle: channel.channelTitle,
      views: summary.viewCount,
      publishedAt: summary.publishedAt,
      durationSeconds: summary.durationSeconds,
      position,
      viewsPerDay: round2(
        (summary.viewCount ?? 0) / videoAgeDays(summary.publishedAt, now),
      ),
    });
  });
  if (videos.length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "YouTube returned no videos for that keyword.",
    );
  }

  const viewValues = videos.map((video) => video.views ?? 0);
  const sample = {
    keyword: input.keyword,
    regionCode: input.regionCode,
    capturedAt: now.toISOString(),
    sampleSize: videos.length,
    medianViews: Math.round(median(viewValues)),
    averageViews: Math.round(
      viewValues.reduce((sum, views) => sum + views, 0) / videos.length,
    ),
    medianViewsPerDay: Math.round(
      median(videos.map((video) => video.viewsPerDay)),
    ),
  };
  const rows: KeywordVideoInput[] = videos.map((video) => ({
    videoId: video.videoId,
    title: video.title,
    channelId: video.channelId,
    channelTitle: video.channelTitle,
    views: video.views,
    publishedAt: video.publishedAt,
    durationSeconds: video.durationSeconds,
    position: video.position,
  }));
  const row = await YoutubeKeywordRepository.replaceQuery({
    ...sample,
    videos: rows,
  });
  return {
    performance: { ...sample, capturedAt: row.capturedAt, videos },
    cached: false,
  };
}

async function getKeywordPerformance(input: {
  projectId: string;
  userId?: string;
  keyword: string;
  regionCode?: string;
  force?: boolean;
}): Promise<KeywordPerformance> {
  return withMappedErrors(async () => {
    const keyword = normalizeKeyword(input.keyword);
    if (keyword === "") {
      throw new AppError("VALIDATION_ERROR", "Enter a keyword to research.");
    }
    const regionCode = (input.regionCode ?? DEFAULT_REGION_CODE).toUpperCase();
    const { performance } = await resolveKeywordPerformance({
      projectId: input.projectId,
      userId: input.userId,
      keyword,
      regionCode,
      force: input.force,
    });
    return performance;
  });
}

async function getHighPerformanceKeywords(input: {
  projectId: string;
  userId?: string;
  channelId?: string;
  minVideos?: number;
  limit?: number;
}): Promise<HighPerformanceKeywords> {
  return withMappedErrors(async () => {
    const limit = clamp(
      input.limit ?? KEYWORD_LIMIT_DEFAULT,
      1,
      KEYWORD_LIMIT_MAX,
    );
    const minVideos = Math.max(
      input.minVideos ?? MIN_VIDEOS_PER_TERM,
      MIN_VIDEOS_PER_TERM,
    );
    const target = await resolveTargetChannel(input.projectId, input.channelId);
    const credentials = await resolveCredentials(input);
    const client = createYoutubeDataClient(credentials);
    const uploadsPlaylistId = await liveUploadsPlaylistId(
      client,
      target.channel.channelId,
      target.uploadsPlaylistId,
    );
    const now = new Date();
    const keywords = (await scoreChannelTerms(client, uploadsPlaylistId, now))
      .filter((term) => term.videoCount >= minVideos)
      .slice(0, limit);
    return { channel: target.channel, keywords };
  });
}

async function getKeywordGap(input: {
  projectId: string;
  userId?: string;
  competitorChannel: string;
  minVideos?: number;
  limit?: number;
}): Promise<KeywordGap> {
  return withMappedErrors(async () => {
    const limit = clamp(
      input.limit ?? KEYWORD_LIMIT_DEFAULT,
      1,
      KEYWORD_LIMIT_MAX,
    );
    const minVideos = Math.max(
      input.minVideos ?? MIN_VIDEOS_PER_TERM,
      MIN_VIDEOS_PER_TERM,
    );
    const ref = parseChannelRef(input.competitorChannel);
    if (!ref) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Enter a YouTube channel URL, @handle, or channel ID.",
      );
    }
    const connection = await YoutubeConnectionRepository.getByProjectId(
      input.projectId,
    );
    if (!connection) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Connect a YouTube account before researching channels.",
      );
    }

    const credentials = await resolveCredentials(input);
    const client = createYoutubeDataClient(credentials);
    const competitor = await resolveChannel(client, ref);
    if (!competitor) {
      throw new AppError(
        "NOT_FOUND",
        "That YouTube channel could not be found.",
      );
    }

    const now = new Date();
    const you = await scoreChannelTerms(
      client,
      await liveUploadsPlaylistId(
        client,
        connection.channelId,
        connection.uploadsPlaylistId,
      ),
      now,
    );
    const rival = await scoreChannelTerms(
      client,
      competitor.uploadsPlaylistId,
      now,
    );
    return {
      you: you.filter((term) => term.videoCount >= minVideos).slice(0, limit),
      competitor: rival
        .filter((term) => term.videoCount >= minVideos)
        .slice(0, limit),
      gaps: rankGaps(you, rival, minVideos).slice(0, limit),
      competitorChannel: channelFromYoutube(competitor),
    };
  });
}

async function compareKeywords(input: {
  projectId: string;
  userId?: string;
  keywords: string[];
  regionCode?: string;
}): Promise<KeywordComparison> {
  const regionCode = (input.regionCode ?? DEFAULT_REGION_CODE).toUpperCase();
  const rows: KeywordComparisonRow[] = [];
  for (const value of input.keywords) {
    const keyword = normalizeKeyword(value);
    if (keyword === "") {
      rows.push({ keyword: value.trim(), error: "no_results" });
      continue;
    }
    try {
      const { performance, cached } = await resolveKeywordPerformance({
        projectId: input.projectId,
        userId: input.userId,
        keyword,
        regionCode,
      });
      rows.push({
        keyword: performance.keyword,
        capturedAt: performance.capturedAt,
        cached,
        medianViews: performance.medianViews,
        medianViewsPerDay: performance.medianViewsPerDay,
        sampleSize: performance.sampleSize,
      });
    } catch (error) {
      rows.push({
        keyword,
        error:
          error instanceof AppError && error.code === "VALIDATION_ERROR"
            ? "no_results"
            : "unavailable",
      });
    }
  }
  return { rows };
}

export const YoutubeKeywordService = {
  getKeywordIdeas,
  getKeywordPerformance,
  getHighPerformanceKeywords,
  getKeywordGap,
  compareKeywords,
};

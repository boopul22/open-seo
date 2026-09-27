/* eslint-disable max-lines -- one research service covers channel resolution, sampling, scoring, snapshots, and comparisons */
import { and, eq } from "drizzle-orm";
import { sort } from "remeda";
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
import { YOUTUBE_OAUTH_PROVIDER_ID } from "@/shared/youtube";
import {
  YoutubeConnectionRepository,
  type YoutubeConnection,
} from "@/server/features/youtube/repositories/YoutubeConnectionRepository";
import {
  YoutubeResearchRepository,
  type YoutubeResearchChannel,
} from "@/server/features/youtube/repositories/YoutubeResearchRepository";
import {
  computeChannelStats,
  round2,
  scoreVideo,
  type YoutubeChannelVideoStats,
} from "@/server/features/youtube/services/YoutubeOutlierMath";

export const MAX_RESEARCH_CHANNELS = 20;
/** Uploads sampled per channel when a caller does not ask for more. */
const DEFAULT_SAMPLE_SIZE = 30;
const getChannelSampleSize = DEFAULT_SAMPLE_SIZE;

// Refresh samples deeper than interactive lists: a snapshot is only as useful
// as the uploads it covers, and 200 is two API pages of 50-video batches.
const MAX_REFRESH_UPLOADS = 200;
const MAX_LIST_UPLOADS = 100;
const UPLOADS_LAST_30_DAYS = 30;
const OUTLIER_SCORE_THRESHOLD = 2;
const DEFAULT_WINDOW_DAYS = 180;
const DEFAULT_OUTLIER_LIMIT = 25;
const DEFAULT_MIN_OUTLIER_SCORE = 1.5;
const DEFAULT_TRENDING_LIMIT = 25;
const MAX_COMPARE_CHANNELS = 5;
const VPH_MIN_WINDOW_HOURS = 1;
const MS_PER_DAY = 86_400_000;
const HOURS_PER_MS = 1 / 3_600_000;

const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;
const HANDLE_PATTERN = /^@[A-Za-z0-9._-]{3,30}$/;

export type ResearchChannelRow = {
  id: string;
  channelId: string;
  channelTitle: string;
  channelHandle: string | null;
  channelThumbnailUrl: string | null;
  subscriberCount: number | null;
  videoCount: number | null;
  viewCount: number | null;
  lastRefreshedAt: string | null;
};

export type VideoRow = {
  videoId: string;
  title: string;
  publishedAt: string | null;
  ageDays: number;
  views: number | null;
  likes: number | null;
  comments: number | null;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  viewsPerDay: number;
  outlierScore: number;
  velocityScore: number;
  vph: number | null;
};

export type OutlierRow = VideoRow & {
  channelId: string;
  channelTitle: string;
};

export type ResearchChannelSummary = {
  id: string | null;
  channelId: string;
  channelTitle: string;
  channelHandle: string | null;
  channelThumbnailUrl: string | null;
  subscriberCount: number | null;
  videoCount: number | null;
  viewCount: number | null;
  lastRefreshedAt: string | null;
};

export type ChannelComparisonRow = {
  channel: ResearchChannelSummary;
  subscriberCount: number | null;
  videoCount: number | null;
  viewCount: number | null;
  uploadsLast30Days: number;
  medianViews: number;
  outlierCount: number;
  topVideo: { videoId: string; title: string; views: number | null } | null;
};

type YoutubeCredentials = { userId: string; youtubeAccountId: string };

type ChannelRef =
  | { kind: "id"; channelId: string }
  | { kind: "handle"; handle: string };

type ChannelSample = {
  summaries: YoutubeVideoSummary[];
  stats: YoutubeChannelVideoStats;
};

type ScoringTarget = {
  channelId: string;
  uploadsPlaylistId: string | null;
  summary: ResearchChannelSummary;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function toResearchChannelRow(row: YoutubeResearchChannel): ResearchChannelRow {
  return {
    id: row.id,
    channelId: row.channelId,
    channelTitle: row.channelTitle,
    channelHandle: row.channelHandle,
    channelThumbnailUrl: row.channelThumbnailUrl,
    subscriberCount: row.subscriberCount,
    videoCount: row.videoCount,
    viewCount: row.viewCount,
    lastRefreshedAt: row.lastRefreshedAt,
  };
}

function summaryFromResearchChannel(
  row: YoutubeResearchChannel,
): ResearchChannelSummary {
  return { ...toResearchChannelRow(row) };
}

function summaryFromYoutubeChannel(
  channel: YoutubeChannel,
): ResearchChannelSummary {
  return {
    id: null,
    channelId: channel.channelId,
    channelTitle: channel.title,
    channelHandle: channel.handle,
    channelThumbnailUrl: channel.thumbnailUrl,
    subscriberCount: channel.subscriberCount,
    videoCount: channel.videoCount,
    viewCount: channel.viewCount,
    lastRefreshedAt: null,
  };
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
  client: ReturnType<typeof createYoutubeDataClient>,
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

/** Newest uploads summarized and baselined. One sample serves both the channel
 *  stats and the per-video scores so a row can never disagree with its stats. */
async function sampleChannelUploads(
  client: ReturnType<typeof createYoutubeDataClient>,
  uploadsPlaylistId: string,
  maxUploads: number,
  now: Date,
): Promise<ChannelSample> {
  const videoIds = await client.listUploadedVideoIds(
    uploadsPlaylistId,
    maxUploads,
  );
  const summaryById = await client.listVideoSummaries(videoIds);
  const summaries = videoIds
    .map((videoId) => summaryById.get(videoId))
    .filter((summary): summary is YoutubeVideoSummary => summary !== undefined);
  const stats = computeChannelStats(
    summaries.map((summary) => ({
      views: summary.viewCount,
      publishedAt: summary.publishedAt,
    })),
    now,
  );
  return { summaries, stats };
}

function toVideoRows(
  summaries: YoutubeVideoSummary[],
  stats: YoutubeChannelVideoStats,
  now: Date,
): VideoRow[] {
  return summaries.map((summary) => {
    const score = scoreVideo(
      { views: summary.viewCount, publishedAt: summary.publishedAt },
      stats,
      now,
    );
    return {
      videoId: summary.videoId,
      title: summary.title,
      publishedAt: summary.publishedAt,
      ageDays: score.ageDays,
      views: summary.viewCount,
      likes: summary.likeCount,
      comments: summary.commentCount,
      durationSeconds: summary.durationSeconds,
      thumbnailUrl: summary.thumbnailUrl,
      viewsPerDay: score.viewsPerDay,
      outlierScore: score.outlierScore,
      velocityScore: score.velocityScore,
      vph: null,
    };
  });
}

function withinWindow(
  publishedAt: string | null,
  now: Date,
  windowDays: number,
): boolean {
  if (!publishedAt) return false;
  const publishedMs = Date.parse(publishedAt);
  return (
    Number.isFinite(publishedMs) &&
    publishedMs >= now.getTime() - windowDays * MS_PER_DAY
  );
}

function byViewsDesc(a: VideoRow, b: VideoRow): number {
  return (b.views ?? -1) - (a.views ?? -1);
}

function byPublishedDesc(a: VideoRow, b: VideoRow): number {
  return (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");
}

function byOutlierDesc(a: VideoRow, b: VideoRow): number {
  return b.outlierScore - a.outlierScore;
}

function sortVideoRows(
  rows: VideoRow[],
  sortKey: "views" | "newest" | "outlier",
): VideoRow[] {
  if (sortKey === "newest") return sort(rows, byPublishedDesc);
  if (sortKey === "outlier") return sort(rows, byOutlierDesc);
  return sort(rows, byViewsDesc);
}

/** Views/hour from the two most recent stored snapshots: null until a video has
 *  two readings at least an hour apart, so a same-run pair never fakes velocity. */
function computeVph(
  snapshots: { capturedAt: string; viewCount: number | null }[],
): number | null {
  if (snapshots.length < 2) return null;
  const mostRecentFirst = sort(snapshots, (a, b) =>
    b.capturedAt.localeCompare(a.capturedAt),
  );
  const [newest, previous] = mostRecentFirst;
  const newestMs = Date.parse(newest.capturedAt);
  const previousMs = Date.parse(previous.capturedAt);
  if (!Number.isFinite(newestMs) || !Number.isFinite(previousMs)) return null;
  const hours = (newestMs - previousMs) * HOURS_PER_MS;
  if (hours < VPH_MIN_WINDOW_HOURS) return null;
  return round2(((newest.viewCount ?? 0) - (previous.viewCount ?? 0)) / hours);
}

async function attachVelocity<T extends { videoId: string }>(
  videos: T[],
): Promise<Array<T & { vph: number | null }>> {
  if (videos.length === 0) return [];
  const snapshots = await YoutubeResearchRepository.listRecentVideoSnapshots(
    videos.map((video) => video.videoId),
  );
  const byVideo = new Map<
    string,
    { capturedAt: string; viewCount: number | null }[]
  >();
  for (const snapshot of snapshots) {
    const existing = byVideo.get(snapshot.videoId);
    if (existing) existing.push(snapshot);
    else byVideo.set(snapshot.videoId, [snapshot]);
  }
  return videos.map((video) => ({
    ...video,
    vph: computeVph(byVideo.get(video.videoId) ?? []),
  }));
}

function targetFromResearchChannel(row: YoutubeResearchChannel): ScoringTarget {
  return {
    channelId: row.channelId,
    uploadsPlaylistId: row.uploadsPlaylistId,
    summary: summaryFromResearchChannel(row),
  };
}

function targetFromConnection(connection: YoutubeConnection): ScoringTarget {
  return {
    channelId: connection.channelId,
    uploadsPlaylistId: connection.uploadsPlaylistId,
    summary: {
      id: null,
      channelId: connection.channelId,
      channelTitle: connection.channelTitle,
      channelHandle: connection.channelHandle,
      channelThumbnailUrl: connection.channelThumbnailUrl,
      subscriberCount: null,
      videoCount: null,
      viewCount: null,
      lastRefreshedAt: null,
    },
  };
}

async function listScoringTargets(
  projectId: string,
  channelId: string | undefined,
): Promise<ScoringTarget[]> {
  const connection =
    await YoutubeConnectionRepository.getByProjectId(projectId);
  if (channelId) {
    const stored = await YoutubeResearchRepository.getByProjectAndChannel(
      projectId,
      channelId,
    );
    if (stored) return [targetFromResearchChannel(stored)];
    if (connection?.channelId === channelId) {
      return [targetFromConnection(connection)];
    }
    throw new AppError(
      "NOT_FOUND",
      "That channel isn't tracked for this project.",
    );
  }
  const stored = await YoutubeResearchRepository.listByProject(projectId);
  const targets = stored.map(targetFromResearchChannel);
  if (
    connection &&
    !targets.some((target) => target.channelId === connection.channelId)
  ) {
    targets.push(targetFromConnection(connection));
  }
  return targets;
}

async function addResearchChannel(input: {
  projectId: string;
  organizationId: string;
  channel: string;
  userId: string;
}): Promise<ResearchChannelRow> {
  return withMappedErrors(async () => {
    const ref = parseChannelRef(input.channel);
    if (!ref) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Enter a YouTube channel URL, @handle, or channel ID.",
      );
    }
    const credentials = await resolveCredentials(input);
    const resolved = await resolveChannel(
      createYoutubeDataClient(credentials),
      ref,
    );
    if (!resolved) {
      throw new AppError(
        "NOT_FOUND",
        "That YouTube channel could not be found.",
      );
    }

    const existing = await YoutubeResearchRepository.getByProjectAndChannel(
      input.projectId,
      resolved.channelId,
    );
    if (!existing) {
      const tracked = await YoutubeResearchRepository.countByProject(
        input.projectId,
      );
      if (tracked >= MAX_RESEARCH_CHANNELS) {
        throw new AppError(
          "VALIDATION_ERROR",
          `You can track up to ${MAX_RESEARCH_CHANNELS} channels per project.`,
        );
      }
    }

    const capturedAt = new Date().toISOString();
    const row = await YoutubeResearchRepository.upsert({
      projectId: input.projectId,
      organizationId: input.organizationId,
      channelId: resolved.channelId,
      channelTitle: resolved.title,
      channelHandle: resolved.handle,
      channelThumbnailUrl: resolved.thumbnailUrl,
      uploadsPlaylistId: resolved.uploadsPlaylistId,
      subscriberCount: resolved.subscriberCount,
      videoCount: resolved.videoCount,
      viewCount: resolved.viewCount,
      lastRefreshedAt: capturedAt,
      addedByUserId: input.userId,
    });
    await YoutubeResearchRepository.insertChannelSnapshot({
      channelId: resolved.channelId,
      subscriberCount: resolved.subscriberCount,
      videoCount: resolved.videoCount,
      viewCount: resolved.viewCount,
      capturedAt,
    });
    return toResearchChannelRow(row);
  });
}

async function removeResearchChannel(input: {
  projectId: string;
  channelId: string;
}): Promise<void> {
  await YoutubeResearchRepository.deleteByProjectAndChannel(
    input.projectId,
    input.channelId,
  );
}

async function listResearchChannels(
  projectId: string,
): Promise<ResearchChannelRow[]> {
  const rows = await YoutubeResearchRepository.listByProject(projectId);
  const sorted = sort(rows, (a, b) => {
    if (a.subscriberCount !== b.subscriberCount) {
      if (a.subscriberCount === null) return 1;
      if (b.subscriberCount === null) return -1;
      return b.subscriberCount - a.subscriberCount;
    }
    return a.channelTitle.localeCompare(b.channelTitle);
  });
  return sorted.map(toResearchChannelRow);
}

async function refreshResearchChannels(input: {
  projectId: string;
  userId?: string;
}): Promise<{ channels: ResearchChannelRow[]; refreshedAt: string }> {
  return withMappedErrors(async () => {
    const stored = await YoutubeResearchRepository.listByProject(
      input.projectId,
    );
    const refreshedAt = new Date().toISOString();
    if (stored.length === 0) return { channels: [], refreshedAt };

    const credentials = await resolveCredentials(input);
    const client = createYoutubeDataClient(credentials);
    const updated = await Promise.all(
      stored.map(async (row) => {
        if (!row.uploadsPlaylistId) return row;
        const fresh = await client.getChannel(row.channelId);
        const videoIds = await client.listUploadedVideoIds(
          row.uploadsPlaylistId,
          MAX_REFRESH_UPLOADS,
        );
        const summaryById = await client.listVideoSummaries(videoIds);
        const summaries = videoIds
          .map((videoId) => summaryById.get(videoId))
          .filter(
            (summary): summary is YoutubeVideoSummary => summary !== undefined,
          );

        const saved = await YoutubeResearchRepository.updateStats({
          id: row.id,
          channelTitle: fresh?.title ?? row.channelTitle,
          channelHandle: fresh?.handle ?? row.channelHandle,
          channelThumbnailUrl: fresh?.thumbnailUrl ?? row.channelThumbnailUrl,
          uploadsPlaylistId: fresh?.uploadsPlaylistId ?? row.uploadsPlaylistId,
          subscriberCount: fresh?.subscriberCount ?? row.subscriberCount,
          videoCount: fresh?.videoCount ?? row.videoCount,
          viewCount: fresh?.viewCount ?? row.viewCount,
          lastRefreshedAt: refreshedAt,
        });
        await YoutubeResearchRepository.insertChannelSnapshot({
          channelId: row.channelId,
          subscriberCount: saved.subscriberCount,
          videoCount: saved.videoCount,
          viewCount: saved.viewCount,
          capturedAt: refreshedAt,
        });
        await YoutubeResearchRepository.insertVideoSnapshots(
          summaries.map((summary) => ({
            channelId: row.channelId,
            videoId: summary.videoId,
            viewCount: summary.viewCount,
            likeCount: summary.likeCount,
            commentCount: summary.commentCount,
            capturedAt: refreshedAt,
          })),
        );
        return saved;
      }),
    );
    return { channels: updated.map(toResearchChannelRow), refreshedAt };
  });
}

async function listChannelVideos(input: {
  projectId: string;
  channelId: string;
  limit?: number;
  sort?: "views" | "newest" | "outlier";
  userId?: string;
}): Promise<{
  channel: ResearchChannelSummary;
  stats: YoutubeChannelVideoStats;
  videos: VideoRow[];
}> {
  return withMappedErrors(async () => {
    const now = new Date();
    const limit = clamp(input.limit ?? 50, 1, 200);
    const stored = await YoutubeResearchRepository.getByProjectAndChannel(
      input.projectId,
      input.channelId,
    );
    const connection = await YoutubeConnectionRepository.getByProjectId(
      input.projectId,
    );
    let channel: ResearchChannelSummary;
    let uploadsPlaylistId: string | null;
    if (stored) {
      channel = summaryFromResearchChannel(stored);
      uploadsPlaylistId = stored.uploadsPlaylistId;
    } else if (connection?.channelId === input.channelId) {
      channel = targetFromConnection(connection).summary;
      uploadsPlaylistId = connection.uploadsPlaylistId;
    } else {
      throw new AppError(
        "NOT_FOUND",
        "That channel isn't tracked for this project.",
      );
    }

    const credentials = await resolveCredentials(input);
    const client = createYoutubeDataClient(credentials);
    if (!uploadsPlaylistId) {
      const live = await client.getChannel(input.channelId);
      uploadsPlaylistId = live?.uploadsPlaylistId ?? null;
    }
    if (!uploadsPlaylistId) {
      return { channel, stats: computeChannelStats([]), videos: [] };
    }

    const sample = await sampleChannelUploads(
      client,
      uploadsPlaylistId,
      MAX_LIST_UPLOADS,
      now,
    );
    const rows = sortVideoRows(
      toVideoRows(sample.summaries, sample.stats, now),
      input.sort ?? "views",
    );
    return {
      channel,
      stats: sample.stats,
      videos: await attachVelocity(rows.slice(0, limit)),
    };
  });
}

async function getOutliers(input: {
  projectId: string;
  channelId?: string;
  windowDays?: number;
  limit?: number;
  minScore?: number;
  userId?: string;
}): Promise<OutlierRow[]> {
  return withMappedErrors(async () => {
    const now = new Date();
    const windowDays = input.windowDays ?? DEFAULT_WINDOW_DAYS;
    const limit = clamp(input.limit ?? DEFAULT_OUTLIER_LIMIT, 1, 100);
    const minScore = input.minScore ?? DEFAULT_MIN_OUTLIER_SCORE;
    const targets = await listScoringTargets(input.projectId, input.channelId);
    if (targets.length === 0) return [];

    const credentials = await resolveCredentials(input);
    const client = createYoutubeDataClient(credentials);
    const perChannel = await Promise.all(
      targets.map(async (target) => {
        if (!target.uploadsPlaylistId) return [] as OutlierRow[];
        const sample = await sampleChannelUploads(
          client,
          target.uploadsPlaylistId,
          MAX_LIST_UPLOADS,
          now,
        );
        return toVideoRows(sample.summaries, sample.stats, now)
          .filter(
            (video) =>
              withinWindow(video.publishedAt, now, windowDays) &&
              video.outlierScore >= minScore,
          )
          .map((video) => ({
            ...video,
            channelId: target.summary.channelId,
            channelTitle: target.summary.channelTitle,
          }));
      }),
    );
    const sorted = sort(
      perChannel.flat(),
      (a, b) => b.outlierScore - a.outlierScore,
    );
    return attachVelocity(sorted.slice(0, limit));
  });
}

async function getChannelStats(input: {
  projectId: string;
  channel: string;
  userId?: string;
}): Promise<
  YoutubeChannelVideoStats & {
    channel: ResearchChannelSummary;
    recentVideos: VideoRow[];
  }
> {
  return withMappedErrors(async () => {
    const ref = parseChannelRef(input.channel);
    if (!ref) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Enter a YouTube channel URL, @handle, or channel ID.",
      );
    }
    const credentials = await resolveCredentials(input);
    const client = createYoutubeDataClient(credentials);
    const channel = await resolveChannel(client, ref);
    if (!channel) {
      throw new AppError(
        "NOT_FOUND",
        "That YouTube channel could not be found.",
      );
    }
    const now = new Date();
    const sample = channel.uploadsPlaylistId
      ? await sampleChannelUploads(
          client,
          channel.uploadsPlaylistId,
          getChannelSampleSize,
          now,
        )
      : { summaries: [], stats: computeChannelStats([]) };
    return {
      channel: summaryFromYoutubeChannel(channel),
      ...sample.stats,
      recentVideos: await attachVelocity(
        toVideoRows(sample.summaries, sample.stats, now),
      ),
    };
  });
}

async function compareChannels(input: {
  projectId: string;
  channels: string[];
  windowDays?: number;
  userId?: string;
}): Promise<ChannelComparisonRow[]> {
  return withMappedErrors(async () => {
    const refs: ChannelRef[] = [];
    for (const value of input.channels.slice(0, MAX_COMPARE_CHANNELS)) {
      const ref = parseChannelRef(value);
      if (!ref) {
        throw new AppError(
          "VALIDATION_ERROR",
          "Enter a YouTube channel URL, @handle, or channel ID.",
        );
      }
      refs.push(ref);
    }
    if (refs.length === 0) return [];

    const windowDays = input.windowDays ?? DEFAULT_WINDOW_DAYS;
    const credentials = await resolveCredentials(input);
    const client = createYoutubeDataClient(credentials);
    const now = new Date();
    return await Promise.all(
      refs.map(async (ref): Promise<ChannelComparisonRow> => {
        const channel = await resolveChannel(client, ref);
        if (!channel) {
          throw new AppError(
            "NOT_FOUND",
            "That YouTube channel could not be found.",
          );
        }
        const sample = channel.uploadsPlaylistId
          ? await sampleChannelUploads(
              client,
              channel.uploadsPlaylistId,
              getChannelSampleSize,
              now,
            )
          : { summaries: [], stats: computeChannelStats([]) };
        const scored = toVideoRows(sample.summaries, sample.stats, now);
        const topVideo = scored.reduce<VideoRow | null>(
          (best, video) =>
            best === null || (video.views ?? -1) > (best.views ?? -1)
              ? video
              : best,
          null,
        );
        return {
          channel: summaryFromYoutubeChannel(channel),
          subscriberCount: channel.subscriberCount,
          videoCount: channel.videoCount,
          viewCount: channel.viewCount,
          uploadsLast30Days: scored.filter((video) =>
            withinWindow(video.publishedAt, now, UPLOADS_LAST_30_DAYS),
          ).length,
          medianViews: sample.stats.medianViews,
          outlierCount: scored.filter(
            (video) =>
              withinWindow(video.publishedAt, now, windowDays) &&
              video.outlierScore >= OUTLIER_SCORE_THRESHOLD,
          ).length,
          topVideo: topVideo
            ? {
                videoId: topVideo.videoId,
                title: topVideo.title,
                views: topVideo.views,
              }
            : null,
        };
      }),
    );
  });
}

// The client's mostPopular rows carry no channel baseline, so trending videos
// are scored against the chart's own median to keep the shared VideoRow shape.
async function getTrendingVideos(input: {
  projectId: string;
  regionCode?: string;
  videoCategoryId?: string;
  limit?: number;
  userId?: string;
}): Promise<VideoRow[]> {
  return withMappedErrors(async () => {
    const credentials = await resolveCredentials(input);
    const client = createYoutubeDataClient(credentials);
    const now = new Date();
    const summaries = await client.listMostPopular({
      regionCode: input.regionCode ?? "US",
      videoCategoryId: input.videoCategoryId,
      maxResults: clamp(input.limit ?? DEFAULT_TRENDING_LIMIT, 1, 50),
    });
    const stats = computeChannelStats(
      summaries.map((summary) => ({
        views: summary.viewCount,
        publishedAt: summary.publishedAt,
      })),
      now,
    );
    return attachVelocity(toVideoRows(summaries, stats, now));
  });
}

export const YoutubeResearchService = {
  addResearchChannel,
  removeResearchChannel,
  listResearchChannels,
  refreshResearchChannels,
  listChannelVideos,
  getOutliers,
  getChannelStats,
  compareChannels,
  getTrendingVideos,
};

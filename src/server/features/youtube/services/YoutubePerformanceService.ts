/* eslint-disable max-lines -- one performance service covers trends, growth, publish days, and playlists */
import { and, eq } from "drizzle-orm";
import { sort } from "remeda";
import { db } from "@/db";
import { account } from "@/db/schema";
import { AppError } from "@/server/lib/errors";
import {
  createYoutubeDataClient,
  type YoutubeAnalyticsRow,
  type YoutubePlaylistSummary,
  type YoutubeVideoSummary,
} from "@/server/lib/youtubeClient";
import {
  YoutubeAnalyticsApiError,
  YoutubeDataApiError,
  YoutubeReportError,
  YoutubeTokenError,
} from "@/server/lib/youtubeErrors";
import { YOUTUBE_OAUTH_PROVIDER_ID } from "@/shared/youtube";
import { getReportContext } from "@/server/features/youtube/services/YoutubeAnalyticsService";
import {
  latestCompleteYoutubeDate,
  shiftYoutubeDate,
} from "@/server/features/youtube/services/YoutubeDates";
import { round2 } from "@/server/features/youtube/services/YoutubeOutlierMath";
import { YoutubeConnectionRepository } from "@/server/features/youtube/repositories/YoutubeConnectionRepository";
import {
  YoutubeResearchRepository,
  type YoutubeChannelSnapshot,
  type YoutubeVideoSnapshot,
} from "@/server/features/youtube/repositories/YoutubeResearchRepository";

export const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;
const DEFAULT_TREND_DAYS = 90;
const MAX_TREND_DAYS = 365;
// One channel snapshot per refresh, so a year of daily refreshes fits.
const CHANNEL_SNAPSHOT_SERIES_LIMIT = 365;
const PUBLISH_DAYS_WINDOW_DAYS = 90;
const PUBLISH_DAYS_SAMPLE_UPLOADS = 100;
const DEFAULT_PLAYLIST_RESULTS = 25;
const MAX_PLAYLIST_RESULTS = 50;
const VPH_MIN_WINDOW_HOURS = 1;
const MS_PER_DAY = 86_400_000;
const HOURS_PER_MS = 1 / 3_600_000;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export type YoutubeWeekday = (typeof WEEKDAYS)[number];

export type YoutubeVideoTrendPoint = {
  capturedAt: string;
  viewCount: number | null;
  deltaViews: number | null;
  hoursSincePrevious: number | null;
  vph: number | null;
};

export type YoutubeChannelGrowthPoint = {
  capturedAt: string;
  subscriberCount: number | null;
  videoCount: number | null;
  viewCount: number | null;
  deltaSubscribers: number | null;
  deltaViews: number | null;
};

export type YoutubePublishDay = {
  weekday: YoutubeWeekday;
  views: number;
  estimatedMinutesWatched: number;
  uploads: number;
  averageViewsPerUpload: number | null;
};

type YoutubeCredentials = { userId: string; youtubeAccountId: string };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function parseMs(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function assertVideoId(videoId: string): void {
  if (!YOUTUBE_VIDEO_ID_PATTERN.test(videoId)) {
    throw new YoutubeReportError(
      "validation_error",
      "Enter a valid 11-character YouTube video ID.",
    );
  }
}

function assertChannelId(channelId: string): void {
  if (!YOUTUBE_CHANNEL_ID_PATTERN.test(channelId)) {
    throw new YoutubeReportError(
      "validation_error",
      "Enter a valid UC-prefixed YouTube channel ID.",
    );
  }
}

function weekdayIndexFromIsoDate(value: string): number | null {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date.getUTCDay();
}

function weekdayIndexFromTimestamp(value: string | null): number | null {
  if (!value) return null;
  const ms = parseMs(value);
  return ms === null ? null : new Date(ms).getUTCDay();
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
 *  user's own grant. Public channel reads need a token; either grant can. */
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

function mapUpstreamError(error: unknown): AppError | null {
  if (error instanceof YoutubeTokenError) {
    return new AppError(
      "FORBIDDEN",
      "The YouTube connection has expired. Reconnect the Google account.",
    );
  }
  if (
    error instanceof YoutubeDataApiError ||
    error instanceof YoutubeAnalyticsApiError
  ) {
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
      error instanceof YoutubeAnalyticsApiError
        ? "YouTube reporting is temporarily unavailable."
        : "YouTube is temporarily unavailable.",
    );
  }
  return null;
}

async function withMappedErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AppError || error instanceof YoutubeReportError) {
      throw error;
    }
    const mapped = mapUpstreamError(error);
    if (mapped) throw mapped;
    throw error;
  }
}

type SnapshotReading = { capturedAt: string; viewCount: number | null };

/** Deltas and velocity between two consecutive readings. A missing view count
 *  nulls the delta; a gap under an hour nulls only the velocity. */
function nextTrendStep(
  previous: SnapshotReading,
  current: SnapshotReading,
): {
  deltaViews: number | null;
  hoursSincePrevious: number | null;
  vph: number | null;
} {
  const currentMs = parseMs(current.capturedAt);
  const previousMs = parseMs(previous.capturedAt);
  if (currentMs === null || previousMs === null || currentMs <= previousMs) {
    return { deltaViews: null, hoursSincePrevious: null, vph: null };
  }
  const hoursSincePrevious = round2((currentMs - previousMs) * HOURS_PER_MS);
  if (current.viewCount === null || previous.viewCount === null) {
    return { deltaViews: null, hoursSincePrevious, vph: null };
  }
  const deltaViews = current.viewCount - previous.viewCount;
  return {
    deltaViews,
    hoursSincePrevious,
    vph:
      hoursSincePrevious >= VPH_MIN_WINDOW_HOURS
        ? round2(deltaViews / hoursSincePrevious)
        : null,
  };
}

function buildVideoTrendPoints(
  snapshots: YoutubeVideoSnapshot[],
): YoutubeVideoTrendPoint[] {
  const points: YoutubeVideoTrendPoint[] = [];
  let previous: SnapshotReading | null = null;
  for (const snapshot of snapshots) {
    const current: SnapshotReading = {
      capturedAt: snapshot.capturedAt,
      viewCount: snapshot.viewCount,
    };
    const step = previous
      ? nextTrendStep(previous, current)
      : { deltaViews: null, hoursSincePrevious: null, vph: null };
    points.push({ ...current, ...step });
    previous = current;
  }
  return points;
}

function buildChannelGrowthPoints(
  snapshots: YoutubeChannelSnapshot[],
): YoutubeChannelGrowthPoint[] {
  const ascending = sort(snapshots, (a, b) =>
    a.capturedAt.localeCompare(b.capturedAt),
  );
  const points: YoutubeChannelGrowthPoint[] = [];
  let previous: YoutubeChannelSnapshot | null = null;
  for (const snapshot of ascending) {
    const deltaSubscribers =
      previous?.subscriberCount != null && snapshot.subscriberCount != null
        ? snapshot.subscriberCount - previous.subscriberCount
        : null;
    const deltaViews =
      previous?.viewCount != null && snapshot.viewCount != null
        ? snapshot.viewCount - previous.viewCount
        : null;
    points.push({
      capturedAt: snapshot.capturedAt,
      subscriberCount: snapshot.subscriberCount,
      videoCount: snapshot.videoCount,
      viewCount: snapshot.viewCount,
      deltaSubscribers,
      deltaViews,
    });
    previous = snapshot;
  }
  return points;
}

async function sampleRecentUploads(
  client: ReturnType<typeof createYoutubeDataClient>,
  connection: { channelId: string; uploadsPlaylistId: string | null },
): Promise<YoutubeVideoSummary[]> {
  let uploadsPlaylistId = connection.uploadsPlaylistId;
  if (!uploadsPlaylistId) {
    const channel = await client.getChannel(connection.channelId);
    uploadsPlaylistId = channel?.uploadsPlaylistId ?? null;
  }
  if (!uploadsPlaylistId) return [];
  const videoIds = await client.listUploadedVideoIds(
    uploadsPlaylistId,
    PUBLISH_DAYS_SAMPLE_UPLOADS,
  );
  const summaryById = await client.listVideoSummaries(videoIds);
  return videoIds
    .map((videoId) => summaryById.get(videoId))
    .filter((summary): summary is YoutubeVideoSummary => summary !== undefined);
}

/** Join Analytics watch totals with the sampled uploads, both bucketed by the
 *  UTC weekday of their day/publish timestamp. */
function aggregatePublishDays(
  analyticsRows: YoutubeAnalyticsRow[],
  uploads: YoutubeVideoSummary[],
): YoutubePublishDay[] {
  const buckets = WEEKDAYS.map((weekday) => ({
    weekday,
    views: 0,
    estimatedMinutesWatched: 0,
    uploads: 0,
    uploadViews: [] as number[],
  }));
  for (const row of analyticsRows) {
    const day = typeof row.day === "string" ? row.day : null;
    const index = day ? weekdayIndexFromIsoDate(day) : null;
    if (index === null) continue;
    const bucket = buckets[index];
    if (typeof row.views === "number") bucket.views += row.views;
    if (typeof row.estimatedMinutesWatched === "number") {
      bucket.estimatedMinutesWatched += row.estimatedMinutesWatched;
    }
  }
  for (const upload of uploads) {
    const index = weekdayIndexFromTimestamp(upload.publishedAt);
    if (index === null) continue;
    const bucket = buckets[index];
    bucket.uploads += 1;
    bucket.uploadViews.push(upload.viewCount ?? 0);
  }
  return buckets.map((bucket) => ({
    weekday: bucket.weekday,
    views: round2(bucket.views),
    estimatedMinutesWatched: round2(bucket.estimatedMinutesWatched),
    uploads: bucket.uploads,
    averageViewsPerUpload:
      bucket.uploads > 0
        ? round2(
            bucket.uploadViews.reduce((sum, value) => sum + value, 0) /
              bucket.uploads,
          )
        : null,
  }));
}

function pickBestDay(rows: YoutubePublishDay[]): YoutubeWeekday | null {
  let best: YoutubePublishDay | null = null;
  for (const row of rows) {
    if (row.views <= 0) continue;
    if (!best || row.views > best.views) best = row;
  }
  return best?.weekday ?? null;
}

type YoutubeVideoTrend = {
  videoId: string;
  points: YoutubeVideoTrendPoint[];
  warnings: string[];
};

/** Views over time for one video's stored snapshots, with per-step deltas and
 *  views/hour. Snapshots only exist while the project keeps refreshing its
 *  research channels, so a thin series is expected, not an error. */
async function getVideoTrend(input: {
  projectId: string;
  videoId: string;
  days?: number;
}): Promise<YoutubeVideoTrend> {
  return withMappedErrors(async () => {
    assertVideoId(input.videoId);
    const days = clamp(input.days ?? DEFAULT_TREND_DAYS, 1, MAX_TREND_DAYS);
    const sinceIso = new Date(Date.now() - days * MS_PER_DAY).toISOString();
    const snapshots = await YoutubeResearchRepository.listVideoSnapshotSeries(
      input.videoId,
      sinceIso,
    );
    const points = buildVideoTrendPoints(snapshots);
    return {
      videoId: input.videoId,
      points,
      warnings: points.length < 2 ? ["insufficient_snapshots"] : [],
    };
  });
}

export type YoutubeChannelGrowth = {
  channel: { channelId: string; channelTitle: string };
  points: YoutubeChannelGrowthPoint[];
  warnings: string[];
};

/** Subscriber/view growth from the channel snapshots written by research
 *  refreshes; defaults to the project's connected channel. */
async function getChannelGrowth(input: {
  projectId: string;
  channelId?: string;
}): Promise<YoutubeChannelGrowth> {
  return withMappedErrors(async () => {
    if (input.channelId) assertChannelId(input.channelId);
    const connection = await YoutubeConnectionRepository.getByProjectId(
      input.projectId,
    );
    let channelId: string;
    let channelTitle: string;
    if (input.channelId) {
      if (connection?.channelId === input.channelId) {
        channelId = connection.channelId;
        channelTitle = connection.channelTitle;
      } else {
        const tracked = await YoutubeResearchRepository.getByProjectAndChannel(
          input.projectId,
          input.channelId,
        );
        if (!tracked) {
          throw new AppError(
            "NOT_FOUND",
            "That channel isn't tracked for this project.",
          );
        }
        channelId = tracked.channelId;
        channelTitle = tracked.channelTitle;
      }
    } else {
      if (!connection) {
        throw new YoutubeReportError(
          "youtube_not_connected",
          "YouTube is not connected for this project.",
        );
      }
      channelId = connection.channelId;
      channelTitle = connection.channelTitle;
    }
    const snapshots = await YoutubeResearchRepository.listChannelSnapshots(
      channelId,
      CHANNEL_SNAPSHOT_SERIES_LIMIT,
    );
    const points = buildChannelGrowthPoints(snapshots);
    return {
      channel: { channelId, channelTitle },
      points,
      warnings: points.length < 2 ? ["insufficient_snapshots"] : [],
    };
  });
}

type YoutubeBestPublishDays = {
  channel: { channelId: string; channelTitle: string };
  range: { startDate: string; endDate: string };
  weekdays: YoutubePublishDay[];
  bestDay: YoutubeWeekday | null;
  notes: string[];
};

/** Owned channel only: audience watch activity by weekday (YouTube Analytics)
 *  joined with the channel's own upload cadence. This is not a cross-channel
 *  "best time to post" benchmark — it describes when this audience already
 *  watches. */
async function getBestPublishDays(input: {
  projectId: string;
}): Promise<YoutubeBestPublishDays> {
  return withMappedErrors(async () => {
    const { connection, data, analytics } = await getReportContext(
      input.projectId,
    );
    const endDate = latestCompleteYoutubeDate();
    const startDate = shiftYoutubeDate(
      endDate,
      -(PUBLISH_DAYS_WINDOW_DAYS - 1),
    );
    const [report, uploads] = await Promise.all([
      analytics.runReport({
        startDate,
        endDate,
        metrics: ["views", "estimatedMinutesWatched"],
        dimensions: ["day"],
        sort: "day",
      }),
      sampleRecentUploads(data, connection),
    ]);
    const weekdays = aggregatePublishDays(report.rows, uploads);
    return {
      channel: {
        channelId: connection.channelId,
        channelTitle: connection.channelTitle,
      },
      range: { startDate, endDate },
      weekdays,
      bestDay: pickBestDay(weekdays),
      notes: [
        `Watch activity reflects when YOUR channel's existing audience watches (${startDate} to ${endDate} of YouTube Analytics), not a cross-channel "best time to post" benchmark.`,
        `Upload counts and views per upload cover the most recent ${PUBLISH_DAYS_SAMPLE_UPLOADS} uploads on the connected channel.`,
        "Weekdays use UTC dates; YouTube Analytics rows follow the channel's own reporting timezone, so activity near midnight can land on an adjacent weekday.",
      ],
    };
  });
}

async function listPlaylistsForChannel(input: {
  projectId: string;
  channelId?: string;
  mine?: boolean;
  maxResults?: number;
  userId?: string;
}): Promise<{
  channelId: string | null;
  playlists: YoutubePlaylistSummary[];
}> {
  return withMappedErrors(async () => {
    if (input.channelId) assertChannelId(input.channelId);
    const maxResults = clamp(
      input.maxResults ?? DEFAULT_PLAYLIST_RESULTS,
      1,
      MAX_PLAYLIST_RESULTS,
    );
    if (!input.channelId && input.mine === false) {
      throw new YoutubeReportError(
        "validation_error",
        "Provide a channelId or set mine to true.",
      );
    }
    const credentials = await resolveCredentials(input);
    const client = createYoutubeDataClient(credentials);
    if (input.channelId) {
      const playlists = await client.listPlaylists({
        channelId: input.channelId,
        maxResults,
      });
      return { channelId: input.channelId, playlists };
    }
    const connection = await YoutubeConnectionRepository.getByProjectId(
      input.projectId,
    );
    const playlists = await client.listPlaylists({ mine: true, maxResults });
    return { channelId: connection?.channelId ?? null, playlists };
  });
}

export const YoutubePerformanceService = {
  getVideoTrend,
  getChannelGrowth,
  getBestPublishDays,
  listPlaylistsForChannel,
};

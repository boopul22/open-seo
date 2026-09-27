import type {
  YoutubeAnalyticsReport,
  YoutubeAnalyticsRow,
} from "@/server/lib/youtubeClient";
import {
  asYoutubeReportError,
  YoutubeReportError,
} from "@/server/lib/youtubeErrors";
import { getReportContext } from "@/server/features/youtube/services/YoutubeAnalyticsService";
import { resolveYoutubeRange } from "@/server/features/youtube/services/YoutubeDates";

export const YOUTUBE_AUDIENCE_DIMENSIONS = [
  "country",
  "ageGroup",
  "gender",
  "deviceType",
  "subscribedStatus",
] as const;

export type YoutubeAudienceDimension =
  (typeof YOUTUBE_AUDIENCE_DIMENSIONS)[number];

type YoutubeAudienceChannel = {
  channelId: string;
  channelTitle: string;
  channelHandle: string | null;
  thumbnailUrl: string | null;
};

export type YoutubeAudienceRow = Record<string, string | number | null>;

export type YoutubeRetentionPoint = {
  ratio: number;
  audienceWatchRatio: number | null;
  relativeRetentionPerformance: number | null;
};

type YoutubeAudienceRequest = {
  resolvedRange: { startDate: string; endDate: string };
  warnings: string[];
  videoId?: string;
  dimension?: YoutubeAudienceDimension;
  metrics?: string[];
  detail?: boolean;
};

type YoutubeAudienceReport = {
  source: "youtube_analytics_api";
  channel: YoutubeAudienceChannel;
  request: YoutubeAudienceRequest;
  rows: YoutubeAudienceRow[];
};

type YoutubeVideoRetentionReport = YoutubeAudienceReport & {
  videoId: string;
  averageViewPercentage: number | null;
  views: number | null;
  points: YoutubeRetentionPoint[];
};

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const MAX_AUDIENCE_ROWS = 200;
const RETENTION_MAX_POINTS = 100;

const AUDIENCE_DIMENSION_METRICS: Record<
  YoutubeAudienceDimension,
  readonly string[]
> = {
  country: ["views", "estimatedMinutesWatched"],
  ageGroup: ["viewerPercentage"],
  gender: ["viewerPercentage"],
  deviceType: ["views", "estimatedMinutesWatched"],
  subscribedStatus: ["views", "estimatedMinutesWatched"],
};

const PLAYBACK_LOCATION_METRICS = [
  "views",
  "estimatedMinutesWatched",
  "averageViewDuration",
] as const;

const PLAYBACK_LOCATION_DETAIL_METRICS = [
  "views",
  "estimatedMinutesWatched",
] as const;

async function withMappedErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw asYoutubeReportError(error);
  }
}

function channelRef(connection: {
  channelId: string;
  channelTitle: string;
  channelHandle: string | null;
  channelThumbnailUrl: string | null;
}): YoutubeAudienceChannel {
  return {
    channelId: connection.channelId,
    channelTitle: connection.channelTitle,
    channelHandle: connection.channelHandle,
    thumbnailUrl: connection.channelThumbnailUrl,
  };
}

function requireVideoId(videoId: string): string {
  if (!VIDEO_ID_PATTERN.test(videoId)) {
    throw new YoutubeReportError(
      "validation_error",
      `"${videoId}" is not a valid YouTube video id.`,
    );
  }
  return videoId;
}

function clampRows(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? 25, 1), MAX_AUDIENCE_ROWS);
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function toFiniteNumber(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The retention curve arrives as one row per bucket; rows without a numeric
 *  ratio are not chartable, and every value is rounded to 4 decimals so the
 *  UI/user sees a stable number. */
function retentionPoints(
  report: YoutubeAnalyticsReport,
): YoutubeRetentionPoint[] {
  const points: YoutubeRetentionPoint[] = [];
  for (const row of report.rows) {
    const ratio = toFiniteNumber(row.elapsedVideoTimeRatio);
    if (ratio === null) continue;
    const audienceWatchRatio = toFiniteNumber(row.audienceWatchRatio);
    const relativeRetentionPerformance = toFiniteNumber(
      row.relativeRetentionPerformance,
    );
    points.push({
      ratio: round4(ratio),
      audienceWatchRatio:
        audienceWatchRatio === null ? null : round4(audienceWatchRatio),
      relativeRetentionPerformance:
        relativeRetentionPerformance === null
          ? null
          : round4(relativeRetentionPerformance),
    });
  }
  return points;
}

function audienceSort(dimension: YoutubeAudienceDimension): string {
  return dimension === "ageGroup" || dimension === "gender"
    ? "-viewerPercentage"
    : "-views";
}

function breakdownRow(
  dimension: YoutubeAudienceDimension,
  row: YoutubeAnalyticsRow,
): YoutubeAudienceRow {
  const mapped: YoutubeAudienceRow = {
    [dimension]: typeof row[dimension] === "string" ? row[dimension] : null,
  };
  if (dimension === "ageGroup" || dimension === "gender") {
    mapped.viewerPercentage = toFiniteNumber(row.viewerPercentage);
    return mapped;
  }
  mapped.views = toFiniteNumber(row.views);
  mapped.estimatedMinutesWatched = toFiniteNumber(row.estimatedMinutesWatched);
  return mapped;
}

/** Average retention curve for one video plus its average view percentage. */
async function getVideoRetention(input: {
  projectId: string;
  videoId: string;
}) {
  return withMappedErrors(async () => {
    const videoId = requireVideoId(input.videoId);
    const { connection, analytics } = await getReportContext(input.projectId);
    const range = resolveYoutubeRange({});
    const filters = `video==${videoId}`;
    const [retention, totals] = await Promise.all([
      analytics.runReport({
        startDate: range.startDate,
        endDate: range.endDate,
        metrics: [
          "audienceWatchRatio",
          "relativeRetentionPerformance",
          "totalSegmentImpressions",
        ],
        dimensions: ["elapsedVideoTimeRatio"],
        filters,
        sort: "elapsedVideoTimeRatio",
        maxResults: RETENTION_MAX_POINTS,
      }),
      analytics.runReport({
        startDate: range.startDate,
        endDate: range.endDate,
        metrics: ["averageViewPercentage", "views"],
        filters,
      }),
    ]);
    const points = retentionPoints(retention);
    const totalsRow = totals.rows[0] ?? {};
    const averageViewPercentage = toFiniteNumber(
      totalsRow.averageViewPercentage,
    );
    const result: YoutubeVideoRetentionReport = {
      source: "youtube_analytics_api",
      channel: channelRef(connection),
      request: {
        resolvedRange: {
          startDate: range.startDate,
          endDate: range.endDate,
        },
        videoId,
        warnings: range.warnings,
      },
      videoId,
      averageViewPercentage:
        averageViewPercentage === null ? null : round4(averageViewPercentage),
      views: toFiniteNumber(totalsRow.views),
      points,
      rows: points,
    };
    return result;
  });
}

/** Audience composition for one dimension (country, age, gender, device,
 *  subscriber status). */
async function getAudienceBreakdown(input: {
  projectId: string;
  dimension: YoutubeAudienceDimension;
  limit?: number;
}) {
  return withMappedErrors(async () => {
    const { connection, analytics } = await getReportContext(input.projectId);
    const range = resolveYoutubeRange({});
    const metrics = [...AUDIENCE_DIMENSION_METRICS[input.dimension]];
    const report = await analytics.runReport({
      startDate: range.startDate,
      endDate: range.endDate,
      metrics,
      dimensions: [input.dimension],
      sort: audienceSort(input.dimension),
      maxResults: clampRows(input.limit),
    });
    const result: YoutubeAudienceReport = {
      source: "youtube_analytics_api",
      channel: channelRef(connection),
      request: {
        resolvedRange: {
          startDate: range.startDate,
          endDate: range.endDate,
        },
        dimension: input.dimension,
        metrics,
        warnings: range.warnings,
      },
      rows: report.rows.map((row) => breakdownRow(input.dimension, row)),
    };
    return result;
  });
}

/** Where playback happened: the location type, or per-type detail rows. */
async function getPlaybackLocations(input: {
  projectId: string;
  limit?: number;
  detail?: boolean;
}) {
  return withMappedErrors(async () => {
    const { connection, analytics } = await getReportContext(input.projectId);
    const range = resolveYoutubeRange({});
    const detail = input.detail ?? false;
    const report = await analytics.runReport({
      startDate: range.startDate,
      endDate: range.endDate,
      metrics: [
        ...(detail
          ? PLAYBACK_LOCATION_DETAIL_METRICS
          : PLAYBACK_LOCATION_METRICS),
      ],
      dimensions: detail
        ? ["insightPlaybackLocationType", "insightPlaybackLocationDetail"]
        : ["insightPlaybackLocationType"],
      sort: "-views",
      maxResults: detail ? MAX_AUDIENCE_ROWS : clampRows(input.limit),
    });
    const result: YoutubeAudienceReport = {
      source: "youtube_analytics_api",
      channel: channelRef(connection),
      request: {
        resolvedRange: {
          startDate: range.startDate,
          endDate: range.endDate,
        },
        detail,
        warnings: range.warnings,
      },
      rows: report.rows.map((row) => ({
        playbackLocation:
          typeof row.insightPlaybackLocationType === "string"
            ? row.insightPlaybackLocationType
            : null,
        playbackLocationDetail:
          typeof row.insightPlaybackLocationDetail === "string"
            ? row.insightPlaybackLocationDetail
            : null,
        views: toFiniteNumber(row.views),
        estimatedMinutesWatched: toFiniteNumber(row.estimatedMinutesWatched),
        averageViewDuration: toFiniteNumber(row.averageViewDuration),
      })),
    };
    return result;
  });
}

/** Traffic sources for one video. */
async function getVideoTraffic(input: {
  projectId: string;
  videoId: string;
  limit?: number;
}) {
  return withMappedErrors(async () => {
    const videoId = requireVideoId(input.videoId);
    const { connection, analytics } = await getReportContext(input.projectId);
    const range = resolveYoutubeRange({});
    const report = await analytics.runReport({
      startDate: range.startDate,
      endDate: range.endDate,
      metrics: [...PLAYBACK_LOCATION_METRICS],
      dimensions: ["insightTrafficSourceType"],
      filters: `video==${videoId}`,
      sort: "-views",
      maxResults: clampRows(input.limit),
    });
    const result: YoutubeAudienceReport = {
      source: "youtube_analytics_api",
      channel: channelRef(connection),
      request: {
        resolvedRange: {
          startDate: range.startDate,
          endDate: range.endDate,
        },
        videoId,
        warnings: range.warnings,
      },
      rows: report.rows.map((row) => ({
        trafficSource:
          typeof row.insightTrafficSourceType === "string"
            ? row.insightTrafficSourceType
            : null,
        views: toFiniteNumber(row.views),
        estimatedMinutesWatched: toFiniteNumber(row.estimatedMinutesWatched),
        averageViewDuration: toFiniteNumber(row.averageViewDuration),
      })),
    };
    return result;
  });
}

export const YoutubeAudienceService = {
  getVideoRetention,
  getAudienceBreakdown,
  getPlaybackLocations,
  getVideoTraffic,
};

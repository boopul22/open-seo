import {
  createYoutubeAnalyticsClient,
  createYoutubeDataClient,
  type YoutubeAnalyticsRow,
  type YoutubeVideoSummary,
} from "@/server/lib/youtubeClient";
import {
  asYoutubeReportError,
  YoutubeReportError,
} from "@/server/lib/youtubeErrors";
import { YoutubeConnectionRepository } from "@/server/features/youtube/repositories/YoutubeConnectionRepository";
import {
  resolveYoutubeRange,
  shiftYoutubeDate,
  type YoutubeResolvedRange,
} from "@/server/features/youtube/services/YoutubeDates";

export const YOUTUBE_OVERVIEW_METRICS = [
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

const YOUTUBE_TREND_METRICS = [
  "views",
  "estimatedMinutesWatched",
  "subscribersGained",
  "subscribersLost",
] as const;

const YOUTUBE_VIDEO_METRICS = [
  "views",
  "estimatedMinutesWatched",
  "averageViewDuration",
  "averageViewPercentage",
  "subscribersGained",
  "likes",
  "comments",
] as const;

const YOUTUBE_TRAFFIC_SOURCE_METRICS = [
  "views",
  "estimatedMinutesWatched",
  "averageViewDuration",
] as const;

const MAX_TOP_VIDEOS = 200;

export type YoutubeChannelRef = {
  channelId: string;
  channelTitle: string;
  channelHandle: string | null;
  thumbnailUrl: string | null;
};

function channelRef(connection: {
  channelId: string;
  channelTitle: string;
  channelHandle: string | null;
  channelThumbnailUrl: string | null;
}): YoutubeChannelRef {
  return {
    channelId: connection.channelId,
    channelTitle: connection.channelTitle,
    channelHandle: connection.channelHandle,
    thumbnailUrl: connection.channelThumbnailUrl,
  };
}

function firstRow(rows: YoutubeAnalyticsRow[]): YoutubeAnalyticsRow | null {
  return rows[0] ?? null;
}

/** YouTube Analytics omits days with no activity; the chart needs them. */
function zeroFillTrend(
  rows: YoutubeAnalyticsRow[],
  range: { startDate: string; endDate: string },
): Array<{
  date: string;
  views: number;
  estimatedMinutesWatched: number;
  subscribersGained: number;
  subscribersLost: number;
}> {
  const byDate = new Map<string, YoutubeAnalyticsRow>();
  for (const row of rows) {
    if (typeof row.day === "string") byDate.set(row.day, row);
  }
  const days: Array<{
    date: string;
    views: number;
    estimatedMinutesWatched: number;
    subscribersGained: number;
    subscribersLost: number;
  }> = [];
  for (
    let date = range.startDate;
    date <= range.endDate;
    date = shiftYoutubeDate(date, 1)
  ) {
    const row = byDate.get(date);
    days.push({
      date,
      views: typeof row?.views === "number" ? row.views : 0,
      estimatedMinutesWatched:
        typeof row?.estimatedMinutesWatched === "number"
          ? row.estimatedMinutesWatched
          : 0,
      subscribersGained:
        typeof row?.subscribersGained === "number" ? row.subscribersGained : 0,
      subscribersLost:
        typeof row?.subscribersLost === "number" ? row.subscribersLost : 0,
    });
  }
  return days;
}

export async function getReportContext(projectId: string) {
  const connection =
    await YoutubeConnectionRepository.getByProjectId(projectId);
  if (!connection) {
    throw new YoutubeReportError(
      "youtube_not_connected",
      "YouTube is not connected for this project.",
    );
  }
  const clientOptions = {
    userId: connection.connectedByUserId,
    youtubeAccountId: connection.youtubeAccountId,
  };
  return {
    connection,
    data: createYoutubeDataClient(clientOptions),
    analytics: createYoutubeAnalyticsClient({
      ...clientOptions,
      channelId: connection.channelId,
    }),
  };
}

async function withMappedErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw asYoutubeReportError(error);
  }
}

export type YoutubeRangeInput = {
  projectId: string;
  startDate?: string;
  endDate?: string;
};

/** Live channel header: subscriber/video/view totals straight from the Data API. */
async function getChannelInfo(input: { projectId: string }) {
  return withMappedErrors(async () => {
    const { connection, data } = await getReportContext(input.projectId);
    const channel = await data.getChannel(connection.channelId);
    if (!channel) {
      throw new YoutubeReportError(
        "youtube_channel_inaccessible",
        "The connected YouTube channel no longer exists or is no longer accessible.",
      );
    }
    return {
      source: "youtube_data_api",
      channel: channelRef({
        channelId: channel.channelId,
        channelTitle: channel.title,
        channelHandle: channel.handle,
        channelThumbnailUrl: channel.thumbnailUrl,
      }),
      subscriberCount: channel.subscriberCount,
      videoCount: channel.videoCount,
      viewCount: channel.viewCount,
      connectedEmail: connection.connectedAccountEmail,
    };
  });
}

async function getChannelOverview(input: YoutubeRangeInput) {
  return withMappedErrors(async () => {
    const { connection, analytics } = await getReportContext(input.projectId);
    const range: YoutubeResolvedRange = resolveYoutubeRange(input);
    const [current, previous, trend] = await Promise.all([
      analytics.runReport({
        startDate: range.startDate,
        endDate: range.endDate,
        metrics: [...YOUTUBE_OVERVIEW_METRICS],
      }),
      analytics.runReport({
        startDate: range.previousStartDate,
        endDate: range.previousEndDate,
        metrics: [...YOUTUBE_OVERVIEW_METRICS],
      }),
      analytics.runReport({
        startDate: range.startDate,
        endDate: range.endDate,
        metrics: [...YOUTUBE_TREND_METRICS],
        dimensions: ["day"],
        sort: "day",
      }),
    ]);
    return {
      source: "youtube_analytics_api",
      channel: channelRef(connection),
      request: {
        resolvedRange: {
          startDate: range.startDate,
          endDate: range.endDate,
        },
        previousRange: {
          startDate: range.previousStartDate,
          endDate: range.previousEndDate,
        },
        warnings: range.warnings,
      },
      current: firstRow(current.rows),
      previous: firstRow(previous.rows),
      trend: zeroFillTrend(trend.rows, range),
    };
  });
}

async function getTopVideos(
  input: YoutubeRangeInput & { limit?: number; sort?: "views" | "watch_time" },
) {
  return withMappedErrors(async () => {
    const { connection, analytics, data } = await getReportContext(
      input.projectId,
    );
    const range = resolveYoutubeRange(input);
    const limit = Math.min(Math.max(input.limit ?? 25, 1), MAX_TOP_VIDEOS);
    const report = await analytics.runReport({
      startDate: range.startDate,
      endDate: range.endDate,
      metrics: [...YOUTUBE_VIDEO_METRICS],
      dimensions: ["video"],
      sort: input.sort === "watch_time" ? "-estimatedMinutesWatched" : "-views",
      maxResults: limit,
    });
    const videoIds = report.rows
      .map((row) => row.video)
      .filter((value): value is string => typeof value === "string");
    const summaries: Map<string, YoutubeVideoSummary> =
      videoIds.length > 0
        ? await data.listVideoSummaries(videoIds)
        : new Map<string, YoutubeVideoSummary>();
    return {
      source: "youtube_analytics_api",
      channel: channelRef(connection),
      request: {
        resolvedRange: {
          startDate: range.startDate,
          endDate: range.endDate,
        },
        warnings: range.warnings,
        sort: input.sort ?? "views",
      },
      rows: report.rows.map((row) => {
        const videoId = typeof row.video === "string" ? row.video : null;
        const summary = videoId ? summaries.get(videoId) : undefined;
        return {
          videoId,
          title: summary?.title ?? null,
          publishedAt: summary?.publishedAt ?? null,
          durationSeconds: summary?.durationSeconds ?? null,
          thumbnailUrl: summary?.thumbnailUrl ?? null,
          views: row.views ?? null,
          estimatedMinutesWatched: row.estimatedMinutesWatched ?? null,
          averageViewDuration: row.averageViewDuration ?? null,
          averageViewPercentage: row.averageViewPercentage ?? null,
          subscribersGained: row.subscribersGained ?? null,
          likes: row.likes ?? null,
          comments: row.comments ?? null,
        };
      }),
    };
  });
}

async function getTrafficSources(
  input: YoutubeRangeInput & { limit?: number },
) {
  return withMappedErrors(async () => {
    const { connection, analytics } = await getReportContext(input.projectId);
    const range = resolveYoutubeRange(input);
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 200);
    const report = await analytics.runReport({
      startDate: range.startDate,
      endDate: range.endDate,
      metrics: [...YOUTUBE_TRAFFIC_SOURCE_METRICS],
      dimensions: ["insightTrafficSourceType"],
      sort: "-views",
      maxResults: limit,
    });
    return {
      source: "youtube_analytics_api",
      channel: channelRef(connection),
      request: {
        resolvedRange: {
          startDate: range.startDate,
          endDate: range.endDate,
        },
        warnings: range.warnings,
      },
      rows: report.rows.map((row) => ({
        trafficSource:
          typeof row.insightTrafficSourceType === "string"
            ? row.insightTrafficSourceType
            : null,
        views: row.views ?? null,
        estimatedMinutesWatched: row.estimatedMinutesWatched ?? null,
        averageViewDuration: row.averageViewDuration ?? null,
      })),
    };
  });
}

export const YoutubeAnalyticsService = {
  getChannelInfo,
  getChannelOverview,
  getTopVideos,
  getTrafficSources,
};

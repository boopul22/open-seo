import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  YoutubeAnalyticsQuery,
  YoutubeAnalyticsReport,
} from "@/server/lib/youtubeClient";
import {
  YoutubeAnalyticsApiError,
  YoutubeReportError,
  YoutubeTokenError,
} from "@/server/lib/youtubeErrors";
import { resolveYoutubeRange } from "@/server/features/youtube/services/YoutubeDates";
import {
  YOUTUBE_AUDIENCE_DIMENSIONS,
  YoutubeAudienceService,
  type YoutubeAudienceDimension,
} from "./YoutubeAudienceService";

const NOW = new Date("2026-09-21T12:00:00.000Z");
const VIDEO_ID = "dQw4w9WgXcQ";

const mocks = vi.hoisted(() => ({
  getReportContext: vi.fn(),
  runReport:
    vi.fn<(query: YoutubeAnalyticsQuery) => Promise<YoutubeAnalyticsReport>>(),
}));

vi.mock("@/server/features/youtube/services/YoutubeAnalyticsService", () => ({
  getReportContext: mocks.getReportContext,
}));

function reportContext() {
  return {
    connection: {
      channelId: "UCabcdefghijklmnopqrstuv",
      channelTitle: "Owned Channel",
      channelHandle: "@owned",
      channelThumbnailUrl: "https://example.com/thumb.jpg",
    },
    data: {},
    analytics: { runReport: mocks.runReport },
  };
}

function report(
  rows: Array<Record<string, string | number>>,
): YoutubeAnalyticsReport {
  return { columnHeaders: [], rows };
}

function queryAt(index: number): YoutubeAnalyticsQuery {
  const call = mocks.runReport.mock.calls[index];
  if (!call) {
    throw new Error(`runReport was not called ${index + 1} time(s)`);
  }
  return call[0];
}

describe("YoutubeAudienceService", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    mocks.getReportContext.mockResolvedValue(reportContext());
    mocks.runReport.mockResolvedValue(report([]));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults to the last 28 complete days", async () => {
    const expected = resolveYoutubeRange({});
    const result = await YoutubeAudienceService.getAudienceBreakdown({
      projectId: "project-1",
      dimension: "deviceType",
    });
    expect(queryAt(0)).toMatchObject({
      startDate: expected.startDate,
      endDate: expected.endDate,
    });
    expect(result.request.resolvedRange).toEqual({
      startDate: expected.startDate,
      endDate: expected.endDate,
    });
    expect(result.source).toBe("youtube_analytics_api");
    expect(result.channel).toEqual({
      channelId: "UCabcdefghijklmnopqrstuv",
      channelTitle: "Owned Channel",
      channelHandle: "@owned",
      thumbnailUrl: "https://example.com/thumb.jpg",
    });
  });

  it("parses retention points, skipping non-numeric ratios and rounding", async () => {
    mocks.runReport.mockImplementation(async (query: YoutubeAnalyticsQuery) =>
      query.dimensions?.length
        ? report([
            {
              elapsedVideoTimeRatio: 0.12345678,
              audienceWatchRatio: 0.98765432,
              relativeRetentionPerformance: 1.23456,
              totalSegmentImpressions: 40,
            },
            {
              elapsedVideoTimeRatio: "not-a-number",
              audienceWatchRatio: 0.5,
              relativeRetentionPerformance: 0.5,
            },
            {
              elapsedVideoTimeRatio: 0.05,
              relativeRetentionPerformance: 2,
            },
          ])
        : report([{ averageViewPercentage: 41.66666667, views: 1234 }]),
    );

    const result = await YoutubeAudienceService.getVideoRetention({
      projectId: "project-1",
      videoId: VIDEO_ID,
    });

    expect(queryAt(0)).toMatchObject({
      metrics: [
        "audienceWatchRatio",
        "relativeRetentionPerformance",
        "totalSegmentImpressions",
      ],
      dimensions: ["elapsedVideoTimeRatio"],
      filters: `video==${VIDEO_ID}`,
      sort: "elapsedVideoTimeRatio",
      maxResults: 100,
    });
    expect(queryAt(1)).toMatchObject({
      metrics: ["averageViewPercentage", "views"],
      filters: `video==${VIDEO_ID}`,
    });
    expect(queryAt(1).dimensions).toBeUndefined();

    expect(result.videoId).toBe(VIDEO_ID);
    expect(result.points).toEqual([
      {
        ratio: 0.1235,
        audienceWatchRatio: 0.9877,
        relativeRetentionPerformance: 1.2346,
      },
      {
        ratio: 0.05,
        audienceWatchRatio: null,
        relativeRetentionPerformance: 2,
      },
    ]);
    expect(result.rows).toBe(result.points);
    expect(result.averageViewPercentage).toBe(41.6667);
    expect(result.views).toBe(1234);
  });

  it.each([
    { dimension: "country", metrics: ["views", "estimatedMinutesWatched"] },
    { dimension: "ageGroup", metrics: ["viewerPercentage"] },
    { dimension: "gender", metrics: ["viewerPercentage"] },
    { dimension: "deviceType", metrics: ["views", "estimatedMinutesWatched"] },
    {
      dimension: "subscribedStatus",
      metrics: ["views", "estimatedMinutesWatched"],
    },
  ] satisfies Array<{
    dimension: YoutubeAudienceDimension;
    metrics: string[];
  }>)(
    "maps $dimension to its metrics and sort",
    async ({ dimension, metrics }) => {
      await YoutubeAudienceService.getAudienceBreakdown({
        projectId: "project-1",
        dimension,
      });
      const query = queryAt(0);
      expect(query.metrics).toEqual(metrics);
      expect(query.dimensions).toEqual([dimension]);
      expect(query.sort).toBe(
        dimension === "ageGroup" || dimension === "gender"
          ? "-viewerPercentage"
          : "-views",
      );
    },
  );

  it("keeps rows keyed by the requested dimension", async () => {
    mocks.runReport.mockResolvedValue(
      report([{ country: "US", views: 120, estimatedMinutesWatched: 44.5 }]),
    );
    const result = await YoutubeAudienceService.getAudienceBreakdown({
      projectId: "project-1",
      dimension: "country",
    });
    expect(result.rows).toEqual([
      { country: "US", views: 120, estimatedMinutesWatched: 44.5 },
    ]);
    expect(result.request).toMatchObject({ dimension: "country" });
  });

  it("clamps row limits to 1..200", async () => {
    await YoutubeAudienceService.getAudienceBreakdown({
      projectId: "project-1",
      dimension: "deviceType",
      limit: 500,
    });
    expect(queryAt(0).maxResults).toBe(200);

    await YoutubeAudienceService.getAudienceBreakdown({
      projectId: "project-1",
      dimension: "deviceType",
      limit: 0,
    });
    expect(queryAt(1).maxResults).toBe(1);

    await YoutubeAudienceService.getAudienceBreakdown({
      projectId: "project-1",
      dimension: "deviceType",
    });
    expect(queryAt(2).maxResults).toBe(25);
  });

  it("uses detail dimensions and metrics for playback location detail", async () => {
    await YoutubeAudienceService.getPlaybackLocations({
      projectId: "project-1",
    });
    expect(queryAt(0)).toMatchObject({
      dimensions: ["insightPlaybackLocationType"],
      metrics: ["views", "estimatedMinutesWatched", "averageViewDuration"],
      sort: "-views",
      maxResults: 25,
    });

    await YoutubeAudienceService.getPlaybackLocations({
      projectId: "project-1",
      detail: true,
    });
    expect(queryAt(1)).toMatchObject({
      dimensions: [
        "insightPlaybackLocationType",
        "insightPlaybackLocationDetail",
      ],
      metrics: ["views", "estimatedMinutesWatched"],
      sort: "-views",
      maxResults: 200,
    });
  });

  it("filters video traffic to the requested video", async () => {
    mocks.runReport.mockResolvedValue(
      report([
        {
          insightTrafficSourceType: "YT_SEARCH",
          views: 10,
          estimatedMinutesWatched: 4.25,
          averageViewDuration: 26,
        },
      ]),
    );
    const result = await YoutubeAudienceService.getVideoTraffic({
      projectId: "project-1",
      videoId: VIDEO_ID,
      limit: 500,
    });
    expect(queryAt(0)).toMatchObject({
      dimensions: ["insightTrafficSourceType"],
      metrics: ["views", "estimatedMinutesWatched", "averageViewDuration"],
      filters: `video==${VIDEO_ID}`,
      sort: "-views",
      maxResults: 200,
    });
    expect(result.rows).toEqual([
      {
        trafficSource: "YT_SEARCH",
        views: 10,
        estimatedMinutesWatched: 4.25,
        averageViewDuration: 26,
      },
    ]);
  });

  it("rejects a malformed video id before calling YouTube", async () => {
    await expect(
      YoutubeAudienceService.getVideoRetention({
        projectId: "project-1",
        videoId: "too-short",
      }),
    ).rejects.toMatchObject({
      name: "YoutubeReportError",
      code: "validation_error",
    });
    await expect(
      YoutubeAudienceService.getVideoTraffic({
        projectId: "project-1",
        videoId: "has spaces!",
      }),
    ).rejects.toBeInstanceOf(YoutubeReportError);
    expect(mocks.getReportContext).not.toHaveBeenCalled();
    expect(mocks.runReport).not.toHaveBeenCalled();
  });

  it("maps connection failures to YoutubeReportError", async () => {
    mocks.getReportContext.mockRejectedValue(
      new YoutubeTokenError("expired token"),
    );
    await expect(
      YoutubeAudienceService.getAudienceBreakdown({
        projectId: "project-1",
        dimension: "country",
      }),
    ).rejects.toMatchObject({
      name: "YoutubeReportError",
      code: "youtube_reconnect_required",
    });
  });

  it("maps upstream reporting failures to YoutubeReportError", async () => {
    mocks.runReport.mockRejectedValue(
      new YoutubeAnalyticsApiError(403, "denied", null, "quotaExceeded"),
    );
    await expect(
      YoutubeAudienceService.getPlaybackLocations({ projectId: "project-1" }),
    ).rejects.toMatchObject({
      name: "YoutubeReportError",
      code: "youtube_quota_exhausted",
    });
  });

  it("passes through an existing YoutubeReportError unchanged", async () => {
    const notConnected = new YoutubeReportError(
      "youtube_not_connected",
      "YouTube is not connected for this project.",
    );
    mocks.getReportContext.mockRejectedValue(notConnected);
    await expect(
      YoutubeAudienceService.getVideoTraffic({
        projectId: "project-1",
        videoId: VIDEO_ID,
      }),
    ).rejects.toBe(notConnected);
  });

  it("exposes every supported audience dimension", () => {
    expect([...YOUTUBE_AUDIENCE_DIMENSIONS]).toEqual([
      "country",
      "ageGroup",
      "gender",
      "deviceType",
      "subscribedStatus",
    ]);
  });
});

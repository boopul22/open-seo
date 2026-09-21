/* eslint-disable max-lines -- one spec covers video trends, channel growth, publish days, and playlists */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  YoutubeAnalyticsQuery,
  YoutubeAnalyticsReport,
  YoutubePlaylistSummary,
  YoutubeVideoSummary,
} from "@/server/lib/youtubeClient";
import type {
  YoutubeChannelSnapshot,
  YoutubeResearchChannel,
  YoutubeVideoSnapshot,
} from "@/server/features/youtube/repositories/YoutubeResearchRepository";
import { YoutubePerformanceService } from "./YoutubePerformanceService";

const NOW = new Date("2026-09-21T12:00:00.000Z");
const VIDEO_ID = "dQw4w9WgXcQ";
const OWNED_CHANNEL = "UCzyxwvutsrqponmlkjihgfe";
const TRACKED_CHANNEL = "UCabcdefghijklmnopqrstuv";
const UPLOADS_PLAYLIST = "UUzyxwvutsrqponmlkjihgfe";

const mocks = vi.hoisted(() => {
  const state = { grants: [] as { accountId: string }[] };
  return {
    state,
    listVideoSnapshotSeries: vi.fn(),
    listChannelSnapshots: vi.fn(),
    getByProjectAndChannel: vi.fn(),
    getConnection: vi.fn(),
    getReportContext: vi.fn(),
    runReport:
      vi.fn<
        (query: YoutubeAnalyticsQuery) => Promise<YoutubeAnalyticsReport>
      >(),
    createYoutubeDataClient: vi.fn(),
    getChannel: vi.fn(),
    listUploadedVideoIds: vi.fn(),
    listVideoSummaries: vi.fn(),
    listPlaylists: vi.fn(),
    dbSelect: vi.fn(),
  };
});

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({ db: { select: mocks.dbSelect } }));
vi.mock("@/server/lib/youtubeClient", () => ({
  createYoutubeDataClient: mocks.createYoutubeDataClient,
}));
vi.mock(
  "@/server/features/youtube/repositories/YoutubeConnectionRepository",
  () => ({
    YoutubeConnectionRepository: { getByProjectId: mocks.getConnection },
  }),
);
vi.mock(
  "@/server/features/youtube/repositories/YoutubeResearchRepository",
  () => ({
    YoutubeResearchRepository: {
      listVideoSnapshotSeries: mocks.listVideoSnapshotSeries,
      listChannelSnapshots: mocks.listChannelSnapshots,
      getByProjectAndChannel: mocks.getByProjectAndChannel,
    },
  }),
);
vi.mock("@/server/features/youtube/services/YoutubeAnalyticsService", () => ({
  getReportContext: mocks.getReportContext,
}));

function videoSnapshot(
  overrides: Partial<YoutubeVideoSnapshot> = {},
): YoutubeVideoSnapshot {
  return {
    id: "video-snapshot-1",
    channelId: TRACKED_CHANNEL,
    videoId: VIDEO_ID,
    viewCount: 1000,
    likeCount: 10,
    commentCount: 2,
    capturedAt: "2026-09-19T00:00:00.000Z",
    ...overrides,
  };
}

function channelSnapshot(
  overrides: Partial<YoutubeChannelSnapshot> = {},
): YoutubeChannelSnapshot {
  return {
    id: "channel-snapshot-1",
    channelId: OWNED_CHANNEL,
    subscriberCount: 1000,
    videoCount: 50,
    viewCount: 50_000,
    capturedAt: "2026-09-19T00:00:00.000Z",
    ...overrides,
  };
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: "connection-1",
    projectId: "project-1",
    organizationId: "org-1",
    channelId: OWNED_CHANNEL,
    channelTitle: "Owned Channel",
    channelHandle: "@owned",
    channelThumbnailUrl: null,
    uploadsPlaylistId: UPLOADS_PLAYLIST,
    connectedByUserId: "owner-1",
    youtubeAccountId: "owner-account",
    connectedAccountEmail: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function researchChannel(
  overrides: Partial<YoutubeResearchChannel> = {},
): YoutubeResearchChannel {
  return {
    id: "research-row-1",
    projectId: "project-1",
    organizationId: "org-1",
    channelId: TRACKED_CHANNEL,
    channelTitle: "Tracked Channel",
    channelHandle: "@tracked",
    channelThumbnailUrl: null,
    uploadsPlaylistId: UPLOADS_PLAYLIST,
    subscriberCount: 500,
    videoCount: 20,
    viewCount: 20_000,
    lastRefreshedAt: "2026-09-19T00:00:00.000Z",
    addedByUserId: "user-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function videoSummary(
  overrides: Partial<YoutubeVideoSummary> = {},
): YoutubeVideoSummary {
  return {
    videoId: "upload-1",
    title: "Upload 1",
    publishedAt: "2026-09-14T10:00:00.000Z",
    durationSeconds: 240,
    viewCount: 1000,
    likeCount: 10,
    commentCount: 1,
    thumbnailUrl: null,
    tags: [],
    channelId: OWNED_CHANNEL,
    channelTitle: "Owned Channel",
    ...overrides,
  };
}

function playlistSummary(
  overrides: Partial<YoutubePlaylistSummary> = {},
): YoutubePlaylistSummary {
  return {
    playlistId: "PLabcdefghijklmnopqrstuv",
    title: "Uploads",
    description: null,
    itemCount: 12,
    publishedAt: "2026-01-01T00:00:00.000Z",
    thumbnailUrl: null,
    ...overrides,
  };
}

function summaryMap(
  summaries: YoutubeVideoSummary[],
): Map<string, YoutubeVideoSummary> {
  return new Map(summaries.map((summary) => [summary.videoId, summary]));
}

function report(
  rows: Array<Record<string, string | number>>,
): YoutubeAnalyticsReport {
  return { columnHeaders: [], rows };
}

function analyticsQueryAt(index: number): YoutubeAnalyticsQuery {
  const call = mocks.runReport.mock.calls[index];
  if (!call) {
    throw new Error(`runReport was not called ${index + 1} time(s)`);
  }
  return call[0];
}

function reportContext() {
  return {
    connection: connection(),
    data: {
      getChannel: mocks.getChannel,
      listUploadedVideoIds: mocks.listUploadedVideoIds,
      listVideoSummaries: mocks.listVideoSummaries,
      listPlaylists: mocks.listPlaylists,
    },
    analytics: { runReport: mocks.runReport },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.state.grants = [{ accountId: "account-1" }];
  mocks.dbSelect.mockImplementation(() => ({
    from: () => ({ where: () => Promise.resolve(mocks.state.grants) }),
  }));
  mocks.listVideoSnapshotSeries.mockResolvedValue([]);
  mocks.listChannelSnapshots.mockResolvedValue([]);
  mocks.getByProjectAndChannel.mockResolvedValue(null);
  mocks.getConnection.mockResolvedValue(null);
  mocks.getReportContext.mockResolvedValue(reportContext());
  mocks.runReport.mockResolvedValue(report([]));
  mocks.getChannel.mockResolvedValue(null);
  mocks.listUploadedVideoIds.mockResolvedValue([]);
  mocks.listVideoSummaries.mockResolvedValue(new Map());
  mocks.listPlaylists.mockResolvedValue([]);
  mocks.createYoutubeDataClient.mockReturnValue({
    getChannel: mocks.getChannel,
    listUploadedVideoIds: mocks.listUploadedVideoIds,
    listVideoSummaries: mocks.listVideoSummaries,
    listPlaylists: mocks.listPlaylists,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("YoutubePerformanceService.getVideoTrend", () => {
  it("computes deltas and VPH across irregular snapshot gaps", async () => {
    mocks.listVideoSnapshotSeries.mockResolvedValue([
      videoSnapshot({
        viewCount: 1000,
        capturedAt: "2026-09-19T00:00:00.000Z",
      }),
      videoSnapshot({
        viewCount: 1030,
        capturedAt: "2026-09-19T01:30:00.000Z",
      }),
      videoSnapshot({
        viewCount: 1210,
        capturedAt: "2026-09-19T06:00:00.000Z",
      }),
    ]);

    const result = await YoutubePerformanceService.getVideoTrend({
      projectId: "project-1",
      videoId: VIDEO_ID,
    });

    expect(result.videoId).toBe(VIDEO_ID);
    expect(result.warnings).toEqual([]);
    expect(result.points).toEqual([
      {
        capturedAt: "2026-09-19T00:00:00.000Z",
        viewCount: 1000,
        deltaViews: null,
        hoursSincePrevious: null,
        vph: null,
      },
      {
        capturedAt: "2026-09-19T01:30:00.000Z",
        viewCount: 1030,
        deltaViews: 30,
        hoursSincePrevious: 1.5,
        vph: 20,
      },
      {
        capturedAt: "2026-09-19T06:00:00.000Z",
        viewCount: 1210,
        deltaViews: 180,
        hoursSincePrevious: 4.5,
        vph: 40,
      },
    ]);
    expect(mocks.listVideoSnapshotSeries).toHaveBeenCalledWith(
      VIDEO_ID,
      "2026-06-23T12:00:00.000Z",
    );
  });

  it("does not fabricate VPH for snapshots less than an hour apart", async () => {
    mocks.listVideoSnapshotSeries.mockResolvedValue([
      videoSnapshot({
        viewCount: 200,
        capturedAt: "2026-09-19T00:00:00.000Z",
      }),
      videoSnapshot({
        viewCount: 215,
        capturedAt: "2026-09-19T00:30:00.000Z",
      }),
    ]);

    const result = await YoutubePerformanceService.getVideoTrend({
      projectId: "project-1",
      videoId: VIDEO_ID,
    });

    expect(result.points[1]).toEqual({
      capturedAt: "2026-09-19T00:30:00.000Z",
      viewCount: 215,
      deltaViews: 15,
      hoursSincePrevious: 0.5,
      vph: null,
    });
  });

  it("keeps the hour gap but nulls deltas around a missing view count", async () => {
    mocks.listVideoSnapshotSeries.mockResolvedValue([
      videoSnapshot({
        viewCount: 100,
        capturedAt: "2026-09-19T00:00:00.000Z",
      }),
      videoSnapshot({
        viewCount: null,
        capturedAt: "2026-09-19T02:00:00.000Z",
      }),
      videoSnapshot({
        viewCount: 300,
        capturedAt: "2026-09-19T04:00:00.000Z",
      }),
    ]);

    const result = await YoutubePerformanceService.getVideoTrend({
      projectId: "project-1",
      videoId: VIDEO_ID,
    });

    expect(result.points[1]).toEqual({
      capturedAt: "2026-09-19T02:00:00.000Z",
      viewCount: null,
      deltaViews: null,
      hoursSincePrevious: 2,
      vph: null,
    });
    expect(result.points[2]).toEqual({
      capturedAt: "2026-09-19T04:00:00.000Z",
      viewCount: 300,
      deltaViews: null,
      hoursSincePrevious: 2,
      vph: null,
    });
  });

  it("warns when fewer than two snapshots exist", async () => {
    mocks.listVideoSnapshotSeries.mockResolvedValue([
      videoSnapshot({ viewCount: 1000 }),
    ]);

    const withOne = await YoutubePerformanceService.getVideoTrend({
      projectId: "project-1",
      videoId: VIDEO_ID,
    });
    expect(withOne.points).toHaveLength(1);
    expect(withOne.warnings).toEqual(["insufficient_snapshots"]);

    mocks.listVideoSnapshotSeries.mockResolvedValue([]);
    const withNone = await YoutubePerformanceService.getVideoTrend({
      projectId: "project-1",
      videoId: VIDEO_ID,
    });
    expect(withNone.points).toEqual([]);
    expect(withNone.warnings).toEqual(["insufficient_snapshots"]);
  });

  it("clamps the requested window to one year", async () => {
    await YoutubePerformanceService.getVideoTrend({
      projectId: "project-1",
      videoId: VIDEO_ID,
      days: 5000,
    });

    expect(mocks.listVideoSnapshotSeries).toHaveBeenCalledWith(
      VIDEO_ID,
      "2025-09-21T12:00:00.000Z",
    );
  });

  it("rejects a malformed video id before reading snapshots", async () => {
    await expect(
      YoutubePerformanceService.getVideoTrend({
        projectId: "project-1",
        videoId: "short",
      }),
    ).rejects.toMatchObject({ code: "validation_error" });
    expect(mocks.listVideoSnapshotSeries).not.toHaveBeenCalled();
  });
});

describe("YoutubePerformanceService.getChannelGrowth", () => {
  it("defaults to the owned connection and orders points oldest first", async () => {
    mocks.getConnection.mockResolvedValue(connection());
    mocks.listChannelSnapshots.mockResolvedValue([
      channelSnapshot({
        capturedAt: "2026-09-20T00:00:00.000Z",
        subscriberCount: 1200,
        videoCount: 60,
        viewCount: 60_000,
      }),
      channelSnapshot({
        capturedAt: "2026-09-10T00:00:00.000Z",
        subscriberCount: 1100,
        videoCount: 55,
        viewCount: 55_000,
      }),
      channelSnapshot({
        capturedAt: "2026-09-01T00:00:00.000Z",
        subscriberCount: 1000,
        videoCount: 50,
        viewCount: 50_000,
      }),
    ]);

    const result = await YoutubePerformanceService.getChannelGrowth({
      projectId: "project-1",
    });

    expect(result.channel).toEqual({
      channelId: OWNED_CHANNEL,
      channelTitle: "Owned Channel",
    });
    expect(result.warnings).toEqual([]);
    expect(result.points.map((point) => point.capturedAt)).toEqual([
      "2026-09-01T00:00:00.000Z",
      "2026-09-10T00:00:00.000Z",
      "2026-09-20T00:00:00.000Z",
    ]);
    expect(result.points[0]).toMatchObject({
      deltaSubscribers: null,
      deltaViews: null,
    });
    expect(result.points[1]).toMatchObject({
      deltaSubscribers: 100,
      deltaViews: 5000,
    });
    expect(result.points[2]).toMatchObject({
      deltaSubscribers: 100,
      deltaViews: 5000,
    });
    expect(mocks.listChannelSnapshots).toHaveBeenCalledWith(OWNED_CHANNEL, 365);
  });

  it("nulls deltas around persisted counters that are null", async () => {
    mocks.getConnection.mockResolvedValue(connection());
    mocks.listChannelSnapshots.mockResolvedValue([
      channelSnapshot({
        capturedAt: "2026-09-20T00:00:00.000Z",
        subscriberCount: null,
        viewCount: 60_000,
      }),
      channelSnapshot({
        capturedAt: "2026-09-10T00:00:00.000Z",
        subscriberCount: 1100,
        viewCount: 55_000,
      }),
      channelSnapshot({
        capturedAt: "2026-09-01T00:00:00.000Z",
        subscriberCount: 1000,
        viewCount: null,
      }),
    ]);

    const result = await YoutubePerformanceService.getChannelGrowth({
      projectId: "project-1",
    });

    expect(result.points[0]).toMatchObject({
      subscriberCount: 1000,
      deltaSubscribers: null,
      deltaViews: null,
    });
    expect(result.points[1]).toMatchObject({
      deltaSubscribers: 100,
      deltaViews: null,
    });
    expect(result.points[2]).toMatchObject({
      subscriberCount: null,
      deltaSubscribers: null,
      deltaViews: 5000,
    });
  });

  it("reads a tracked research channel by id", async () => {
    mocks.getByProjectAndChannel.mockResolvedValue(researchChannel());
    mocks.listChannelSnapshots.mockResolvedValue([
      channelSnapshot({ channelId: TRACKED_CHANNEL }),
    ]);

    const result = await YoutubePerformanceService.getChannelGrowth({
      projectId: "project-1",
      channelId: TRACKED_CHANNEL,
    });

    expect(result.channel).toEqual({
      channelId: TRACKED_CHANNEL,
      channelTitle: "Tracked Channel",
    });
    expect(result.warnings).toEqual(["insufficient_snapshots"]);
    expect(mocks.listChannelSnapshots).toHaveBeenCalledWith(
      TRACKED_CHANNEL,
      365,
    );
  });

  it("rejects a channel that is neither tracked nor connected", async () => {
    await expect(
      YoutubePerformanceService.getChannelGrowth({
        projectId: "project-1",
        channelId: TRACKED_CHANNEL,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("requires a connection when no channel id is given", async () => {
    await expect(
      YoutubePerformanceService.getChannelGrowth({ projectId: "project-1" }),
    ).rejects.toMatchObject({ code: "youtube_not_connected" });
  });

  it("rejects a malformed channel id", async () => {
    await expect(
      YoutubePerformanceService.getChannelGrowth({
        projectId: "project-1",
        channelId: "not-a-channel",
      }),
    ).rejects.toMatchObject({ code: "validation_error" });
    expect(mocks.listChannelSnapshots).not.toHaveBeenCalled();
  });
});

describe("YoutubePerformanceService.getBestPublishDays", () => {
  it("aggregates analytics watch activity and upload counts by weekday", async () => {
    mocks.runReport.mockResolvedValue(
      report([
        { day: "2026-09-07", views: 200, estimatedMinutesWatched: 60 },
        { day: "2026-09-13", views: 100, estimatedMinutesWatched: 40 },
        { day: "2026-09-14", views: 300, estimatedMinutesWatched: 100 },
      ]),
    );
    mocks.listUploadedVideoIds.mockResolvedValue(["v1", "v2", "v3", "v4"]);
    mocks.listVideoSummaries.mockResolvedValue(
      summaryMap([
        videoSummary({
          videoId: "v1",
          publishedAt: "2026-09-14T10:00:00.000Z",
          viewCount: 1000,
        }),
        videoSummary({
          videoId: "v2",
          publishedAt: "2026-09-14T20:00:00.000Z",
          viewCount: 3000,
        }),
        videoSummary({
          videoId: "v3",
          publishedAt: "2026-09-13T05:00:00.000Z",
          viewCount: 500,
        }),
        videoSummary({
          videoId: "v4",
          publishedAt: null,
          viewCount: 9000,
        }),
      ]),
    );

    const result = await YoutubePerformanceService.getBestPublishDays({
      projectId: "project-1",
    });

    expect(analyticsQueryAt(0)).toEqual({
      startDate: "2026-06-22",
      endDate: "2026-09-19",
      metrics: ["views", "estimatedMinutesWatched"],
      dimensions: ["day"],
      sort: "day",
    });
    expect(mocks.listUploadedVideoIds).toHaveBeenCalledWith(
      UPLOADS_PLAYLIST,
      100,
    );
    expect(result.channel).toEqual({
      channelId: OWNED_CHANNEL,
      channelTitle: "Owned Channel",
    });
    expect(result.range).toEqual({
      startDate: "2026-06-22",
      endDate: "2026-09-19",
    });
    expect(result.weekdays).toHaveLength(7);
    const byDay = Object.fromEntries(
      result.weekdays.map((row) => [row.weekday, row]),
    );
    expect(byDay.Mon).toEqual({
      weekday: "Mon",
      views: 500,
      estimatedMinutesWatched: 160,
      uploads: 2,
      averageViewsPerUpload: 2000,
    });
    expect(byDay.Sun).toEqual({
      weekday: "Sun",
      views: 100,
      estimatedMinutesWatched: 40,
      uploads: 1,
      averageViewsPerUpload: 500,
    });
    expect(byDay.Wed).toEqual({
      weekday: "Wed",
      views: 0,
      estimatedMinutesWatched: 0,
      uploads: 0,
      averageViewsPerUpload: null,
    });
    expect(result.bestDay).toBe("Mon");
    expect(result.notes.length).toBeGreaterThan(0);
    expect(result.notes.join(" ")).toMatch(/not a cross-channel/i);
  });

  it("returns zeroed weekdays and no best day for a month without activity", async () => {
    mocks.runReport.mockResolvedValue(report([]));
    mocks.listUploadedVideoIds.mockResolvedValue([]);
    mocks.listVideoSummaries.mockResolvedValue(summaryMap([]));

    const result = await YoutubePerformanceService.getBestPublishDays({
      projectId: "project-1",
    });

    expect(result.bestDay).toBeNull();
    expect(result.weekdays).toHaveLength(7);
    expect(
      result.weekdays.every(
        (row) =>
          row.views === 0 &&
          row.estimatedMinutesWatched === 0 &&
          row.uploads === 0 &&
          row.averageViewsPerUpload === null,
      ),
    ).toBe(true);
  });

  it("resolves the uploads playlist when the connection has none", async () => {
    mocks.getReportContext.mockResolvedValue({
      ...reportContext(),
      connection: connection({ uploadsPlaylistId: null }),
    });
    mocks.getChannel.mockResolvedValue({
      channelId: OWNED_CHANNEL,
      title: "Owned Channel",
      handle: "@owned",
      thumbnailUrl: null,
      uploadsPlaylistId: UPLOADS_PLAYLIST,
      subscriberCount: 1000,
      videoCount: 50,
      viewCount: 50_000,
    });
    mocks.listUploadedVideoIds.mockResolvedValue(["v1"]);
    mocks.listVideoSummaries.mockResolvedValue(
      summaryMap([videoSummary({ videoId: "v1" })]),
    );

    await YoutubePerformanceService.getBestPublishDays({
      projectId: "project-1",
    });

    expect(mocks.getChannel).toHaveBeenCalledWith(OWNED_CHANNEL);
    expect(mocks.listUploadedVideoIds).toHaveBeenCalledWith(
      UPLOADS_PLAYLIST,
      100,
    );
  });
});

describe("YoutubePerformanceService.listPlaylistsForChannel", () => {
  it("defaults to the connected channel's own playlists", async () => {
    mocks.getConnection.mockResolvedValue(connection());
    mocks.listPlaylists.mockResolvedValue([playlistSummary()]);

    const result = await YoutubePerformanceService.listPlaylistsForChannel({
      projectId: "project-1",
      userId: "user-1",
    });

    expect(mocks.createYoutubeDataClient).toHaveBeenCalledWith({
      userId: "owner-1",
      youtubeAccountId: "owner-account",
    });
    expect(mocks.listPlaylists).toHaveBeenCalledWith({
      mine: true,
      maxResults: 25,
    });
    expect(result.channelId).toBe(OWNED_CHANNEL);
    expect(result.playlists).toHaveLength(1);
  });

  it("reads any public channel with the caller's grant when nothing is connected", async () => {
    mocks.state.grants = [{ accountId: "personal-account" }];
    mocks.listPlaylists.mockResolvedValue([]);

    const result = await YoutubePerformanceService.listPlaylistsForChannel({
      projectId: "project-1",
      channelId: TRACKED_CHANNEL,
      userId: "user-9",
    });

    expect(mocks.createYoutubeDataClient).toHaveBeenCalledWith({
      userId: "user-9",
      youtubeAccountId: "personal-account",
    });
    expect(mocks.listPlaylists).toHaveBeenCalledWith({
      channelId: TRACKED_CHANNEL,
      maxResults: 25,
    });
    expect(result).toEqual({ channelId: TRACKED_CHANNEL, playlists: [] });
  });

  it("clamps maxResults into 1..50", async () => {
    mocks.getConnection.mockResolvedValue(connection());

    await YoutubePerformanceService.listPlaylistsForChannel({
      projectId: "project-1",
      userId: "user-1",
      maxResults: 500,
    });
    expect(mocks.listPlaylists).toHaveBeenLastCalledWith({
      mine: true,
      maxResults: 50,
    });

    await YoutubePerformanceService.listPlaylistsForChannel({
      projectId: "project-1",
      userId: "user-1",
      maxResults: 0,
    });
    expect(mocks.listPlaylists).toHaveBeenLastCalledWith({
      mine: true,
      maxResults: 1,
    });
  });

  it("rejects mine=false without a channel id", async () => {
    mocks.getConnection.mockResolvedValue(connection());

    await expect(
      YoutubePerformanceService.listPlaylistsForChannel({
        projectId: "project-1",
        mine: false,
      }),
    ).rejects.toMatchObject({ code: "validation_error" });
    expect(mocks.listPlaylists).not.toHaveBeenCalled();
  });

  it("asks the user to connect YouTube when no grant exists", async () => {
    mocks.state.grants = [];

    await expect(
      YoutubePerformanceService.listPlaylistsForChannel({
        projectId: "project-1",
        channelId: TRACKED_CHANNEL,
        userId: "user-9",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Connect a YouTube account before researching channels.",
    });
  });

  it("rejects a malformed channel id", async () => {
    await expect(
      YoutubePerformanceService.listPlaylistsForChannel({
        projectId: "project-1",
        channelId: "not-a-channel",
      }),
    ).rejects.toMatchObject({ code: "validation_error" });
    expect(mocks.listPlaylists).not.toHaveBeenCalled();
  });
});

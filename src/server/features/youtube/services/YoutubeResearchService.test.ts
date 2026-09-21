/* eslint-disable max-lines -- one spec covers channel resolution, refresh, scoring, outliers, comparisons, and trending */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  YoutubeChannel,
  YoutubeVideoSummary,
} from "@/server/lib/youtubeClient";
import type {
  YoutubeResearchChannel,
  YoutubeVideoSnapshot,
} from "@/server/features/youtube/repositories/YoutubeResearchRepository";
import {
  MAX_RESEARCH_CHANNELS,
  YoutubeResearchService,
} from "./YoutubeResearchService";

const NOW = new Date("2026-09-21T12:00:00.000Z");
const CHANNEL_A = "UCabcdefghijklmnopqrstuv";
const CHANNEL_B = "UCzyxwvutsrqponmlkjihgfe";
const PLAYLIST_A = "UUabcdefghijklmnopqrstuv";
const PLAYLIST_B = "UUzyxwvutsrqponmlkjihgfe";

const mocks = vi.hoisted(() => {
  const state = { grants: [] as { accountId: string }[] };
  return {
    state,
    getChannel: vi.fn(),
    getChannelByHandle: vi.fn(),
    listUploadedVideoIds: vi.fn(),
    listVideoSummaries: vi.fn(),
    listMostPopular: vi.fn(),
    createYoutubeDataClient: vi.fn(),
    getConnection: vi.fn(),
    listByProject: vi.fn(),
    getByProjectAndChannel: vi.fn(),
    countByProject: vi.fn(),
    upsert: vi.fn(),
    deleteByProjectAndChannel: vi.fn(),
    updateStats: vi.fn(),
    insertChannelSnapshot: vi.fn(),
    insertVideoSnapshots: vi.fn(),
    listRecentVideoSnapshots: vi.fn(),
    listChannelSnapshots: vi.fn(),
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
      listByProject: mocks.listByProject,
      getByProjectAndChannel: mocks.getByProjectAndChannel,
      countByProject: mocks.countByProject,
      upsert: mocks.upsert,
      deleteByProjectAndChannel: mocks.deleteByProjectAndChannel,
      updateStats: mocks.updateStats,
      insertChannelSnapshot: mocks.insertChannelSnapshot,
      insertVideoSnapshots: mocks.insertVideoSnapshots,
      listRecentVideoSnapshots: mocks.listRecentVideoSnapshots,
      listChannelSnapshots: mocks.listChannelSnapshots,
    },
  }),
);

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

function youtubeChannel(
  overrides: Partial<YoutubeChannel> = {},
): YoutubeChannel {
  return {
    channelId: CHANNEL_A,
    title: "Alpha Channel",
    handle: "@alpha",
    thumbnailUrl: "https://example.com/alpha.jpg",
    uploadsPlaylistId: PLAYLIST_A,
    subscriberCount: 1000,
    videoCount: 50,
    viewCount: 50_000,
    ...overrides,
  };
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: "connection-1",
    projectId: "project-1",
    organizationId: "org-1",
    channelId: CHANNEL_A,
    channelTitle: "Owned Channel",
    channelHandle: "@owned",
    channelThumbnailUrl: null,
    uploadsPlaylistId: PLAYLIST_A,
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
    id: "row-1",
    projectId: "project-1",
    organizationId: "org-1",
    channelId: CHANNEL_A,
    channelTitle: "Alpha Channel",
    channelHandle: "@alpha",
    channelThumbnailUrl: "https://example.com/alpha.jpg",
    uploadsPlaylistId: PLAYLIST_A,
    subscriberCount: 1000,
    videoCount: 50,
    viewCount: 50_000,
    lastRefreshedAt: "2026-09-01T00:00:00.000Z",
    addedByUserId: "user-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function video(
  overrides: Partial<YoutubeVideoSummary> = {},
): YoutubeVideoSummary {
  return {
    videoId: "video-1",
    title: "Video 1",
    publishedAt: daysAgo(20),
    durationSeconds: 120,
    viewCount: 1000,
    likeCount: 10,
    commentCount: 2,
    thumbnailUrl: "https://example.com/video.jpg",
    tags: [],
    channelId: null,
    channelTitle: null,
    ...overrides,
  };
}

function summaryMap(
  summaries: YoutubeVideoSummary[],
): Map<string, YoutubeVideoSummary> {
  return new Map(summaries.map((summary) => [summary.videoId, summary]));
}

function videoSnapshot(
  overrides: Partial<YoutubeVideoSnapshot> = {},
): YoutubeVideoSnapshot {
  return {
    id: "snapshot-1",
    channelId: CHANNEL_A,
    videoId: "video-1",
    viewCount: 1000,
    likeCount: 10,
    commentCount: 2,
    capturedAt: "2026-09-21T10:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.state.grants = [{ accountId: "account-1" }];
  mocks.dbSelect.mockImplementation(() => ({
    from: () => ({ where: () => Promise.resolve(mocks.state.grants) }),
  }));
  mocks.createYoutubeDataClient.mockReturnValue({
    getChannel: mocks.getChannel,
    getChannelByHandle: mocks.getChannelByHandle,
    listUploadedVideoIds: mocks.listUploadedVideoIds,
    listVideoSummaries: mocks.listVideoSummaries,
    listMostPopular: mocks.listMostPopular,
  });
  mocks.getConnection.mockResolvedValue(null);
  mocks.listRecentVideoSnapshots.mockResolvedValue([]);
  mocks.insertChannelSnapshot.mockResolvedValue(undefined);
  mocks.insertVideoSnapshots.mockResolvedValue(undefined);
  mocks.deleteByProjectAndChannel.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("YoutubeResearchService.addResearchChannel", () => {
  it("resolves a channel URL, stores it, and captures a snapshot", async () => {
    mocks.getConnection.mockResolvedValue(connection());
    mocks.getChannel.mockResolvedValue(youtubeChannel());
    mocks.getByProjectAndChannel.mockResolvedValue(null);
    mocks.countByProject.mockResolvedValue(0);
    mocks.upsert.mockResolvedValue(researchChannel());

    const result = await YoutubeResearchService.addResearchChannel({
      projectId: "project-1",
      organizationId: "org-1",
      channel: `https://www.youtube.com/channel/${CHANNEL_A}?sub_confirmation=1`,
      userId: "user-1",
    });

    expect(mocks.createYoutubeDataClient).toHaveBeenCalledWith({
      userId: "owner-1",
      youtubeAccountId: "owner-account",
    });
    expect(mocks.getChannel).toHaveBeenCalledWith(CHANNEL_A);
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        organizationId: "org-1",
        channelId: CHANNEL_A,
        channelTitle: "Alpha Channel",
        uploadsPlaylistId: PLAYLIST_A,
        subscriberCount: 1000,
        addedByUserId: "user-1",
        // oxlint-disable-next-line typescript/no-unsafe-assignment -- asymmetric matcher is typed any
        lastRefreshedAt: expect.any(String),
      }),
    );
    expect(mocks.insertChannelSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: CHANNEL_A,
        subscriberCount: 1000,
        // oxlint-disable-next-line typescript/no-unsafe-assignment -- asymmetric matcher is typed any
        capturedAt: expect.any(String),
      }),
    );
    expect(result).toMatchObject({ id: "row-1", channelId: CHANNEL_A });
  });

  it("resolves a bare @handle through the client's handle lookup", async () => {
    mocks.getChannelByHandle.mockResolvedValue(youtubeChannel());
    mocks.getByProjectAndChannel.mockResolvedValue(null);
    mocks.countByProject.mockResolvedValue(0);
    mocks.upsert.mockResolvedValue(researchChannel());

    await YoutubeResearchService.addResearchChannel({
      projectId: "project-1",
      organizationId: "org-1",
      channel: "@alpha",
      userId: "user-1",
    });

    expect(mocks.getChannelByHandle).toHaveBeenCalledWith("@alpha");
    expect(mocks.getChannel).not.toHaveBeenCalled();
  });

  it("rejects free text that is not a URL, handle, or channel ID", async () => {
    await expect(
      YoutubeResearchService.addResearchChannel({
        projectId: "project-1",
        organizationId: "org-1",
        channel: "some random text",
        userId: "user-1",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Enter a YouTube channel URL, @handle, or channel ID.",
    });
    expect(mocks.createYoutubeDataClient).not.toHaveBeenCalled();
  });

  it("reports NOT_FOUND when no channel matches", async () => {
    mocks.getChannel.mockResolvedValue(null);

    await expect(
      YoutubeResearchService.addResearchChannel({
        projectId: "project-1",
        organizationId: "org-1",
        channel: CHANNEL_A,
        userId: "user-1",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("enforces the per-project channel cap for new channels", async () => {
    mocks.getChannel.mockResolvedValue(youtubeChannel());
    mocks.getByProjectAndChannel.mockResolvedValue(null);
    mocks.countByProject.mockResolvedValue(MAX_RESEARCH_CHANNELS);

    await expect(
      YoutubeResearchService.addResearchChannel({
        projectId: "project-1",
        organizationId: "org-1",
        channel: CHANNEL_A,
        userId: "user-1",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: `You can track up to ${MAX_RESEARCH_CHANNELS} channels per project.`,
    });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("re-adds an already tracked channel even at the cap", async () => {
    mocks.getChannel.mockResolvedValue(youtubeChannel());
    mocks.getByProjectAndChannel.mockResolvedValue(researchChannel());
    mocks.countByProject.mockResolvedValue(MAX_RESEARCH_CHANNELS);
    mocks.upsert.mockResolvedValue(researchChannel());

    await expect(
      YoutubeResearchService.addResearchChannel({
        projectId: "project-1",
        organizationId: "org-1",
        channel: CHANNEL_A,
        userId: "user-1",
      }),
    ).resolves.toMatchObject({ channelId: CHANNEL_A });
    expect(mocks.countByProject).not.toHaveBeenCalled();
  });

  it("falls back to the caller's own grant when the project has no connection", async () => {
    mocks.state.grants = [{ accountId: "personal-account" }];
    mocks.getChannel.mockResolvedValue(youtubeChannel());
    mocks.getByProjectAndChannel.mockResolvedValue(null);
    mocks.countByProject.mockResolvedValue(0);
    mocks.upsert.mockResolvedValue(researchChannel());

    await YoutubeResearchService.addResearchChannel({
      projectId: "project-1",
      organizationId: "org-1",
      channel: CHANNEL_A,
      userId: "user-9",
    });

    expect(mocks.createYoutubeDataClient).toHaveBeenCalledWith({
      userId: "user-9",
      youtubeAccountId: "personal-account",
    });
  });

  it("asks the user to connect YouTube when no grant exists at all", async () => {
    mocks.state.grants = [];

    await expect(
      YoutubeResearchService.addResearchChannel({
        projectId: "project-1",
        organizationId: "org-1",
        channel: CHANNEL_A,
        userId: "user-9",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Connect a YouTube account before researching channels.",
    });
  });
});

describe("YoutubeResearchService.listResearchChannels", () => {
  it("orders by subscribers descending with unknown counts last", async () => {
    mocks.listByProject.mockResolvedValue([
      researchChannel({
        id: "r1",
        channelTitle: "Alpha",
        subscriberCount: 100,
      }),
      researchChannel({
        id: "r2",
        channelId: CHANNEL_B,
        channelTitle: "Beta",
        subscriberCount: null,
      }),
      researchChannel({
        id: "r3",
        channelId: "UCcccccccccccccccccccccc",
        channelTitle: "Gamma",
        subscriberCount: 5000,
      }),
    ]);

    const channels =
      await YoutubeResearchService.listResearchChannels("project-1");

    expect(channels.map((channel) => channel.id)).toEqual(["r3", "r1", "r2"]);
  });
});

describe("YoutubeResearchService.removeResearchChannel", () => {
  it("deletes the stored channel", async () => {
    await YoutubeResearchService.removeResearchChannel({
      projectId: "project-1",
      channelId: CHANNEL_A,
    });

    expect(mocks.deleteByProjectAndChannel).toHaveBeenCalledWith(
      "project-1",
      CHANNEL_A,
    );
  });
});

describe("YoutubeResearchService.refreshResearchChannels", () => {
  it("updates stats and writes channel + video snapshots", async () => {
    mocks.listByProject.mockResolvedValue([researchChannel()]);
    mocks.getChannel.mockResolvedValue(
      youtubeChannel({ subscriberCount: 2000, viewCount: 90_000 }),
    );
    mocks.listUploadedVideoIds.mockResolvedValue(["v1", "v2"]);
    mocks.listVideoSummaries.mockResolvedValue(
      summaryMap([
        video({ videoId: "v1", viewCount: 1000 }),
        video({ videoId: "v2", viewCount: 2000 }),
      ]),
    );
    mocks.updateStats.mockResolvedValue(
      researchChannel({ subscriberCount: 2000, viewCount: 90_000 }),
    );

    const result = await YoutubeResearchService.refreshResearchChannels({
      projectId: "project-1",
      userId: "user-1",
    });

    expect(mocks.listUploadedVideoIds).toHaveBeenCalledWith(PLAYLIST_A, 200);
    expect(mocks.updateStats).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "row-1",
        subscriberCount: 2000,
        viewCount: 90_000,
        lastRefreshedAt: result.refreshedAt,
      }),
    );
    expect(mocks.insertChannelSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: CHANNEL_A,
        subscriberCount: 2000,
        capturedAt: result.refreshedAt,
      }),
    );
    expect(mocks.insertVideoSnapshots).toHaveBeenCalledWith([
      expect.objectContaining({ videoId: "v1", viewCount: 1000 }),
      expect.objectContaining({ videoId: "v2", viewCount: 2000 }),
    ]);
    expect(result.channels).toHaveLength(1);
  });

  it("skips channels with no uploads playlist", async () => {
    mocks.listByProject.mockResolvedValue([
      researchChannel({ uploadsPlaylistId: null }),
    ]);

    const result = await YoutubeResearchService.refreshResearchChannels({
      projectId: "project-1",
      userId: "user-1",
    });

    expect(mocks.listUploadedVideoIds).not.toHaveBeenCalled();
    expect(mocks.updateStats).not.toHaveBeenCalled();
    expect(result.channels[0]?.channelId).toBe(CHANNEL_A);
  });

  it("does not mint credentials when nothing is tracked", async () => {
    mocks.listByProject.mockResolvedValue([]);

    const result = await YoutubeResearchService.refreshResearchChannels({
      projectId: "project-1",
    });

    expect(result.channels).toEqual([]);
    expect(mocks.createYoutubeDataClient).not.toHaveBeenCalled();
  });
});

describe("YoutubeResearchService.listChannelVideos", () => {
  it("scores and sorts sampled uploads, attaching velocity", async () => {
    mocks.getConnection.mockResolvedValue(connection());
    mocks.getByProjectAndChannel.mockResolvedValue(researchChannel());
    mocks.listUploadedVideoIds.mockResolvedValue(["v1", "v2", "v3"]);
    mocks.listVideoSummaries.mockResolvedValue(
      summaryMap([
        video({ videoId: "v1", viewCount: 1000, publishedAt: daysAgo(20) }),
        video({ videoId: "v2", viewCount: 3000, publishedAt: daysAgo(10) }),
        video({ videoId: "v3", viewCount: 100, publishedAt: daysAgo(1) }),
      ]),
    );
    mocks.listRecentVideoSnapshots.mockResolvedValue([
      videoSnapshot({
        videoId: "v2",
        viewCount: 3000,
        capturedAt: "2026-09-21T10:00:00.000Z",
      }),
      videoSnapshot({
        id: "snapshot-2",
        videoId: "v2",
        viewCount: 2800,
        capturedAt: "2026-09-21T08:00:00.000Z",
      }),
    ]);

    const result = await YoutubeResearchService.listChannelVideos({
      projectId: "project-1",
      channelId: CHANNEL_A,
    });

    expect(mocks.listUploadedVideoIds).toHaveBeenCalledWith(PLAYLIST_A, 100);
    expect(result.channel.id).toBe("row-1");
    expect(result.stats.sampleSize).toBe(3);
    expect(result.videos.map((row) => row.videoId)).toEqual(["v2", "v1", "v3"]);
    expect(result.videos[0]).toMatchObject({
      views: 3000,
      outlierScore: 3,
      vph: 100,
    });
    expect(result.videos[1]?.vph).toBeNull();
  });

  it("honors the newest sort", async () => {
    mocks.getConnection.mockResolvedValue(connection());
    mocks.getByProjectAndChannel.mockResolvedValue(researchChannel());
    mocks.listUploadedVideoIds.mockResolvedValue(["v1", "v2", "v3"]);
    mocks.listVideoSummaries.mockResolvedValue(
      summaryMap([
        video({ videoId: "v1", viewCount: 1000, publishedAt: daysAgo(20) }),
        video({ videoId: "v2", viewCount: 3000, publishedAt: daysAgo(10) }),
        video({ videoId: "v3", viewCount: 100, publishedAt: daysAgo(1) }),
      ]),
    );

    const result = await YoutubeResearchService.listChannelVideos({
      projectId: "project-1",
      channelId: CHANNEL_A,
      sort: "newest",
    });

    expect(result.videos.map((row) => row.videoId)).toEqual(["v3", "v2", "v1"]);
  });

  it("falls back to the owned connection's channel", async () => {
    mocks.getByProjectAndChannel.mockResolvedValue(null);
    mocks.getConnection.mockResolvedValue(
      connection({ channelTitle: "Owned Channel" }),
    );
    mocks.listUploadedVideoIds.mockResolvedValue([]);
    mocks.listVideoSummaries.mockResolvedValue(new Map());

    const result = await YoutubeResearchService.listChannelVideos({
      projectId: "project-1",
      channelId: CHANNEL_A,
    });

    expect(result.channel).toMatchObject({
      id: null,
      channelTitle: "Owned Channel",
    });
    expect(result.videos).toEqual([]);
  });

  it("throws NOT_FOUND for an untracked channel", async () => {
    mocks.getByProjectAndChannel.mockResolvedValue(null);

    await expect(
      YoutubeResearchService.listChannelVideos({
        projectId: "project-1",
        channelId: CHANNEL_A,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("YoutubeResearchService.getOutliers", () => {
  function stubSamples() {
    const allVideos = [
      video({ videoId: "a1", viewCount: 10_000, publishedAt: daysAgo(20) }),
      video({ videoId: "a2", viewCount: 1000, publishedAt: daysAgo(20) }),
      video({ videoId: "b1", viewCount: 20_000, publishedAt: daysAgo(20) }),
      video({ videoId: "b2", viewCount: 1000, publishedAt: daysAgo(20) }),
    ];
    const byId = summaryMap(allVideos);
    mocks.listByProject.mockResolvedValue([researchChannel()]);
    mocks.getByProjectAndChannel.mockResolvedValue(researchChannel());
    mocks.getConnection.mockResolvedValue(
      connection({
        channelId: CHANNEL_B,
        channelTitle: "Beta Owned",
        uploadsPlaylistId: PLAYLIST_B,
      }),
    );
    mocks.listUploadedVideoIds.mockImplementation((playlistId: string) =>
      Promise.resolve(playlistId === PLAYLIST_A ? ["a1", "a2"] : ["b1", "b2"]),
    );
    mocks.listVideoSummaries.mockImplementation((videoIds: string[]) =>
      Promise.resolve(
        new Map(
          videoIds.flatMap((videoId) => {
            const found = byId.get(videoId);
            return found ? [[videoId, found] as const] : [];
          }),
        ),
      ),
    );
  }

  it("scores every tracked channel plus the owned channel", async () => {
    stubSamples();

    const rows = await YoutubeResearchService.getOutliers({
      projectId: "project-1",
    });

    expect(rows.map((row) => row.videoId)).toEqual(["b1", "a1"]);
    expect(rows[0]).toMatchObject({
      channelId: CHANNEL_B,
      channelTitle: "Beta Owned",
    });
    expect(rows[1]).toMatchObject({
      channelId: CHANNEL_A,
      channelTitle: "Alpha Channel",
    });
  });

  it("scopes scoring to one channel when asked", async () => {
    stubSamples();

    const rows = await YoutubeResearchService.getOutliers({
      projectId: "project-1",
      channelId: CHANNEL_A,
    });

    expect(rows.map((row) => row.videoId)).toEqual(["a1"]);
    expect(mocks.listUploadedVideoIds).toHaveBeenCalledTimes(1);
  });

  it("drops videos outside the window or below the score floor", async () => {
    stubSamples();
    mocks.listByProject.mockResolvedValue([researchChannel()]);
    mocks.getConnection.mockResolvedValue(null);
    mocks.listUploadedVideoIds.mockResolvedValue(["a1", "a2"]);
    mocks.listUploadedVideoIds.mockImplementation(() =>
      Promise.resolve(["a1", "a2"]),
    );
    const byId = summaryMap([
      video({ videoId: "a1", viewCount: 10_000, publishedAt: daysAgo(400) }),
      video({ videoId: "a2", viewCount: 1000, publishedAt: daysAgo(20) }),
    ]);
    mocks.listVideoSummaries.mockImplementation((videoIds: string[]) =>
      Promise.resolve(
        new Map(
          videoIds.flatMap((videoId) => {
            const found = byId.get(videoId);
            return found ? [[videoId, found] as const] : [];
          }),
        ),
      ),
    );

    const rows = await YoutubeResearchService.getOutliers({
      projectId: "project-1",
      windowDays: 180,
      minScore: 1.5,
      userId: "user-1",
    });

    expect(rows).toEqual([]);
  });
});

describe("YoutubeResearchService.getChannelStats", () => {
  it("resolves a handle, samples uploads, and returns baseline stats", async () => {
    mocks.getConnection.mockResolvedValue(connection());
    mocks.getChannelByHandle.mockResolvedValue(youtubeChannel());
    mocks.listUploadedVideoIds.mockResolvedValue(["v1"]);
    mocks.listVideoSummaries.mockResolvedValue(
      summaryMap([video({ videoId: "v1", viewCount: 1000 })]),
    );

    const result = await YoutubeResearchService.getChannelStats({
      projectId: "project-1",
      channel: "https://youtube.com/@alpha",
    });

    expect(mocks.getChannelByHandle).toHaveBeenCalledWith("@alpha");
    expect(mocks.listUploadedVideoIds).toHaveBeenCalledWith(PLAYLIST_A, 30);
    expect(result).toMatchObject({
      channel: { channelId: CHANNEL_A, channelTitle: "Alpha Channel" },
      sampleSize: 1,
      medianViews: 1000,
      averageViews: 1000,
    });
    expect(result.recentVideos).toHaveLength(1);
  });

  it("rejects an unparseable channel reference", async () => {
    await expect(
      YoutubeResearchService.getChannelStats({
        projectId: "project-1",
        channel: "definitely not a channel",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("reports NOT_FOUND when the channel does not exist", async () => {
    mocks.getConnection.mockResolvedValue(connection());
    mocks.getChannelByHandle.mockResolvedValue(null);

    await expect(
      YoutubeResearchService.getChannelStats({
        projectId: "project-1",
        channel: "@missing",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("YoutubeResearchService.compareChannels", () => {
  function stubChannel() {
    mocks.getConnection.mockResolvedValue(connection());
    mocks.getChannelByHandle.mockResolvedValue(youtubeChannel());
    mocks.getChannel.mockResolvedValue(youtubeChannel());
    mocks.listUploadedVideoIds.mockResolvedValue(["v1", "v2", "v3"]);
    mocks.listVideoSummaries.mockResolvedValue(
      summaryMap([
        video({ videoId: "v1", viewCount: 9000, publishedAt: daysAgo(5) }),
        video({ videoId: "v2", viewCount: 1000, publishedAt: daysAgo(40) }),
        video({ videoId: "v3", viewCount: 1000, publishedAt: daysAgo(60) }),
      ]),
    );
  }

  it("returns per-channel comparison rows", async () => {
    stubChannel();

    const rows = await YoutubeResearchService.compareChannels({
      projectId: "project-1",
      channels: ["@alpha", CHANNEL_B],
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      subscriberCount: 1000,
      uploadsLast30Days: 1,
      medianViews: 1000,
      outlierCount: 1,
      topVideo: { videoId: "v1", views: 9000 },
    });
  });

  it("caps the comparison at five channels", async () => {
    stubChannel();

    const rows = await YoutubeResearchService.compareChannels({
      projectId: "project-1",
      channels: ["@chan1", "@chan2", "@chan3", "@chan4", "@chan5", "@chan6"],
    });

    expect(rows).toHaveLength(5);
  });

  it("rejects an invalid channel reference in the batch", async () => {
    stubChannel();

    await expect(
      YoutubeResearchService.compareChannels({
        projectId: "project-1",
        channels: ["@alpha", "???"],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("YoutubeResearchService.getTrendingVideos", () => {
  it("maps the mostPopular chart into scored rows", async () => {
    mocks.getConnection.mockResolvedValue(connection());
    mocks.listMostPopular.mockResolvedValue([
      video({ videoId: "t1", viewCount: 1000 }),
      video({ videoId: "t2", viewCount: 5000 }),
    ]);

    const rows = await YoutubeResearchService.getTrendingVideos({
      projectId: "project-1",
    });

    expect(mocks.listMostPopular).toHaveBeenCalledWith({
      regionCode: "US",
      videoCategoryId: undefined,
      maxResults: 25,
    });
    expect(rows.map((row) => row.videoId)).toEqual(["t1", "t2"]);
    expect(rows[1]).toMatchObject({ views: 5000, outlierScore: 1.67 });
    expect(rows[0]?.vph).toBeNull();
  });

  it("passes region and category through", async () => {
    mocks.getConnection.mockResolvedValue(connection());
    mocks.listMostPopular.mockResolvedValue([]);

    await YoutubeResearchService.getTrendingVideos({
      projectId: "project-1",
      regionCode: "GB",
      videoCategoryId: "10",
      limit: 10,
    });

    expect(mocks.listMostPopular).toHaveBeenCalledWith({
      regionCode: "GB",
      videoCategoryId: "10",
      maxResults: 10,
    });
  });
});

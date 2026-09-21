/* eslint-disable max-lines -- one spec covers ideas, cache/TTL, scoring, gaps, and comparisons */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { YoutubeVideoSummary } from "@/server/lib/youtubeClient";
import { YoutubeDataApiError } from "@/server/lib/youtubeErrors";
import type {
  YoutubeKeywordQuery,
  YoutubeKeywordVideo,
} from "@/server/features/youtube/repositories/YoutubeKeywordRepository";
import type { YoutubeResearchChannel } from "@/server/features/youtube/repositories/YoutubeResearchRepository";
import {
  KEYWORD_CACHE_TTL_MS,
  KEYWORD_SAMPLE_SIZE,
  MAX_IDEA_SEED_LETTERS,
  YoutubeKeywordService,
} from "./YoutubeKeywordService";

const NOW = new Date("2026-09-21T12:00:00.000Z");
const PROJECT_ID = "project-1";
const CHANNEL_A = "UCabcdefghijklmnopqrstuv";
const CHANNEL_B = "UCzyxwvutsrqponmlkjihgfe";
const PLAYLIST_A = "UUabcdefghijklmnopqrstuv";
const PLAYLIST_B = "UUzyxwvutsrqponmlkjihgfe";

const mocks = vi.hoisted(() => {
  const state = { grants: [] as { accountId: string }[] };
  return {
    state,
    getConnection: vi.fn(),
    getResearchChannel: vi.fn(),
    getQuery: vi.fn(),
    listVideos: vi.fn(),
    replaceQuery: vi.fn(),
    createYoutubeDataClient: vi.fn(),
    searchVideoIds: vi.fn(),
    listVideoSummaries: vi.fn(),
    listUploadedVideoIds: vi.fn(),
    getChannel: vi.fn(),
    getChannelByHandle: vi.fn(),
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
      getByProjectAndChannel: mocks.getResearchChannel,
    },
  }),
);
vi.mock(
  "@/server/features/youtube/repositories/YoutubeKeywordRepository",
  () => ({
    YoutubeKeywordRepository: {
      getQuery: mocks.getQuery,
      listVideos: mocks.listVideos,
      replaceQuery: mocks.replaceQuery,
    },
  }),
);

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

function video(
  overrides: Partial<YoutubeVideoSummary> = {},
): YoutubeVideoSummary {
  return {
    videoId: "video-1",
    title: "Video 1",
    publishedAt: daysAgo(10),
    durationSeconds: 120,
    viewCount: 1000,
    likeCount: 10,
    commentCount: 2,
    thumbnailUrl: null,
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

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: "connection-1",
    projectId: PROJECT_ID,
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
    projectId: PROJECT_ID,
    organizationId: "org-1",
    channelId: CHANNEL_B,
    channelTitle: "Beta Channel",
    channelHandle: "@beta",
    channelThumbnailUrl: null,
    uploadsPlaylistId: PLAYLIST_B,
    subscriberCount: 500,
    videoCount: 10,
    viewCount: 5000,
    lastRefreshedAt: "2026-09-01T00:00:00.000Z",
    addedByUserId: "user-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function queryRow(
  overrides: Partial<YoutubeKeywordQuery> = {},
): YoutubeKeywordQuery {
  return {
    id: "query-1",
    keyword: "minecraft survival",
    regionCode: "US",
    sampleSize: 1,
    medianViews: 1000,
    averageViews: 1000,
    medianViewsPerDay: 100,
    capturedAt: NOW.toISOString(),
    ...overrides,
  };
}

function storedVideo(
  overrides: Partial<YoutubeKeywordVideo> = {},
): YoutubeKeywordVideo {
  return {
    id: "stored-1",
    queryId: "query-1",
    videoId: "v1",
    title: "One",
    channelId: CHANNEL_A,
    channelTitle: "Owned Channel",
    views: 1000,
    publishedAt: daysAgo(10),
    durationSeconds: 120,
    position: 0,
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

function suggestBody(suggestions: string[]): string {
  const payload = suggestions.map((suggestion) => [suggestion, 0, [512]]);
  return `window.google.ac.h(["q",${JSON.stringify(payload)},{"k":1}])`;
}

function stubSuggest(byQuery: Record<string, string[]>) {
  const fetchMock = vi.fn(async (url: string) => {
    const query = new URL(url).searchParams.get("q") ?? "";
    return new Response(suggestBody(byQuery[query] ?? []), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  mocks.state.grants = [{ accountId: "account-1" }];
  mocks.dbSelect.mockImplementation(() => ({
    from: () => ({ where: () => Promise.resolve(mocks.state.grants) }),
  }));
  mocks.createYoutubeDataClient.mockReturnValue({
    getChannel: mocks.getChannel,
    getChannelByHandle: mocks.getChannelByHandle,
    listUploadedVideoIds: mocks.listUploadedVideoIds,
    listVideoSummaries: mocks.listVideoSummaries,
    searchVideoIds: mocks.searchVideoIds,
  });
  mocks.getConnection.mockResolvedValue(connection());
  mocks.getResearchChannel.mockResolvedValue(null);
  mocks.getQuery.mockResolvedValue(null);
  mocks.listVideos.mockResolvedValue([]);
  mocks.replaceQuery.mockImplementation(
    async (input: Omit<YoutubeKeywordQuery, "id">) => ({
      id: "query-1",
      ...input,
    }),
  );
  mocks.searchVideoIds.mockResolvedValue([]);
  mocks.listVideoSummaries.mockResolvedValue(new Map());
  mocks.listUploadedVideoIds.mockResolvedValue([]);
  mocks.getChannel.mockResolvedValue(null);
  mocks.getChannelByHandle.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("getKeywordPerformance", () => {
  it("serves a fresh cache row without calling YouTube", async () => {
    mocks.getQuery.mockResolvedValue(
      queryRow({ capturedAt: new Date(NOW.getTime() - 60_000).toISOString() }),
    );
    mocks.listVideos.mockResolvedValue([
      storedVideo({ videoId: "v1", views: 1000, publishedAt: daysAgo(10) }),
    ]);

    const result = await YoutubeKeywordService.getKeywordPerformance({
      projectId: PROJECT_ID,
      userId: "user-1",
      keyword: "  Minecraft   Survival ",
      regionCode: "us",
    });

    expect(mocks.getQuery).toHaveBeenCalledWith("minecraft survival", "US");
    expect(mocks.searchVideoIds).not.toHaveBeenCalled();
    expect(mocks.replaceQuery).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      keyword: "minecraft survival",
      regionCode: "US",
      sampleSize: 1,
      medianViews: 1000,
      averageViews: 1000,
      medianViewsPerDay: 100,
      capturedAt: new Date(NOW.getTime() - 60_000).toISOString(),
    });
    expect(result.videos).toEqual([
      {
        videoId: "v1",
        title: "One",
        channelId: CHANNEL_A,
        channelTitle: "Owned Channel",
        views: 1000,
        publishedAt: daysAgo(10),
        durationSeconds: 120,
        position: 0,
        viewsPerDay: 100,
      },
    ]);
  });

  it("refreshes a stale cache and writes rounded medians with child rows", async () => {
    mocks.getQuery.mockResolvedValue(
      queryRow({
        capturedAt: new Date(
          NOW.getTime() - KEYWORD_CACHE_TTL_MS - 1_000,
        ).toISOString(),
      }),
    );
    mocks.searchVideoIds.mockResolvedValue(["v1", "v2", "v3"]);
    mocks.listVideoSummaries.mockResolvedValue(
      summaryMap([
        video({ videoId: "v1", title: "One", viewCount: 100 }),
        video({ videoId: "v2", title: "Two", viewCount: 250 }),
        video({ videoId: "v3", title: "Three", viewCount: 1000 }),
      ]),
    );

    const result = await YoutubeKeywordService.getKeywordPerformance({
      projectId: PROJECT_ID,
      userId: "user-1",
      keyword: "minecraft survival",
    });

    expect(mocks.searchVideoIds).toHaveBeenCalledWith({
      query: "minecraft survival",
      maxResults: KEYWORD_SAMPLE_SIZE,
      regionCode: "US",
    });
    expect(mocks.replaceQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        keyword: "minecraft survival",
        regionCode: "US",
        sampleSize: 3,
        medianViews: 250,
        averageViews: 450,
        medianViewsPerDay: 25,
        videos: [
          expect.objectContaining({ videoId: "v1", position: 0, views: 100 }),
          expect.objectContaining({ videoId: "v2", position: 1, views: 250 }),
          expect.objectContaining({ videoId: "v3", position: 2, views: 1000 }),
        ],
      }),
    );
    expect(result).toMatchObject({
      sampleSize: 3,
      medianViews: 250,
      averageViews: 450,
      medianViewsPerDay: 25,
    });
    expect(result.videos.map((entry) => entry.viewsPerDay)).toEqual([
      10, 25, 100,
    ]);
  });

  it("bypasses a fresh cache when force is set", async () => {
    mocks.getQuery.mockResolvedValue(queryRow());
    mocks.searchVideoIds.mockResolvedValue(["v1"]);
    mocks.listVideoSummaries.mockResolvedValue(
      summaryMap([video({ videoId: "v1" })]),
    );

    await YoutubeKeywordService.getKeywordPerformance({
      projectId: PROJECT_ID,
      userId: "user-1",
      keyword: "minecraft survival",
      force: true,
    });

    expect(mocks.searchVideoIds).toHaveBeenCalledTimes(1);
    expect(mocks.replaceQuery).toHaveBeenCalledTimes(1);
  });

  it("fails with a validation error when the search returns no videos", async () => {
    mocks.searchVideoIds.mockResolvedValue([]);

    await expect(
      YoutubeKeywordService.getKeywordPerformance({
        projectId: PROJECT_ID,
        userId: "user-1",
        keyword: "minecraft survival",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "YouTube returned no videos for that keyword.",
    });
    expect(mocks.replaceQuery).not.toHaveBeenCalled();
  });

  it("uses the owned connection's grant before the caller's", async () => {
    mocks.searchVideoIds.mockResolvedValue(["v1"]);
    mocks.listVideoSummaries.mockResolvedValue(
      summaryMap([video({ videoId: "v1" })]),
    );

    await YoutubeKeywordService.getKeywordPerformance({
      projectId: PROJECT_ID,
      userId: "user-1",
      keyword: "minecraft survival",
    });

    expect(mocks.createYoutubeDataClient).toHaveBeenCalledWith({
      userId: "owner-1",
      youtubeAccountId: "owner-account",
    });
  });

  it("falls back to the caller's google-youtube grant", async () => {
    mocks.getConnection.mockResolvedValue(null);
    mocks.searchVideoIds.mockResolvedValue(["v1"]);
    mocks.listVideoSummaries.mockResolvedValue(
      summaryMap([video({ videoId: "v1" })]),
    );

    await YoutubeKeywordService.getKeywordPerformance({
      projectId: PROJECT_ID,
      userId: "user-1",
      keyword: "minecraft survival",
    });

    expect(mocks.createYoutubeDataClient).toHaveBeenCalledWith({
      userId: "user-1",
      youtubeAccountId: "account-1",
    });
  });

  it("rejects an empty keyword", async () => {
    await expect(
      YoutubeKeywordService.getKeywordPerformance({
        projectId: PROJECT_ID,
        keyword: "   ",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(mocks.getQuery).not.toHaveBeenCalled();
  });
});

describe("getKeywordIdeas", () => {
  it("dedupes autocomplete first, then tags, then titles", async () => {
    stubSuggest({
      minecraft: ["Minecraft Survival", "minecraft survival guide"],
      "minecraft a": ["minecraft armor"],
    });
    mocks.searchVideoIds.mockResolvedValue(["v1"]);
    mocks.listVideoSummaries.mockResolvedValue(
      summaryMap([
        video({
          videoId: "v1",
          title: "Minecraft Survival Guide",
          tags: ["minecraft survival", "official video"],
        }),
      ]),
    );

    const result = await YoutubeKeywordService.getKeywordIdeas({
      projectId: PROJECT_ID,
      userId: "user-1",
      seed: "  Minecraft ",
      regionCode: "us",
    });

    expect(result.seed).toBe("minecraft");
    expect(result.warnings).toEqual([]);
    expect(result.ideas).toEqual([
      { phrase: "minecraft survival", source: "autocomplete", position: 0 },
      {
        phrase: "minecraft survival guide",
        source: "autocomplete",
        position: 1,
      },
      { phrase: "minecraft armor", source: "autocomplete", position: 2 },
      { phrase: "survival guide", source: "title", position: 3 },
    ]);
    expect(mocks.searchVideoIds).toHaveBeenCalledWith({
      query: "minecraft",
      maxResults: 10,
      regionCode: "US",
    });
  });

  it("queries the seed plus one autocomplete query per seed letter", async () => {
    const fetchMock = stubSuggest({ minecraft: ["minecraft armor"] });
    mocks.searchVideoIds.mockResolvedValue([]);

    await YoutubeKeywordService.getKeywordIdeas({
      projectId: PROJECT_ID,
      userId: "user-1",
      seed: "minecraft",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1 + MAX_IDEA_SEED_LETTERS);
    const queries = fetchMock.mock.calls.map(
      (call) => new URL(call[0]).searchParams.get("q") ?? "",
    );
    expect(queries[0]).toBe("minecraft");
    expect(queries).toContain("minecraft a");
    expect(queries).toContain("minecraft l");
  });

  it("caps ideas at the requested limit", async () => {
    stubSuggest({
      minecraft: ["minecraft armor", "minecraft house", "minecraft farm"],
    });
    mocks.searchVideoIds.mockResolvedValue([]);

    const result = await YoutubeKeywordService.getKeywordIdeas({
      projectId: PROJECT_ID,
      userId: "user-1",
      seed: "minecraft",
      limit: 2,
    });

    expect(result.ideas.map((idea) => idea.phrase)).toEqual([
      "minecraft armor",
      "minecraft house",
    ]);
  });

  it("degrades to tag/title phrases when autocomplete is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    mocks.searchVideoIds.mockResolvedValue(["v1"]);
    mocks.listVideoSummaries.mockResolvedValue(
      summaryMap([
        video({
          videoId: "v1",
          title: "Redstone Tutorial",
          tags: ["redstone tutorial"],
        }),
      ]),
    );

    const result = await YoutubeKeywordService.getKeywordIdeas({
      projectId: PROJECT_ID,
      userId: "user-1",
      seed: "minecraft",
    });

    expect(result.warnings).toEqual(["autocomplete_unavailable"]);
    expect(result.ideas).toEqual([
      { phrase: "redstone tutorial", source: "tag", position: 0 },
    ]);
  });

  it("degrades to autocomplete-only when the search step fails", async () => {
    stubSuggest({ minecraft: ["minecraft armor"] });
    mocks.searchVideoIds.mockRejectedValue(
      new YoutubeDataApiError(403, "quota", "quotaExceeded"),
    );

    const result = await YoutubeKeywordService.getKeywordIdeas({
      projectId: PROJECT_ID,
      userId: "user-1",
      seed: "minecraft",
    });

    expect(result.warnings).toEqual(["search_unavailable"]);
    expect(result.ideas).toEqual([
      { phrase: "minecraft armor", source: "autocomplete", position: 0 },
    ]);
  });

  it("reports both warnings when autocomplete and search both fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    mocks.searchVideoIds.mockRejectedValue(new Error("boom"));

    const result = await YoutubeKeywordService.getKeywordIdeas({
      projectId: PROJECT_ID,
      userId: "user-1",
      seed: "minecraft",
    });

    expect(result.warnings).toEqual([
      "autocomplete_unavailable",
      "search_unavailable",
    ]);
    expect(result.ideas).toEqual([]);
  });

  it("rejects an empty seed", async () => {
    await expect(
      YoutubeKeywordService.getKeywordIdeas({
        projectId: PROJECT_ID,
        seed: "  ",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("getHighPerformanceKeywords", () => {
  it("scores the owned channel's sampled uploads into terms", async () => {
    mocks.listUploadedVideoIds.mockResolvedValue(["v1", "v2", "v3"]);
    mocks.listVideoSummaries.mockResolvedValue(
      summaryMap([
        video({
          videoId: "v1",
          title: "Minecraft Survival Guide",
          tags: ["minecraft survival"],
          viewCount: 1000,
          publishedAt: daysAgo(10),
        }),
        video({
          videoId: "v2",
          title: "Minecraft Survival Tips",
          tags: ["minecraft survival"],
          viewCount: 3000,
          publishedAt: daysAgo(20),
        }),
        video({
          videoId: "v3",
          title: "Unrelated Vlog",
          viewCount: 100,
          publishedAt: daysAgo(5),
        }),
      ]),
    );

    const result = await YoutubeKeywordService.getHighPerformanceKeywords({
      projectId: PROJECT_ID,
      userId: "user-1",
    });

    expect(mocks.listUploadedVideoIds).toHaveBeenCalledWith(PLAYLIST_A, 100);
    expect(result.channel).toEqual({
      channelId: CHANNEL_A,
      channelTitle: "Owned Channel",
      channelHandle: "@owned",
      channelThumbnailUrl: null,
    });
    expect(result.keywords).toEqual([
      {
        term: "minecraft survival",
        videoCount: 2,
        medianOutlierScore: 2,
        averageViews: 2000,
        exampleVideoIds: ["v2", "v1"],
      },
    ]);
  });

  it("accepts a tracked research channel", async () => {
    mocks.getResearchChannel.mockResolvedValue(researchChannel());
    mocks.listUploadedVideoIds.mockResolvedValue([]);

    const result = await YoutubeKeywordService.getHighPerformanceKeywords({
      projectId: PROJECT_ID,
      userId: "user-1",
      channelId: CHANNEL_B,
    });

    expect(mocks.getResearchChannel).toHaveBeenCalledWith(
      PROJECT_ID,
      CHANNEL_B,
    );
    expect(mocks.listUploadedVideoIds).toHaveBeenCalledWith(PLAYLIST_B, 100);
    expect(result.channel.channelId).toBe(CHANNEL_B);
    expect(result.keywords).toEqual([]);
  });

  it("rejects a channel that is neither owned nor tracked", async () => {
    await expect(
      YoutubeKeywordService.getHighPerformanceKeywords({
        projectId: PROJECT_ID,
        userId: "user-1",
        channelId: CHANNEL_B,
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "That channel isn't tracked for this project.",
    });
  });

  it("requires a connection when no channel is named", async () => {
    mocks.getConnection.mockResolvedValue(null);

    await expect(
      YoutubeKeywordService.getHighPerformanceKeywords({
        projectId: PROJECT_ID,
        userId: "user-1",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Connect a YouTube account before researching channels.",
    });
  });
});

describe("getKeywordGap", () => {
  it("compares the owned channel with a resolved competitor", async () => {
    mocks.getChannel.mockResolvedValue({
      channelId: CHANNEL_B,
      title: "Beta Channel",
      handle: "@beta",
      thumbnailUrl: null,
      uploadsPlaylistId: PLAYLIST_B,
      subscriberCount: 500,
      videoCount: 10,
      viewCount: 5000,
    });
    mocks.listUploadedVideoIds
      .mockResolvedValueOnce(["v1", "v2"])
      .mockResolvedValueOnce(["v3", "v4", "v5"]);
    mocks.listVideoSummaries
      .mockResolvedValueOnce(
        summaryMap([
          video({
            videoId: "v1",
            title: "Minecraft Survival Guide",
            tags: ["minecraft survival"],
            viewCount: 1000,
            publishedAt: daysAgo(10),
          }),
          video({
            videoId: "v2",
            title: "Minecraft Survival Tips",
            tags: ["minecraft survival"],
            viewCount: 3000,
            publishedAt: daysAgo(20),
          }),
        ]),
      )
      .mockResolvedValueOnce(
        summaryMap([
          video({
            videoId: "v3",
            title: "Redstone Tutorial",
            tags: ["redstone tutorial"],
            viewCount: 1000,
            publishedAt: daysAgo(10),
          }),
          video({
            videoId: "v4",
            title: "Redstone Tutorial Advanced",
            tags: ["redstone tutorial"],
            viewCount: 3000,
            publishedAt: daysAgo(20),
          }),
          video({
            videoId: "v5",
            title: "Minecraft Survival Guide",
            tags: ["minecraft survival"],
            viewCount: 500,
            publishedAt: daysAgo(10),
          }),
        ]),
      );

    const result = await YoutubeKeywordService.getKeywordGap({
      projectId: PROJECT_ID,
      userId: "user-1",
      competitorChannel: `https://www.youtube.com/channel/${CHANNEL_B}`,
    });

    expect(mocks.getChannel).toHaveBeenCalledWith(CHANNEL_B);
    expect(result.you.map((term) => term.term)).toEqual(["minecraft survival"]);
    expect(result.competitor.map((term) => term.term)).toEqual([
      "redstone tutorial",
    ]);
    expect(result.gaps.map((term) => term.term)).toEqual(["redstone tutorial"]);
    expect(result.competitorChannel).toEqual({
      channelId: CHANNEL_B,
      channelTitle: "Beta Channel",
      channelHandle: "@beta",
      channelThumbnailUrl: null,
    });
  });

  it("resolves an @handle competitor", async () => {
    mocks.getChannelByHandle.mockResolvedValue({
      channelId: CHANNEL_B,
      title: "Beta Channel",
      handle: "@beta",
      thumbnailUrl: null,
      uploadsPlaylistId: PLAYLIST_B,
      subscriberCount: 500,
      videoCount: 10,
      viewCount: 5000,
    });
    mocks.listUploadedVideoIds.mockResolvedValue([]);

    await YoutubeKeywordService.getKeywordGap({
      projectId: PROJECT_ID,
      userId: "user-1",
      competitorChannel: "@beta",
    });

    expect(mocks.getChannelByHandle).toHaveBeenCalledWith("@beta");
  });

  it("rejects an unparseable competitor reference", async () => {
    await expect(
      YoutubeKeywordService.getKeywordGap({
        projectId: PROJECT_ID,
        userId: "user-1",
        competitorChannel: "not a channel",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(mocks.getChannel).not.toHaveBeenCalled();
  });

  it("reports a competitor that YouTube cannot find", async () => {
    mocks.getChannel.mockResolvedValue(null);

    await expect(
      YoutubeKeywordService.getKeywordGap({
        projectId: PROJECT_ID,
        userId: "user-1",
        competitorChannel: CHANNEL_B,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("compareKeywords", () => {
  it("returns per-keyword rows and isolates a no-results keyword", async () => {
    mocks.searchVideoIds.mockImplementation(
      async ({ query }: { query: string }) =>
        query === "good one" ? ["v1"] : [],
    );
    mocks.listVideoSummaries.mockResolvedValue(
      summaryMap([video({ videoId: "v1", viewCount: 1000 })]),
    );

    const result = await YoutubeKeywordService.compareKeywords({
      projectId: PROJECT_ID,
      userId: "user-1",
      keywords: ["Good One", "bad one"],
    });

    expect(result.rows).toEqual([
      {
        keyword: "good one",
        capturedAt: NOW.toISOString(),
        cached: false,
        medianViews: 1000,
        medianViewsPerDay: 100,
        sampleSize: 1,
      },
      { keyword: "bad one", error: "no_results" },
    ]);
  });

  it("marks an upstream failure as unavailable without failing the batch", async () => {
    mocks.searchVideoIds.mockRejectedValue(
      new YoutubeDataApiError(500, "boom"),
    );

    const result = await YoutubeKeywordService.compareKeywords({
      projectId: PROJECT_ID,
      userId: "user-1",
      keywords: ["first", "second"],
    });

    expect(result.rows).toEqual([
      { keyword: "first", error: "unavailable" },
      { keyword: "second", error: "unavailable" },
    ]);
  });

  it("serves cached keywords without a search", async () => {
    mocks.getQuery.mockResolvedValue(queryRow());
    mocks.listVideos.mockResolvedValue([storedVideo()]);

    const result = await YoutubeKeywordService.compareKeywords({
      projectId: PROJECT_ID,
      userId: "user-1",
      keywords: ["minecraft survival"],
    });

    expect(mocks.searchVideoIds).not.toHaveBeenCalled();
    expect(result.rows[0]).toMatchObject({
      keyword: "minecraft survival",
      cached: true,
      sampleSize: 1,
      medianViews: 1000,
    });
  });
});

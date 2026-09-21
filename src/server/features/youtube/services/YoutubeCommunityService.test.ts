import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { YoutubeCommentSummary } from "@/server/lib/youtubeClient";
import {
  SEARCH_QUOTA_WARNING,
  YoutubeCommunityService,
} from "./YoutubeCommunityService";

const PROJECT_ID = "project-1";
const VIDEO_ID = "dQw4w9WgXcQ";

const JSONP_BODY =
  'window.google.ac.h(["minecraft",[["minecraft",0,[512]],["minecraft video",0,[512,433]],["minecraft house",0,[512,433]]],{"k":1}])';

const mocks = vi.hoisted(() => ({
  getConnection: vi.fn(),
  listCommentThreads: vi.fn(),
  searchVideos: vi.fn(),
  createYoutubeDataClient: vi.fn(),
}));

vi.mock("@/server/lib/youtubeClient", () => ({
  createYoutubeDataClient: mocks.createYoutubeDataClient,
}));

vi.mock(
  "@/server/features/youtube/repositories/YoutubeConnectionRepository",
  () => ({
    YoutubeConnectionRepository: { getByProjectId: mocks.getConnection },
  }),
);

function stubAutocompleteFetch(handler: (url: string) => Promise<Response>) {
  const fetchMock = vi.fn<(url: string) => Promise<Response>>(handler);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const CONNECTION = {
  id: "connection-1",
  projectId: PROJECT_ID,
  organizationId: "org-1",
  channelId: "UCabcdefghijklmnopqrstuv",
  channelTitle: "Owned Channel",
  channelHandle: "@owned",
  channelThumbnailUrl: null,
  uploadsPlaylistId: "UUabcdefghijklmnopqrstuv",
  connectedByUserId: "owner-1",
  youtubeAccountId: "owner-account",
  connectedAccountEmail: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function comment(overrides: Partial<YoutubeCommentSummary> = {}) {
  return {
    commentId: "comment-1",
    authorDisplayName: "Alice",
    text: "Great video",
    likeCount: 3,
    publishedAt: "2026-09-01T00:00:00.000Z",
    replyCount: 0,
    isReplyThread: false,
    ...overrides,
  } satisfies YoutubeCommentSummary;
}

beforeEach(() => {
  mocks.createYoutubeDataClient.mockReturnValue({
    listCommentThreads: mocks.listCommentThreads,
    searchVideos: mocks.searchVideos,
  });
  mocks.getConnection.mockResolvedValue(CONNECTION);
  mocks.listCommentThreads.mockResolvedValue({
    comments: [],
    nextPageToken: null,
  });
  mocks.searchVideos.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getVideoComments", () => {
  it("fails with youtube_not_connected when the project has no connection", async () => {
    mocks.getConnection.mockResolvedValue(null);

    await expect(
      YoutubeCommunityService.getVideoComments({
        projectId: PROJECT_ID,
        videoId: VIDEO_ID,
      }),
    ).rejects.toMatchObject({ code: "youtube_not_connected" });
    expect(mocks.createYoutubeDataClient).not.toHaveBeenCalled();
  });

  it("rejects an invalid videoId before touching the connection", async () => {
    await expect(
      YoutubeCommunityService.getVideoComments({
        projectId: PROJECT_ID,
        videoId: "too-short",
      }),
    ).rejects.toMatchObject({ code: "validation_error" });
    expect(mocks.getConnection).not.toHaveBeenCalled();
  });

  it("uses the connection's grant and returns comments with the page token", async () => {
    const comments = [comment()];
    mocks.listCommentThreads.mockResolvedValue({
      comments,
      nextPageToken: "page-2",
    });

    const result = await YoutubeCommunityService.getVideoComments({
      projectId: PROJECT_ID,
      videoId: VIDEO_ID,
    });

    expect(mocks.createYoutubeDataClient).toHaveBeenCalledWith({
      userId: "owner-1",
      youtubeAccountId: "owner-account",
    });
    expect(mocks.listCommentThreads).toHaveBeenCalledWith({
      videoId: VIDEO_ID,
      maxResults: 20,
      order: "relevance",
    });
    expect(result).toEqual({
      videoId: VIDEO_ID,
      comments,
      nextPageToken: "page-2",
    });
  });

  it("clamps the limit to 1..100 and passes the order through", async () => {
    await YoutubeCommunityService.getVideoComments({
      projectId: PROJECT_ID,
      videoId: VIDEO_ID,
      limit: 1000,
      order: "time",
    });
    expect(mocks.listCommentThreads).toHaveBeenLastCalledWith({
      videoId: VIDEO_ID,
      maxResults: 100,
      order: "time",
    });

    await YoutubeCommunityService.getVideoComments({
      projectId: PROJECT_ID,
      videoId: VIDEO_ID,
      limit: 0,
    });
    expect(mocks.listCommentThreads).toHaveBeenLastCalledWith({
      videoId: VIDEO_ID,
      maxResults: 1,
      order: "relevance",
    });
  });
});

describe("searchVideos", () => {
  it("fails with youtube_not_connected when the project has no connection", async () => {
    mocks.getConnection.mockResolvedValue(null);

    await expect(
      YoutubeCommunityService.searchVideos({
        projectId: PROJECT_ID,
        query: "minecraft tips",
      }),
    ).rejects.toMatchObject({ code: "youtube_not_connected" });
  });

  it("rejects an empty query before touching the connection", async () => {
    await expect(
      YoutubeCommunityService.searchVideos({
        projectId: PROJECT_ID,
        query: "   ",
      }),
    ).rejects.toMatchObject({ code: "validation_error" });
    expect(mocks.getConnection).not.toHaveBeenCalled();
  });

  it("trims the query, clamps maxResults, and warns about quota", async () => {
    mocks.searchVideos.mockResolvedValue([
      { videoId: VIDEO_ID, title: "A video" },
    ]);

    const result = await YoutubeCommunityService.searchVideos({
      projectId: PROJECT_ID,
      query: "  minecraft tips  ",
      maxResults: 500,
    });

    expect(mocks.searchVideos).toHaveBeenCalledWith({
      query: "minecraft tips",
      maxResults: 50,
      order: "relevance",
    });
    expect(result.query).toBe("minecraft tips");
    expect(result.results).toEqual([{ videoId: VIDEO_ID, title: "A video" }]);
    expect(result.warnings).toEqual([SEARCH_QUOTA_WARNING]);
  });
});

describe("getKeywordHints", () => {
  it("parses a JSONP autocomplete body via fetch without a connection", async () => {
    mocks.getConnection.mockResolvedValue(null);
    const fetchMock = stubAutocompleteFetch(
      async () => new Response(JSONP_BODY, { status: 200 }),
    );

    const result = await YoutubeCommunityService.getKeywordHints({
      projectId: PROJECT_ID,
      query: "minecraft",
    });

    expect(mocks.getConnection).not.toHaveBeenCalled();
    expect(result).toEqual({
      query: "minecraft",
      hints: ["minecraft", "minecraft video", "minecraft house"],
      warnings: [],
    });
    const url = new URL(fetchMock.mock.calls[0]?.[0] ?? "");
    expect(url.searchParams.get("client")).toBe("youtube");
    expect(url.searchParams.get("q")).toBe("minecraft");
  });

  it("slices hints to the clamped limit", async () => {
    stubAutocompleteFetch(
      async () => new Response(JSONP_BODY, { status: 200 }),
    );

    const result = await YoutubeCommunityService.getKeywordHints({
      projectId: PROJECT_ID,
      query: "minecraft",
      limit: 2,
    });

    expect(result.hints).toEqual(["minecraft", "minecraft video"]);
  });

  it("falls back to an empty list with a warning on a garbage body", async () => {
    stubAutocompleteFetch(async () => new Response("<html>nope</html>"));

    const result = await YoutubeCommunityService.getKeywordHints({
      projectId: PROJECT_ID,
      query: "minecraft",
    });

    expect(result).toEqual({
      query: "minecraft",
      hints: [],
      warnings: ["autocomplete_unavailable"],
    });
  });

  it("falls back to an empty list with a warning when fetch fails", async () => {
    stubAutocompleteFetch(async () => {
      throw new Error("offline");
    });

    const result = await YoutubeCommunityService.getKeywordHints({
      projectId: PROJECT_ID,
      query: "minecraft",
    });

    expect(result).toEqual({
      query: "minecraft",
      hints: [],
      warnings: ["autocomplete_unavailable"],
    });
  });

  it("falls back to an empty list with a warning on a non-ok response", async () => {
    stubAutocompleteFetch(
      async () => new Response("rate limited", { status: 429 }),
    );

    const result = await YoutubeCommunityService.getKeywordHints({
      projectId: PROJECT_ID,
      query: "minecraft",
    });

    expect(result).toEqual({
      query: "minecraft",
      hints: [],
      warnings: ["autocomplete_unavailable"],
    });
  });

  it("rejects an empty query", async () => {
    await expect(
      YoutubeCommunityService.getKeywordHints({
        projectId: PROJECT_ID,
        query: "  ",
      }),
    ).rejects.toMatchObject({ code: "validation_error" });
  });
});

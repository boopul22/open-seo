import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createYoutubeDataClient,
  normalizeYoutubeChannelRef,
} from "./youtubeClient";

const authMocks = vi.hoisted(() => ({ getAccessToken: vi.fn() }));

vi.mock("@/lib/auth", () => ({
  getAuth: () => ({ api: authMocks }),
}));

const UC_ID = "UCX6OQ3DkcsbYNE6H8uQQuVA";

describe("normalizeYoutubeChannelRef", () => {
  it("returns a channelId for a bare UC channel id", () => {
    expect(normalizeYoutubeChannelRef(UC_ID)).toEqual({ channelId: UC_ID });
  });

  it("normalizes an @handle to a handle ref", () => {
    expect(normalizeYoutubeChannelRef("@MrBeast")).toEqual({
      handle: "@MrBeast",
    });
  });

  it("normalizes a bare handle to a handle ref", () => {
    expect(normalizeYoutubeChannelRef("MrBeast")).toEqual({
      handle: "@MrBeast",
    });
  });

  it("trims surrounding whitespace before normalizing", () => {
    expect(normalizeYoutubeChannelRef("  @MrBeast  ")).toEqual({
      handle: "@MrBeast",
    });
  });

  it("extracts a handle from a youtube.com/@handle URL", () => {
    expect(
      normalizeYoutubeChannelRef("https://www.youtube.com/@MrBeast"),
    ).toEqual({ handle: "@MrBeast" });
  });

  it("extracts a channelId from a youtube.com/channel URL", () => {
    expect(
      normalizeYoutubeChannelRef(`https://www.youtube.com/channel/${UC_ID}`),
    ).toEqual({ channelId: UC_ID });
  });

  it("maps youtube.com/c and /user paths to handle refs", () => {
    expect(
      normalizeYoutubeChannelRef("https://www.youtube.com/c/SomeName"),
    ).toEqual({ handle: "@SomeName" });
    expect(
      normalizeYoutubeChannelRef("https://www.youtube.com/user/SomeName"),
    ).toEqual({ handle: "@SomeName" });
  });

  it("throws for a youtu.be short link", () => {
    expect(() => normalizeYoutubeChannelRef("https://youtu.be/x")).toThrow(
      "Unrecognized YouTube channel reference",
    );
  });

  it("throws for an empty string", () => {
    expect(() => normalizeYoutubeChannelRef("")).toThrow(
      "Unrecognized YouTube channel reference",
    );
  });
});

describe("listUploadedVideoIds", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    authMocks.getAccessToken.mockReset();
  });

  it("dedupes a video returned on two pages when the uploads playlist shifts", async () => {
    authMocks.getAccessToken.mockResolvedValue({ accessToken: "token" });
    const pages = [
      {
        items: [
          { contentDetails: { videoId: "aaaaaaaaaaa" } },
          { contentDetails: { videoId: "bbbbbbbbbbb" } },
        ],
        nextPageToken: "page-2",
      },
      {
        items: [
          { contentDetails: { videoId: "bbbbbbbbbbb" } },
          { contentDetails: { videoId: "ccccccccccc" } },
        ],
      },
    ];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => pages.shift() ?? { items: [] },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createYoutubeDataClient({
      userId: "user-1",
      youtubeAccountId: "account-1",
    });
    await expect(
      client.listUploadedVideoIds("UUaaaaaaaaaaaaaaaaaaaaaa", 10),
    ).resolves.toEqual(["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("searchVideoIds", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    authMocks.getAccessToken.mockReset();
  });

  it("follows nextPageToken, preserves order, and dedupes ids", async () => {
    authMocks.getAccessToken.mockResolvedValue({ accessToken: "token" });
    const pages = [
      {
        items: [
          { id: { videoId: "aaaaaaaaaaa" } },
          { id: { videoId: "bbbbbbbbbbb" } },
          { id: {} },
        ],
        nextPageToken: "page-2",
      },
      {
        items: [
          { id: { videoId: "bbbbbbbbbbb" } },
          { id: { videoId: "ccccccccccc" } },
        ],
      },
    ];
    const fetchMock = vi.fn(async (_input: string) => ({
      ok: true,
      status: 200,
      json: async () => pages.shift() ?? { items: [] },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createYoutubeDataClient({
      userId: "user-1",
      youtubeAccountId: "account-1",
    });
    await expect(
      client.searchVideoIds({ query: "lofi beats", maxResults: 4 }),
    ).resolves.toEqual(["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("type=video");
    expect(
      new URL(fetchMock.mock.calls[1]?.[0] ?? "").searchParams.get("pageToken"),
    ).toBe("page-2");
  });

  it("clamps maxResults into 1..50 in the request URL", async () => {
    authMocks.getAccessToken.mockResolvedValue({ accessToken: "token" });
    const requestedUrls: string[] = [];
    const fetchMock = vi.fn(async (input: string) => {
      requestedUrls.push(input);
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createYoutubeDataClient({
      userId: "user-1",
      youtubeAccountId: "account-1",
    });
    await client.searchVideoIds({ query: "x", maxResults: 999 });
    await client.searchVideoIds({ query: "x", maxResults: 0 });

    const maxResultsParams = requestedUrls.map((value) =>
      new URL(value).searchParams.get("maxResults"),
    );
    expect(maxResultsParams).toEqual(["50", "1"]);
  });
});

describe("listPlaylists", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    authMocks.getAccessToken.mockReset();
  });

  it("maps itemCount, thumbnail, and publishedAt, defaulting missing fields to null", async () => {
    authMocks.getAccessToken.mockResolvedValue({ accessToken: "token" });
    const fetchMock = vi.fn(async (_input: string) => ({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          {
            id: "PLaaaaaaaaaaaaaaaaaaaaaa",
            snippet: {
              title: "Tagged playlist",
              description: "desc",
              publishedAt: "2024-01-01T00:00:00Z",
              thumbnails: { high: { url: "https://example.com/high.jpg" } },
            },
            contentDetails: { itemCount: 7 },
          },
          {
            id: "PLbbbbbbbbbbbbbbbbbbbbbb",
            snippet: { title: "Sparse playlist" },
          },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createYoutubeDataClient({
      userId: "user-1",
      youtubeAccountId: "account-1",
    });
    await expect(client.listPlaylists({ channelId: UC_ID })).resolves.toEqual([
      {
        playlistId: "PLaaaaaaaaaaaaaaaaaaaaaa",
        title: "Tagged playlist",
        description: "desc",
        itemCount: 7,
        publishedAt: "2024-01-01T00:00:00Z",
        thumbnailUrl: "https://example.com/high.jpg",
      },
      {
        playlistId: "PLbbbbbbbbbbbbbbbbbbbbbb",
        title: "Sparse playlist",
        description: null,
        itemCount: null,
        publishedAt: null,
        thumbnailUrl: null,
      },
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toContain(`channelId=${UC_ID}`);
  });

  it("requests the authorized account's playlists when mine is true", async () => {
    authMocks.getAccessToken.mockResolvedValue({ accessToken: "token" });
    const fetchMock = vi.fn(async (_input: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ items: [] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createYoutubeDataClient({
      userId: "user-1",
      youtubeAccountId: "account-1",
    });
    await expect(client.listPlaylists({ mine: true })).resolves.toEqual([]);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("mine=true");
  });

  it("rejects when neither channelId nor mine is provided", async () => {
    const client = createYoutubeDataClient({
      userId: "user-1",
      youtubeAccountId: "account-1",
    });
    await expect(client.listPlaylists({})).rejects.toThrow(
      "Either channelId or mine is required",
    );
  });
});

describe("listVideoSummaries", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    authMocks.getAccessToken.mockReset();
  });

  it("maps snippet tags and defaults missing tags to an empty array", async () => {
    authMocks.getAccessToken.mockResolvedValue({ accessToken: "token" });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          {
            id: "aaaaaaaaaaa",
            snippet: { title: "Tagged", tags: ["a", "b"] },
          },
          { id: "bbbbbbbbbbb", snippet: { title: "Untagged" } },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createYoutubeDataClient({
      userId: "user-1",
      youtubeAccountId: "account-1",
    });
    const summaries = await client.listVideoSummaries([
      "aaaaaaaaaaa",
      "bbbbbbbbbbb",
    ]);
    expect(summaries.get("aaaaaaaaaaa")?.tags).toEqual(["a", "b"]);
    expect(summaries.get("bbbbbbbbbbb")?.tags).toEqual([]);
  });
});

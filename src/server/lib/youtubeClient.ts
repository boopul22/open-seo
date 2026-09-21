/* eslint-disable max-lines -- one client module per Google integration (ga4Client precedent); YouTube spans the Data API and the Analytics API */
import { z } from "zod";
import { getAuth } from "@/lib/auth";
import {
  YoutubeAnalyticsApiError,
  YoutubeDataApiError,
  YoutubeMalformedResponseError,
  YoutubeTokenError,
} from "@/server/lib/youtubeErrors";
import { YOUTUBE_OAUTH_PROVIDER_ID } from "@/shared/youtube";

const YOUTUBE_DATA_API_BASE = "https://www.googleapis.com/youtube/v3";
const YOUTUBE_ANALYTICS_API_BASE = "https://youtubeanalytics.googleapis.com/v2";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const MAX_ERROR_BODY_LENGTH = 8_000;
const MAX_VIDEO_IDS_PER_REQUEST = 50;
const MAX_PLAYLIST_PAGES = 4;

export type YoutubeChannel = {
  channelId: string;
  title: string;
  handle: string | null;
  thumbnailUrl: string | null;
  uploadsPlaylistId: string | null;
  subscriberCount: number | null;
  videoCount: number | null;
  viewCount: number | null;
};

export type YoutubeVideoSummary = {
  videoId: string;
  title: string;
  publishedAt: string | null;
  durationSeconds: number | null;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  thumbnailUrl: string | null;
  tags: string[];
  // Present on videos.list results; null on search.list results (snippet-only).
  channelId: string | null;
  channelTitle: string | null;
};

export type YoutubePlaylistSummary = {
  playlistId: string;
  title: string;
  description: string | null;
  itemCount: number | null;
  publishedAt: string | null;
  thumbnailUrl: string | null;
};

export type YoutubeCommentSummary = {
  commentId: string | null;
  authorDisplayName: string | null;
  text: string | null;
  likeCount: number | null;
  publishedAt: string | null;
  replyCount: number | null;
  isReplyThread: boolean;
};

const thumbnailSchema = z.object({
  url: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
});

const channelResourceSchema = z.object({
  id: z.string().min(1),
  snippet: z
    .object({
      title: z.string().default(""),
      customUrl: z.string().optional(),
      thumbnails: z
        .object({
          default: thumbnailSchema.optional(),
          medium: thumbnailSchema.optional(),
          high: thumbnailSchema.optional(),
        })
        .optional(),
    })
    .optional(),
  contentDetails: z
    .object({
      relatedPlaylists: z.object({ uploads: z.string().optional() }).optional(),
    })
    .optional(),
  statistics: z
    .object({
      viewCount: z.string().optional(),
      subscriberCount: z.string().optional(),
      videoCount: z.string().optional(),
      hiddenSubscriberCount: z.boolean().optional(),
    })
    .optional(),
});

const channelsResponseSchema = z.object({
  items: z.array(channelResourceSchema).optional(),
});

const playlistItemsResponseSchema = z.object({
  items: z
    .array(
      z.object({
        contentDetails: z.object({ videoId: z.string().optional() }).optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
});

const playlistResourceSchema = z.object({
  id: z.string().min(1),
  snippet: z
    .object({
      title: z.string().default(""),
      description: z.string().optional(),
      publishedAt: z.string().optional(),
      thumbnails: z
        .object({
          default: thumbnailSchema.optional(),
          medium: thumbnailSchema.optional(),
          high: thumbnailSchema.optional(),
        })
        .optional(),
    })
    .optional(),
  contentDetails: z.object({ itemCount: z.number().optional() }).optional(),
});

const playlistsResponseSchema = z.object({
  items: z.array(playlistResourceSchema).optional(),
  nextPageToken: z.string().optional(),
});

const videoResourceSchema = z.object({
  id: z.string().min(1),
  snippet: z
    .object({
      title: z.string().default(""),
      publishedAt: z.string().optional(),
      tags: z.array(z.string()).optional(),
      channelId: z.string().optional(),
      channelTitle: z.string().optional(),
      thumbnails: z
        .object({
          default: thumbnailSchema.optional(),
          medium: thumbnailSchema.optional(),
          high: thumbnailSchema.optional(),
        })
        .optional(),
    })
    .optional(),
  contentDetails: z.object({ duration: z.string().optional() }).optional(),
  statistics: z
    .object({
      viewCount: z.string().optional(),
      likeCount: z.string().optional(),
      commentCount: z.string().optional(),
    })
    .optional(),
});

const videosResponseSchema = z.object({
  items: z.array(videoResourceSchema).optional(),
});

const searchListResponseSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.object({ videoId: z.string().optional() }).optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
});

const searchResponseSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.object({ videoId: z.string().optional() }).optional(),
        snippet: z
          .object({
            title: z.string().default(""),
            publishedAt: z.string().optional(),
            channelId: z.string().optional(),
            channelTitle: z.string().optional(),
            thumbnails: z
              .object({
                default: thumbnailSchema.optional(),
                medium: thumbnailSchema.optional(),
                high: thumbnailSchema.optional(),
              })
              .optional(),
          })
          .optional(),
      }),
    )
    .optional(),
});

const commentThreadsResponseSchema = z.object({
  items: z
    .array(
      z.object({
        snippet: z
          .object({
            totalReplyCount: z.number().optional(),
            topLevelComment: z
              .object({
                id: z.string().optional(),
                snippet: z
                  .object({
                    authorDisplayName: z.string().optional(),
                    textDisplay: z.string().optional(),
                    textOriginal: z.string().optional(),
                    likeCount: z.number().optional(),
                    publishedAt: z.string().optional(),
                  })
                  .optional(),
              })
              .optional(),
          })
          .optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
});

const googleErrorSchema = z.object({
  error: z.object({
    details: z
      .array(
        z.object({
          reason: z.string().optional(),
          metadata: z.object({ service: z.string().optional() }).optional(),
        }),
      )
      .optional(),
  }),
});

function numericString(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** ISO-8601 video duration (PT#H#M#S) to seconds; null when unparseable. */
export function parseIsoDurationSeconds(value: string): number | null {
  const match =
    /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value);
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  const total =
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0);
  return Number.isFinite(total) ? Math.round(total) : null;
}

function bestThumbnail(
  thumbnails:
    | {
        default?: { url: string };
        medium?: { url: string };
        high?: { url: string };
      }
    | undefined,
): string | null {
  return (
    thumbnails?.high?.url ??
    thumbnails?.medium?.url ??
    thumbnails?.default?.url ??
    null
  );
}

function toChannel(
  resource: z.infer<typeof channelResourceSchema>,
): YoutubeChannel {
  const statistics = resource.statistics;
  return {
    channelId: resource.id,
    title: resource.snippet?.title ?? "",
    handle: resource.snippet?.customUrl ?? null,
    thumbnailUrl: bestThumbnail(resource.snippet?.thumbnails),
    uploadsPlaylistId:
      resource.contentDetails?.relatedPlaylists?.uploads ?? null,
    subscriberCount: statistics?.hiddenSubscriberCount
      ? null
      : numericString(statistics?.subscriberCount),
    videoCount: numericString(statistics?.videoCount),
    viewCount: numericString(statistics?.viewCount),
  };
}

function toVideoSummary(
  resource: z.infer<typeof videoResourceSchema>,
): YoutubeVideoSummary {
  return {
    videoId: resource.id,
    title: resource.snippet?.title ?? "",
    publishedAt: resource.snippet?.publishedAt ?? null,
    durationSeconds: resource.contentDetails?.duration
      ? parseIsoDurationSeconds(resource.contentDetails.duration)
      : null,
    viewCount: numericString(resource.statistics?.viewCount),
    likeCount: numericString(resource.statistics?.likeCount),
    commentCount: numericString(resource.statistics?.commentCount),
    thumbnailUrl: bestThumbnail(resource.snippet?.thumbnails),
    tags: resource.snippet?.tags ?? [],
    channelId: resource.snippet?.channelId ?? null,
    channelTitle: resource.snippet?.channelTitle ?? null,
  };
}

function toPlaylistSummary(
  resource: z.infer<typeof playlistResourceSchema>,
): YoutubePlaylistSummary {
  return {
    playlistId: resource.id,
    title: resource.snippet?.title ?? "",
    description: resource.snippet?.description ?? null,
    itemCount: resource.contentDetails?.itemCount ?? null,
    publishedAt: resource.snippet?.publishedAt ?? null,
    thumbnailUrl: bestThumbnail(resource.snippet?.thumbnails),
  };
}

const YOUTUBE_CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;
const YOUTUBE_HANDLE_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const UNRECOGNIZED_CHANNEL_REF = "Unrecognized YouTube channel reference";

function channelRefFromYoutubeUrl(
  value: string,
): { channelId: string } | { handle: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(UNRECOGNIZED_CHANNEL_REF);
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "youtube.com" && host !== "m.youtube.com") {
    throw new Error(UNRECOGNIZED_CHANNEL_REF);
  }
  const [first, second] = url.pathname.split("/").filter(Boolean);
  if (
    first === "channel" &&
    second &&
    YOUTUBE_CHANNEL_ID_PATTERN.test(second)
  ) {
    return { channelId: second };
  }
  if (first?.startsWith("@") && YOUTUBE_HANDLE_PATTERN.test(first.slice(1))) {
    return { handle: first };
  }
  if (
    (first === "c" || first === "user") &&
    second &&
    YOUTUBE_HANDLE_PATTERN.test(second)
  ) {
    return { handle: `@${second}` };
  }
  throw new Error(UNRECOGNIZED_CHANNEL_REF);
}

/** Accepts a channel ID, handle, or YouTube URL and normalizes it to the form
 *  the Data API expects. Pure and network-free. */
export function normalizeYoutubeChannelRef(
  input: string,
): { channelId: string } | { handle: string } {
  const trimmed = input.trim();
  if (YOUTUBE_CHANNEL_ID_PATTERN.test(trimmed)) return { channelId: trimmed };
  const withoutAt = trimmed.replace(/^@/, "");
  if (YOUTUBE_HANDLE_PATTERN.test(withoutAt))
    return { handle: `@${withoutAt}` };
  return channelRefFromYoutubeUrl(trimmed);
}

async function getYoutubeAccessToken(opts: {
  userId: string;
  youtubeAccountId: string;
}): Promise<string> {
  let result: { accessToken?: string } | undefined;
  try {
    result = await getAuth().api.getAccessToken({
      body: {
        providerId: YOUTUBE_OAUTH_PROVIDER_ID,
        userId: opts.userId,
        accountId: opts.youtubeAccountId,
      },
    });
  } catch (error) {
    throw new YoutubeTokenError(
      "Could not mint a YouTube access token.",
      error,
    );
  }
  if (!result?.accessToken) {
    throw new YoutubeTokenError("YouTube returned no access token.");
  }
  return result.accessToken;
}

function memoizedYoutubeAccessToken(opts: {
  userId: string;
  youtubeAccountId: string;
}) {
  let accessTokenPromise: Promise<string> | undefined;
  return () => (accessTokenPromise ??= getYoutubeAccessToken(opts));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function dataMessageForStatus(status: number): string {
  if (status === 401) return "YouTube connection expired.";
  if (status === 403) {
    return "YouTube denied access. Check the channel's permissions and enabled APIs.";
  }
  if (status === 404) return "YouTube resource not found.";
  return `YouTube Data API error (${status}).`;
}

function safeRetryAfter(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (!value || !/^\d+$/.test(value)) return null;
  return Math.min(Number(value), 86_400);
}

function analyticsMessageForStatus(status: number): string {
  if (status === 400) return "YouTube Analytics rejected this report.";
  if (status === 401) return "YouTube connection expired.";
  if (status === 403) return "YouTube Analytics denied access to this channel.";
  if (status === 429) return "YouTube Analytics quota was exhausted.";
  return "YouTube Analytics reporting is temporarily unavailable.";
}

function extractUpstreamReason(body: string): string | null {
  try {
    const parsed = googleErrorSchema.safeParse(JSON.parse(body));
    if (!parsed.success) return null;
    return (
      parsed.data.error.details?.find((detail) => detail.reason)?.reason ?? null
    );
  } catch {
    return null;
  }
}

/** Read-only Data API client: channel discovery plus video metadata. */
export function createYoutubeDataClient(opts: {
  userId: string;
  youtubeAccountId: string;
}) {
  const accessToken = memoizedYoutubeAccessToken(opts);

  async function request<T>(url: string, schema: z.ZodType<T>): Promise<T> {
    const token = await accessToken();
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new YoutubeDataApiError(0, "YouTube is temporarily unavailable.");
    }
    if (!response.ok) {
      const body = await response
        .text()
        .then((text) => text.slice(0, MAX_ERROR_BODY_LENGTH))
        .catch(() => "");
      throw new YoutubeDataApiError(
        response.status,
        dataMessageForStatus(response.status),
        extractUpstreamReason(body),
      );
    }
    try {
      return schema.parse(await response.json());
    } catch {
      throw new YoutubeMalformedResponseError();
    }
  }

  return {
    async getUserInfoEmail(): Promise<string | null> {
      const token = await accessToken();
      let response: Response;
      try {
        response = await fetch(GOOGLE_USERINFO_URL, {
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (error) {
        if (isAbortError(error)) throw error;
        throw new YoutubeDataApiError(
          0,
          "Google account lookup is temporarily unavailable.",
        );
      }
      if (!response.ok) {
        throw new YoutubeDataApiError(
          response.status,
          "Could not read the connected Google account.",
        );
      }
      const data = z
        .object({ email: z.string().email().optional() })
        .parse(await response.json());
      return data.email ?? null;
    },

    /** Channels the authorization can act as. One Google account normally maps
     *  to exactly one channel; brand accounts surface as their own grants. */
    async listMyChannels(): Promise<YoutubeChannel[]> {
      const url = new URL(`${YOUTUBE_DATA_API_BASE}/channels`);
      url.searchParams.set("part", "snippet,contentDetails,statistics");
      url.searchParams.set("mine", "true");
      url.searchParams.set("maxResults", "50");
      const response = await request(url.toString(), channelsResponseSchema);
      return (response.items ?? []).map(toChannel);
    },

    async getChannel(channelId: string): Promise<YoutubeChannel | null> {
      const url = new URL(`${YOUTUBE_DATA_API_BASE}/channels`);
      url.searchParams.set("part", "snippet,contentDetails,statistics");
      url.searchParams.set("id", channelId);
      const response = await request(url.toString(), channelsResponseSchema);
      const resource = response.items?.[0];
      return resource ? toChannel(resource) : null;
    },

    /** Look up a public channel by @handle, for discovery before connecting. */
    async getChannelByHandle(handle: string): Promise<YoutubeChannel | null> {
      const url = new URL(`${YOUTUBE_DATA_API_BASE}/channels`);
      url.searchParams.set("part", "snippet,contentDetails,statistics");
      url.searchParams.set("forHandle", `@${handle.trim().replace(/^@/, "")}`);
      const response = await request(url.toString(), channelsResponseSchema);
      const resource = response.items?.[0];
      return resource ? toChannel(resource) : null;
    },

    /** Most recent video IDs on a channel's uploads playlist, newest first. */
    async listUploadedVideoIds(
      uploadsPlaylistId: string,
      maxResults: number,
    ): Promise<string[]> {
      // The uploads playlist is append-at-head: a video published between page
      // fetches shifts the offsets and can be returned on two pages. Dedupe as
      // we go, or callers double-count the video (and skew medians/scores).
      const seen = new Set<string>();
      const ids: string[] = [];
      let pageToken: string | undefined;
      while (ids.length < maxResults) {
        const url = new URL(`${YOUTUBE_DATA_API_BASE}/playlistItems`);
        url.searchParams.set("part", "contentDetails");
        url.searchParams.set("playlistId", uploadsPlaylistId);
        url.searchParams.set(
          "maxResults",
          String(Math.min(50, maxResults - ids.length)),
        );
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const response = await request(
          url.toString(),
          playlistItemsResponseSchema,
        );
        for (const item of response.items ?? []) {
          const videoId = item.contentDetails?.videoId;
          if (videoId && !seen.has(videoId)) {
            seen.add(videoId);
            ids.push(videoId);
          }
        }
        pageToken = response.nextPageToken || undefined;
        if (!pageToken) break;
      }
      return ids.slice(0, maxResults);
    },

    /** Playlists owned by a channel (`channelId`) or the authorized account
     *  (`mine`). Exactly one of the two must be provided. At most
     *  `maxResults` playlists are returned, across a maximum of four pages. */
    async listPlaylists(input: {
      channelId?: string;
      mine?: boolean;
      maxResults?: number;
    }): Promise<YoutubePlaylistSummary[]> {
      if (!input.channelId && !input.mine) {
        throw new Error("Either channelId or mine is required");
      }
      const requested = Math.min(
        50,
        Math.max(1, Math.trunc(input.maxResults ?? 25)),
      );
      const playlists: YoutubePlaylistSummary[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_PLAYLIST_PAGES; page += 1) {
        const url = new URL(`${YOUTUBE_DATA_API_BASE}/playlists`);
        url.searchParams.set("part", "snippet,contentDetails");
        if (input.channelId) {
          url.searchParams.set("channelId", input.channelId);
        } else {
          url.searchParams.set("mine", "true");
        }
        url.searchParams.set(
          "maxResults",
          String(Math.min(50, requested - playlists.length)),
        );
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const response = await request(url.toString(), playlistsResponseSchema);
        for (const resource of response.items ?? []) {
          playlists.push(toPlaylistSummary(resource));
        }
        pageToken = response.nextPageToken || undefined;
        if (!pageToken || playlists.length >= requested) break;
      }
      return playlists.slice(0, requested);
    },

    async listVideoSummaries(
      videoIds: string[],
    ): Promise<Map<string, YoutubeVideoSummary>> {
      const summaries = new Map<string, YoutubeVideoSummary>();
      for (
        let index = 0;
        index < videoIds.length;
        index += MAX_VIDEO_IDS_PER_REQUEST
      ) {
        const batch = videoIds.slice(index, index + MAX_VIDEO_IDS_PER_REQUEST);
        const url = new URL(`${YOUTUBE_DATA_API_BASE}/videos`);
        url.searchParams.set("part", "snippet,contentDetails,statistics");
        url.searchParams.set("id", batch.join(","));
        url.searchParams.set("maxResults", "50");
        const response = await request(url.toString(), videosResponseSchema);
        for (const resource of response.items ?? []) {
          summaries.set(resource.id, toVideoSummary(resource));
        }
      }
      return summaries;
    },

    /** YouTube's mostPopular chart for a region and optional category. */
    async listMostPopular(input: {
      regionCode?: string;
      videoCategoryId?: string;
      maxResults?: number;
    }): Promise<YoutubeVideoSummary[]> {
      const url = new URL(`${YOUTUBE_DATA_API_BASE}/videos`);
      url.searchParams.set("part", "snippet,contentDetails,statistics");
      url.searchParams.set("chart", "mostPopular");
      url.searchParams.set("regionCode", input.regionCode ?? "US");
      url.searchParams.set(
        "maxResults",
        String(Math.min(50, Math.max(1, Math.trunc(input.maxResults ?? 25)))),
      );
      if (input.videoCategoryId) {
        url.searchParams.set("videoCategoryId", input.videoCategoryId);
      }
      const response = await request(url.toString(), videosResponseSchema);
      return (response.items ?? []).map(toVideoSummary);
    },

    /** Top-level comment threads on a video, most relevant or newest first. */
    async listCommentThreads(input: {
      videoId: string;
      maxResults?: number;
      order?: "relevance" | "time";
      pageToken?: string;
    }): Promise<{
      comments: YoutubeCommentSummary[];
      nextPageToken: string | null;
    }> {
      const url = new URL(`${YOUTUBE_DATA_API_BASE}/commentThreads`);
      url.searchParams.set("part", "snippet,replies");
      url.searchParams.set("videoId", input.videoId);
      url.searchParams.set("textFormat", "plainText");
      url.searchParams.set("order", input.order ?? "relevance");
      url.searchParams.set(
        "maxResults",
        String(Math.min(100, Math.max(1, Math.trunc(input.maxResults ?? 20)))),
      );
      if (input.pageToken) url.searchParams.set("pageToken", input.pageToken);
      const response = await request(
        url.toString(),
        commentThreadsResponseSchema,
      );
      const comments = (response.items ?? []).map(
        (item): YoutubeCommentSummary => {
          const snippet = item.snippet?.topLevelComment?.snippet;
          return {
            commentId: item.snippet?.topLevelComment?.id ?? null,
            authorDisplayName: snippet?.authorDisplayName ?? null,
            text: snippet?.textDisplay ?? snippet?.textOriginal ?? null,
            likeCount: numericString(snippet?.likeCount),
            publishedAt: snippet?.publishedAt ?? null,
            replyCount: item.snippet?.totalReplyCount ?? null,
            isReplyThread: false,
          };
        },
      );
      return { comments, nextPageToken: response.nextPageToken ?? null };
    },

    /**
     * Full-text video search. NOTE: search.list costs 100 YouTube quota units
     * per call — callers must treat it as expensive. Search returns snippet
     * data only (no statistics or contentDetails), so view/like/comment counts
     * and duration are always null on these summaries.
     */
    async searchVideos(input: {
      query: string;
      maxResults?: number;
      order?: "relevance" | "date" | "viewCount";
      regionCode?: string;
      type?: "video";
    }): Promise<YoutubeVideoSummary[]> {
      const url = new URL(`${YOUTUBE_DATA_API_BASE}/search`);
      url.searchParams.set("part", "snippet");
      url.searchParams.set("type", input.type ?? "video");
      url.searchParams.set("q", input.query);
      url.searchParams.set(
        "maxResults",
        String(Math.min(50, Math.max(1, Math.trunc(input.maxResults ?? 25)))),
      );
      if (input.order) url.searchParams.set("order", input.order);
      if (input.regionCode)
        url.searchParams.set("regionCode", input.regionCode);
      const response = await request(url.toString(), searchResponseSchema);
      return (response.items ?? []).flatMap((item): YoutubeVideoSummary[] => {
        const videoId = item.id?.videoId;
        if (!videoId) return [];
        return [
          {
            videoId,
            title: item.snippet?.title ?? "",
            publishedAt: item.snippet?.publishedAt ?? null,
            durationSeconds: null,
            viewCount: null,
            likeCount: null,
            commentCount: null,
            thumbnailUrl: bestThumbnail(item.snippet?.thumbnails),
            tags: [],
            channelId: item.snippet?.channelId ?? null,
            channelTitle: item.snippet?.channelTitle ?? null,
          },
        ];
      });
    },

    /**
     * Video IDs matching a search query, in YouTube's result order.
     *
     * NOTE: `search.list` costs 100 quota units per call regardless of
     * `maxResults` — callers must cache results rather than re-querying.
     */
    async searchVideoIds(input: {
      query: string;
      maxResults?: number;
      order?: "relevance" | "date" | "viewCount";
      regionCode?: string;
      videoDuration?: "any" | "short" | "medium" | "long";
    }): Promise<string[]> {
      const requested = Math.min(
        50,
        Math.max(1, Math.trunc(input.maxResults ?? 25)),
      );
      const seen = new Set<string>();
      const ids: string[] = [];
      let pageToken: string | undefined;
      while (ids.length < requested) {
        const url = new URL(`${YOUTUBE_DATA_API_BASE}/search`);
        url.searchParams.set("part", "id");
        url.searchParams.set("type", "video");
        url.searchParams.set("q", input.query);
        url.searchParams.set("order", input.order ?? "relevance");
        url.searchParams.set(
          "maxResults",
          String(Math.min(50, requested - ids.length)),
        );
        if (input.regionCode)
          url.searchParams.set("regionCode", input.regionCode);
        if (input.videoDuration) {
          url.searchParams.set("videoDuration", input.videoDuration);
        }
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const response = await request(
          url.toString(),
          searchListResponseSchema,
        );
        for (const item of response.items ?? []) {
          const videoId = item.id?.videoId;
          if (videoId && !seen.has(videoId)) {
            seen.add(videoId);
            ids.push(videoId);
          }
        }
        pageToken = response.nextPageToken || undefined;
        if (!pageToken) break;
      }
      return ids.slice(0, requested);
    },
  };
}

export type YoutubeAnalyticsRow = Record<string, string | number>;

export type YoutubeAnalyticsReport = {
  columnHeaders: string[];
  rows: YoutubeAnalyticsRow[];
};

const columnHeaderSchema = z.object({
  name: z.string(),
  columnType: z.string().optional(),
  dataType: z.string().optional(),
});

const reportsResponseSchema = z.object({
  columnHeaders: z.array(columnHeaderSchema).optional(),
  rows: z
    .array(z.array(z.union([z.string(), z.number(), z.null()])))
    .optional(),
});

export type YoutubeAnalyticsQuery = {
  startDate: string;
  endDate: string;
  metrics: string[];
  dimensions?: string[];
  sort?: string;
  maxResults?: number;
  filters?: string;
};

/** Read-only YouTube Analytics client bound to one channel. */
export function createYoutubeAnalyticsClient(opts: {
  userId: string;
  youtubeAccountId: string;
  channelId: string;
}) {
  const accessToken = memoizedYoutubeAccessToken(opts);

  return {
    async runReport(
      query: YoutubeAnalyticsQuery,
    ): Promise<YoutubeAnalyticsReport> {
      const url = new URL(`${YOUTUBE_ANALYTICS_API_BASE}/reports`);
      url.searchParams.set("ids", `channel==${opts.channelId}`);
      url.searchParams.set("startDate", query.startDate);
      url.searchParams.set("endDate", query.endDate);
      url.searchParams.set("metrics", query.metrics.join(","));
      if (query.dimensions?.length) {
        url.searchParams.set("dimensions", query.dimensions.join(","));
      }
      if (query.sort) url.searchParams.set("sort", query.sort);
      if (query.maxResults) {
        url.searchParams.set("maxResults", String(query.maxResults));
      }
      if (query.filters) url.searchParams.set("filters", query.filters);

      const token = await accessToken();
      let response: Response;
      try {
        response = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (error) {
        if (isAbortError(error)) throw error;
        throw new YoutubeAnalyticsApiError(
          0,
          "YouTube Analytics reporting is temporarily unavailable.",
        );
      }
      if (!response.ok) {
        const body = await response
          .text()
          .then((text) => text.slice(0, MAX_ERROR_BODY_LENGTH))
          .catch(() => "");
        throw new YoutubeAnalyticsApiError(
          response.status,
          analyticsMessageForStatus(response.status),
          safeRetryAfter(response),
          extractUpstreamReason(body),
        );
      }

      let parsed: z.infer<typeof reportsResponseSchema>;
      try {
        parsed = reportsResponseSchema.parse(await response.json());
      } catch {
        throw new YoutubeMalformedResponseError();
      }
      const headers = parsed.columnHeaders ?? [];
      const rows: YoutubeAnalyticsRow[] = (parsed.rows ?? []).map((values) => {
        const row: YoutubeAnalyticsRow = {};
        headers.forEach((header, index) => {
          const value = values[index] ?? null;
          row[header.name] =
            typeof value === "number" || typeof value === "string" ? value : 0;
        });
        return row;
      });
      return { columnHeaders: headers.map((header) => header.name), rows };
    },
  };
}

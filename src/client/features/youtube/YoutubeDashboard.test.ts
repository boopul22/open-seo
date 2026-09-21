import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { YoutubeDashboard, youtubeDashboardRange } from "./YoutubeDashboard";

vi.mock("@/serverFunctions/youtube", () => ({
  getYoutubeConnection: vi.fn(),
  getYoutubeChannelInfo: vi.fn(),
  getYoutubeChannelOverview: vi.fn(),
  getYoutubeTopVideos: vi.fn(),
  getYoutubeTrafficSources: vi.fn(),
}));
vi.mock("@/serverFunctions/gsc", () => ({
  getGscConnection: vi.fn(),
}));
vi.mock("@/serverFunctions/ga4", () => ({
  getGa4Connection: vi.fn(),
}));
vi.mock("@/serverFunctions/youtubeAudience", () => ({
  getYoutubeAudienceBreakdown: vi.fn(),
}));

const PROJECT_ID = "project-a";
const RANGE = youtubeDashboardRange(28);

const channel = {
  channelId: "UCaaaaaaaaaaaaaaaaaaaaaa",
  channelTitle: "My Channel",
  channelHandle: "@mine",
  thumbnailUrl: null,
};

const currentMetrics = {
  views: 12_345,
  estimatedMinutesWatched: 900,
  averageViewDuration: 125,
  averageViewPercentage: 42.5,
  subscribersGained: 120,
  subscribersLost: 30,
  likes: 800,
  comments: 45,
  shares: 12,
};

const previousMetrics = {
  ...currentMetrics,
  views: 10_000,
  estimatedMinutesWatched: 800,
  subscribersGained: 100,
  subscribersLost: 40,
  likes: 700,
  comments: 40,
  shares: 10,
};

function renderDashboard() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["youtubeConnection", PROJECT_ID], {
    connected: true,
    canManage: true,
    currentUserHasGrant: true,
    googleOAuthConfigured: true,
    channelId: channel.channelId,
    channelTitle: channel.channelTitle,
    channelHandle: channel.channelHandle,
    connectedByEmail: null,
    connectedAt: null,
  });
  queryClient.setQueryData(["youtubeChannelInfo", PROJECT_ID], {
    source: "youtube_data_api",
    channel,
    subscriberCount: 12_345,
    videoCount: 210,
    viewCount: 4_567_890,
    connectedEmail: "creator@example.com",
  });
  queryClient.setQueryData(
    ["youtubeChannelOverview", PROJECT_ID, RANGE.startDate, RANGE.endDate],
    {
      connected: true,
      source: "youtube_analytics_api",
      channel,
      request: {
        resolvedRange: { startDate: RANGE.startDate, endDate: RANGE.endDate },
        previousRange: { startDate: "2026-08-01", endDate: "2026-08-28" },
        warnings: [],
      },
      current: currentMetrics,
      previous: previousMetrics,
      trend: [
        {
          date: "2026-09-20",
          views: 400,
          estimatedMinutesWatched: 30,
          subscribersGained: 5,
          subscribersLost: 1,
        },
        {
          date: "2026-09-21",
          views: 500,
          estimatedMinutesWatched: 40,
          subscribersGained: 6,
          subscribersLost: 2,
        },
      ],
    },
  );
  queryClient.setQueryData(
    ["youtubeTopVideos", PROJECT_ID, RANGE.startDate, RANGE.endDate, "views"],
    {
      source: "youtube_analytics_api",
      channel,
      request: {
        resolvedRange: { startDate: RANGE.startDate, endDate: RANGE.endDate },
        warnings: [],
        sort: "views",
      },
      rows: [
        {
          videoId: "dQw4w9WgXcQ",
          title: "A very popular video",
          publishedAt: null,
          durationSeconds: 240,
          thumbnailUrl: null,
          views: 9_000,
          estimatedMinutesWatched: 600,
          averageViewDuration: 90,
          averageViewPercentage: 40,
          subscribersGained: 15,
          likes: 320,
          comments: 12,
        },
      ],
    },
  );
  queryClient.setQueryData(
    ["youtubeTrafficSources", PROJECT_ID, RANGE.startDate, RANGE.endDate],
    {
      source: "youtube_analytics_api",
      channel,
      request: {
        resolvedRange: { startDate: RANGE.startDate, endDate: RANGE.endDate },
        warnings: [],
      },
      rows: [
        {
          trafficSource: "YT_SEARCH",
          views: 9_000,
          estimatedMinutesWatched: 600,
          averageViewDuration: 90,
        },
      ],
    },
  );
  queryClient.setQueryData(["youtubeAudienceCard", PROJECT_ID, "country"], {
    rows: [
      { country: "United States", views: 5_000, estimatedMinutesWatched: 300 },
    ],
  });
  queryClient.setQueryData(["youtubeAudienceCard", PROJECT_ID, "deviceType"], {
    rows: [
      { deviceType: "Mobile", views: 4_000, estimatedMinutesWatched: 250 },
    ],
  });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(YoutubeDashboard, { projectId: PROJECT_ID }),
    ),
  );
}

describe("YoutubeDashboard", () => {
  it("renders the channel header and the range tabs", () => {
    const markup = renderDashboard();
    expect(markup).toContain("My Channel");
    expect(markup).toContain("@mine");
    expect(markup).toContain("https://youtube.com/@mine");
    expect(markup).toContain("7 days");
    expect(markup).toContain("28 days");
    expect(markup).toContain("90 days");
  });

  it("renders every overview metric tile", () => {
    const markup = renderDashboard();
    for (const label of [
      "Views",
      "Watch time",
      "Net subscribers",
      "Subscribers gained",
      "Subscribers lost",
      "Likes",
      "Comments",
      "Shares",
      "Avg view duration",
      "Avg view %",
    ]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain("15.0 h");
    expect(markup).toContain("+90");
  });

  it("renders a top video row, a traffic source row, and audience rows", () => {
    const markup = renderDashboard();
    expect(markup).toContain("A very popular video");
    expect(markup).toContain("https://youtube.com/watch?v=dQw4w9WgXcQ");
    expect(markup).toContain("YouTube search");
    expect(markup).toContain("United States");
    expect(markup).toContain("Mobile");
  });
});

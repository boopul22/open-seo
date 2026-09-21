import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { YoutubeKeywordsTab } from "./YoutubeKeywordsTab";
import {
  DEFAULT_OUTLIER_MIN_SCORE,
  DEFAULT_OUTLIER_WINDOW_DAYS,
  YoutubeVideosPage,
  youtubeOutliersQueryKey,
} from "./YoutubeVideosPage";

vi.mock("@/serverFunctions/youtube", () => ({
  getYoutubeConnection: vi.fn(),
  listYoutubeChannels: vi.fn(),
  setYoutubeChannel: vi.fn(),
  disconnectYoutube: vi.fn(),
  getYoutubeChannelOverview: vi.fn(),
  startSelfHostedYoutubeLink: vi.fn(),
}));
vi.mock("@/serverFunctions/gsc", () => ({
  getGscConnection: vi.fn(),
  startSelfHostedGscLink: vi.fn(),
}));
vi.mock("@/serverFunctions/ga4", () => ({
  getGa4Connection: vi.fn(),
  startSelfHostedGa4Link: vi.fn(),
}));
vi.mock("@/serverFunctions/youtubeResearch", () => ({
  addYoutubeResearchChannel: vi.fn(),
  removeYoutubeResearchChannel: vi.fn(),
  listYoutubeResearchChannels: vi.fn(),
  refreshYoutubeResearchChannels: vi.fn(),
  listYoutubeChannelVideos: vi.fn(),
  getYoutubeOutliers: vi.fn(),
  getYoutubeChannelStats: vi.fn(),
  compareYoutubeChannels: vi.fn(),
  getYoutubeTrendingVideos: vi.fn(),
}));
vi.mock("@/serverFunctions/youtubeAudience", () => ({
  getYoutubeVideoRetention: vi.fn(),
  getYoutubeAudienceBreakdown: vi.fn(),
  getYoutubePlaybackLocations: vi.fn(),
  getYoutubeVideoTraffic: vi.fn(),
}));
vi.mock("@/serverFunctions/youtubeKeywords", () => ({
  getYoutubeKeywordIdeas: vi.fn(),
  getYoutubeKeywordPerformance: vi.fn(),
  getYoutubeHighPerformanceKeywords: vi.fn(),
  getYoutubeKeywordGap: vi.fn(),
  compareYoutubeKeywords: vi.fn(),
}));
vi.mock("@/serverFunctions/youtubePerformance", () => ({
  getYoutubeChannelGrowth: vi.fn(),
  getYoutubeBestPublishDays: vi.fn(),
  getYoutubeVideoTrend: vi.fn(),
  listYoutubePlaylists: vi.fn(),
}));
// Loaded transitively by YouTubeConnectionCard (via the account-removal dialog).
vi.mock("@/serverFunctions/googleAccounts", () => ({
  getGoogleAccountRemovalImpact: vi.fn(),
  removeGoogleAccount: vi.fn(),
}));

const PROJECT_ID = "project-a";

const connection = {
  connected: true,
  canManage: true,
  currentUserHasGrant: true,
  googleOAuthConfigured: true,
  channelId: "UCaaaaaaaaaaaaaaaaaaaaaa",
  channelTitle: "My Channel",
  channelHandle: "@mine",
  connectedByEmail: null,
  connectedAt: null,
};

const outlierRow = {
  videoId: "dQw4w9WgXcQ",
  title: "A breakout video",
  publishedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  ageDays: 3,
  views: 12_345,
  likes: 120,
  comments: 8,
  durationSeconds: 240,
  thumbnailUrl: null,
  viewsPerDay: 4115,
  outlierScore: 3.14,
  velocityScore: 1.2,
  vph: null,
  channelId: "UCbbbbbbbbbbbbbbbbbbbbbb",
  channelTitle: "Tracked Channel",
};

function renderPage(
  outlierRows: Array<typeof outlierRow>,
  seedExtra?: (queryClient: QueryClient) => void,
) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["youtubeConnection", PROJECT_ID], connection);
  queryClient.setQueryData(["youtubeResearchChannels", PROJECT_ID], {
    channels: [],
  });
  queryClient.setQueryData(
    youtubeOutliersQueryKey(
      PROJECT_ID,
      DEFAULT_OUTLIER_WINDOW_DAYS,
      DEFAULT_OUTLIER_MIN_SCORE,
      null,
    ),
    { rows: outlierRows },
  );
  seedExtra?.(queryClient);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(YoutubeVideosPage, { projectId: PROJECT_ID }),
    ),
  );
}

const keywordPerformance = {
  keyword: "minecraft survival",
  regionCode: "US",
  capturedAt: new Date(Date.now() - 3_600_000).toISOString(),
  sampleSize: 25,
  medianViews: 12_345,
  averageViews: 45_678,
  medianViewsPerDay: 987,
  videos: [
    {
      videoId: "dQw4w9WgXcQ",
      title: "A sampled keyword video",
      channelId: "UCcccccccccccccccccccccc",
      channelTitle: "Sampled Channel",
      views: 12_345,
      publishedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      durationSeconds: 240,
      position: 0,
      viewsPerDay: 1234.5,
    },
  ],
};

function renderKeywordsTab(seedExtra?: (queryClient: QueryClient) => void) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["youtubeResearchChannels", PROJECT_ID], {
    channels: [],
  });
  seedExtra?.(queryClient);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(YoutubeKeywordsTab, {
        projectId: PROJECT_ID,
        ownedChannel: {
          channelId: connection.channelId,
          channelTitle: connection.channelTitle,
        },
      }),
    ),
  );
}

describe("YoutubeVideosPage outliers tab", () => {
  it("shows an add-channel affordance when nothing is tracked yet", () => {
    const markup = renderPage([]);
    expect(markup).toContain("No outliers yet");
    expect(markup).toContain("Add channel");
  });

  it("renders an outlier row with its score and link", () => {
    const markup = renderPage([outlierRow]);
    expect(markup).toContain("A breakout video");
    expect(markup).toContain("3.1x");
    expect(markup).toContain("https://youtube.com/watch?v=dQw4w9WgXcQ");
  });
});

describe("YoutubeVideosPage keywords tab", () => {
  it("advertises the Keywords tab on the page", () => {
    const markup = renderPage([outlierRow]);
    expect(markup).toContain("Keywords");
  });

  it("renders the five keyword section headings", () => {
    const markup = renderKeywordsTab();
    expect(markup).toContain("Keyword ideas");
    expect(markup).toContain("Keyword performance");
    expect(markup).toContain("High-performance keywords");
    expect(markup).toContain("Keyword gap");
    expect(markup).toContain("Compare keywords");
  });

  it("renders a cached performance sample with its median views and a video", () => {
    const markup = renderKeywordsTab((queryClient) => {
      queryClient.setQueryData(
        ["youtubeKeywordPerformance", PROJECT_ID, "", "US"],
        keywordPerformance,
      );
    });
    expect(markup).toContain("12,345");
    expect(markup).toContain("A sampled keyword video");
    expect(markup).toContain("Sampled Channel");
  });
});

describe("YoutubePerformanceSection", () => {
  it("explains that channel growth needs more snapshots", () => {
    const markup = renderPage([outlierRow], (queryClient) => {
      queryClient.setQueryData(["youtubeChannelGrowth", PROJECT_ID], {
        channel: {
          channelId: connection.channelId,
          channelTitle: connection.channelTitle,
        },
        points: [],
        warnings: ["insufficient_snapshots"],
      });
    });
    expect(markup).toContain("Channel performance");
    expect(markup).toContain(
      "Snapshots build as you refresh research channels",
    );
  });
});

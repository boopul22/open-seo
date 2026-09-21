/* eslint-disable max-lines -- page-only orchestration: the four tabs and the shared video table are colocated to avoid fake indirection (DomainOverviewPage precedent). */
import * as React from "react";
import {
  keepPreviousData,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";
import { sortBy } from "remeda";
import { youtubeConnectionOptions } from "@/client/features/integrations/googleConnectionQueries";
import { formatCount } from "@/client/features/search-performance/SearchPerformanceColumns";
import { YoutubeAudienceSection } from "@/client/features/youtube/YoutubeAudienceSection";
import { YoutubeKeywordsTab } from "@/client/features/youtube/YoutubeKeywordsTab";
import { YoutubePerformanceSection } from "@/client/features/youtube/YoutubePerformanceSection";
import { YoutubeResearchChannels } from "@/client/features/youtube/YoutubeResearchChannels";
import { YouTubeConnectionCard } from "@/client/features/youtube/YouTubeConnectionCard";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { formatRelativeTime } from "@/client/lib/relative-time";
import {
  getYoutubeOutliers,
  listYoutubeChannelVideos,
  listYoutubeResearchChannels,
  type ResearchChannelRow,
  type VideoRow,
} from "@/serverFunctions/youtubeResearch";

type Tab = "outliers" | "videos" | "audience" | "keywords";
type SortKey = "outlierScore" | "views" | "viewsPerDay" | "publishedAt";
type SortState = { key: SortKey; dir: "asc" | "desc" };
type VideoTableRow = VideoRow & { channelTitle?: string };
type OwnedChannel = { channelId: string | null; channelTitle: string | null };

const ALL_CHANNELS = "all";
const MY_CHANNEL = "mine";
const TABS: Array<{ value: Tab; label: string }> = [
  { value: "outliers", label: "Outliers" },
  { value: "videos", label: "Videos" },
  { value: "audience", label: "Audience" },
  { value: "keywords", label: "Keywords" },
];

/** Exported so the smoke test can seed the cache with the same query key. */
export const DEFAULT_OUTLIER_WINDOW_DAYS = 180;
export const DEFAULT_OUTLIER_MIN_SCORE = 1.5;

const OUTLIER_WINDOWS = [30, 90, 180, 365];
const OUTLIER_MIN_SCORES = [1, 1.5, 2, 3];
const OUTLIER_LIMIT = 50;
const VIDEO_LIMITS = [25, 50, 100];

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const SORT_ACCESSORS: Record<SortKey, (row: VideoTableRow) => number> = {
  outlierScore: (row) => row.outlierScore,
  views: (row) => row.views ?? -1,
  viewsPerDay: (row) => row.viewsPerDay,
  publishedAt: (row) => (row.publishedAt ? Date.parse(row.publishedAt) : 0),
};

export function youtubeOutliersQueryKey(
  projectId: string,
  windowDays: number,
  minScore: number,
  channelId: string | null,
) {
  return ["youtubeOutliers", projectId, windowDays, minScore, channelId];
}

function youtubeOutliersQueryOptions(
  projectId: string,
  windowDays: number,
  minScore: number,
  channelId: string | null,
) {
  return queryOptions({
    queryKey: youtubeOutliersQueryKey(
      projectId,
      windowDays,
      minScore,
      channelId,
    ),
    queryFn: () =>
      getYoutubeOutliers({
        data: {
          projectId,
          windowDays,
          minScore,
          limit: OUTLIER_LIMIT,
          ...(channelId ? { channelId } : {}),
        },
      }),
  });
}

function OutlierScoreBadge({ score }: { score: number }) {
  const tone =
    score >= 5 ? "badge-error" : score >= 2 ? "badge-warning" : "badge-ghost";
  return (
    <span className={`badge badge-sm tabular-nums ${tone}`}>
      {score.toFixed(1)}x
    </span>
  );
}

function HeaderCell({
  label,
  sortKey,
  sort,
  onSort,
  align,
}: {
  label: string;
  sortKey?: SortKey;
  sort?: SortState;
  onSort?: (key: SortKey) => void;
  align?: "right";
}) {
  const className = align === "right" ? "text-right" : undefined;
  if (!sortKey || !sort || !onSort) {
    return <th className={className}>{label}</th>;
  }
  const active = sort.key === sortKey;
  return (
    <th className={className}>
      <button
        type="button"
        className="font-medium transition-colors hover:text-base-content"
        onClick={() => onSort(sortKey)}
        aria-label={`Sort by ${label}`}
        aria-pressed={active}
      >
        {label}
        {active ? (sort.dir === "desc" ? " ▼" : " ▲") : ""}
      </button>
    </th>
  );
}

function VideoRowsTable({
  rows,
  showChannel = false,
  sort,
  onSort,
}: {
  rows: VideoTableRow[];
  showChannel?: boolean;
  sort?: SortState;
  onSort?: (key: SortKey) => void;
}) {
  const numeric = "text-right tabular-nums";
  return (
    <div className="overflow-x-auto rounded-lg border border-base-300">
      <table className="table table-sm">
        <thead>
          <tr>
            <th className="w-20">
              <span className="sr-only">Thumbnail</span>
            </th>
            <th>Video</th>
            {showChannel ? <th>Channel</th> : null}
            <HeaderCell
              label="Published"
              sortKey="publishedAt"
              sort={sort}
              onSort={onSort}
            />
            <HeaderCell
              label="Views"
              sortKey="views"
              sort={sort}
              onSort={onSort}
              align="right"
            />
            <HeaderCell
              label="Views/day"
              sortKey="viewsPerDay"
              sort={sort}
              onSort={onSort}
              align="right"
            />
            <HeaderCell
              label="Score"
              sortKey="outlierScore"
              sort={sort}
              onSort={onSort}
              align="right"
            />
            <th className="text-right">VPH</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.videoId}>
              <td>
                {row.thumbnailUrl ? (
                  <img
                    src={row.thumbnailUrl}
                    alt=""
                    loading="lazy"
                    className="h-9 w-16 rounded object-cover"
                  />
                ) : (
                  <div className="h-9 w-16 rounded bg-base-200" />
                )}
              </td>
              <td className="max-w-sm">
                <a
                  href={`https://youtube.com/watch?v=${row.videoId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="link link-hover line-clamp-2 font-medium"
                  title={row.title}
                >
                  {row.title}
                </a>
              </td>
              {showChannel ? (
                <td className="whitespace-nowrap text-sm text-base-content/70">
                  {row.channelTitle ?? "—"}
                </td>
              ) : null}
              <td className="whitespace-nowrap text-sm text-base-content/70">
                {row.publishedAt ? formatRelativeTime(row.publishedAt) : "—"}
              </td>
              <td className={numeric}>
                {row.views === null ? "—" : formatCount(row.views)}
              </td>
              <td className={numeric}>
                {compact.format(Math.round(row.viewsPerDay))}
              </td>
              <td className="text-right">
                <OutlierScoreBadge score={row.outlierScore} />
              </td>
              <td className={numeric}>
                {row.vph === null ? "—" : compact.format(Math.round(row.vph))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AddChannelPrompt({
  message,
  onAddChannel,
}: {
  message: string;
  onAddChannel: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      <p className="text-sm text-base-content/70">{message}</p>
      <button
        type="button"
        className="btn btn-primary btn-sm"
        onClick={onAddChannel}
      >
        <Plus className="size-4" />
        Add channel
      </button>
    </div>
  );
}

function QueryStatus({ error }: { error: unknown }) {
  return (
    <p role="alert" className="text-sm text-error">
      {getStandardErrorMessage(error)}
    </p>
  );
}

function TableLoading() {
  return (
    <div aria-busy className="space-y-2">
      <div className="skeleton h-8" />
      <div className="skeleton h-8" />
      <div className="skeleton h-8" />
    </div>
  );
}

function OutliersTab({
  projectId,
  ownedChannel,
  researchChannels,
  onAddChannel,
}: {
  projectId: string;
  ownedChannel: OwnedChannel;
  researchChannels: ResearchChannelRow[];
  onAddChannel: () => void;
}) {
  const [windowDays, setWindowDays] = React.useState(
    DEFAULT_OUTLIER_WINDOW_DAYS,
  );
  const [minScore, setMinScore] = React.useState(DEFAULT_OUTLIER_MIN_SCORE);
  const [scope, setScope] = React.useState(ALL_CHANNELS);
  const [sort, setSort] = React.useState<SortState>({
    key: "outlierScore",
    dir: "desc",
  });

  const scopeChannelId =
    scope === MY_CHANNEL
      ? ownedChannel.channelId
      : scope === ALL_CHANNELS
        ? null
        : scope;
  const outliersQuery = useQuery({
    ...youtubeOutliersQueryOptions(
      projectId,
      windowDays,
      minScore,
      scopeChannelId,
    ),
    placeholderData: keepPreviousData,
  });
  const rows = outliersQuery.data?.rows;
  const sortedRows = React.useMemo(
    () => sortBy(rows ?? [], [SORT_ACCESSORS[sort.key], sort.dir]),
    [rows, sort],
  );
  const toggleSort = (key: SortKey) =>
    setSort((current) =>
      current.key === key
        ? { key, dir: current.dir === "desc" ? "asc" : "desc" }
        : { key, dir: "desc" },
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="select select-bordered select-sm w-40"
          value={windowDays}
          onChange={(event) => setWindowDays(Number(event.target.value))}
          aria-label="Outlier window"
        >
          {OUTLIER_WINDOWS.map((days) => (
            <option key={days} value={days}>
              Last {days} days
            </option>
          ))}
        </select>
        <select
          className="select select-bordered select-sm w-36"
          value={minScore}
          onChange={(event) => setMinScore(Number(event.target.value))}
          aria-label="Minimum outlier score"
        >
          {OUTLIER_MIN_SCORES.map((score) => (
            <option key={score} value={score}>
              {score.toFixed(1)}x or more
            </option>
          ))}
        </select>
        <select
          className="select select-bordered select-sm w-56"
          value={scope}
          onChange={(event) => setScope(event.target.value)}
          aria-label="Channel scope"
        >
          <option value={ALL_CHANNELS}>All tracked + mine</option>
          {ownedChannel.channelId ? (
            <option value={MY_CHANNEL}>
              My channel
              {ownedChannel.channelTitle
                ? ` · ${ownedChannel.channelTitle}`
                : ""}
            </option>
          ) : null}
          {researchChannels.map((channel) => (
            <option key={channel.channelId} value={channel.channelId}>
              {channel.channelTitle}
            </option>
          ))}
        </select>
        {outliersQuery.isFetching && !outliersQuery.isPending ? (
          <Loader2 className="size-4 animate-spin text-base-content/40" />
        ) : null}
      </div>

      {outliersQuery.isPending ? (
        <TableLoading />
      ) : outliersQuery.isError ? (
        <QueryStatus error={outliersQuery.error} />
      ) : sortedRows.length === 0 ? (
        <AddChannelPrompt
          message={
            researchChannels.length === 0
              ? "No outliers yet — add a channel to track."
              : "No outliers match these filters. Try a wider window or a lower minimum score."
          }
          onAddChannel={onAddChannel}
        />
      ) : (
        <VideoRowsTable
          rows={sortedRows}
          showChannel
          sort={sort}
          onSort={toggleSort}
        />
      )}
    </div>
  );
}

function VideosTab({
  projectId,
  ownedChannel,
  researchChannels,
  onAddChannel,
}: {
  projectId: string;
  ownedChannel: OwnedChannel;
  researchChannels: ResearchChannelRow[];
  onAddChannel: () => void;
}) {
  const [selectedChannelId, setSelectedChannelId] = React.useState("");
  const [sort, setSort] = React.useState<"views" | "newest" | "outlier">(
    "views",
  );
  const [limit, setLimit] = React.useState(50);

  const channelOptions: Array<{ channelId: string; label: string }> = [];
  if (ownedChannel.channelId) {
    channelOptions.push({
      channelId: ownedChannel.channelId,
      label: `My channel${ownedChannel.channelTitle ? ` · ${ownedChannel.channelTitle}` : ""}`,
    });
  }
  for (const channel of researchChannels) {
    if (channel.channelId === ownedChannel.channelId) continue;
    channelOptions.push({
      channelId: channel.channelId,
      label: channel.channelTitle,
    });
  }
  const channelId = channelOptions.some(
    (option) => option.channelId === selectedChannelId,
  )
    ? selectedChannelId
    : (channelOptions[0]?.channelId ?? "");

  const videosQuery = useQuery({
    queryKey: ["youtubeChannelVideos", projectId, channelId, sort, limit],
    queryFn: () =>
      listYoutubeChannelVideos({ data: { projectId, channelId, sort, limit } }),
    enabled: Boolean(channelId),
    placeholderData: keepPreviousData,
  });
  const data = videosQuery.data;

  if (channelOptions.length === 0) {
    return (
      <AddChannelPrompt
        message="No channels to list yet — add a research channel."
        onAddChannel={onAddChannel}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="select select-bordered select-sm w-64"
          value={channelId}
          onChange={(event) => setSelectedChannelId(event.target.value)}
          aria-label="Channel"
        >
          {channelOptions.map((option) => (
            <option key={option.channelId} value={option.channelId}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          className="select select-bordered select-sm w-40"
          value={sort}
          onChange={(event) =>
            setSort(
              event.target.value === "newest"
                ? "newest"
                : event.target.value === "outlier"
                  ? "outlier"
                  : "views",
            )
          }
          aria-label="Sort videos"
        >
          <option value="views">Most views</option>
          <option value="newest">Newest</option>
          <option value="outlier">Outlier score</option>
        </select>
        <select
          className="select select-bordered select-sm w-32"
          value={limit}
          onChange={(event) => setLimit(Number(event.target.value))}
          aria-label="Video limit"
        >
          {VIDEO_LIMITS.map((value) => (
            <option key={value} value={value}>
              {value} videos
            </option>
          ))}
        </select>
        {videosQuery.isFetching && !videosQuery.isPending ? (
          <Loader2 className="size-4 animate-spin text-base-content/40" />
        ) : null}
      </div>

      {data ? (
        <p className="text-sm text-base-content/70">
          <span className="font-medium text-base-content">
            {data.channel.channelTitle}
          </span>
          {": median "}
          <span className="tabular-nums">
            {formatCount(data.stats.medianViews)}
          </span>
          {" views, average "}
          <span className="tabular-nums">
            {formatCount(data.stats.averageViews)}
          </span>
          {", "}
          <span className="tabular-nums">
            {data.stats.uploadsPerWeek.toFixed(1)}
          </span>
          {` uploads/week (sample of ${data.stats.sampleSize})`}
        </p>
      ) : null}

      {videosQuery.isPending ? (
        <TableLoading />
      ) : videosQuery.isError ? (
        <QueryStatus error={videosQuery.error} />
      ) : data && data.videos.length > 0 ? (
        <VideoRowsTable rows={data.videos} />
      ) : (
        <p className="py-8 text-center text-sm text-base-content/60">
          No videos found for this channel.
        </p>
      )}
    </div>
  );
}

export function YoutubeVideosPage({ projectId }: { projectId: string }) {
  const [tab, setTab] = React.useState<Tab>("outliers");
  const [channelsOpen, setChannelsOpen] = React.useState(false);
  const connectionQuery = useQuery(youtubeConnectionOptions(projectId));
  const connection = connectionQuery.data;
  const connected = Boolean(connection?.connected);

  const researchChannelsQuery = useQuery({
    queryKey: ["youtubeResearchChannels", projectId],
    queryFn: () => listYoutubeResearchChannels({ data: { projectId } }),
    enabled: connected,
  });
  const researchChannels = researchChannelsQuery.data?.channels ?? [];
  const ownedChannel: OwnedChannel = {
    channelId: connection?.channelId ?? null,
    channelTitle: connection?.channelTitle ?? null,
  };

  return (
    <div className="overflow-auto px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-7xl space-y-4">
        {connectionQuery.isPending ? (
          <div aria-busy className="skeleton h-64 rounded-xl" />
        ) : !connected ? (
          <YouTubeConnectionCard
            projectId={projectId}
            heading={<h1 className="text-2xl font-semibold">YouTube</h1>}
          />
        ) : (
          <>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h1 className="text-2xl font-semibold">YouTube</h1>
                <p className="text-sm text-base-content/70">
                  Find breakout videos across the channels you track, then dig
                  into your own channel&rsquo;s audience.
                </p>
              </div>
              <button
                type="button"
                className="btn btn-sm shrink-0 self-start"
                onClick={() => setChannelsOpen(true)}
              >
                <Plus className="size-4" />
                Research channels
              </button>
            </div>

            <div className="overflow-hidden rounded-xl border border-base-300 bg-base-100">
              <div className="border-b border-base-300 px-4 py-3">
                <div role="tablist" className="tabs tabs-border w-fit">
                  {TABS.filter(
                    (item) =>
                      item.value !== "audience" || connection?.channelId,
                  ).map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      role="tab"
                      aria-selected={tab === item.value}
                      className={`tab ${tab === item.value ? "tab-active" : ""}`}
                      onClick={() => setTab(item.value)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="p-4">
                {tab === "outliers" ? (
                  <OutliersTab
                    projectId={projectId}
                    ownedChannel={ownedChannel}
                    researchChannels={researchChannels}
                    onAddChannel={() => setChannelsOpen(true)}
                  />
                ) : tab === "videos" ? (
                  <VideosTab
                    projectId={projectId}
                    ownedChannel={ownedChannel}
                    researchChannels={researchChannels}
                    onAddChannel={() => setChannelsOpen(true)}
                  />
                ) : tab === "keywords" ? (
                  <YoutubeKeywordsTab
                    projectId={projectId}
                    ownedChannel={ownedChannel}
                  />
                ) : connection?.channelId ? (
                  <YoutubeAudienceSection
                    projectId={projectId}
                    channelId={connection.channelId}
                  />
                ) : null}
              </div>
            </div>

            <YoutubePerformanceSection projectId={projectId} />
          </>
        )}
      </div>

      {connected ? (
        <YoutubeResearchChannels
          projectId={projectId}
          open={channelsOpen}
          onClose={() => setChannelsOpen(false)}
        />
      ) : null}
    </div>
  );
}

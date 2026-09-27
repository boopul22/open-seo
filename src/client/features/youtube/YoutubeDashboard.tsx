/* eslint-disable max-lines -- one dashboard keeps its header, range, tiles, chart, and tables colocated (YoutubeVideosPage precedent). */
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  CardShell,
  PercentDelta,
  Stat,
  formatDay,
} from "@/client/features/dashboard/cardParts";
import { youtubeConnectionOptions } from "@/client/features/integrations/googleConnectionQueries";
import { formatCount } from "@/client/features/search-performance/SearchPerformanceColumns";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  getYoutubeChannelInfo,
  getYoutubeChannelOverview,
  getYoutubeTopVideos,
  getYoutubeTrafficSources,
} from "@/serverFunctions/youtube";
import {
  getYoutubeAudienceBreakdown,
  type YoutubeAudienceDimension,
  type YoutubeAudienceRow,
} from "@/serverFunctions/youtubeAudience";

const YOUTUBE_DASHBOARD_RANGE_DAYS = [7, 28, 90] as const;
const DEFAULT_RANGE_DAYS = 28;
const ANALYTICS_LAG_NOTE = "Analytics lags about 2 days; showing through";
const RANKED_VIDEO_LIMIT = 10;
const TRAFFIC_SOURCE_LIMIT = 10;
const AUDIENCE_LIMIT = 5;
const TILE_SKELETON_COUNT = 10;

type MetricRow = Record<string, unknown> | null | undefined;
type TrendDay = {
  date: string;
  views: number;
  estimatedMinutesWatched: number;
  subscribersGained: number;
  subscribersLost: number;
};
type VideoSort = "views" | "watch_time";

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const TRAFFIC_SOURCE_LABELS: Record<string, string> = {
  YT_SEARCH: "YouTube search",
  SUGGESTED_VIDEO: "Suggested videos",
  BROWSE: "Browse features",
  EXTERNAL: "External",
  PLAYLIST: "Playlists",
  DIRECT_OR_UNKNOWN: "Direct or unknown",
  YT_OTHER: "Other YouTube features",
  NOTIFICATION: "Notifications",
  SUBSCRIBER: "Subscribers",
  CHANNEL: "Channel pages",
  SHORTS: "Shorts feed",
  NO_LINK_OTHER: "Other",
};

/** UTC trailing window: endDate is today, startDate is days - 1 earlier. The
 *  server clamps the end to the last complete analytics day. */
export function youtubeDashboardRange(days: number): {
  startDate: string;
  endDate: string;
} {
  const endDate = new Date().toISOString().slice(0, 10);
  const startMs = Date.parse(`${endDate}T00:00:00Z`) - (days - 1) * 86_400_000;
  return {
    startDate: new Date(startMs).toISOString().slice(0, 10),
    endDate,
  };
}

function numberAt(row: MetricRow, key: string): number | null {
  const value = row?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function netSubscribers(row: MetricRow): number | null {
  const gained = numberAt(row, "subscribersGained");
  const lost = numberAt(row, "subscribersLost");
  if (gained === null && lost === null) return null;
  return (gained ?? 0) - (lost ?? 0);
}

function signedCount(value: number | null): string {
  if (value === null) return "—";
  return `${value > 0 ? "+" : ""}${formatCount(value)}`;
}

function countValue(row: MetricRow, key: string): string {
  const value = numberAt(row, key);
  return value === null ? "—" : formatCount(value);
}

/** YouTube Analytics rows keep their raw `string | number` values. */
function toNumber(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function countText(value: string | number | null | undefined): string {
  const count = toNumber(value);
  return count === null ? "—" : formatCount(count);
}

function formatWatchTime(value: string | number | null | undefined): string {
  const minutes = toNumber(value);
  if (minutes === null) return "—";
  return minutes > 120
    ? `${(minutes / 60).toFixed(1)} h`
    : `${formatCount(minutes)} min`;
}

function formatHours(value: string | number | null | undefined): string {
  const minutes = toNumber(value);
  return minutes === null ? "—" : (minutes / 60).toFixed(1);
}

function formatDuration(value: string | number | null | undefined): string {
  const seconds = toNumber(value);
  if (seconds === null) return "—";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const secs = total % 60;
  const ss = String(secs).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${ss}`
    : `${minutes}:${ss}`;
}

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function trafficSourceLabel(value: string | null): string {
  if (!value) return "Unknown";
  return (
    TRAFFIC_SOURCE_LABELS[value] ??
    value
      .toLowerCase()
      .split("_")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ")
  );
}

function QueryStatus({ error }: { error: unknown }) {
  return (
    <p role="alert" className="text-sm text-error">
      {getStandardErrorMessage(error)}
    </p>
  );
}

function SectionHint({ children }: { children: ReactNode }) {
  return <p className="text-sm text-base-content/60">{children}</p>;
}

function RangeTabs({
  days,
  onChange,
}: {
  days: number;
  onChange: (days: number) => void;
}) {
  return (
    <div role="tablist" aria-label="Date range" className="join">
      {YOUTUBE_DASHBOARD_RANGE_DAYS.map((value) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={value === days}
          className={`btn join-item btn-sm ${value === days ? "btn-active" : "btn-ghost"}`}
          onClick={() => onChange(value)}
        >
          {value} days
        </button>
      ))}
    </div>
  );
}

function ChannelHeader({ projectId }: { projectId: string }) {
  const query = useQuery({
    queryKey: ["youtubeChannelInfo", projectId],
    queryFn: () => getYoutubeChannelInfo({ data: { projectId } }),
  });

  if (query.isPending) {
    return (
      <div
        className="flex items-center gap-4 rounded-xl border border-base-300 bg-base-100 p-5 shadow-sm"
        aria-busy
      >
        <div className="skeleton h-16 w-16 shrink-0 rounded-full" />
        <div className="flex-1 space-y-2">
          <div className="skeleton h-5 w-48" />
          <div className="skeleton h-4 w-32" />
        </div>
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="rounded-xl border border-base-300 bg-base-100 p-5 shadow-sm">
        <QueryStatus error={query.error} />
      </div>
    );
  }

  const info = query.data;
  const handlePath = info.channel.channelHandle?.replace(/^@/, "") ?? null;
  const initial = info.channel.channelTitle.slice(0, 1).toUpperCase();

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-base-300 bg-base-100 p-5 shadow-sm sm:flex-row sm:items-center">
      {info.channel.thumbnailUrl ? (
        <img
          src={info.channel.thumbnailUrl}
          alt=""
          className="h-16 w-16 shrink-0 rounded-full object-cover"
          referrerPolicy="no-referrer"
        />
      ) : (
        <div
          className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-base-200 text-xl font-semibold"
          aria-hidden
        >
          {initial}
        </div>
      )}
      <div className="min-w-0">
        <h2 className="truncate text-xl font-semibold">
          {handlePath ? (
            <a
              href={`https://youtube.com/@${handlePath}`}
              target="_blank"
              rel="noreferrer"
              className="hover:underline"
            >
              {info.channel.channelTitle}
            </a>
          ) : (
            info.channel.channelTitle
          )}
        </h2>
        {info.channel.channelHandle ? (
          <p className="text-sm text-base-content/60">
            {info.channel.channelHandle}
          </p>
        ) : null}
      </div>
      <div className="grid grid-cols-3 gap-5 sm:ml-auto sm:text-right">
        <Stat
          label="Subscribers"
          value={
            info.subscriberCount === null
              ? "—"
              : formatCount(info.subscriberCount)
          }
        />
        <Stat
          label="Videos"
          value={info.videoCount === null ? "—" : formatCount(info.videoCount)}
        />
        <Stat
          label="Total views"
          value={info.viewCount === null ? "—" : formatCount(info.viewCount)}
        />
      </div>
    </div>
  );
}

function MetricTiles({
  current,
  previous,
}: {
  current: MetricRow;
  previous: MetricRow;
}) {
  const delta = (key: string) => {
    const currentValue = numberAt(current, key);
    const previousValue = numberAt(previous, key);
    return currentValue === null || previousValue === null ? undefined : (
      <PercentDelta current={currentValue} previous={previousValue} />
    );
  };

  const net = netSubscribers(current);
  const previousNet = netSubscribers(previous);
  const tiles: Array<{
    label: string;
    value: string;
    tone?: "success" | "error";
    sub?: ReactNode;
  }> = [
    {
      label: "Views",
      value: countValue(current, "views"),
      sub: delta("views"),
    },
    {
      label: "Watch time",
      value: formatWatchTime(numberAt(current, "estimatedMinutesWatched")),
      sub: delta("estimatedMinutesWatched"),
    },
    {
      label: "Net subscribers",
      value: signedCount(net),
      tone:
        net !== null && net > 0
          ? "success"
          : net !== null && net < 0
            ? "error"
            : undefined,
      sub:
        net !== null && previousNet !== null ? (
          <PercentDelta current={net} previous={previousNet} />
        ) : undefined,
    },
    {
      label: "Subscribers gained",
      value: countValue(current, "subscribersGained"),
      sub: delta("subscribersGained"),
    },
    {
      label: "Subscribers lost",
      value: countValue(current, "subscribersLost"),
      sub: delta("subscribersLost"),
    },
    {
      label: "Likes",
      value: countValue(current, "likes"),
      sub: delta("likes"),
    },
    {
      label: "Comments",
      value: countValue(current, "comments"),
      sub: delta("comments"),
    },
    {
      label: "Shares",
      value: countValue(current, "shares"),
      sub: delta("shares"),
    },
    {
      label: "Avg view duration",
      value: formatDuration(numberAt(current, "averageViewDuration")),
    },
    {
      label: "Avg view %",
      value: formatPercent(numberAt(current, "averageViewPercentage")),
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
      {tiles.map((tile) => (
        <div
          key={tile.label}
          className="rounded-xl border border-base-300 bg-base-100 p-4 shadow-sm"
        >
          <Stat
            label={tile.label}
            value={tile.value}
            tone={tile.tone}
            sub={tile.sub}
          />
        </div>
      ))}
    </div>
  );
}

function ChartTooltip({
  active,
  payload,
  label,
  format,
}: {
  active?: boolean;
  payload?: Array<{ value?: number }>;
  label?: string;
  format: (value: number) => string;
}) {
  if (!active || !payload?.length) return null;
  const value = payload[0]?.value;
  if (typeof value !== "number") return null;
  return (
    <div className="rounded-md border border-base-300 bg-base-100 px-3 py-2 shadow-sm">
      <p className="text-xs text-base-content/60">
        {label ? formatDay(label) : ""}
      </p>
      <p className="text-sm font-medium tabular-nums">{format(value)}</p>
    </div>
  );
}

const CHART_METRICS = [
  { key: "views", label: "Views" },
  { key: "watchMinutes", label: "Watch time" },
  { key: "netSubscribers", label: "Net subscribers" },
] as const;

type ChartMetricKey = (typeof CHART_METRICS)[number]["key"];

function TrendCard({ trend }: { trend: TrendDay[] }) {
  const [metric, setMetric] = useState<ChartMetricKey>("views");
  const data = trend.map((day) => ({
    date: day.date,
    views: day.views,
    watchMinutes: day.estimatedMinutesWatched,
    netSubscribers: day.subscribersGained - day.subscribersLost,
  }));
  const formatValue =
    metric === "views"
      ? (value: number) => `${formatCount(value)} views`
      : metric === "watchMinutes"
        ? (value: number) => formatWatchTime(value)
        : (value: number) => `${signedCount(value)} subscribers`;

  return (
    <CardShell
      title="Channel performance"
      action={
        <div role="tablist" aria-label="Chart metric" className="join">
          {CHART_METRICS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              role="tab"
              aria-selected={entry.key === metric}
              className={`btn join-item btn-xs ${entry.key === metric ? "btn-active" : "btn-ghost"}`}
              onClick={() => setMetric(entry.key)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      }
    >
      {data.length === 0 ? (
        <SectionHint>No daily activity in this period yet.</SectionHint>
      ) : (
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={data}
              margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
            >
              <XAxis dataKey="date" hide />
              <YAxis hide domain={["auto", "auto"]} />
              <Tooltip
                content={<ChartTooltip format={formatValue} />}
                cursor={{ stroke: "currentColor", strokeOpacity: 0.2 }}
              />
              <Area
                type="monotone"
                dataKey={metric}
                stroke="var(--color-primary)"
                strokeWidth={2}
                fill="var(--color-primary)"
                fillOpacity={0.08}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </CardShell>
  );
}

function VideoSortToggle({
  value,
  onChange,
}: {
  value: VideoSort;
  onChange: (value: VideoSort) => void;
}) {
  return (
    <div role="tablist" aria-label="Rank videos by" className="join">
      {(
        [
          ["views", "Views"],
          ["watch_time", "Watch time"],
        ] as const
      ).map(([key, label]) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={value === key}
          className={`btn join-item btn-xs ${value === key ? "btn-active" : "btn-ghost"}`}
          onClick={() => onChange(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function TopVideosCard({
  projectId,
  startDate,
  endDate,
}: {
  projectId: string;
  startDate: string;
  endDate: string;
}) {
  const [sort, setSort] = useState<VideoSort>("views");
  const query = useQuery({
    queryKey: ["youtubeTopVideos", projectId, startDate, endDate, sort],
    queryFn: () =>
      getYoutubeTopVideos({
        data: {
          projectId,
          startDate,
          endDate,
          limit: RANKED_VIDEO_LIMIT,
          sort,
        },
      }),
  });

  return (
    <CardShell
      title="Top videos"
      action={<VideoSortToggle value={sort} onChange={setSort} />}
    >
      {query.isPending ? (
        <div className="space-y-3" aria-busy>
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="skeleton h-10" />
          ))}
        </div>
      ) : query.isError ? (
        <QueryStatus error={query.error} />
      ) : query.data.rows.length === 0 ? (
        <SectionHint>No video views in this period yet.</SectionHint>
      ) : (
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>#</th>
                <th aria-label="Thumbnail" />
                <th>Video</th>
                <th className="text-right">Views</th>
                <th className="text-right">Watch time (h)</th>
                <th className="text-right">Avg view</th>
                <th className="text-right">Subscribers</th>
                <th className="text-right">Likes</th>
              </tr>
            </thead>
            <tbody>
              {query.data.rows.map((row, index) => (
                <tr key={row.videoId ?? `video-${index}`}>
                  <td className="text-base-content/50">{index + 1}</td>
                  <td>
                    {row.thumbnailUrl ? (
                      <img
                        src={row.thumbnailUrl}
                        alt=""
                        className="h-9 w-16 rounded object-cover"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <div className="h-9 w-16 rounded bg-base-200" />
                    )}
                  </td>
                  <td>
                    <div className="max-w-64 truncate font-medium">
                      {row.videoId ? (
                        <a
                          href={`https://youtube.com/watch?v=${row.videoId}`}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:underline"
                        >
                          {row.title ?? row.videoId}
                        </a>
                      ) : (
                        (row.title ?? "—")
                      )}
                    </div>
                  </td>
                  <td className="text-right tabular-nums">
                    {countText(row.views)}
                  </td>
                  <td className="text-right tabular-nums">
                    {formatHours(row.estimatedMinutesWatched)}
                  </td>
                  <td className="text-right tabular-nums">
                    {formatDuration(row.averageViewDuration)}
                  </td>
                  <td className="text-right tabular-nums">
                    {countText(row.subscribersGained)}
                  </td>
                  <td className="text-right tabular-nums">
                    {countText(row.likes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </CardShell>
  );
}

function TrafficSourcesCard({
  projectId,
  startDate,
  endDate,
}: {
  projectId: string;
  startDate: string;
  endDate: string;
}) {
  const query = useQuery({
    queryKey: ["youtubeTrafficSources", projectId, startDate, endDate],
    queryFn: () =>
      getYoutubeTrafficSources({
        data: { projectId, startDate, endDate, limit: TRAFFIC_SOURCE_LIMIT },
      }),
  });

  return (
    <CardShell title="Traffic sources">
      {query.isPending ? (
        <div className="space-y-3" aria-busy>
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="skeleton h-8" />
          ))}
        </div>
      ) : query.isError ? (
        <QueryStatus error={query.error} />
      ) : query.data.rows.length === 0 ? (
        <SectionHint>
          No traffic sources recorded in this period yet.
        </SectionHint>
      ) : (
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Source</th>
                <th className="text-right">Views</th>
                <th className="text-right">Watch time (h)</th>
                <th className="text-right">Avg view</th>
              </tr>
            </thead>
            <tbody>
              {query.data.rows.map((row, index) => (
                <tr key={`${row.trafficSource ?? "unknown"}-${index}`}>
                  <td className="font-medium">
                    {trafficSourceLabel(row.trafficSource)}
                  </td>
                  <td className="text-right tabular-nums">
                    {countText(row.views)}
                  </td>
                  <td className="text-right tabular-nums">
                    {formatHours(row.estimatedMinutesWatched)}
                  </td>
                  <td className="text-right tabular-nums">
                    {formatDuration(row.averageViewDuration)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </CardShell>
  );
}

function audienceLabelKey(
  rows: YoutubeAudienceRow[],
  dimension: string,
): string | null {
  const first = rows[0];
  if (!first) return null;
  if (typeof first[dimension] === "string") return dimension;
  return (
    Object.keys(first).find((key) => typeof first[key] === "string") ?? null
  );
}

function audienceMetrics(
  row: YoutubeAudienceRow,
  labelKey: string | null,
): Array<{ key: string; value: number }> {
  const metrics: Array<{ key: string; value: number }> = [];
  for (const [key, value] of Object.entries(row)) {
    if (key === labelKey || typeof value !== "number") continue;
    metrics.push({ key, value });
    if (metrics.length === 2) break;
  }
  return metrics;
}

function formatAudienceMetric(key: string, value: number): string {
  const normalized = key.toLowerCase();
  if (normalized.includes("minutes")) return formatWatchTime(value);
  if (normalized.includes("percentage")) return formatPercent(value);
  return compact.format(value);
}

function AudienceRows({
  rows,
  dimension,
}: {
  rows: YoutubeAudienceRow[];
  dimension: string;
}) {
  const labelKey = audienceLabelKey(rows, dimension);
  return (
    <ul className="space-y-2">
      {rows.map((row, index) => {
        const label = labelKey ? row[labelKey] : null;
        return (
          <li
            key={`${typeof label === "string" ? label : "row"}-${index}`}
            className="flex items-center justify-between gap-3 text-sm"
          >
            <span className="truncate">
              {typeof label === "string" && label ? label : "Unknown"}
            </span>
            <span className="shrink-0 tabular-nums text-base-content/70">
              {audienceMetrics(row, labelKey)
                .map((metric) => formatAudienceMetric(metric.key, metric.value))
                .join(" · ")}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function AudienceCard({
  projectId,
  dimension,
  title,
}: {
  projectId: string;
  dimension: YoutubeAudienceDimension;
  title: string;
}) {
  const query = useQuery({
    queryKey: ["youtubeAudienceCard", projectId, dimension],
    queryFn: () =>
      getYoutubeAudienceBreakdown({
        data: { projectId, dimension, limit: AUDIENCE_LIMIT },
      }),
  });

  return (
    <CardShell title={title}>
      {query.isPending ? (
        <div className="space-y-3" aria-busy>
          {Array.from({ length: AUDIENCE_LIMIT }, (_, index) => (
            <div key={index} className="skeleton h-5" />
          ))}
        </div>
      ) : query.isError ? (
        <QueryStatus error={query.error} />
      ) : query.data.rows.length === 0 ? (
        <SectionHint>No audience data in this period yet.</SectionHint>
      ) : (
        <AudienceRows rows={query.data.rows} dimension={dimension} />
      )}
    </CardShell>
  );
}

/** Full-width YouTube Studio-style dashboard for YouTube projects. */
export function YoutubeDashboard({ projectId }: { projectId: string }) {
  const connectionQuery = useQuery(youtubeConnectionOptions(projectId));
  const [rangeDays, setRangeDays] = useState(DEFAULT_RANGE_DAYS);
  const { startDate, endDate } = youtubeDashboardRange(rangeDays);

  const overviewQuery = useQuery({
    queryKey: ["youtubeChannelOverview", projectId, startDate, endDate],
    queryFn: () =>
      getYoutubeChannelOverview({ data: { projectId, startDate, endDate } }),
  });

  if (connectionQuery.data && !connectionQuery.data.connected) return null;

  const report = overviewQuery.data?.connected ? overviewQuery.data : null;
  const clamped =
    report?.request.warnings.includes("end_date_clamped") ?? false;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <ChannelHeader projectId={projectId} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <RangeTabs days={rangeDays} onChange={setRangeDays} />
        {clamped && report ? (
          <p className="text-xs text-base-content/50">
            {ANALYTICS_LAG_NOTE} {report.request.resolvedRange.endDate}
          </p>
        ) : null}
      </div>

      {overviewQuery.isPending ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3" aria-busy>
          {Array.from({ length: TILE_SKELETON_COUNT }, (_, index) => (
            <div key={index} className="skeleton h-24 rounded-xl" />
          ))}
        </div>
      ) : overviewQuery.isError ? (
        <CardShell title="Channel performance">
          <QueryStatus error={overviewQuery.error} />
        </CardShell>
      ) : report ? (
        <>
          <MetricTiles current={report.current} previous={report.previous} />
          <TrendCard trend={report.trend} />
        </>
      ) : (
        <CardShell title="Channel performance">
          <SectionHint>
            YouTube Analytics isn&rsquo;t available for this channel.
          </SectionHint>
        </CardShell>
      )}

      <TopVideosCard
        projectId={projectId}
        startDate={startDate}
        endDate={endDate}
      />

      <TrafficSourcesCard
        projectId={projectId}
        startDate={startDate}
        endDate={endDate}
      />

      <div className="grid items-start gap-5 lg:grid-cols-2">
        <AudienceCard
          projectId={projectId}
          dimension="country"
          title="Top countries"
        />
        <AudienceCard
          projectId={projectId}
          dimension="deviceType"
          title="Device types"
        />
      </div>
    </div>
  );
}

/* eslint-disable max-lines -- one compact performance section keeps its four metric cards colocated (YoutubeVideosPage precedent). */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { reverse } from "remeda";
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
  Stat,
  formatDay,
} from "@/client/features/dashboard/cardParts";
import { youtubeConnectionOptions } from "@/client/features/integrations/googleConnectionQueries";
import { formatCount } from "@/client/features/search-performance/SearchPerformanceColumns";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { formatRelativeTime } from "@/client/lib/relative-time";
import {
  getYoutubeBestPublishDays,
  getYoutubeChannelGrowth,
  getYoutubeVideoTrend,
  listYoutubePlaylists,
  type YoutubeChannelGrowth,
  type YoutubeVideoTrendPoint,
} from "@/serverFunctions/youtubePerformance";

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const INSUFFICIENT_SNAPSHOTS = "insufficient_snapshots";
const DEFAULT_TREND_DAYS = 90;
const TREND_DAYS = [30, 90, 365];
const GROWTH_GUIDANCE =
  "Snapshots build as you refresh research channels — at least two are needed for growth.";
const TREND_GUIDANCE =
  "Snapshots build as you refresh research channels — at least two are needed for a trend.";

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function signedCount(value: number | null): string {
  if (value === null) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${compact.format(Math.abs(value))}`;
}

function QueryStatus({ error }: { error: unknown }) {
  return (
    <p role="alert" className="text-sm text-error">
      {getStandardErrorMessage(error)}
    </p>
  );
}

function CardSkeleton({ className = "h-32" }: { className?: string }) {
  return <div aria-busy className={`skeleton rounded-lg ${className}`} />;
}

function SectionHint({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-base-content/60">{children}</p>;
}

function SnapshotTooltip({
  active,
  payload,
  label,
  unit,
}: {
  active?: boolean;
  payload?: Array<{ value: number }>;
  label?: string;
  unit: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-base-300 bg-base-100 px-3 py-2 shadow-sm">
      <p className="text-xs text-base-content/60">
        {label ? formatDay(label) : ""}
      </p>
      <p className="text-sm font-medium tabular-nums">
        {formatCount(payload[0].value)} {unit}
      </p>
    </div>
  );
}

function GrowthBody({ data }: { data: YoutubeChannelGrowth }) {
  const points = data.points;
  const first = points[0];
  const latest = points[points.length - 1];
  const seriesDelta =
    latest?.subscriberCount != null && first?.subscriberCount != null
      ? latest.subscriberCount - first.subscriberCount
      : null;
  const chartData = points.map((point) => ({
    capturedAt: point.capturedAt,
    subscriberCount: point.subscriberCount,
  }));

  return (
    <div className="space-y-3">
      <p className="text-xs text-base-content/60">
        {data.channel.channelTitle} · {points.length} snapshots
      </p>
      <div className="grid grid-cols-3 gap-3">
        <Stat
          label="Subscribers"
          value={
            latest?.subscriberCount == null
              ? "—"
              : formatCount(latest.subscriberCount)
          }
        />
        <Stat
          label="Latest change"
          value={signedCount(latest?.deltaSubscribers ?? null)}
        />
        <Stat label="Series change" value={signedCount(seriesDelta)} />
      </div>
      <div className="h-28">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={chartData}
            margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
          >
            <XAxis dataKey="capturedAt" hide />
            <YAxis hide domain={["auto", "auto"]} />
            <Tooltip
              content={<SnapshotTooltip unit="subscribers" />}
              cursor={{ stroke: "currentColor", strokeOpacity: 0.2 }}
            />
            <Area
              type="monotone"
              dataKey="subscriberCount"
              stroke="var(--color-primary)"
              strokeWidth={2}
              fill="var(--color-primary)"
              fillOpacity={0.08}
              connectNulls
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function ChannelGrowthCard({ projectId }: { projectId: string }) {
  const query = useQuery({
    queryKey: ["youtubeChannelGrowth", projectId],
    queryFn: () => getYoutubeChannelGrowth({ data: { projectId } }),
  });

  return (
    <CardShell title="Channel growth">
      {query.isPending ? (
        <CardSkeleton />
      ) : query.isError ? (
        <QueryStatus error={query.error} />
      ) : query.data.warnings.includes(INSUFFICIENT_SNAPSHOTS) ? (
        <SectionHint>{GROWTH_GUIDANCE}</SectionHint>
      ) : (
        <GrowthBody data={query.data} />
      )}
    </CardShell>
  );
}

function BestPublishDaysCard({ projectId }: { projectId: string }) {
  const query = useQuery({
    queryKey: ["youtubeBestPublishDays", projectId],
    queryFn: () => getYoutubeBestPublishDays({ data: { projectId } }),
  });

  return (
    <CardShell title="Best publish days">
      {query.isPending ? (
        <CardSkeleton />
      ) : query.isError ? (
        <QueryStatus error={query.error} />
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-base-content/60">
            {query.data.channel.channelTitle} · {query.data.range.startDate} to{" "}
            {query.data.range.endDate}
          </p>
          <div className="overflow-x-auto rounded-lg border border-base-300">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>Day</th>
                  <th className="text-right">Views</th>
                  <th className="text-right">Uploads</th>
                  <th className="text-right">Avg views/upload</th>
                </tr>
              </thead>
              <tbody>
                {query.data.weekdays.map((day) => {
                  const best = day.weekday === query.data.bestDay;
                  return (
                    <tr
                      key={day.weekday}
                      className={best ? "bg-primary/5" : ""}
                    >
                      <td className="font-medium">
                        {day.weekday}
                        {best ? (
                          <span className="badge badge-primary badge-sm ml-2">
                            Best
                          </span>
                        ) : null}
                      </td>
                      <td className="text-right tabular-nums">
                        {formatCount(day.views)}
                      </td>
                      <td className="text-right tabular-nums">{day.uploads}</td>
                      <td className="text-right tabular-nums">
                        {day.averageViewsPerUpload === null
                          ? "—"
                          : formatCount(day.averageViewsPerUpload)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ul className="space-y-1">
            {query.data.notes.map((note) => (
              <li
                key={note}
                className="text-[11px] leading-snug text-base-content/45"
              >
                {note}
              </li>
            ))}
          </ul>
        </div>
      )}
    </CardShell>
  );
}

function TrendBody({ points }: { points: YoutubeVideoTrendPoint[] }) {
  const latest = points[points.length - 1] ?? null;
  const chartData = points.map((point) => ({
    capturedAt: point.capturedAt,
    viewCount: point.viewCount,
  }));
  const rows = reverse(points);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <Stat
          label="Latest views"
          value={
            latest?.viewCount == null ? "—" : formatCount(latest.viewCount)
          }
        />
        <Stat
          label="Latest Δ"
          value={signedCount(latest?.deltaViews ?? null)}
        />
        <Stat
          label="Latest VPH"
          value={latest?.vph == null ? "—" : compact.format(latest.vph)}
        />
      </div>
      <div className="h-28">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={chartData}
            margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
          >
            <XAxis dataKey="capturedAt" hide />
            <YAxis hide domain={["auto", "auto"]} />
            <Tooltip
              content={<SnapshotTooltip unit="views" />}
              cursor={{ stroke: "currentColor", strokeOpacity: 0.2 }}
            />
            <Area
              type="monotone"
              dataKey="viewCount"
              stroke="var(--color-primary)"
              strokeWidth={2}
              fill="var(--color-primary)"
              fillOpacity={0.08}
              connectNulls
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="max-h-48 overflow-auto rounded-lg border border-base-300">
        <table className="table table-xs">
          <thead>
            <tr>
              <th>Snapshot</th>
              <th className="text-right">Views</th>
              <th className="text-right">Δ Views</th>
              <th className="text-right">Views/hour</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((point, index) => (
              <tr key={`${point.capturedAt}-${index}`}>
                <td className="whitespace-nowrap text-base-content/60">
                  {formatRelativeTime(point.capturedAt)}
                </td>
                <td className="text-right tabular-nums">
                  {point.viewCount === null
                    ? "—"
                    : formatCount(point.viewCount)}
                </td>
                <td className="text-right tabular-nums">
                  {point.deltaViews === null
                    ? "—"
                    : signedCount(point.deltaViews)}
                </td>
                <td className="text-right tabular-nums">
                  {point.vph === null ? "—" : compact.format(point.vph)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function VideoTrendCard({ projectId }: { projectId: string }) {
  const [videoIdInput, setVideoIdInput] = React.useState("");
  const [days, setDays] = React.useState(DEFAULT_TREND_DAYS);
  const videoId = videoIdInput.trim();
  const valid = VIDEO_ID_PATTERN.test(videoId);
  const query = useQuery({
    queryKey: ["youtubeVideoTrend", projectId, videoId, days],
    queryFn: () => getYoutubeVideoTrend({ data: { projectId, videoId, days } }),
    enabled: valid,
  });

  return (
    <CardShell title="Video trend">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          type="text"
          value={videoIdInput}
          onChange={(event) => setVideoIdInput(event.target.value)}
          placeholder="dQw4w9WgXcQ"
          aria-label="Video ID"
          className="input input-bordered input-sm w-full font-mono"
        />
        <select
          className="select select-bordered select-sm w-32 shrink-0"
          value={days}
          onChange={(event) => setDays(Number(event.target.value))}
          aria-label="Trend window"
        >
          {TREND_DAYS.map((value) => (
            <option key={value} value={value}>
              Last {value} days
            </option>
          ))}
        </select>
      </div>
      {videoId !== "" && !valid ? (
        <p className="mt-2 text-xs text-warning">
          A YouTube video ID is 11 characters (the v= value in a watch URL).
        </p>
      ) : null}

      <div className="mt-4 space-y-3">
        {!valid ? (
          <SectionHint>
            Enter a video ID to load its stored view snapshots.
          </SectionHint>
        ) : query.isPending ? (
          <CardSkeleton />
        ) : query.isError ? (
          <QueryStatus error={query.error} />
        ) : query.data.warnings.includes(INSUFFICIENT_SNAPSHOTS) ? (
          <SectionHint>{TREND_GUIDANCE}</SectionHint>
        ) : (
          <TrendBody points={query.data.points} />
        )}
      </div>
    </CardShell>
  );
}

function PlaylistsCard({ projectId }: { projectId: string }) {
  const query = useQuery({
    queryKey: ["youtubePlaylists", projectId, "mine"],
    queryFn: () => listYoutubePlaylists({ data: { projectId, mine: true } }),
  });

  return (
    <CardShell title="Playlists">
      {query.isPending ? (
        <CardSkeleton className="h-24" />
      ) : query.isError ? (
        <QueryStatus error={query.error} />
      ) : query.data.playlists.length === 0 ? (
        <SectionHint>No playlists on the connected channel.</SectionHint>
      ) : (
        <ul className="divide-y divide-base-300">
          {query.data.playlists.map((playlist) => (
            <li
              key={playlist.playlistId}
              className="flex items-center justify-between gap-3 py-2"
            >
              <a
                href={`https://www.youtube.com/playlist?list=${playlist.playlistId}`}
                target="_blank"
                rel="noreferrer"
                className="link link-hover min-w-0 truncate text-sm font-medium"
                title={playlist.title}
              >
                {playlist.title || playlist.playlistId}
              </a>
              <span className="shrink-0 text-xs text-base-content/60">
                {playlist.itemCount === null
                  ? "—"
                  : `${formatCount(playlist.itemCount)} videos`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </CardShell>
  );
}

/** Snapshot-backed reports for the connected channel: growth, publish days,
 *  video trends, and playlists. Cards explain themselves when a series is too
 *  thin instead of showing an empty chart. */
export function YoutubePerformanceSection({
  projectId,
}: {
  projectId: string;
}) {
  const connectionQuery = useQuery(youtubeConnectionOptions(projectId));
  if (!connectionQuery.data?.connected) return null;

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Channel performance</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        <ChannelGrowthCard projectId={projectId} />
        <BestPublishDaysCard projectId={projectId} />
        <VideoTrendCard projectId={projectId} />
        <PlaylistsCard projectId={projectId} />
      </div>
    </section>
  );
}

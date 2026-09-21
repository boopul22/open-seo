import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Stat } from "@/client/features/dashboard/cardParts";
import { formatCount } from "@/client/features/search-performance/SearchPerformanceColumns";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  getYoutubeAudienceBreakdown,
  getYoutubePlaybackLocations,
  getYoutubeVideoRetention,
  getYoutubeVideoTraffic,
  type YoutubeAudienceDimension,
  type YoutubeAudienceRow,
  type YoutubeRetentionPoint,
} from "@/serverFunctions/youtubeAudience";
import { listYoutubeChannelVideos } from "@/serverFunctions/youtubeResearch";

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

const DIMENSIONS: Array<{ value: YoutubeAudienceDimension; label: string }> = [
  { value: "country", label: "Country" },
  { value: "ageGroup", label: "Age group" },
  { value: "gender", label: "Gender" },
  { value: "deviceType", label: "Device" },
  { value: "subscribedStatus", label: "Subscriber status" },
];

const COLUMN_LABELS: Record<string, string> = {
  country: "Country",
  ageGroup: "Age group",
  gender: "Gender",
  deviceType: "Device",
  subscribedStatus: "Subscriber status",
  viewerPercentage: "% of viewers",
  views: "Views",
  estimatedMinutesWatched: "Watch time (min)",
  averageViewDuration: "Avg view",
  playbackLocation: "Playback location",
  playbackLocationDetail: "Detail",
  trafficSource: "Traffic source",
};

function isDimension(value: string): value is YoutubeAudienceDimension {
  return DIMENSIONS.some((option) => option.value === value);
}

function percentTick(value: unknown): string {
  return `${Math.round(Number(value) * 100)}%`;
}

function formatReportValue(
  column: string,
  value: string | number | null,
): string {
  if (value === null) return "—";
  if (typeof value !== "number") return value;
  if (column === "viewerPercentage") return `${value.toFixed(2)}%`;
  if (column === "averageViewDuration") return `${Math.round(value)} s`;
  return formatCount(value);
}

function RangeLabel({
  range,
}: {
  range: { startDate: string; endDate: string };
}) {
  return (
    <span className="text-xs text-base-content/50">
      {range.startDate} to {range.endDate}
    </span>
  );
}

function RetentionTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: YoutubeRetentionPoint }>;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return (
    <div className="rounded-md border border-base-300 bg-base-100 px-3 py-2 shadow-sm">
      <p className="text-xs text-base-content/60">
        {Math.round(point.ratio * 100)}% through the video
      </p>
      <p className="text-sm font-medium tabular-nums">
        {point.audienceWatchRatio === null
          ? "—"
          : `${Math.round(point.audienceWatchRatio * 100)}% still watching`}
      </p>
    </div>
  );
}

function ReportRowsTable({
  rows,
  emptyMessage,
}: {
  rows: YoutubeAudienceRow[];
  emptyMessage: string;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-base-content/60">{emptyMessage}</p>;
  }
  const columns = Object.keys(rows[0]);
  return (
    <div className="overflow-x-auto rounded-lg border border-base-300">
      <table className="table table-sm">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{COLUMN_LABELS[column] ?? column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td
                  key={column}
                  className={
                    typeof row[column] === "number" ? "tabular-nums" : undefined
                  }
                >
                  {formatReportValue(column, row[column])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function QueryError({ error }: { error: unknown }) {
  return (
    <p role="alert" className="text-sm text-error">
      {getStandardErrorMessage(error)}
    </p>
  );
}

function TableSkeleton() {
  return (
    <div aria-busy className="space-y-2">
      <div className="skeleton h-8" />
      <div className="skeleton h-8" />
      <div className="skeleton h-8" />
    </div>
  );
}

/** Retention and audience analytics for the project's own connected channel. */
export function YoutubeAudienceSection({
  projectId,
  channelId,
}: {
  projectId: string;
  channelId: string;
}) {
  // null means "not edited yet", so the input falls back to the channel's most
  // recent upload without an effect overwriting what the user cleared.
  const [videoIdInput, setVideoIdInput] = React.useState<string | null>(null);
  const [dimension, setDimension] =
    React.useState<YoutubeAudienceDimension>("country");

  const latestVideoQuery = useQuery({
    queryKey: ["youtubeChannelVideos", projectId, channelId, "newest", 1],
    queryFn: () =>
      listYoutubeChannelVideos({
        data: { projectId, channelId, sort: "newest", limit: 1 },
      }),
  });
  const latestVideoId = latestVideoQuery.data?.videos[0]?.videoId ?? "";
  const videoId = (videoIdInput ?? latestVideoId).trim();
  const hasVideoId = VIDEO_ID_PATTERN.test(videoId);

  const retentionQuery = useQuery({
    queryKey: ["youtubeVideoRetention", projectId, videoId],
    queryFn: () => getYoutubeVideoRetention({ data: { projectId, videoId } }),
    enabled: hasVideoId,
  });
  const breakdownQuery = useQuery({
    queryKey: ["youtubeAudienceBreakdown", projectId, dimension],
    queryFn: () =>
      getYoutubeAudienceBreakdown({
        data: { projectId, dimension, limit: 25 },
      }),
  });
  const locationTypesQuery = useQuery({
    queryKey: ["youtubePlaybackLocations", projectId, "types"],
    queryFn: () =>
      getYoutubePlaybackLocations({ data: { projectId, limit: 10 } }),
  });
  const locationDetailsQuery = useQuery({
    queryKey: ["youtubePlaybackLocations", projectId, "details"],
    queryFn: () =>
      getYoutubePlaybackLocations({
        data: { projectId, detail: true, limit: 10 },
      }),
  });
  const trafficQuery = useQuery({
    queryKey: ["youtubeVideoTraffic", projectId, videoId],
    queryFn: () =>
      getYoutubeVideoTraffic({ data: { projectId, videoId, limit: 10 } }),
    enabled: hasVideoId,
  });

  const retention = retentionQuery.data;

  return (
    <div className="space-y-6">
      <label className="block max-w-sm">
        <span className="mb-1 block text-xs font-medium text-base-content/60">
          Video ID
        </span>
        <input
          type="text"
          value={videoIdInput ?? latestVideoId}
          onChange={(event) => setVideoIdInput(event.target.value)}
          placeholder="dQw4w9WgXcQ"
          className="input input-bordered input-sm w-full font-mono"
        />
        <span className="mt-1 block text-xs text-base-content/50">
          Retention and traffic are for this video; audience and playback
          locations cover the whole channel.
        </span>
      </label>

      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">Retention</h3>
          {retention ? (
            <RangeLabel range={retention.request.resolvedRange} />
          ) : null}
        </div>
        {!hasVideoId ? (
          <p className="text-sm text-base-content/60">
            Enter a video ID to load its retention curve.
          </p>
        ) : retentionQuery.isPending ? (
          <div aria-busy className="skeleton h-52" />
        ) : retentionQuery.isError ? (
          <QueryError error={retentionQuery.error} />
        ) : retention ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_11rem] lg:items-center">
            <div className="h-52">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={retention.points}
                  margin={{ top: 4, right: 8, bottom: 0, left: -8 }}
                >
                  <XAxis
                    dataKey="ratio"
                    type="number"
                    domain={[0, 1]}
                    tickFormatter={percentTick}
                    tick={{ fontSize: 11 }}
                  />
                  <YAxis
                    domain={[0, 1]}
                    width={40}
                    tickFormatter={percentTick}
                    tick={{ fontSize: 11 }}
                  />
                  <Tooltip
                    content={<RetentionTooltip />}
                    cursor={{ stroke: "currentColor", strokeOpacity: 0.2 }}
                  />
                  <Area
                    type="monotone"
                    dataKey="audienceWatchRatio"
                    stroke="var(--color-primary)"
                    strokeWidth={2}
                    fill="var(--color-primary)"
                    fillOpacity={0.08}
                    connectNulls
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-1">
              <Stat
                label="Avg view percentage"
                value={
                  retention.averageViewPercentage === null
                    ? "—"
                    : `${retention.averageViewPercentage.toFixed(1)}%`
                }
              />
              <Stat
                label="Views"
                value={
                  retention.views === null ? "—" : formatCount(retention.views)
                }
              />
            </div>
          </div>
        ) : null}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Audience</h3>
          <select
            className="select select-bordered select-sm w-44"
            value={dimension}
            onChange={(event) =>
              setDimension(
                isDimension(event.target.value)
                  ? event.target.value
                  : "country",
              )
            }
            aria-label="Audience dimension"
          >
            {DIMENSIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        {breakdownQuery.isPending ? (
          <TableSkeleton />
        ) : breakdownQuery.isError ? (
          <QueryError error={breakdownQuery.error} />
        ) : (
          <>
            <ReportRowsTable
              rows={breakdownQuery.data.rows}
              emptyMessage="No audience data for this dimension yet."
            />
            <RangeLabel range={breakdownQuery.data.request.resolvedRange} />
          </>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Where viewers watched</h3>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <h4 className="text-xs uppercase tracking-wide text-base-content/60">
              Location type
            </h4>
            {locationTypesQuery.isPending ? (
              <TableSkeleton />
            ) : locationTypesQuery.isError ? (
              <QueryError error={locationTypesQuery.error} />
            ) : (
              <ReportRowsTable
                rows={locationTypesQuery.data.rows}
                emptyMessage="No playback data yet."
              />
            )}
          </div>
          <div className="space-y-2">
            <h4 className="text-xs uppercase tracking-wide text-base-content/60">
              Detail
            </h4>
            {locationDetailsQuery.isPending ? (
              <TableSkeleton />
            ) : locationDetailsQuery.isError ? (
              <QueryError error={locationDetailsQuery.error} />
            ) : (
              <ReportRowsTable
                rows={locationDetailsQuery.data.rows}
                emptyMessage="No playback detail yet."
              />
            )}
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">
            Traffic sources for this video
          </h3>
          {trafficQuery.data ? (
            <RangeLabel range={trafficQuery.data.request.resolvedRange} />
          ) : null}
        </div>
        {!hasVideoId ? (
          <p className="text-sm text-base-content/60">
            Enter a video ID to load its traffic sources.
          </p>
        ) : trafficQuery.isPending ? (
          <TableSkeleton />
        ) : trafficQuery.isError ? (
          <QueryError error={trafficQuery.error} />
        ) : (
          <ReportRowsTable
            rows={trafficQuery.data.rows}
            emptyMessage="No traffic data for this video yet."
          />
        )}
      </section>
    </div>
  );
}

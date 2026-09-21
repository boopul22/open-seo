import { useQuery } from "@tanstack/react-query";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { PercentDelta, Stat } from "@/client/features/dashboard/cardParts";
import { formatCount } from "@/client/features/search-performance/SearchPerformanceColumns";
import { getYoutubeChannelOverview } from "@/serverFunctions/youtube";

type MetricRow = Record<string, string | number | null> | null | undefined;

function metric(row: MetricRow, key: string): number | null {
  const value = row?.[key];
  return typeof value === "number" ? value : null;
}

function formatWatchHours(minutes: number | null): string {
  return minutes === null ? "—" : `${(minutes / 60).toFixed(1)} h`;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const secs = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${minutes}:${String(secs).padStart(2, "0")}`;
}

function netSubscribers(row: MetricRow): number | null {
  const gained = metric(row, "subscribersGained");
  const lost = metric(row, "subscribersLost");
  if (gained === null && lost === null) return null;
  return (gained ?? 0) - (lost ?? 0);
}

function ViewsTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value: number }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-base-300 bg-base-100 px-3 py-2 shadow-sm">
      <p className="text-xs text-base-content/60">{label}</p>
      <p className="text-sm font-medium tabular-nums">
        {formatCount(payload[0].value)} views
      </p>
    </div>
  );
}

/** Channel analytics for the connected state: last 28 complete days vs the
 *  previous period, plus a daily views trend. */
export function YoutubeAnalyticsPanel({
  projectId,
  showRangeLabel = true,
}: {
  projectId: string;
  showRangeLabel?: boolean;
}) {
  const reportQuery = useQuery({
    queryKey: ["youtubeChannelOverview", projectId],
    queryFn: () => getYoutubeChannelOverview({ data: { projectId } }),
    staleTime: 5 * 60 * 1_000,
  });

  if (reportQuery.isPending) {
    return (
      <div className="space-y-3" aria-busy>
        <div className="grid grid-cols-2 gap-3">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="skeleton h-16" />
          ))}
        </div>
        <div className="skeleton h-24" />
      </div>
    );
  }
  if (reportQuery.isError) {
    return (
      <p className="text-sm text-base-content/60">
        Couldn&rsquo;t load YouTube Analytics. Try again shortly.
      </p>
    );
  }
  const report = reportQuery.data;
  if (!report?.connected) return null;

  const current = report.current;
  const previous = report.previous;
  const views = metric(current, "views");
  const watchMinutes = metric(current, "estimatedMinutesWatched");
  const subscribers = netSubscribers(current);
  const previousSubscribers = netSubscribers(previous);
  const averageViewDuration = metric(current, "averageViewDuration");
  const hasTrend = report.trend.some((day) => day.views > 0);

  return (
    <div className="space-y-4">
      {showRangeLabel ? (
        <p className="text-xs text-base-content/50">
          YouTube Analytics · {report.request.resolvedRange.startDate} to{" "}
          {report.request.resolvedRange.endDate}
        </p>
      ) : null}
      {views === null ? (
        <p className="text-sm text-base-content/60">
          No views recorded in this period yet.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Stat
              label="Views"
              value={formatCount(views)}
              sub={
                metric(previous, "views") !== null ? (
                  <PercentDelta
                    current={views}
                    previous={metric(previous, "views") ?? 0}
                  />
                ) : undefined
              }
            />
            <Stat
              label="Watch time"
              value={formatWatchHours(watchMinutes)}
              sub={
                watchMinutes !== null &&
                metric(previous, "estimatedMinutesWatched") !== null ? (
                  <PercentDelta
                    current={watchMinutes}
                    previous={metric(previous, "estimatedMinutesWatched") ?? 0}
                  />
                ) : undefined
              }
            />
            <Stat
              label="Net subscribers"
              value={subscribers === null ? "—" : formatCount(subscribers)}
              sub={
                subscribers !== null && previousSubscribers !== null ? (
                  <PercentDelta
                    current={subscribers}
                    previous={previousSubscribers}
                  />
                ) : undefined
              }
            />
            <Stat
              label="Avg view duration"
              value={formatDuration(averageViewDuration)}
            />
          </div>
          {hasTrend ? (
            <div className="h-24">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={report.trend}
                  margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
                >
                  <XAxis dataKey="date" hide />
                  <YAxis hide domain={[0, "auto"]} />
                  <Tooltip
                    content={<ViewsTooltip />}
                    cursor={{ stroke: "currentColor", strokeOpacity: 0.2 }}
                  />
                  <Area
                    type="monotone"
                    dataKey="views"
                    stroke="var(--color-primary)"
                    strokeWidth={2}
                    fill="var(--color-primary)"
                    fillOpacity={0.08}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

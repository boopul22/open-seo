import { Link } from "@tanstack/react-router";
import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCount } from "@/client/features/search-performance/SearchPerformanceColumns";
import { renderChangeMarkers } from "@/client/features/seo-changes/changeMarkers";
import type { getSearchPerformanceReport } from "@/serverFunctions/searchPerformance";

type Report = Extract<
  Awaited<ReturnType<typeof getSearchPerformanceReport>>,
  { connected: true }
>;

function formatDay(date: string): string {
  // Local-time construction: a bare ISO date parses as UTC midnight and would
  // render as the previous day west of Greenwich.
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function TrendTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ dataKey?: string | number; value?: number }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const value = (key: string) =>
    payload.find((entry) => entry.dataKey === key)?.value ?? 0;
  return (
    <div className="rounded-md border border-base-300 bg-base-100 px-3 py-2 shadow-sm">
      <p className="text-xs text-base-content/60">
        {label ? formatDay(label) : ""}
      </p>
      <p className="text-sm font-medium tabular-nums">
        {formatCount(value("clicks"))} clicks
      </p>
      <p className="text-xs tabular-nums text-base-content/60">
        {formatCount(value("impressions"))} impressions
      </p>
    </div>
  );
}

/** Daily clicks and impressions, with a marker on each logged change's ship
 *  date so a jump or drop can be matched to what shipped. */
export function SearchTrendChart({
  report,
  projectId,
}: {
  report: Report;
  projectId: string;
}) {
  if (report.daily.length === 0) return null;
  return (
    <div className="rounded-xl border border-base-300 bg-base-100 p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-base-content/60">
        <div className="flex items-center gap-4">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-3 rounded bg-primary" /> Clicks
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-3 rounded bg-base-content/30" />{" "}
            Impressions
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-secondary" /> Logged change
          </span>
        </div>
        <Link
          to="/p/$projectId/changes"
          params={{ projectId }}
          className="link link-hover"
        >
          Change log
        </Link>
      </div>
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={report.daily}
            margin={{ top: 10, right: 0, bottom: 0, left: 0 }}
          >
            <XAxis
              dataKey="date"
              tickFormatter={formatDay}
              tick={{ fontSize: 11 }}
              minTickGap={24}
              stroke="currentColor"
              strokeOpacity={0.3}
            />
            <YAxis yAxisId="clicks" hide domain={[0, "auto"]} />
            <YAxis yAxisId="impressions" hide domain={[0, "auto"]} />
            <Tooltip
              content={<TrendTooltip />}
              cursor={{ stroke: "currentColor", strokeOpacity: 0.2 }}
            />
            <Line
              yAxisId="impressions"
              type="monotone"
              dataKey="impressions"
              stroke="currentColor"
              strokeOpacity={0.3}
              strokeWidth={1.5}
              dot={false}
            />
            <Line
              yAxisId="clicks"
              type="monotone"
              dataKey="clicks"
              stroke="var(--color-primary)"
              strokeWidth={2}
              dot={false}
            />
            {renderChangeMarkers(report.changeMarkers, "clicks")}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

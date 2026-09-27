import {
  formatDelta,
  scoreTone,
} from "@/client/features/pagespeed/pagespeedFormat";
import type { getPageSpeedOverview } from "@/serverFunctions/pagespeed";

type Overview = Awaited<ReturnType<typeof getPageSpeedOverview>>;

function progressText(sweep: NonNullable<Overview["active"]>) {
  const tested = sweep.urlsDone + sweep.urlsFailed;
  return `${tested.toLocaleString()} / ${sweep.urlsTotal.toLocaleString()} URLs`;
}

export function SweepBanner({ overview }: { overview: Overview }) {
  const { sweep, active } = overview;
  if (!sweep) return null;
  const running = active ?? null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-base-300 bg-base-100 px-4 py-3 text-sm">
      <span className="text-base-content/70">
        {sweep.status === "completed" && sweep.completedAt
          ? `Last sweep ${new Date(sweep.completedAt).toLocaleString()} · ${sweep.urlsDone.toLocaleString()} pages tested`
          : "First sweep in progress · partial results"}
      </span>
      {running ? (
        <span className="flex min-w-60 flex-1 items-center gap-3">
          <progress
            className="progress progress-primary w-full max-w-xs"
            value={running.urlsDone + running.urlsFailed}
            max={Math.max(running.urlsTotal, 1)}
          />
          <span className="whitespace-nowrap text-xs text-base-content/60">
            {running.status === "queued"
              ? "Queued"
              : running.status === "waiting_quota"
                ? `Paused for Google's daily quota until ${running.resumeAt ? new Date(running.resumeAt).toLocaleString() : "reset"}`
                : progressText(running)}
          </span>
        </span>
      ) : null}
    </div>
  );
}

export function SummaryCards({ overview }: { overview: Overview }) {
  const summary = overview.summary;
  if (!summary) return null;
  const deltas = overview.changes?.averageDeltas;
  const cards = [
    {
      label: "Performance",
      value: summary.averages.performance,
      delta: deltas?.performance,
    },
    {
      label: "Accessibility",
      value: summary.averages.accessibility,
      delta: deltas?.accessibility,
    },
    {
      label: "Best practices",
      value: summary.averages.bestPractices,
      delta: deltas?.bestPractices,
    },
    { label: "SEO", value: summary.averages.seo, delta: deltas?.seo },
  ];
  const cwv = summary.fieldCoreWebVitals;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      {cards.map((card) => {
        const delta = formatDelta(card.delta);
        return (
          <div
            key={card.label}
            className="rounded-xl border border-base-300 bg-base-100 p-4"
          >
            <div className="text-sm text-base-content/60">
              Avg {card.label === "SEO" ? card.label : card.label.toLowerCase()}
            </div>
            <div
              className={`text-2xl font-semibold tabular-nums ${scoreTone(card.value)}`}
            >
              {card.value ?? "—"}
              {delta ? (
                <span className={`ml-2 text-xs ${delta.tone}`}>
                  {delta.text} vs last week
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
      <div className="rounded-xl border border-base-300 bg-base-100 p-4">
        <div className="text-sm text-base-content/60">Pages tested</div>
        <div className="text-2xl font-semibold tabular-nums">
          {summary.pages.toLocaleString()}
        </div>
        <div className="text-xs text-base-content/50">
          {cwv.assessed > 0
            ? `${cwv.passing}/${cwv.assessed} pass Core Web Vitals (real users)`
            : "No per-page real-user data yet"}
        </div>
      </div>
    </div>
  );
}

export function DistributionPanel({ overview }: { overview: Overview }) {
  const summary = overview.summary;
  if (!summary) return null;
  const rows = [
    ["Performance score", summary.distribution.performance],
    ["Largest Contentful Paint", summary.distribution.lcp],
    ["Cumulative Layout Shift", summary.distribution.cls],
    ["Total Blocking Time", summary.distribution.tbt],
  ] as const;
  return (
    <div className="rounded-xl border border-base-300 bg-base-100 p-4">
      <div className="mb-3 font-medium">Pages by rating (lab, mobile)</div>
      <div className="space-y-3">
        {rows.map(([label, d]) => {
          const total = d.good + d.needs_improvement + d.poor || 1;
          return (
            <div key={label} className="grid gap-1 sm:grid-cols-[14rem_1fr]">
              <div className="text-sm">{label}</div>
              <div>
                <div className="flex h-3 overflow-hidden rounded-full bg-base-200">
                  <div
                    className="bg-success"
                    style={{ width: `${(d.good / total) * 100}%` }}
                  />
                  <div
                    className="bg-warning"
                    style={{ width: `${(d.needs_improvement / total) * 100}%` }}
                  />
                  <div
                    className="bg-error"
                    style={{ width: `${(d.poor / total) * 100}%` }}
                  />
                </div>
                <div className="mt-1 flex gap-4 text-xs text-base-content/60">
                  <span>{d.good} good</span>
                  <span>{d.needs_improvement} need improvement</span>
                  <span>{d.poor} poor</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function TopProblems({
  overview,
  selected,
  onSelect,
}: {
  overview: Overview;
  selected: string | null;
  onSelect: (audit: { key: string; title: string } | null) => void;
}) {
  if (overview.topIssues.length === 0) return null;
  return (
    <div className="rounded-xl border border-base-300 bg-base-100">
      <div className="border-b border-base-300 px-4 py-3">
        <div className="font-medium">Top problems across the site</div>
        <div className="text-xs text-base-content/60">
          Click one to list the pages it affects.
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="table table-sm">
          <thead>
            <tr>
              <th>Problem</th>
              <th>Category</th>
              <th className="text-right">Pages</th>
              <th className="text-right">Critical on</th>
            </tr>
          </thead>
          <tbody>
            {overview.topIssues.map((issue) => (
              <tr
                key={issue.auditKey}
                className={`cursor-pointer hover:bg-base-200 ${selected === issue.auditKey ? "bg-base-200" : ""}`}
                onClick={() =>
                  onSelect(
                    selected === issue.auditKey
                      ? null
                      : { key: issue.auditKey, title: issue.title },
                  )
                }
              >
                <td>{issue.title}</td>
                <td className="text-xs capitalize text-base-content/70">
                  {issue.category}
                </td>
                <td className="text-right tabular-nums">{issue.pages}</td>
                <td className="text-right tabular-nums">
                  {issue.criticalPages || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

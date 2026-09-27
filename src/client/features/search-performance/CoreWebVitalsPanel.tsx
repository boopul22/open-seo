import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { getCoreWebVitals } from "@/serverFunctions/gscIndex";
import {
  CWV_METRICS,
  type CruxFormFactor,
  type CwvMetric,
  type CwvRating,
} from "@/shared/core-web-vitals";

const METRIC_LABELS: Record<CwvMetric, string> = {
  lcp: "LCP",
  inp: "INP",
  cls: "CLS",
  fcp: "FCP",
  ttfb: "TTFB",
};

const RATING_CLASS: Record<CwvRating, string> = {
  good: "text-success",
  needs_improvement: "text-warning",
  poor: "text-error",
};

type MetricCell = { p75: number | null; rating: CwvRating | null } | undefined;

function formatP75(metric: CwvMetric, value: number | null | undefined) {
  if (value == null) return "—";
  return metric === "cls" ? value.toFixed(2) : `${Math.round(value)} ms`;
}

function MetricValue({
  metric,
  cell,
}: {
  metric: CwvMetric;
  cell: MetricCell;
}) {
  return (
    <span
      className={
        cell?.rating ? RATING_CLASS[cell.rating] : "text-base-content/40"
      }
    >
      {formatP75(metric, cell?.p75)}
    </span>
  );
}

function Assessment({ value }: { value: "pass" | "fail" | null }) {
  if (value === null)
    return <span className="badge badge-ghost badge-sm">No data</span>;
  return (
    <span
      className={`badge badge-sm ${value === "pass" ? "badge-success" : "badge-error"}`}
    >
      {value === "pass" ? "Passed" : "Failed"}
    </span>
  );
}

/** Chrome UX Report field data. Search Console's own Core Web Vitals report
 *  has no API; CrUX is the dataset behind it. */
export function CoreWebVitalsPanel({ projectId }: { projectId: string }) {
  const [scope, setScope] = useState<"origin" | "urls">("origin");
  const [formFactor, setFormFactor] = useState<CruxFormFactor>("PHONE");
  const query = useQuery({
    queryKey: ["coreWebVitals", projectId, scope],
    queryFn: () => getCoreWebVitals({ data: { projectId, scope } }),
    staleTime: 60 * 60_000,
  });
  const data = query.data;

  return (
    <div className="rounded-xl border border-base-300 bg-base-100">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-base-300 px-4 py-3">
        <div>
          <div className="font-medium">Core Web Vitals</div>
          <div className="text-xs text-base-content/60">
            Chrome UX Report field data (real Chrome users, last 28 days), not
            the Search Console report.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select
            className="select select-bordered select-sm"
            value={scope}
            onChange={(event) =>
              setScope(event.target.value === "urls" ? "urls" : "origin")
            }
            aria-label="Core Web Vitals scope"
          >
            <option value="origin">Whole site</option>
            <option value="urls">Top pages</option>
          </select>
          <select
            className="select select-bordered select-sm"
            value={formFactor}
            onChange={(event) =>
              setFormFactor(
                event.target.value === "DESKTOP" ? "DESKTOP" : "PHONE",
              )
            }
            aria-label="Device"
          >
            <option value="PHONE">Mobile</option>
            <option value="DESKTOP">Desktop</option>
          </select>
        </div>
      </div>
      <div className="p-4">
        {query.isPending ? (
          <div className="flex items-center gap-2 text-sm text-base-content/60">
            <Loader2 className="size-4 animate-spin" /> Querying Chrome UX
            Report…
          </div>
        ) : query.isError ? (
          <div className="text-sm text-error">
            {getStandardErrorMessage(query.error)}
          </div>
        ) : data?.status === "not_configured" ? (
          <div className="text-sm text-base-content/60">{data.message}</div>
        ) : data?.status !== "ok" ? (
          <div className="text-sm text-base-content/60">
            Search Console is not connected.
          </div>
        ) : data.result.scope === "origin" ? (
          (() => {
            const record = data.result.records.find(
              (r) => r.formFactor === formFactor,
            );
            return (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-mono">{data.result.origin}</span>
                  <Assessment value={record?.assessment ?? null} />
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                  {CWV_METRICS.map((metric) => (
                    <div
                      key={metric}
                      className="rounded-lg border border-base-300 p-3"
                    >
                      <div className="text-xs text-base-content/60">
                        {METRIC_LABELS[metric]} p75
                      </div>
                      <div className="text-lg font-semibold">
                        <MetricValue
                          metric={metric}
                          cell={record?.metrics[metric]}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()
        ) : (
          <div className="overflow-x-auto">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>Page</th>
                  <th>Assessment</th>
                  {CWV_METRICS.map((metric) => (
                    <th key={metric} className="text-right">
                      {METRIC_LABELS[metric]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.result.pages.map((page) => {
                  const record = page.records.find(
                    (r) => r.formFactor === formFactor,
                  );
                  return (
                    <tr key={page.url}>
                      <td
                        className="max-w-sm truncate font-mono text-xs"
                        title={page.url}
                      >
                        {page.url}
                      </td>
                      <td>
                        <Assessment value={record?.assessment ?? null} />
                      </td>
                      {CWV_METRICS.map((metric) => (
                        <td key={metric} className="text-right tabular-nums">
                          <MetricValue
                            metric={metric}
                            cell={record?.metrics[metric]}
                          />
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

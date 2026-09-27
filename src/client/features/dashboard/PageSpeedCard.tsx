import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CardShell,
  EmptyCardBody,
  formatDay,
  moreDetailsClass,
} from "@/client/features/dashboard/cardParts";
import {
  formatDelta,
  formatMs,
  scoreTone,
} from "@/client/features/pagespeed/pagespeedFormat";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  getPageSpeedOverview,
  runPageSpeedSweep,
} from "@/serverFunctions/pagespeed";

export function PageSpeedCard({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ["pagespeedOverview", projectId];
  const query = useQuery({
    queryKey,
    queryFn: () => getPageSpeedOverview({ data: { projectId } }),
  });
  const runNow = useMutation({
    mutationFn: () => runPageSpeedSweep({ data: { projectId } }),
    onSuccess: () => {
      toast.success("PageSpeed sweep queued; it starts within the hour");
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) => toast.error(getStandardErrorMessage(error)),
  });
  const overview = query.data;
  const details = (
    <Link
      to="/p/$projectId/pagespeed"
      params={{ projectId }}
      className={moreDetailsClass}
    >
      More details
    </Link>
  );

  if (query.isPending) {
    return (
      <CardShell title="PageSpeed">
        <div className="skeleton h-24" />
      </CardShell>
    );
  }
  if (!overview?.summary || !overview.sweep) {
    return (
      <CardShell title="PageSpeed" action={details}>
        <EmptyCardBody
          message={
            overview?.active
              ? "Testing every sitemap URL on mobile. Scores appear here as pages finish."
              : "Test every URL in your sitemap with Google PageSpeed each week."
          }
          cta={
            overview?.active ? null : (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={runNow.isPending}
                onClick={() => runNow.mutate()}
              >
                Run first sweep
              </button>
            )
          }
        />
      </CardShell>
    );
  }

  const { summary, sweep, changes } = overview;
  const perf = summary.averages.performance;
  const delta = formatDelta(changes?.averageDeltas.performance);
  const d = summary.distribution.performance;
  return (
    <CardShell
      title="PageSpeed"
      action={details}
      stamp={`PageSpeed · mobile · ${summary.pages} pages${
        sweep.status === "completed" && sweep.completedAt
          ? ` · ${formatDay(sweep.completedAt)}`
          : " · first sweep in progress"
      }`}
    >
      <div className="flex items-end gap-6">
        <div>
          <div className="text-xs text-base-content/60">Avg performance</div>
          <div
            className={`text-3xl font-semibold tabular-nums ${scoreTone(perf)}`}
          >
            {perf ?? "—"}
            {delta ? (
              <span className={`ml-2 text-xs ${delta.tone}`}>{delta.text}</span>
            ) : null}
          </div>
        </div>
        <div className="flex gap-4 text-sm">
          <span className="text-success">{d.good} good</span>
          <span className="text-warning">{d.needs_improvement} NI</span>
          <span className="text-error">{d.poor} poor</span>
        </div>
      </div>
      {overview.slowest.length > 0 ? (
        <ul className="mt-4 space-y-1.5">
          {overview.slowest.slice(0, 3).map((page) => (
            <li
              key={page.url}
              className="flex items-center justify-between gap-2 text-sm"
            >
              <span className="truncate font-mono text-xs" title={page.url}>
                {page.url.replace(/^https?:\/\/[^/]+/, "") || "/"}
              </span>
              <span className="shrink-0 tabular-nums text-xs text-base-content/60">
                <span
                  className={`font-semibold ${scoreTone(page.performance)}`}
                >
                  {page.performance}
                </span>{" "}
                · LCP {formatMs(page.lcpMs)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {changes && changes.regressions.length > 0 ? (
        <p className="mt-3 text-xs text-error">
          {changes.regressions.length} page
          {changes.regressions.length === 1 ? "" : "s"} dropped 10+ points since
          last week
        </p>
      ) : null}
    </CardShell>
  );
}

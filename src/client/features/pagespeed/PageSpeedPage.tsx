import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { PageSpeedUrlDrawer } from "@/client/features/pagespeed/PageSpeedUrlDrawer";
import {
  DistributionPanel,
  SummaryCards,
  SweepBanner,
  TopProblems,
} from "@/client/features/pagespeed/PageSpeedParts";
import {
  UrlTable,
  type PageSpeedSort,
} from "@/client/features/pagespeed/PageSpeedUrlTable";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  getPageSpeedOverview,
  runPageSpeedSweep,
} from "@/serverFunctions/pagespeed";
import type { PageSpeedRating } from "@/shared/pagespeed";

export function PageSpeedPage({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [openUrl, setOpenUrl] = useState<string | null>(null);
  const [sort, setSort] = useState<PageSpeedSort>("performance");
  const [rating, setRating] = useState<PageSpeedRating | undefined>();
  const [audit, setAudit] = useState<{ key: string; title: string } | null>(
    null,
  );
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);

  const overviewKey = ["pagespeedOverview", projectId];
  const overviewQuery = useQuery({
    queryKey: overviewKey,
    queryFn: () => getPageSpeedOverview({ data: { projectId } }),
    // Poll while a sweep is working so progress and partial results move.
    refetchInterval: (query) => (query.state.data?.active ? 15_000 : false),
  });
  const overview = overviewQuery.data;

  const runNow = useMutation({
    mutationFn: () => runPageSpeedSweep({ data: { projectId } }),
    onSuccess: (result) => {
      toast.success(
        result.created
          ? "PageSpeed sweep queued; it starts within the hour"
          : "A sweep is already queued or running",
      );
      void queryClient.invalidateQueries({ queryKey: overviewKey });
    },
    onError: (error) => toast.error(getStandardErrorMessage(error)),
  });

  return (
    <div className="overflow-auto px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-7xl space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">PageSpeed</h1>
            <p className="text-sm text-base-content/70">
              Mobile PageSpeed Insights for every URL in your sitemap, run each
              week with the site audit and compared with the week before.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            disabled={runNow.isPending || overview?.active != null}
            onClick={() => runNow.mutate()}
          >
            {runNow.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : null}
            Run now
          </button>
        </div>

        {overviewQuery.isPending ? (
          <div className="flex items-center gap-2 text-sm text-base-content/60">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : overviewQuery.isError ? (
          <div className="alert alert-error">
            <span className="text-sm">
              {getStandardErrorMessage(overviewQuery.error)}
            </span>
          </div>
        ) : !overview?.sweep || !overview.summary ? (
          <div className="rounded-xl border border-base-300 bg-base-100 p-6 text-sm text-base-content/70">
            {overview?.active
              ? "The first sweep is starting. Results appear here as pages are tested."
              : "No PageSpeed results yet. They arrive with the next weekly site audit, or start a sweep now with Run now."}
          </div>
        ) : (
          <>
            <SweepBanner overview={overview} />
            <SummaryCards overview={overview} />
            <DistributionPanel overview={overview} />
            <TopProblems
              overview={overview}
              selected={audit?.key ?? null}
              onSelect={(next) => {
                setAudit(next);
                setOffset(0);
              }}
            />
            <div className="rounded-xl border border-base-300 bg-base-100">
              <div className="flex flex-wrap items-center gap-2 border-b border-base-300 px-4 py-3">
                <div className="mr-auto font-medium">Pages</div>
                {audit ? (
                  <span className="badge badge-outline gap-1">
                    {audit.title}
                    <button
                      type="button"
                      aria-label="Clear audit filter"
                      onClick={() => setAudit(null)}
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ) : null}
                <input
                  type="search"
                  className="input input-bordered input-sm w-48"
                  placeholder="Filter URLs"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setOffset(0);
                  }}
                  aria-label="Filter URLs"
                />
                <select
                  className="select select-bordered select-sm"
                  value={rating ?? ""}
                  onChange={(event) => {
                    const value = event.target.value;
                    setRating(
                      value === "good" ||
                        value === "needs_improvement" ||
                        value === "poor"
                        ? value
                        : undefined,
                    );
                    setOffset(0);
                  }}
                  aria-label="Filter by performance rating"
                >
                  <option value="">All ratings</option>
                  <option value="poor">Poor (0-49)</option>
                  <option value="needs_improvement">
                    Needs improvement (50-89)
                  </option>
                  <option value="good">Good (90+)</option>
                </select>
              </div>
              <UrlTable
                projectId={projectId}
                sort={sort}
                onSort={(next) => {
                  setSort(next);
                  setOffset(0);
                }}
                rating={rating}
                auditKey={audit?.key}
                search={search}
                offset={offset}
                onOffsetChange={setOffset}
                onOpenUrl={setOpenUrl}
              />
            </div>
            {overview.failed.length > 0 ? (
              <details className="rounded-xl border border-base-300 bg-base-100 p-4 text-sm">
                <summary className="cursor-pointer font-medium">
                  {overview.sweep.urlsFailed} pages PageSpeed couldn&apos;t test
                </summary>
                <ul className="mt-2 space-y-1">
                  {overview.failed.map((row) => (
                    <li key={row.url} className="break-all text-xs">
                      <span className="font-mono">{row.url}</span>
                      <span className="text-base-content/50">
                        {" "}
                        · {row.error}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        )}
      </div>
      {openUrl ? (
        <PageSpeedUrlDrawer
          projectId={projectId}
          url={openUrl}
          onClose={() => setOpenUrl(null)}
        />
      ) : null}
    </div>
  );
}

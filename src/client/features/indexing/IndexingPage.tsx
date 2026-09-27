import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { SearchConsoleConnectionCard } from "@/client/features/gsc/SearchConsoleConnectionCard";
import {
  ReasonsTable,
  ReasonUrlList,
  RichResultsPanel,
  SummaryCards,
  SweepPanel,
  type ReasonSelection,
} from "@/client/features/indexing/IndexingParts";
import { SitemapsTable } from "@/client/features/indexing/SitemapsTable";
import { UrlDetailDrawer } from "@/client/features/indexing/UrlDetailDrawer";
import {
  startGoogleLink,
  useGoogleLinkPending,
} from "@/client/features/integrations/startGoogleLink";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  getIndexingOverview,
  refreshIndexingSitemaps,
  startIndexingSweep,
  writeIndexingSitemap,
} from "@/serverFunctions/gscIndex";

export function IndexingPage({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [selection, setSelection] = useState<ReasonSelection | null>(null);
  const [offset, setOffset] = useState(0);
  const [openUrl, setOpenUrl] = useState<string | null>(null);
  const [newSitemap, setNewSitemap] = useState("");
  const linkPending = useGoogleLinkPending();

  const overviewKey = ["indexingOverview", projectId];
  const overviewQuery = useQuery({
    queryKey: overviewKey,
    queryFn: () => getIndexingOverview({ data: { projectId } }),
    // Poll while a sweep is working so progress moves without a reload.
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.connected && data.sweep.active ? 10_000 : false;
    },
  });
  const overview = overviewQuery.data;
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: overviewKey });

  const runNow = useMutation({
    mutationFn: () => startIndexingSweep({ data: { projectId } }),
    onSuccess: (result) => {
      toast.success(
        result.created ? "Sweep started" : "A sweep is already running",
      );
      void invalidate();
    },
    onError: (error) => toast.error(getStandardErrorMessage(error)),
  });
  const refreshSitemaps = useMutation({
    mutationFn: () => refreshIndexingSitemaps({ data: { projectId } }),
    onSuccess: () => void invalidate(),
    onError: (error) => toast.error(getStandardErrorMessage(error)),
  });
  const writeSitemap = useMutation({
    mutationFn: (input: { feedpath: string; action: "submit" | "delete" }) =>
      writeIndexingSitemap({ data: { projectId, ...input } }),
    onSuccess: (_data, input) => {
      toast.success(
        input.action === "submit" ? "Sitemap submitted" : "Sitemap removed",
      );
      setNewSitemap("");
      void invalidate();
    },
    onError: (error) => toast.error(getStandardErrorMessage(error)),
  });

  return (
    <div className="overflow-auto px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-7xl space-y-4">
        <div>
          <h1 className="text-2xl font-semibold">Indexing</h1>
          <p className="text-sm text-base-content/70">
            Which pages Google has indexed and why the rest aren&apos;t, rebuilt
            from Search Console&apos;s URL Inspection API. Manual actions,
            security issues, links, crawl stats and removals have no API; check
            those in Search Console.
          </p>
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
        ) : !overview?.connected ? (
          <div className="max-w-2xl">
            <SearchConsoleConnectionCard projectId={projectId} />
          </div>
        ) : (
          <>
            <SummaryCards overview={overview} />
            <SweepPanel
              overview={overview}
              onRunNow={() => runNow.mutate()}
              running={runNow.isPending}
            />
            {selection ? (
              <ReasonUrlList
                projectId={projectId}
                selection={selection}
                offset={offset}
                onOffsetChange={setOffset}
                onOpenUrl={setOpenUrl}
                onClose={() => setSelection(null)}
              />
            ) : null}
            <ReasonsTable
              overview={overview}
              onSelect={(next) => {
                setSelection(next);
                setOffset(0);
              }}
            />
            <RichResultsPanel overview={overview} />
            <SitemapsTable
              overview={overview}
              onRefresh={() => refreshSitemaps.mutate()}
              refreshing={refreshSitemaps.isPending}
              onDelete={
                overview.sitemapWriteEnabled
                  ? (path) => {
                      if (
                        window.confirm(`Remove ${path} from Search Console?`)
                      ) {
                        writeSitemap.mutate({
                          feedpath: path,
                          action: "delete",
                        });
                      }
                    }
                  : undefined
              }
            />
            {overview.sitemapWriteEnabled ? (
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  writeSitemap.mutate({
                    feedpath: newSitemap,
                    action: "submit",
                  });
                }}
              >
                <input
                  type="url"
                  required
                  className="input input-bordered input-sm w-full max-w-md"
                  placeholder="https://example.com/sitemap.xml"
                  value={newSitemap}
                  onChange={(event) => setNewSitemap(event.target.value)}
                  aria-label="Sitemap URL to submit"
                />
                <button
                  type="submit"
                  className="btn btn-sm"
                  disabled={writeSitemap.isPending}
                >
                  Submit sitemap
                </button>
              </form>
            ) : (
              <div className="text-xs text-base-content/60">
                The connection is read-only.{" "}
                <button
                  type="button"
                  className="link link-primary"
                  disabled={linkPending}
                  onClick={() =>
                    void startGoogleLink("gsc", window.location.href, {
                      gscWrite: true,
                    })
                  }
                >
                  Allow sitemap submit/delete
                </button>{" "}
                (asks Google for write access to Search Console).
              </div>
            )}
          </>
        )}
      </div>
      {openUrl ? (
        <UrlDetailDrawer
          projectId={projectId}
          url={openUrl}
          onClose={() => setOpenUrl(null)}
        />
      ) : null}
    </div>
  );
}

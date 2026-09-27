import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  listIndexingUrls,
  type getIndexingOverview,
} from "@/serverFunctions/gscIndex";

export type IndexingOverview = Extract<
  Awaited<ReturnType<typeof getIndexingOverview>>,
  { connected: true }
>;
export type IndexStatusKey =
  | "indexed"
  | "not_indexed"
  | "error"
  | "uninspected";
export type ReasonSelection = { reason: string; status: IndexStatusKey };

const STATUS_LABELS: Record<IndexStatusKey, string> = {
  indexed: "Indexed",
  not_indexed: "Not indexed",
  error: "Inspection failed",
  uninspected: "Not inspected yet",
};

const STATUS_BADGES: Record<IndexStatusKey, string> = {
  indexed: "badge-success",
  not_indexed: "badge-warning",
  error: "badge-error",
  uninspected: "badge-ghost",
};

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

export function SummaryCards({ overview }: { overview: IndexingOverview }) {
  const { coverage } = overview;
  const cards: Array<{ label: string; value: number; tone: string }> = [
    {
      label: "Indexed",
      value: coverage.byStatus.indexed,
      tone: "text-success",
    },
    {
      label: "Not indexed",
      value: coverage.byStatus.not_indexed,
      tone: "text-warning",
    },
    {
      label: "Inspection failed",
      value: coverage.byStatus.error,
      tone: "text-error",
    },
    {
      label: "Not inspected yet",
      value: coverage.byStatus.uninspected,
      tone: "text-base-content/60",
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {cards.map((card) => (
        <div
          key={card.label}
          className="rounded-xl border border-base-300 bg-base-100 p-4"
        >
          <div className="text-sm text-base-content/60">{card.label}</div>
          <div className={`text-2xl font-semibold ${card.tone}`}>
            {card.value.toLocaleString()}
          </div>
        </div>
      ))}
    </div>
  );
}

export function SweepPanel({
  overview,
  onRunNow,
  running,
}: {
  overview: IndexingOverview;
  onRunNow: () => void;
  running: boolean;
}) {
  const { sweep, coverage } = overview;
  const active = sweep.active;
  const progress =
    active && active.totalUrls > 0
      ? Math.min(
          100,
          Math.round((active.inspectedCount / active.totalUrls) * 100),
        )
      : null;
  return (
    <div className="rounded-xl border border-base-300 bg-base-100 p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="font-medium">
            {active
              ? active.status === "waiting_quota"
                ? "Sweep paused: daily inspection quota used"
                : active.status === "collecting"
                  ? "Collecting URLs from sitemaps and Search Analytics…"
                  : "Sweep in progress"
              : "No sweep running"}
          </div>
          <div className="text-sm text-base-content/60">
            {coverage.totalUrls.toLocaleString()} URLs known ·{" "}
            {coverage.inspectedPercent}% inspected · last full sweep finished{" "}
            {formatDate(sweep.lastCompleted?.finishedAt)}
            {active?.resumeAt
              ? ` · resumes ${formatDate(active.resumeAt)}`
              : ""}
          </div>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={onRunNow}
          disabled={running || Boolean(active)}
        >
          {running ? <Loader2 className="size-4 animate-spin" /> : null}
          Run now
        </button>
      </div>
      {progress !== null && active ? (
        <div className="space-y-1">
          <progress
            className="progress progress-primary w-full"
            value={progress}
            max={100}
          />
          <div className="text-xs text-base-content/60">
            {active.inspectedCount.toLocaleString()} of{" "}
            {active.totalUrls.toLocaleString()} inspected
            {active.errorCount > 0 ? ` · ${active.errorCount} failed` : ""}
          </div>
        </div>
      ) : null}
      <div className="text-xs text-base-content/60">
        URL Inspection quota today: {sweep.quota.used.toLocaleString()} /{" "}
        {sweep.quota.limit.toLocaleString()} (resets{" "}
        {formatDate(sweep.quota.resetsAt)}). Google allows 2,000 inspections per
        property per day, so large sites take several days per full pass.
      </div>
    </div>
  );
}

export function ReasonsTable({
  overview,
  onSelect,
}: {
  overview: IndexingOverview;
  onSelect: (selection: ReasonSelection) => void;
}) {
  const reasons = overview.coverage.reasons;
  if (reasons.length === 0) {
    return (
      <div className="rounded-xl border border-base-300 bg-base-100 p-6 text-sm text-base-content/60">
        No URLs collected yet. Run a sweep to build the report.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-base-300 bg-base-100">
      <table className="table table-sm">
        <thead>
          <tr>
            <th>Reason</th>
            <th>Status</th>
            <th className="text-right">Pages</th>
            <th className="text-right">New</th>
          </tr>
        </thead>
        <tbody>
          {reasons.map((row) => (
            <tr
              key={`${row.status}-${row.reason}`}
              className="cursor-pointer hover:bg-base-200"
              onClick={() =>
                onSelect({ reason: row.reason, status: row.status })
              }
            >
              <td className="font-medium">{row.reason}</td>
              <td>
                <span className={`badge badge-sm ${STATUS_BADGES[row.status]}`}>
                  {STATUS_LABELS[row.status]}
                </span>
              </td>
              <td className="text-right tabular-nums">
                {row.count.toLocaleString()}
              </td>
              <td className="text-right tabular-nums">
                {row.newCount > 0 ? `+${row.newCount}` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="border-t border-base-300 px-4 py-2 text-xs text-base-content/60">
        Rebuilt from Google&apos;s URL Inspection API. Reasons match Search
        Console&apos;s Page indexing report; counts cover inspected URLs only.
      </div>
    </div>
  );
}

const PAGE_SIZE = 50;

export function ReasonUrlList({
  projectId,
  selection,
  offset,
  onOffsetChange,
  onOpenUrl,
  onClose,
}: {
  projectId: string;
  selection: ReasonSelection;
  offset: number;
  onOffsetChange: (offset: number) => void;
  onOpenUrl: (url: string) => void;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: ["indexingUrls", projectId, selection, offset],
    queryFn: () =>
      listIndexingUrls({
        data: {
          projectId,
          reason:
            selection.status === "uninspected" ? undefined : selection.reason,
          status:
            selection.status === "uninspected" ? "uninspected" : undefined,
          offset,
          limit: PAGE_SIZE,
        },
      }),
    placeholderData: keepPreviousData,
  });
  return (
    <div className="rounded-xl border border-base-300 bg-base-100">
      <div className="flex items-center justify-between border-b border-base-300 px-4 py-3">
        <div className="font-medium">{selection.reason}</div>
        <button
          type="button"
          className="btn btn-ghost btn-sm btn-square"
          onClick={onClose}
          aria-label="Close list"
        >
          <X className="size-4" />
        </button>
      </div>
      {query.isPending ? (
        <div className="flex items-center gap-2 p-6 text-sm text-base-content/60">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : query.isError ? (
        <div className="p-4 text-sm text-error">
          {getStandardErrorMessage(query.error)}
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>URL</th>
                  <th>Page title</th>
                  <th className="text-right">Impressions</th>
                  <th>Last crawl</th>
                  <th>In reason since</th>
                </tr>
              </thead>
              <tbody>
                {query.data.urls.map((row) => (
                  <tr
                    key={row.url}
                    className="cursor-pointer hover:bg-base-200"
                    onClick={() => onOpenUrl(row.url)}
                  >
                    <td
                      className="max-w-md truncate font-mono text-xs"
                      title={row.url}
                    >
                      {row.url}
                    </td>
                    <td
                      className="max-w-xs truncate text-xs"
                      title={row.pageTitle ?? ""}
                    >
                      {row.pageTitle ?? "—"}
                    </td>
                    <td className="text-right tabular-nums">
                      {row.impressions.toLocaleString()}
                    </td>
                    <td className="text-xs">{formatDate(row.lastCrawlTime)}</td>
                    <td className="text-xs">{formatDate(row.reasonSince)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-base-300 px-4 py-2">
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              disabled={offset === 0}
              onClick={() => onOffsetChange(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              disabled={!query.data.hasMore}
              onClick={() => onOffsetChange(offset + PAGE_SIZE)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function RichResultsPanel({ overview }: { overview: IndexingOverview }) {
  const types = overview.richResults;
  if (types.length === 0) return null;
  return (
    <div className="rounded-xl border border-base-300 bg-base-100 p-4 space-y-3">
      <div>
        <div className="font-medium">Enhancements (rich results)</div>
        <div className="text-xs text-base-content/60">
          Rich result types Google detected on inspected pages, and their
          issues.
        </div>
      </div>
      <div className="space-y-2">
        {types.map((type) => (
          <div key={type.richResultType}>
            <div className="text-sm font-medium">
              {type.richResultType}{" "}
              <span className="font-normal text-base-content/60">
                · {type.pages} page(s)
              </span>
            </div>
            {type.issues.length === 0 ? (
              <div className="text-xs text-success">No issues</div>
            ) : (
              <ul className="ml-4 list-disc text-xs">
                {type.issues.map((issue) => (
                  <li key={`${issue.severity}-${issue.issueMessage}`}>
                    <span
                      className={
                        issue.severity === "ERROR"
                          ? "text-error"
                          : "text-warning"
                      }
                    >
                      {issue.severity}
                    </span>{" "}
                    {issue.issueMessage} — {issue.pages} page(s)
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

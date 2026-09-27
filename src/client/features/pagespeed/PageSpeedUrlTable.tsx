import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import {
  formatCls,
  formatDelta,
  formatMs,
  RATING_LABELS,
  scoreTone,
} from "@/client/features/pagespeed/pagespeedFormat";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { listPageSpeedUrls } from "@/serverFunctions/pagespeed";
import type { PageSpeedRating } from "@/shared/pagespeed";

export type PageSpeedSort =
  | "performance"
  | "lcp"
  | "cls"
  | "tbt"
  | "seo"
  | "delta";
type Sort = PageSpeedSort;

const PAGE_SIZE = 50;

const SORTABLE: Array<{ key: Sort; label: string; right?: boolean }> = [
  { key: "performance", label: "Perf", right: true },
  { key: "delta", label: "Change", right: true },
  { key: "lcp", label: "LCP", right: true },
  { key: "cls", label: "CLS", right: true },
  { key: "tbt", label: "TBT", right: true },
  { key: "seo", label: "SEO", right: true },
];

export function UrlTable({
  projectId,
  sort,
  onSort,
  rating,
  auditKey,
  search,
  offset,
  onOffsetChange,
  onOpenUrl,
}: {
  projectId: string;
  sort: Sort;
  onSort: (sort: Sort) => void;
  rating: PageSpeedRating | undefined;
  auditKey: string | undefined;
  search: string;
  offset: number;
  onOffsetChange: (offset: number) => void;
  onOpenUrl: (url: string) => void;
}) {
  const query = useQuery({
    queryKey: [
      "pagespeedUrls",
      projectId,
      sort,
      rating,
      auditKey,
      search,
      offset,
    ],
    queryFn: () =>
      listPageSpeedUrls({
        data: {
          projectId,
          sort,
          rating,
          auditKey,
          search: search || undefined,
          offset,
          limit: PAGE_SIZE,
        },
      }),
    placeholderData: keepPreviousData,
  });
  if (query.isPending) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-base-content/60">
        <Loader2 className="size-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="p-4 text-sm text-error">
        {getStandardErrorMessage(query.error)}
      </div>
    );
  }
  const { rows, total } = query.data;
  return (
    <>
      <div className="overflow-x-auto">
        <table className="table table-sm">
          <thead>
            <tr>
              <th>URL</th>
              {SORTABLE.map((column) => (
                <th key={column.key} className="text-right">
                  <button
                    type="button"
                    className={`hover:underline ${sort === column.key ? "font-bold text-base-content" : ""}`}
                    onClick={() => onSort(column.key)}
                    title="Sort worst first"
                  >
                    {column.label}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={SORTABLE.length + 1}
                  className="text-sm text-base-content/60"
                >
                  No pages match.
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const delta = formatDelta(row.delta);
                return (
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
                      className={`text-right font-semibold tabular-nums ${scoreTone(row.performance)}`}
                      title={row.rating ? RATING_LABELS[row.rating] : ""}
                    >
                      {row.performance ?? "—"}
                    </td>
                    <td
                      className={`text-right text-xs tabular-nums ${delta?.tone ?? "text-base-content/40"}`}
                    >
                      {delta?.text ?? "—"}
                    </td>
                    <td className="text-right tabular-nums">
                      {formatMs(row.lcpMs)}
                    </td>
                    <td className="text-right tabular-nums">
                      {formatCls(row.cls)}
                    </td>
                    <td className="text-right tabular-nums">
                      {formatMs(row.tbtMs)}
                    </td>
                    <td
                      className={`text-right tabular-nums ${scoreTone(row.seo)}`}
                    >
                      {row.seo ?? "—"}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-base-300 px-4 py-2 text-xs text-base-content/60">
        <span>
          {total === 0
            ? "0 pages"
            : `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total.toLocaleString()} pages`}
        </span>
        <span className="flex gap-2">
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
            disabled={offset + PAGE_SIZE >= total}
            onClick={() => onOffsetChange(offset + PAGE_SIZE)}
          >
            Next
          </button>
        </span>
      </div>
    </>
  );
}

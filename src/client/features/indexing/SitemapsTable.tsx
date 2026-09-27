import { Loader2 } from "lucide-react";
import {
  formatDate,
  type IndexingOverview,
} from "@/client/features/indexing/IndexingParts";

export function SitemapsTable({
  overview,
  onRefresh,
  refreshing,
  onDelete,
}: {
  overview: IndexingOverview;
  onRefresh: () => void;
  refreshing: boolean;
  onDelete?: (path: string) => void;
}) {
  const { sitemaps, totals } = overview.sitemaps;
  return (
    <div className="rounded-xl border border-base-300 bg-base-100">
      <div className="flex items-center justify-between border-b border-base-300 px-4 py-3">
        <div>
          <div className="font-medium">Sitemaps</div>
          <div className="text-xs text-base-content/60">
            {totals.sitemaps} sitemaps · {totals.errors} errors ·{" "}
            {totals.warnings} warnings · {totals.submittedUrls.toLocaleString()}{" "}
            submitted URLs
          </div>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onRefresh}
          disabled={refreshing}
        >
          {refreshing ? <Loader2 className="size-4 animate-spin" /> : null}
          Refresh
        </button>
      </div>
      {sitemaps.length === 0 ? (
        <div className="p-4 text-sm text-base-content/60">
          No sitemaps stored yet. Refresh to read them from Search Console.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Sitemap</th>
                <th>Type</th>
                <th className="text-right">Submitted pages</th>
                <th className="text-right">Errors</th>
                <th className="text-right">Warnings</th>
                <th>Last read</th>
                {onDelete ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {sitemaps.map((s) => (
                <tr key={s.path}>
                  <td
                    className="max-w-md truncate font-mono text-xs"
                    title={s.path}
                  >
                    {s.parentPath ? "↳ " : ""}
                    {s.path}
                  </td>
                  <td className="text-xs">
                    {s.isSitemapsIndex ? "index" : (s.type ?? "sitemap")}
                    {s.isPending ? " · pending" : ""}
                  </td>
                  <td className="text-right tabular-nums">
                    {s.contents
                      // Page URLs only; image and video entries count separately.
                      .reduce(
                        (n, c) => n + (c.type === "web" ? c.submitted : 0),
                        0,
                      )
                      .toLocaleString()}
                  </td>
                  <td
                    className={`text-right tabular-nums ${s.errors > 0 ? "text-error" : ""}`}
                  >
                    {s.errors}
                  </td>
                  <td
                    className={`text-right tabular-nums ${s.warnings > 0 ? "text-warning" : ""}`}
                  >
                    {s.warnings}
                  </td>
                  <td className="text-xs">{formatDate(s.lastDownloaded)}</td>
                  {onDelete ? (
                    <td>
                      {s.parentPath ? null : (
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs text-error"
                          onClick={() => onDelete(s.path)}
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

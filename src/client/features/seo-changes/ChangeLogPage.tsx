import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { ChangeImpactPanel } from "@/client/features/seo-changes/ChangeImpactPanel";
import { LogChangeModal } from "@/client/features/seo-changes/LogChangeModal";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { listSeoChanges } from "@/serverFunctions/seoChanges";
import { SEO_CHANGE_TYPE_LABELS } from "@/shared/seo-changes";
import { SEO_CHANGE_MAX_LIST_LIMIT } from "@/types/schemas/seoChanges";

export function ChangeLogPage({
  projectId,
  selectedChangeId,
  onSelect,
}: {
  projectId: string;
  selectedChangeId: string | undefined;
  onSelect: (changeId: string | undefined) => void;
}) {
  const [logging, setLogging] = useState(false);
  const changesQuery = useQuery({
    queryKey: ["seoChanges", projectId],
    queryFn: () =>
      listSeoChanges({
        data: { projectId, limit: SEO_CHANGE_MAX_LIST_LIMIT },
      }),
    // Agents log changes over MCP; show them as soon as the page opens.
    staleTime: 0,
  });

  return (
    <div className="overflow-auto px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-5xl space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Change log</h1>
            <p className="text-sm text-base-content/70">
              What shipped to the site, with Search Console before and 14 and 28
              days after.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-primary btn-sm gap-1"
            onClick={() => setLogging(true)}
          >
            <Plus className="size-4" /> Log change
          </button>
        </div>

        {selectedChangeId ? (
          <ChangeImpactPanel
            key={selectedChangeId}
            projectId={projectId}
            changeId={selectedChangeId}
            onClose={() => onSelect(undefined)}
          />
        ) : null}

        {changesQuery.isPending ? (
          <div className="flex justify-center py-10">
            <span className="loading loading-spinner loading-md" />
          </div>
        ) : changesQuery.isError ? (
          <div className="alert alert-error">
            <span className="text-sm">
              {getStandardErrorMessage(
                changesQuery.error,
                "Failed to load changes",
              )}
            </span>
          </div>
        ) : changesQuery.data.length === 0 ? (
          <p className="rounded-lg border border-dashed border-base-300 px-4 py-6 text-sm text-base-content/60">
            No changes logged yet. Log one here after it ships, or have your
            agent call log_change over MCP.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-base-300">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>Shipped</th>
                  <th>Change</th>
                  <th>Type</th>
                  <th>Pages &amp; queries</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                {changesQuery.data.map((change) => (
                  <tr
                    key={change.id}
                    className={`cursor-pointer hover:bg-base-200 ${
                      change.id === selectedChangeId ? "bg-base-200" : ""
                    }`}
                    onClick={() => onSelect(change.id)}
                  >
                    <td className="whitespace-nowrap tabular-nums">
                      {change.shipDate}
                    </td>
                    <td className="max-w-[360px]">
                      <span className="font-medium">{change.summary}</span>
                      {change.status === "reverted" ? (
                        <span className="badge badge-warning badge-sm ml-2">
                          Reverted
                        </span>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap text-base-content/70">
                      {SEO_CHANGE_TYPE_LABELS[change.type]}
                    </td>
                    <td className="max-w-[240px] truncate text-base-content/70">
                      {change.targets.map((t) => t.value).join(", ")}
                    </td>
                    <td className="text-base-content/70">{change.author}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {logging ? (
        <LogChangeModal
          projectId={projectId}
          onClose={() => setLogging(false)}
          onLogged={(changeId) => {
            setLogging(false);
            onSelect(changeId);
          }}
        />
      ) : null}
    </div>
  );
}

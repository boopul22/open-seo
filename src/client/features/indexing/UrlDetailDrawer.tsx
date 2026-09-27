import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Loader2, X } from "lucide-react";
import { formatDate } from "@/client/features/indexing/IndexingParts";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { getIndexingUrlDetail } from "@/serverFunctions/gscIndex";

function Field({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-2 text-sm">
      <div className="text-base-content/60">{label}</div>
      <div className="break-all">{value || "—"}</div>
    </div>
  );
}

export function UrlDetailDrawer({
  projectId,
  url,
  onClose,
}: {
  projectId: string;
  url: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const query = useQuery({
    queryKey: ["indexingUrlDetail", projectId, url],
    queryFn: () => getIndexingUrlDetail({ data: { projectId, url } }),
  });
  const detail = query.data;
  const latest = detail?.latest;
  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40"
      onClick={onClose}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="URL inspection result"
        className="h-full w-full max-w-2xl overflow-y-auto border-l border-base-300 bg-base-100 p-5 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs text-base-content/60">URL Inspection</div>
            <div className="break-all font-mono text-sm">{url}</div>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-square"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>
        {query.isPending ? (
          <Loader2 className="size-5 animate-spin" />
        ) : query.isError ? (
          <div className="text-sm text-error">
            {getStandardErrorMessage(query.error)}
          </div>
        ) : !detail ? (
          <div className="text-sm text-base-content/60">
            Not in the URL set.
          </div>
        ) : (
          <div className="space-y-5">
            <section className="space-y-2">
              <Field label="Verdict" value={latest?.verdict} />
              <Field label="Reason" value={latest?.coverageState} />
              <Field label="Indexing allowed" value={latest?.indexingState} />
              <Field label="robots.txt" value={latest?.robotsTxtState} />
              <Field label="Page fetch" value={latest?.pageFetchState} />
              <Field
                label="Last crawl"
                value={formatDate(latest?.lastCrawlTime)}
              />
              <Field label="Crawled as" value={latest?.crawledAs} />
              <Field label="Google canonical" value={latest?.googleCanonical} />
              <Field label="User canonical" value={latest?.userCanonical} />
              <Field label="Rich results" value={latest?.richResultsVerdict} />
              <Field
                label="Mobile usability"
                value={latest?.mobileUsabilityVerdict}
              />
              <Field
                label="Inspected"
                value={formatDate(latest?.inspectedAt)}
              />
              <Field label="Page title" value={latest?.pageTitle} />
              <Field
                label="Meta description"
                value={latest?.pageMetaDescription}
              />
              <Field
                label="Live HTTP status"
                value={latest?.pageHttpStatus?.toString()}
              />
              {latest?.error ? (
                <Field label="Error" value={latest.error} />
              ) : null}
              {latest?.inspectionLink ? (
                <a
                  className="link link-primary inline-flex items-center gap-1 text-sm"
                  href={latest.inspectionLink}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in Search Console <ExternalLink className="size-3" />
                </a>
              ) : null}
            </section>
            {detail.links.length > 0 ? (
              <section>
                <h3 className="mb-1 text-sm font-medium">
                  Sitemaps and referring pages
                </h3>
                <ul className="space-y-1 text-xs">
                  {detail.links.map((link) => (
                    <li key={`${link.kind}-${link.url}`} className="break-all">
                      <span className="badge badge-ghost badge-xs mr-2">
                        {link.kind}
                      </span>
                      {link.url}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {detail.richResults.length > 0 ? (
              <section>
                <h3 className="mb-1 text-sm font-medium">Rich results</h3>
                <ul className="space-y-1 text-xs">
                  {detail.richResults.map((item, index) => (
                    <li key={index}>
                      <span className="font-medium">{item.richResultType}</span>
                      {item.itemName ? ` · ${item.itemName}` : ""}
                      {item.issueMessage
                        ? ` — [${item.severity}] ${item.issueMessage}`
                        : " — no issues"}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            <section>
              <h3 className="mb-1 text-sm font-medium">History</h3>
              <ul className="space-y-1 text-xs">
                {detail.history.map((row) => (
                  <li key={row.id}>
                    {formatDate(row.inspectedAt)} —{" "}
                    {row.error
                      ? `error: ${row.error}`
                      : `${row.verdict ?? "?"} · ${row.coverageState ?? "?"}`}
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}

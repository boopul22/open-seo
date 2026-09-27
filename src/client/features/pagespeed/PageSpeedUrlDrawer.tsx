import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Loader2, X } from "lucide-react";
import {
  formatCls,
  formatDelta,
  formatMs,
  scoreTone,
} from "@/client/features/pagespeed/pagespeedFormat";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { getPageSpeedUrl } from "@/serverFunctions/pagespeed";

const SEVERITY_DOT: Record<string, string> = {
  critical: "bg-error",
  warning: "bg-warning",
  info: "bg-base-content/30",
};

export function PageSpeedUrlDrawer({
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
    queryKey: ["pagespeedUrl", projectId, url],
    queryFn: () => getPageSpeedUrl({ data: { projectId, url } }),
  });
  const detail = query.data;
  const r = detail?.result;
  const delta = formatDelta(
    r?.performance != null && detail?.previousPerformance != null
      ? r.performance - detail.previousPerformance
      : null,
  );

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40"
      onClick={onClose}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="PageSpeed result"
        className="h-full w-full max-w-2xl overflow-y-auto border-l border-base-300 bg-base-100 p-5 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs text-base-content/60">
              PageSpeed · mobile
              {r?.fetchedAt
                ? ` · ${new Date(r.fetchedAt).toLocaleString()}`
                : ""}
            </div>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 break-all font-mono text-sm hover:underline"
            >
              {url} <ExternalLink className="size-3 shrink-0" />
            </a>
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
          <div className="flex items-center gap-2 text-sm text-base-content/60">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : query.isError ? (
          <div className="text-sm text-error">
            {getStandardErrorMessage(query.error)}
          </div>
        ) : !detail || !r ? (
          <div className="text-sm text-base-content/60">
            This URL isn&apos;t in the latest sweep.
          </div>
        ) : r.status === "failed" ? (
          <div className="alert alert-warning text-sm">
            PageSpeed couldn&apos;t test this page: {r.error ?? "unknown error"}
          </div>
        ) : (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {(
                [
                  ["Performance", r.performance],
                  ["Accessibility", r.accessibility],
                  ["Best practices", r.bestPractices],
                  ["SEO", r.seo],
                ] as const
              ).map(([label, score]) => (
                <div
                  key={label}
                  className="rounded-lg border border-base-300 p-3"
                >
                  <div className="text-xs text-base-content/60">{label}</div>
                  <div
                    className={`text-2xl font-semibold tabular-nums ${scoreTone(score)}`}
                  >
                    {score ?? "—"}
                    {label === "Performance" && delta ? (
                      <span className={`ml-1 text-xs ${delta.tone}`}>
                        {delta.text}
                      </span>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>

            <section>
              <h3 className="mb-2 text-sm font-semibold">Lab metrics</h3>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
                <div>LCP {formatMs(r.lcpMs)}</div>
                <div>CLS {formatCls(r.cls)}</div>
                <div>TBT {formatMs(r.tbtMs)}</div>
                <div>FCP {formatMs(r.fcpMs)}</div>
                <div>Speed Index {formatMs(r.speedIndexMs)}</div>
              </div>
            </section>

            <section>
              <h3 className="mb-2 text-sm font-semibold">
                Real users (Chrome UX Report)
              </h3>
              {r.fieldScope ? (
                <div className="space-y-1 text-sm">
                  <div className="text-xs text-base-content/60">
                    {r.fieldScope === "url"
                      ? "Data for this page"
                      : "Not enough traffic for this page; showing the whole site"}{" "}
                    · p75 · {r.fieldOverall ?? "no overall rating"}
                  </div>
                  <div className="flex flex-wrap gap-x-6">
                    <span>LCP {formatMs(r.fieldLcpMs)}</span>
                    <span>INP {formatMs(r.fieldInpMs)}</span>
                    <span>CLS {formatCls(r.fieldCls)}</span>
                  </div>
                </div>
              ) : (
                <div className="text-sm text-base-content/60">
                  Not enough Chrome traffic for field data.
                </div>
              )}
            </section>

            <section>
              <h3 className="mb-2 text-sm font-semibold">
                What to fix ({detail.issues.length})
              </h3>
              {detail.issues.length === 0 ? (
                <div className="text-sm text-base-content/60">
                  No failing audits.
                </div>
              ) : (
                <ul className="space-y-2">
                  {detail.issues.map((issue) => (
                    <li
                      key={issue.id}
                      className="flex items-start gap-2 text-sm"
                    >
                      <span
                        className={`mt-1.5 size-2 shrink-0 rounded-full ${SEVERITY_DOT[issue.severity] ?? "bg-base-content/30"}`}
                      />
                      <span>
                        {issue.title}
                        <span className="text-base-content/50">
                          {" "}
                          · {issue.category}
                          {issue.displayValue ? ` · ${issue.displayValue}` : ""}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}

import { GscService } from "@/server/features/gsc/services/GscService";
import { GscIndexService } from "@/server/features/gsc/services/GscIndexService";
import { CruxService } from "@/server/features/gsc/services/CruxService";
import { CruxNotConfiguredError } from "@/server/lib/cruxClient";
import { comparePeriods } from "@/server/features/gsc/performanceDrops";
import { buildSearchAnalyticsRequest } from "@/server/features/gsc/searchAnalytics";
import { GscTokenError } from "@/server/lib/gscErrors";
import { GSC_REPORTS_WITHOUT_API } from "@/shared/gsc-index";

const DROP_ROWS = 25_000;
const TOP_REASONS = 8;
const TOP_DROPS = 10;

type Section<T> = { ok: true; data: T } | { ok: false; error: string };

// Each section fails on its own: a missing CrUX key or a sitemap hiccup must
// not hide the index coverage the agent actually asked about. A revoked grant
// fails the whole call, since nothing else can work either.
async function section<T>(run: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    if (error instanceof GscTokenError) throw error;
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function isoDaysBefore(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** The biggest page-level click/impression losses, last 28 days against the
 *  28 days before. */
async function performanceDrops(projectId: string) {
  const { connection, client } = await GscService.getProjectClient(projectId);
  const current = buildSearchAnalyticsRequest({
    projectId,
    dimensions: ["page"],
    dateRange: "last_28_days",
    dataState: "final",
  });
  const previous = {
    ...current,
    startDate: isoDaysBefore(current.startDate, 28),
    endDate: isoDaysBefore(current.endDate, 28),
  };
  const [cur, prev] = await Promise.all([
    GscService.fetchAllRows(client, connection.siteUrl, current, DROP_ROWS),
    GscService.fetchAllRows(client, connection.siteUrl, previous, DROP_ROWS),
  ]);
  return {
    currentWindow: { startDate: current.startDate, endDate: current.endDate },
    previousWindow: {
      startDate: previous.startDate,
      endDate: previous.endDate,
    },
    ...comparePeriods(cur.rows, prev.rows, TOP_DROPS),
  };
}

async function propertyInfo(projectId: string) {
  const { connection, client } = await GscService.getProjectClient(projectId);
  const [sites, canWrite] = await Promise.all([
    client.listSites(),
    GscService.connectionCanWrite(connection),
  ]);
  const site = sites.find((s) => s.siteUrl === connection.siteUrl);
  return {
    siteUrl: connection.siteUrl,
    propertyType: connection.siteUrl.startsWith("sc-domain:")
      ? ("domain" as const)
      : ("url_prefix" as const),
    permissionLevel: site?.permissionLevel ?? null,
    connectedBy: connection.connectedAccountEmail,
    sitemapWriteEnabled: canWrite,
  };
}

async function getHealth(projectId: string) {
  // Resolve the connection first so "not connected" surfaces as one error.
  await GscService.getProjectClient(projectId);
  const [property, sitemaps, coverage, sweep, richResults, cwv, drops] =
    await Promise.all([
      section(() => propertyInfo(projectId)),
      section(() => GscIndexService.getSitemaps(projectId, { refresh: true })),
      section(() => GscIndexService.getCoverage(projectId, { sampleSize: 3 })),
      section(() => GscIndexService.getSweepStatus(projectId)),
      section(() => GscIndexService.getRichResultIssues(projectId)),
      section(async () => {
        try {
          const result = await CruxService.getCoreWebVitals({
            projectId,
            scope: "origin",
          });
          return { configured: true as const, ...result };
        } catch (error) {
          if (error instanceof CruxNotConfiguredError) {
            return { configured: false as const, message: error.message };
          }
          throw error;
        }
      }),
      section(() => performanceDrops(projectId)),
    ]);

  const coverageData = coverage.ok ? coverage.data : null;
  return {
    property,
    sitemaps: sitemaps.ok
      ? {
          ok: true as const,
          data: {
            totals: sitemaps.data.totals,
            withIssues: sitemaps.data.sitemaps
              .filter((s) => s.errors > 0 || s.warnings > 0 || s.isPending)
              .map((s) => ({
                path: s.path,
                errors: s.errors,
                warnings: s.warnings,
                isPending: s.isPending,
                lastDownloaded: s.lastDownloaded,
              })),
          },
        }
      : sitemaps,
    indexCoverage: coverage.ok
      ? {
          ok: true as const,
          data: {
            totalUrls: coverage.data.totalUrls,
            inspectedPercent: coverage.data.inspectedPercent,
            byStatus: coverage.data.byStatus,
            newSince: coverage.data.newSince,
            newIssues: coverage.data.reasons
              .filter((r) => r.status === "not_indexed" && r.newCount > 0)
              .map((r) => ({ reason: r.reason, newCount: r.newCount })),
            topReasons: coverage.data.reasons
              .filter((r) => r.status === "not_indexed" || r.status === "error")
              .slice(0, TOP_REASONS)
              .map((r) => ({
                ...r,
                sampleUrls: coverageData?.samples[r.reason] ?? [],
              })),
          },
        }
      : coverage,
    sweep: sweep.ok
      ? {
          ok: true as const,
          data: {
            active: sweep.data.active
              ? {
                  status: sweep.data.active.status,
                  inspected: sweep.data.active.inspectedCount,
                  total: sweep.data.active.totalUrls,
                  resumeAt: sweep.data.active.resumeAt,
                }
              : null,
            lastCompletedAt: sweep.data.lastCompleted?.finishedAt ?? null,
            pendingUrls: sweep.data.pending,
            quota: sweep.data.quota,
          },
        }
      : sweep,
    richResults,
    coreWebVitals: cwv,
    performanceDrops: drops,
    notAvailableViaApi: GSC_REPORTS_WITHOUT_API,
  };
}

export const GscHealthService = { getHealth };

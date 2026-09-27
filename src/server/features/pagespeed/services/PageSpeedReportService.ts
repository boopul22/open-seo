import { sort } from "remeda";
import {
  PageSpeedRepository,
  type PageSpeedSweepRow,
} from "@/server/features/pagespeed/repositories/PageSpeedRepository";
import {
  diffPageSpeed,
  slowestPages,
  summarizePageSpeed,
} from "@/server/features/pagespeed/services/pagespeedSummary";
import {
  PAGESPEED_KEEP_COMPLETED_SWEEPS,
  ratePerformanceScore,
} from "@/shared/pagespeed";

/** The sweep reports read from: the latest completed one, or the active one
 *  while the first sweep is still running (partial results). */
async function resolveReportSweeps(projectId: string) {
  const [active, completed] = await Promise.all([
    PageSpeedRepository.getActiveSweep(projectId),
    PageSpeedRepository.listCompletedSweeps(
      projectId,
      PAGESPEED_KEEP_COMPLETED_SWEEPS,
    ),
  ]);
  const [latest, previous] = completed;
  return {
    active: active ?? null,
    report: latest ?? active ?? null,
    previous: latest ? (previous ?? null) : null,
  };
}

function sweepState(
  sweep: PageSpeedSweepRow | null,
  live: { id: string; done: number; failed: number } | null,
) {
  if (!sweep) return null;
  // The sweep row's counts refresh once per batch; an active sweep reads its
  // rows so progress moves page by page.
  const counts =
    live?.id === sweep.id
      ? { urlsDone: live.done, urlsFailed: live.failed }
      : { urlsDone: sweep.urlsDone, urlsFailed: sweep.urlsFailed };
  return {
    id: sweep.id,
    status: sweep.status,
    startUrl: sweep.startUrl,
    urlsTotal: sweep.urlsTotal,
    ...counts,
    resumeAt: sweep.resumeAt,
    startedAt: sweep.startedAt,
    completedAt: sweep.completedAt,
  };
}

async function getReport(projectId: string, options: { limit?: number } = {}) {
  const limit = options.limit ?? 10;
  const { active, report, previous } = await resolveReportSweeps(projectId);
  if (!report) {
    return {
      active: null,
      sweep: null,
      summary: null,
      slowest: [],
      topIssues: [],
      changes: null,
      failed: [],
    };
  }
  const live = active
    ? {
        id: active.id,
        ...(await PageSpeedRepository.countResultsByStatus(active.id)),
      }
    : null;
  const [rows, previousRows, issueCounts, failed] = await Promise.all([
    PageSpeedRepository.listDoneResults(report.id),
    previous ? PageSpeedRepository.listDoneResults(previous.id) : null,
    PageSpeedRepository.countIssuesByAudit(report.id),
    PageSpeedRepository.listFailedResults(report.id, 20),
  ]);
  return {
    active: sweepState(active, live),
    sweep: sweepState(report, live),
    previousSweep: sweepState(previous, null),
    summary: summarizePageSpeed(rows),
    slowest: slowestPages(rows, limit).map((row) => ({
      url: row.url,
      performance: row.performance,
      rating:
        row.performance != null ? ratePerformanceScore(row.performance) : null,
      lcpMs: row.lcpMs,
      cls: row.cls,
      tbtMs: row.tbtMs,
    })),
    topIssues: sort(
      issueCounts.map((issue) => ({
        ...issue,
        pages: Number(issue.pages),
        criticalPages: Number(issue.criticalPages),
        totalImpactMs: Number(issue.totalImpactMs),
      })),
      (a, b) => b.pages - a.pages || b.totalImpactMs - a.totalImpactMs,
    ).slice(0, 15),
    changes: previousRows ? diffPageSpeed(rows, previousRows) : null,
    failed,
  };
}

const URL_SORTS = [
  "performance",
  "lcp",
  "cls",
  "tbt",
  "seo",
  "accessibility",
  "delta",
] as const;
type PageSpeedUrlSort = (typeof URL_SORTS)[number];
export const PAGESPEED_URL_SORTS = URL_SORTS;

async function listUrls(
  projectId: string,
  options: {
    sort: PageSpeedUrlSort;
    rating?: "good" | "needs_improvement" | "poor";
    auditKey?: string;
    search?: string;
    offset: number;
    limit: number;
  },
) {
  const { report, previous } = await resolveReportSweeps(projectId);
  if (!report) return { total: 0, rows: [] };
  const [rows, previousRows, auditUrls] = await Promise.all([
    PageSpeedRepository.listDoneResults(report.id),
    previous ? PageSpeedRepository.listDoneResults(previous.id) : [],
    options.auditKey
      ? PageSpeedRepository.listUrlsWithAudit(report.id, options.auditKey)
      : null,
  ]);
  const before = new Map(previousRows.map((row) => [row.url, row.performance]));
  const auditSet = auditUrls ? new Set(auditUrls) : null;
  const search = options.search?.trim().toLowerCase();
  const enriched = rows
    .map((row) => {
      const old = before.get(row.url);
      return {
        url: row.url,
        performance: row.performance,
        accessibility: row.accessibility,
        bestPractices: row.bestPractices,
        seo: row.seo,
        lcpMs: row.lcpMs,
        cls: row.cls,
        tbtMs: row.tbtMs,
        fieldScope: row.fieldScope,
        rating:
          row.performance != null
            ? ratePerformanceScore(row.performance)
            : null,
        delta:
          row.performance != null && old != null ? row.performance - old : null,
      };
    })
    .filter(
      (row) =>
        (!options.rating || row.rating === options.rating) &&
        (!auditSet || auditSet.has(row.url)) &&
        (!search || row.url.toLowerCase().includes(search)),
    );
  // Worst first for every sort key.
  const key: Record<
    PageSpeedUrlSort,
    (row: (typeof enriched)[number]) => number
  > = {
    performance: (row) => row.performance ?? 101,
    seo: (row) => row.seo ?? 101,
    accessibility: (row) => row.accessibility ?? 101,
    lcp: (row) => -(row.lcpMs ?? -1),
    cls: (row) => -(row.cls ?? -1),
    tbt: (row) => -(row.tbtMs ?? -1),
    delta: (row) => row.delta ?? Number.POSITIVE_INFINITY,
  };
  const sorted = sort(
    enriched,
    (a, b) => key[options.sort](a) - key[options.sort](b),
  );
  return {
    total: sorted.length,
    rows: sorted.slice(options.offset, options.offset + options.limit),
  };
}

async function getUrlDetail(projectId: string, url: string) {
  const { report, previous } = await resolveReportSweeps(projectId);
  if (!report) return null;
  const row = await PageSpeedRepository.getResultByUrl(report.id, url);
  if (!row) return null;
  const [issues, previousRow] = await Promise.all([
    PageSpeedRepository.listIssuesForResult(row.id),
    previous ? PageSpeedRepository.getResultByUrl(previous.id, url) : null,
  ]);
  return {
    result: row,
    previousPerformance: previousRow?.performance ?? null,
    issues: sort(
      issues,
      (a, b) =>
        (b.severity === "critical" ? 1 : 0) -
          (a.severity === "critical" ? 1 : 0) ||
        (b.impactMs ?? 0) - (a.impactMs ?? 0),
    ),
  };
}

export const PageSpeedReportService = {
  getReport,
  listUrls,
  getUrlDetail,
} as const;

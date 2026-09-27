/* eslint-disable max-lines */
import { sort } from "remeda";
import { env } from "cloudflare:workers";
import { fetchSitemapDocumentWithRetry } from "@/server/lib/audit/discovery";
import { GscConnectionRepository } from "@/server/features/gsc/repositories/GscConnectionRepository";
import {
  GscIndexRepository,
  type DiscoveredUrl,
  type SitemapSnapshot,
  type SweepRow,
} from "@/server/features/gsc/repositories/GscIndexRepository";
import { GscService } from "@/server/features/gsc/services/GscService";
import { buildSearchAnalyticsRequest } from "@/server/features/gsc/searchAnalytics";
import { fetchPageMeta } from "@/server/features/gsc/pageMeta";
import {
  buildCoverageSummary,
  failedInspectionDetails,
  groupRichResultIssues,
  reasonOf,
  toInspectionDetails,
  type CoverageSummary,
  type IndexStatus,
} from "@/server/features/gsc/indexCoverage";
import {
  dailyRemaining,
  nextQuotaReset,
  quotaDay,
} from "@/server/features/gsc/inspectionQuota";
import type { GscClient, GscSitemap } from "@/server/lib/gscClient";
import {
  GscApiError,
  GscNotConnectedError,
  GscTokenError,
  isGscDailyQuotaError,
} from "@/server/lib/gscErrors";
import {
  GSC_INSPECTIONS_PER_DAY,
  type GscSweepTrigger,
} from "@/shared/gsc-index";

// URLs inspected per workflow step. Small enough that a step finishes well
// inside its timeout; progress is durable per URL either way.
export const SWEEP_BATCH_SIZE = 50;
const INSPECT_CONCURRENCY = 4;
// The URL set is capped so one property can't monopolise a worker; the queue
// order still covers sitemap URLs and the highest-traffic pages first.
const MAX_URL_SET = 50_000;
const MAX_SITEMAP_DOCS = 200;
const REASON_SAMPLE_SIZE = 10;
const RATE_LIMIT_WAIT_MS = 60_000;
// An in-progress sweep with no inspection for this long lost its workflow. A
// batch finishes in a couple of minutes, and its step times out at ten.
const STALLED_SWEEP_MS = 15 * 60_000;

// ---------------------------------------------------------------------------
// Sitemaps
// ---------------------------------------------------------------------------

function toCount(value: string | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function toSnapshot(
  sitemap: GscSitemap,
  parentPath: string | null,
): SitemapSnapshot {
  return {
    sitemap: {
      path: sitemap.path,
      parentPath,
      type: sitemap.type ?? null,
      isPending: sitemap.isPending ?? false,
      isSitemapsIndex: sitemap.isSitemapsIndex ?? false,
      lastSubmitted: sitemap.lastSubmitted ?? null,
      lastDownloaded: sitemap.lastDownloaded ?? null,
      errors: toCount(sitemap.errors),
      warnings: toCount(sitemap.warnings),
    },
    contents: (sitemap.contents ?? []).map((content) => ({
      type: content.type ?? "unknown",
      submitted: toCount(content.submitted),
    })),
  };
}

/** Fetch sitemaps.list (plus each index's children) and store the snapshot. */
async function refreshSitemaps(projectId: string) {
  const { connection, client } = await GscService.getProjectClient(projectId);
  const top = await client.listSitemaps(connection.siteUrl);
  const snapshots = new Map<string, SitemapSnapshot>();
  for (const sitemap of top)
    snapshots.set(sitemap.path, toSnapshot(sitemap, null));
  for (const index of top.filter((s) => s.isSitemapsIndex)) {
    const children = await client.listSitemaps(connection.siteUrl, index.path);
    for (const child of children) {
      snapshots.set(child.path, toSnapshot(child, index.path));
    }
  }
  await GscIndexRepository.replaceSitemaps(projectId, [...snapshots.values()]);
  return GscIndexRepository.listSitemaps(projectId);
}

async function getSitemaps(projectId: string, opts: { refresh: boolean }) {
  const sitemaps = opts.refresh
    ? await refreshSitemaps(projectId)
    : await GscIndexRepository.listSitemaps(projectId);
  return {
    sitemaps,
    totals: {
      sitemaps: sitemaps.length,
      errors: sitemaps.reduce((sum, s) => sum + s.errors, 0),
      warnings: sitemaps.reduce((sum, s) => sum + s.warnings, 0),
      submittedUrls: sitemaps
        // An index's contents repeat its children's; count leaves only.
        .filter((s) => !s.isSitemapsIndex)
        .reduce(
          (sum, s) =>
            sum +
            s.contents.reduce(
              (n, c) => n + (c.type === "web" ? c.submitted : 0),
              0,
            ),
          0,
        ),
    },
  };
}

async function submitSitemap(projectId: string, feedpath: string) {
  const { connection, client } = await GscService.getProjectClient(projectId);
  await client.submitSitemap(connection.siteUrl, feedpath);
  return refreshSitemaps(projectId);
}

async function deleteSitemap(projectId: string, feedpath: string) {
  const { connection, client } = await GscService.getProjectClient(projectId);
  await client.deleteSitemap(connection.siteUrl, feedpath);
  return refreshSitemaps(projectId);
}

// ---------------------------------------------------------------------------
// URL set collection
// ---------------------------------------------------------------------------

/** Expand sitemap files (and nested indexes) into page URLs. */
async function expandSitemapUrls(sitemapPaths: string[]): Promise<Set<string>> {
  const pages = new Set<string>();
  const queue = [...sitemapPaths];
  const seen = new Set<string>();
  while (queue.length > 0 && seen.size < MAX_SITEMAP_DOCS) {
    const path = queue.shift();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const doc = await fetchSitemapDocumentWithRetry(path);
    for (const nested of doc.nestedSitemaps) queue.push(nested);
    for (const url of doc.pageUrls) {
      pages.add(url);
      if (pages.size >= MAX_URL_SET) return pages;
    }
  }
  return pages;
}

/** Build the property's URL set: every sitemap URL plus every page with
 *  search impressions in the last 16 months (catches unlisted pages). */
async function collectUrlSet(
  projectId: string,
  client: GscClient,
  siteUrl: string,
): Promise<number> {
  const sitemaps = await refreshSitemaps(projectId);
  const sitemapUrls = await expandSitemapUrls(
    sitemaps.filter((s) => !s.parentPath).map((s) => s.path),
  );
  const request = buildSearchAnalyticsRequest({
    projectId,
    dimensions: ["page"],
    dateRange: "last_16_months",
    aggregationType: "byPage",
  });
  const { rows } = await GscService.fetchAllRows(
    client,
    siteUrl,
    request,
    MAX_URL_SET,
  );

  const urls = new Map<string, DiscoveredUrl>();
  for (const url of sitemapUrls) {
    urls.set(url, {
      url,
      inSitemap: true,
      inSearchAnalytics: false,
      impressions: 0,
    });
  }
  for (const row of rows) {
    const url = row.keys?.[0];
    if (!url) continue;
    const existing = urls.get(url);
    urls.set(url, {
      url,
      inSitemap: existing?.inSitemap ?? false,
      inSearchAnalytics: true,
      impressions: row.impressions,
    });
  }
  const collected = sort(
    [...urls.values()],
    (a, b) =>
      Number(b.inSitemap) - Number(a.inSitemap) ||
      b.impressions - a.impressions,
  ).slice(0, MAX_URL_SET);
  await GscIndexRepository.saveCollectedUrls(projectId, collected);
  return collected.length;
}

// ---------------------------------------------------------------------------
// Sweeps
// ---------------------------------------------------------------------------

async function launchWorkflow(sweep: SweepRow): Promise<void> {
  try {
    await env.INDEX_SWEEP_WORKFLOW.create({
      id: `${sweep.id}-${sweep.attempt}`,
      params: { sweepId: sweep.id },
    });
  } catch (error) {
    await GscIndexRepository.updateSweep(sweep.id, {
      status: "failed",
      error: error instanceof Error ? error.message : "Could not start sweep",
      finishedAt: new Date().toISOString(),
    });
    throw error;
  }
}

/** Queue a full sweep, or specific URLs. A sweep already in progress absorbs
 *  requested URLs (they jump its queue) instead of starting a second one. */
async function startSweep(input: {
  projectId: string;
  trigger: GscSweepTrigger;
  urls?: string[];
}): Promise<{ sweep: SweepRow; created: boolean }> {
  const connection = await GscConnectionRepository.getByProjectId(
    input.projectId,
  );
  if (!connection) throw new GscNotConnectedError(input.projectId);
  const now = new Date().toISOString();
  if (input.urls && input.urls.length > 0) {
    await GscIndexRepository.requestUrls(input.projectId, input.urls, now);
  }
  const result = await GscIndexRepository.createSweepIfNone({
    projectId: input.projectId,
    siteUrl: connection.siteUrl,
    kind: input.urls && input.urls.length > 0 ? "urls" : "full",
    trigger: input.trigger,
    now,
  });
  if (result.created) await launchWorkflow(result.sweep);
  return result;
}

/** Relaunch a paused sweep with a fresh workflow instance. */
async function resumeSweep(sweep: SweepRow): Promise<void> {
  const attempt = sweep.attempt + 1;
  await GscIndexRepository.updateSweep(sweep.id, {
    status: "running",
    resumeAt: null,
    attempt,
  });
  await launchWorkflow({ ...sweep, attempt });
}

/** Workflow step 1: gather the URL set (full sweeps) and size the queue. */
async function prepareSweep(sweepId: string): Promise<{ pending: number }> {
  const sweep = await GscIndexRepository.getSweep(sweepId);
  if (!sweep) return { pending: 0 };
  if (sweep.kind === "full" && sweep.status === "queued") {
    await GscIndexRepository.updateSweep(sweepId, { status: "collecting" });
    const { connection, client } = await GscService.getProjectClient(
      sweep.projectId,
    );
    await collectUrlSet(sweep.projectId, client, connection.siteUrl);
  }
  const pending = await GscIndexRepository.countPendingUrls(
    sweep.projectId,
    sweep,
  );
  await GscIndexRepository.updateSweep(sweepId, {
    status: "running",
    totalUrls: sweep.inspectedCount + pending,
  });
  return { pending };
}

export type BatchOutcome =
  | { state: "continue"; inspected: number }
  | { state: "done" }
  | { state: "quota"; resumeAt: string }
  | { state: "rate_limited"; waitMs: number; inspected: number };

async function inspectAll<T>(
  items: T[],
  worker: (item: T) => Promise<"ok" | "error" | "stop">,
): Promise<{ ok: number; errors: number }> {
  let next = 0;
  let stopped = false;
  let ok = 0;
  let errors = 0;
  const run = async () => {
    while (!stopped && next < items.length) {
      const item = items[next++];
      if (item === undefined) break;
      const outcome = await worker(item);
      if (outcome === "stop") stopped = true;
      else if (outcome === "ok") ok++;
      else errors++;
    }
  };
  await Promise.all(Array.from({ length: INSPECT_CONCURRENCY }, run));
  return { ok, errors };
}

/** Workflow step: inspect the next batch of pending URLs within the daily
 *  quota. Per-URL errors are stored and the batch moves on; quota and rate
 *  limits pause the sweep; a revoked grant fails it. */
async function processBatch(
  sweepId: string,
  now = new Date(),
): Promise<BatchOutcome> {
  const sweep = await GscIndexRepository.getSweep(sweepId);
  if (!sweep || sweep.status === "completed" || sweep.status === "failed") {
    return { state: "done" };
  }
  const day = quotaDay(now);
  const remaining = dailyRemaining(
    await GscIndexRepository.getUsage(sweep.siteUrl, day),
  );
  if (remaining === 0) return pauseForQuota(sweep, now);

  const urls = await GscIndexRepository.nextPendingUrls(
    sweep.projectId,
    sweep,
    Math.min(SWEEP_BATCH_SIZE, remaining),
  );
  if (urls.length === 0) {
    await GscIndexRepository.updateSweep(sweepId, {
      status: "completed",
      finishedAt: now.toISOString(),
      resumeAt: null,
    });
    return { state: "done" };
  }
  if (sweep.status !== "running") {
    await GscIndexRepository.updateSweep(sweepId, {
      status: "running",
      resumeAt: null,
    });
  }

  // Reserve quota up front so a concurrent sweep on the same property sees it.
  await GscIndexRepository.addUsage(sweep.siteUrl, day, urls.length);
  const { connection, client } = await GscService.getProjectClient(
    sweep.projectId,
  );
  let hitDailyQuota = false;
  let hitRateLimit = false;

  const { ok, errors } = await inspectAll(urls, async (url) => {
    const inspectedAt = new Date().toISOString();
    try {
      const result = await client.inspectUrl(connection.siteUrl, url.url);
      const details = toInspectionDetails(result, inspectedAt);
      const page = await fetchPageMeta(url.url);
      details.inspection.pageTitle = page.title;
      details.inspection.pageMetaDescription = page.metaDescription;
      details.inspection.pageHttpStatus = page.httpStatus;
      await GscIndexRepository.recordInspection({
        url,
        details,
        now: inspectedAt,
      });
      return "ok";
    } catch (error) {
      if (error instanceof GscTokenError) throw error;
      if (error instanceof GscApiError && error.status === 429) {
        if (isGscDailyQuotaError(error.status, error.body))
          hitDailyQuota = true;
        else hitRateLimit = true;
        return "stop";
      }
      const message =
        error instanceof Error ? error.message : "Inspection failed";
      await GscIndexRepository.recordInspection({
        url,
        details: failedInspectionDetails(message, inspectedAt),
        now: inspectedAt,
      });
      return "error";
    }
  });
  await GscIndexRepository.addSweepProgress(sweepId, ok, errors);

  if (hitDailyQuota) {
    await GscIndexRepository.markUsageExhausted(
      sweep.siteUrl,
      day,
      GSC_INSPECTIONS_PER_DAY,
    );
    return pauseForQuota(sweep, now);
  }
  if (hitRateLimit) {
    return {
      state: "rate_limited",
      waitMs: RATE_LIMIT_WAIT_MS,
      inspected: ok + errors,
    };
  }
  return { state: "continue", inspected: ok + errors };
}

async function pauseForQuota(
  sweep: SweepRow,
  now: Date,
): Promise<BatchOutcome> {
  const resumeAt = nextQuotaReset(now).toISOString();
  await GscIndexRepository.updateSweep(sweep.id, {
    status: "waiting_quota",
    resumeAt,
  });
  return { state: "quota", resumeAt };
}

/** Hand a still-running sweep back to the cron (its instance is out of
 *  steps). resumeAt now makes it eligible on the next tick. */
async function yieldSweep(sweepId: string): Promise<void> {
  const sweep = await GscIndexRepository.getSweep(sweepId);
  if (!sweep || sweep.status !== "running") return;
  await GscIndexRepository.updateSweep(sweepId, {
    status: "waiting_quota",
    resumeAt: new Date().toISOString(),
  });
}

async function failSweep(sweepId: string, error: unknown): Promise<void> {
  const sweep = await GscIndexRepository.getSweep(sweepId);
  if (!sweep || sweep.status === "completed" || sweep.status === "failed")
    return;
  await GscIndexRepository.updateSweep(sweepId, {
    status: "failed",
    error:
      error instanceof GscTokenError
        ? "The Search Console connection has expired or was revoked. Reconnect it and run the sweep again."
        : error instanceof Error
          ? error.message.slice(0, 500)
          : "Sweep failed",
    finishedAt: new Date().toISOString(),
  });
}

// Workflow instance states that mean it will still make progress.
const LIVE_INSTANCE_STATUSES = new Set([
  "queued",
  "running",
  "waiting",
  "waitingForPause",
  "paused",
]);

/** In-progress sweeps whose workflow instance is gone or finished without
 *  finishing the sweep (a restart, a crash). */
async function sweepsWithDeadInstances(): Promise<SweepRow[]> {
  const dead: SweepRow[] = [];
  for (const sweep of await GscIndexRepository.listRunningSweeps()) {
    try {
      const instance = await env.INDEX_SWEEP_WORKFLOW.get(
        `${sweep.id}-${sweep.attempt}`,
      );
      const { status } = await instance.status();
      if (!LIVE_INSTANCE_STATUSES.has(status)) {
        console.log(`[gsc-sweep] ${sweep.id} instance is ${status}`);
        dead.push(sweep);
      }
    } catch {
      // Unknown instance id: nothing is driving this sweep.
      dead.push(sweep);
    }
  }
  return dead;
}

/** Cron: resume paused sweeps whose quota day rolled over, and start the
 *  daily full sweep for connected projects. */
async function runScheduledSweeps(now = new Date()): Promise<void> {
  const nowIso = now.toISOString();
  const stalledBefore = new Date(
    now.getTime() - STALLED_SWEEP_MS,
  ).toISOString();
  const candidates = [
    ...(await GscIndexRepository.listResumableSweeps(nowIso)),
    ...(await GscIndexRepository.listStalledSweeps(stalledBefore)),
    ...(await sweepsWithDeadInstances()),
  ];
  const toResume = [...new Map(candidates.map((s) => [s.id, s])).values()];
  for (const sweep of toResume) {
    try {
      console.log(
        `[gsc-sweep] resuming ${sweep.id} project=${sweep.projectId} status=${sweep.status} attempt=${sweep.attempt + 1}`,
      );
      await resumeSweep(sweep);
    } catch (error) {
      console.error("[gsc-sweep] resume failed", sweep.id, error);
    }
  }
  const dayAgo = new Date(now.getTime() - 24 * 3600_000).toISOString();
  for (const due of await GscIndexRepository.listProjectsDueForSweep(dayAgo)) {
    try {
      console.log(`[gsc-sweep] starting daily sweep project=${due.projectId}`);
      await startSweep({ projectId: due.projectId, trigger: "scheduled" });
    } catch (error) {
      console.error("[gsc-sweep] scheduled start failed", due.projectId, error);
    }
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function getSweepStatus(projectId: string, now = new Date()) {
  const [active, lastCompleted, recent] = await Promise.all([
    GscIndexRepository.getActiveSweep(projectId),
    GscIndexRepository.lastCompletedSweep(projectId),
    GscIndexRepository.listSweeps(projectId, 5),
  ]);
  const connection = await GscConnectionRepository.getByProjectId(projectId);
  const usedToday = connection
    ? await GscIndexRepository.getUsage(connection.siteUrl, quotaDay(now))
    : 0;
  const pending = active
    ? await GscIndexRepository.countPendingUrls(projectId, active)
    : 0;
  return {
    active,
    lastCompleted,
    recent,
    pending,
    quota: {
      day: quotaDay(now),
      used: Math.min(usedToday, GSC_INSPECTIONS_PER_DAY),
      limit: GSC_INSPECTIONS_PER_DAY,
      remaining: dailyRemaining(usedToday),
      resetsAt: nextQuotaReset(now).toISOString(),
    },
  };
}

/** "New" means entered its current state during the latest sweep, measured
 *  against an earlier completed sweep. The first sweep sets the baseline. */
async function newIssuesSince(projectId: string): Promise<string | null> {
  const latest =
    (await GscIndexRepository.getActiveSweep(projectId)) ??
    (await GscIndexRepository.lastCompletedSweep(projectId));
  if (!latest) return null;
  const baseline = await GscIndexRepository.lastCompletedSweep(
    projectId,
    latest.createdAt,
  );
  return baseline ? latest.createdAt : null;
}

export type CoverageReport = CoverageSummary & {
  newSince: string | null;
  samples: Record<string, string[]>;
};

async function getCoverage(
  projectId: string,
  opts: { status?: IndexStatus; sampleSize?: number } = {},
): Promise<CoverageReport> {
  const newSince = await newIssuesSince(projectId);
  const summary = buildCoverageSummary(
    await GscIndexRepository.coverageGroups(projectId, newSince),
  );
  const reasons = opts.status
    ? summary.reasons.filter((r) => r.status === opts.status)
    : summary.reasons;
  const samples: Record<string, string[]> = {};
  const sampleSize = opts.sampleSize ?? REASON_SAMPLE_SIZE;
  if (sampleSize > 0) {
    for (const reason of reasons
      .filter((r) => r.status !== "uninspected")
      .slice(0, 12)) {
      const { rows } = await GscIndexRepository.listUrls({
        projectId,
        coverageState: reason.reason,
        limit: sampleSize,
        offset: 0,
      });
      samples[reason.reason] = rows.map((row) => row.url);
    }
  }
  return { ...summary, reasons, newSince, samples };
}

async function listIssues(input: {
  projectId: string;
  reason?: string;
  status?: IndexStatus;
  sinceDate?: string;
  limit: number;
  offset: number;
}) {
  const { rows, hasMore } = await GscIndexRepository.listUrls({
    projectId: input.projectId,
    coverageState: input.status === "uninspected" ? null : input.reason,
    verdict:
      input.status === "indexed"
        ? "PASS"
        : input.status === "not_indexed" || (!input.status && !input.reason)
          ? "NOT_PASS"
          : undefined,
    errorsOnly: input.status === "error",
    sinceDate: input.sinceDate,
    limit: input.limit,
    offset: input.offset,
  });
  return {
    hasMore,
    nextOffset: hasMore ? input.offset + rows.length : null,
    urls: rows.map((row) => ({
      url: row.url,
      reason: reasonOf({
        coverageState: row.inspection?.coverageState ?? null,
        verdict: row.inspection?.verdict ?? null,
        error: row.inspection?.error ?? null,
        inspected: row.inspection !== null,
      }),
      inSitemap: row.inSitemap,
      inSearchAnalytics: row.inSearchAnalytics,
      impressions: row.impressions,
      lastInspectedAt: row.lastInspectedAt,
      reasonSince: row.coverageStateSince,
      verdict: row.inspection?.verdict ?? null,
      coverageState: row.inspection?.coverageState ?? null,
      robotsTxtState: row.inspection?.robotsTxtState ?? null,
      indexingState: row.inspection?.indexingState ?? null,
      pageFetchState: row.inspection?.pageFetchState ?? null,
      lastCrawlTime: row.inspection?.lastCrawlTime ?? null,
      crawledAs: row.inspection?.crawledAs ?? null,
      googleCanonical: row.inspection?.googleCanonical ?? null,
      userCanonical: row.inspection?.userCanonical ?? null,
      richResultsVerdict: row.inspection?.richResultsVerdict ?? null,
      error: row.inspection?.error ?? null,
      inspectionLink: row.inspection?.inspectionLink ?? null,
      // Read from the live page during the sweep, not from Google.
      pageTitle: row.inspection?.pageTitle ?? null,
      pageMetaDescription: row.inspection?.pageMetaDescription ?? null,
      pageHttpStatus: row.inspection?.pageHttpStatus ?? null,
    })),
  };
}

async function getRichResultIssues(projectId: string) {
  return groupRichResultIssues(
    await GscIndexRepository.richResultRows(projectId),
  );
}

export const GscIndexService = {
  refreshSitemaps,
  getSitemaps,
  submitSitemap,
  deleteSitemap,
  startSweep,
  resumeSweep,
  prepareSweep,
  processBatch,
  yieldSweep,
  failSweep,
  runScheduledSweeps,
  getSweepStatus,
  getCoverage,
  listIssues,
  getRichResultIssues,
  getUrlDetail: GscIndexRepository.getUrlDetail,
};

import { env } from "cloudflare:workers";
import { sort } from "remeda";
import {
  dailyRemaining,
  nextQuotaReset,
  quotaDay,
} from "@/server/features/gsc/inspectionQuota";
import {
  PageSpeedRepository,
  type PageSpeedIssueInput,
  type PageSpeedSweepRow,
} from "@/server/features/pagespeed/repositories/PageSpeedRepository";
import { listSitemapPageUrls } from "@/server/lib/audit/discovery";
import { CRUX_API_KEY_ENV } from "@/server/lib/cruxClient";
import {
  isPageSpeedDailyQuotaError,
  PAGESPEED_API_KEY_ENV,
  PageSpeedApiError,
  runPageSpeedInsights,
} from "@/server/lib/pagespeedClient";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import {
  PAGESPEED_BATCH_CONCURRENCY,
  PAGESPEED_BATCH_SIZE,
  PAGESPEED_DAILY_BUDGET,
  PAGESPEED_KEEP_COMPLETED_SWEEPS,
  PAGESPEED_MAX_CONCURRENT_SWEEPS,
  PAGESPEED_MAX_URLS,
} from "@/shared/pagespeed";

// Issues stored per page: the costliest failing audits.
const MAX_ISSUES_PER_PAGE = 10;
// A running sweep with no batch progress for this long lost its workflow. A
// healthy batch refreshes the heartbeat every few minutes. Also catches
// instances a local (Docker) restart left reporting "running" with nothing
// executing them.
const STALLED_SWEEP_MS = 15 * 60_000;
const RATE_LIMIT_BACKOFF_MS = 65_000;

type PageSpeedBatchOutcome =
  | { state: "done" }
  | { state: "continue"; processed: number }
  | { state: "rate_limited"; processed: number; waitMs: number }
  | { state: "quota"; resumeAt: string };

async function getApiKey() {
  // One Google Cloud key can enable both the PageSpeed and CrUX APIs.
  return (
    (await getOptionalEnvValue(PAGESPEED_API_KEY_ENV)) ??
    (await getOptionalEnvValue(CRUX_API_KEY_ENV))
  );
}

// ─── Scheduling ──────────────────────────────────────────────────────────────

/** Queue a sweep for a project unless one is already queued or running. The
 *  hourly cron starts it (at most PAGESPEED_MAX_CONCURRENT_SWEEPS at once). */
async function queueSweep(projectId: string, startUrl: string) {
  const active = await PageSpeedRepository.getActiveSweep(projectId);
  if (active) return { sweepId: active.id, created: false };
  const sweepId = await PageSpeedRepository.createSweep(projectId, startUrl);
  return { sweepId, created: true };
}

async function launch(sweep: PageSpeedSweepRow, now: Date) {
  const attempt = sweep.attempt + 1;
  await PageSpeedRepository.updateSweep(sweep.id, {
    status: "running",
    attempt,
    resumeAt: null,
    startedAt: sweep.startedAt ?? now.toISOString(),
    heartbeatAt: now.toISOString(),
  });
  try {
    await env.PAGESPEED_SWEEP_WORKFLOW.create({
      id: `${sweep.id}-${attempt}`,
      params: { sweepId: sweep.id, attempt },
    });
  } catch (error) {
    await failSweep(sweep.id, error);
  }
}

// Workflow instance states that are still driving (or about to drive) a sweep.
const LIVE_INSTANCE_STATUSES = new Set([
  "queued",
  "running",
  "paused",
  "waiting",
  "waitingForPause",
]);

/** Running sweeps whose workflow instance ended or vanished (a container
 *  restart, a crash) without marking the sweep. */
async function sweepsWithDeadInstances() {
  const dead: PageSpeedSweepRow[] = [];
  for (const sweep of await PageSpeedRepository.listSweepsByStatus(
    "running",
    PAGESPEED_MAX_CONCURRENT_SWEEPS * 4,
  )) {
    try {
      const instance = await env.PAGESPEED_SWEEP_WORKFLOW.get(
        `${sweep.id}-${sweep.attempt}`,
      );
      const { status } = await instance.status();
      if (!LIVE_INSTANCE_STATUSES.has(status)) dead.push(sweep);
    } catch {
      // Unknown instance id: nothing is driving this sweep.
      dead.push(sweep);
    }
  }
  return dead;
}

/** Cron body: relaunch quota-paused and stalled sweeps, then start queued
 *  ones while fewer than the concurrency cap are running. */
async function startQueuedSweeps(now = new Date()) {
  const stalledBefore = new Date(
    now.getTime() - STALLED_SWEEP_MS,
  ).toISOString();
  const candidates = [
    ...(await PageSpeedRepository.listResumableSweeps(now.toISOString())),
    ...(await PageSpeedRepository.listStalledSweeps(stalledBefore)),
    ...(await sweepsWithDeadInstances()),
  ];
  const relaunch = [...new Map(candidates.map((s) => [s.id, s])).values()];
  for (const sweep of relaunch) await launch(sweep, now);

  const running = await PageSpeedRepository.countSweepsByStatus(["running"]);
  const slots = PAGESPEED_MAX_CONCURRENT_SWEEPS - running;
  if (slots <= 0) return { relaunched: relaunch.length, started: 0 };
  const queued = await PageSpeedRepository.listSweepsByStatus("queued", slots);
  for (const sweep of queued) await launch(sweep, now);
  return { relaunched: relaunch.length, started: queued.length };
}

// ─── Workflow steps ──────────────────────────────────────────────────────────

/** Collect the sitemap URL set once per sweep; replays reuse the rows. */
async function prepareSweep(sweepId: string) {
  const sweep = await PageSpeedRepository.getSweep(sweepId);
  if (!sweep) return { pending: 0 };
  if (sweep.urlsTotal === 0) {
    const origin = new URL(sweep.startUrl).origin;
    const urls = await listSitemapPageUrls(origin, PAGESPEED_MAX_URLS);
    await PageSpeedRepository.insertPendingUrls(
      sweepId,
      urls.length > 0 ? urls : [sweep.startUrl],
    );
  }
  const counts = await PageSpeedRepository.countResultsByStatus(sweepId);
  await PageSpeedRepository.updateSweep(sweepId, {
    urlsTotal: counts.pending + counts.done + counts.failed,
  });
  return { pending: counts.pending };
}

type PsiResult = Awaited<ReturnType<typeof runPageSpeedInsights>>;

function toStoredResult(result: PsiResult, fetchedAt: string) {
  const field = result.fieldData?.metrics ?? {};
  const fields = {
    fetchedAt,
    performance: result.scores.performance,
    accessibility: result.scores.accessibility,
    bestPractices: result.scores["best-practices"],
    seo: result.scores.seo,
    lcpMs: result.metrics.largestContentfulPaint.numericValue,
    // CLS is unitless; numericValue carries it.
    cls: result.metrics.cumulativeLayoutShift.numericValue,
    tbtMs: result.metrics.totalBlockingTime.numericValue,
    fcpMs: result.metrics.firstContentfulPaint.numericValue,
    speedIndexMs: result.metrics.speedIndex.numericValue,
    fieldScope: result.fieldDataScope,
    fieldOverall: result.fieldData?.overall ?? null,
    fieldLcpMs: field.LARGEST_CONTENTFUL_PAINT_MS?.p75 ?? null,
    fieldInpMs: field.INTERACTION_TO_NEXT_PAINT?.p75 ?? null,
    // PSI reports field CLS ×100 as an integer.
    fieldCls:
      field.CUMULATIVE_LAYOUT_SHIFT_SCORE?.p75 != null
        ? field.CUMULATIVE_LAYOUT_SHIFT_SCORE.p75 / 100
        : null,
  };
  const issues: PageSpeedIssueInput[] = sort(
    result.issues,
    (a, b) =>
      (b.severity === "critical" ? 1 : 0) -
        (a.severity === "critical" ? 1 : 0) ||
      (b.impactMs ?? 0) - (a.impactMs ?? 0),
  )
    .slice(0, MAX_ISSUES_PER_PAGE)
    .map((issue) => ({
      auditKey: issue.auditKey,
      category: issue.category,
      title: issue.title,
      severity: issue.severity,
      displayValue: issue.displayValue,
      impactMs: issue.impactMs,
      impactBytes: issue.impactBytes,
    }));
  return { fields, issues };
}

async function pauseForQuota(sweepId: string, now: Date) {
  const resumeAt = nextQuotaReset(now).toISOString();
  await PageSpeedRepository.updateSweep(sweepId, {
    status: "waiting_quota",
    resumeAt,
  });
  return { state: "quota" as const, resumeAt };
}

async function refreshCounts(sweepId: string, patch = {}) {
  const counts = await PageSpeedRepository.countResultsByStatus(sweepId);
  await PageSpeedRepository.updateSweep(sweepId, {
    urlsDone: counts.done,
    urlsFailed: counts.failed,
    heartbeatAt: new Date().toISOString(),
    ...patch,
  });
  return counts;
}

async function completeSweep(sweep: PageSpeedSweepRow, now: Date) {
  await refreshCounts(sweep.id, {
    status: "completed",
    completedAt: now.toISOString(),
    resumeAt: null,
  });
  const keep = await PageSpeedRepository.listCompletedSweeps(
    sweep.projectId,
    PAGESPEED_KEEP_COMPLETED_SWEEPS,
  );
  await PageSpeedRepository.deleteCompletedSweepsExcept(
    sweep.projectId,
    keep.map((kept) => kept.id),
  );
}

/** Workflow step: test the next batch of pending URLs within the daily quota.
 *  A page PageSpeed can't test is stored as failed and the batch moves on;
 *  rate and quota limits leave the page pending and pause the sweep. */
async function processBatch(
  sweepId: string,
  attempt: number,
  now = new Date(),
): Promise<PageSpeedBatchOutcome> {
  const sweep = await PageSpeedRepository.getSweep(sweepId);
  if (
    !sweep ||
    sweep.status === "completed" ||
    sweep.status === "failed" ||
    // A relaunch superseded this instance; let the new one drive the sweep.
    sweep.attempt !== attempt
  ) {
    return { state: "done" };
  }
  const day = quotaDay(now);
  const remaining = dailyRemaining(
    await PageSpeedRepository.getUsage(day),
    PAGESPEED_DAILY_BUDGET,
  );
  if (remaining === 0) return pauseForQuota(sweepId, now);

  const pending = await PageSpeedRepository.nextPendingResults(
    sweepId,
    Math.min(PAGESPEED_BATCH_SIZE, remaining),
  );
  if (pending.length === 0) {
    await completeSweep(sweep, now);
    return { state: "done" };
  }

  // Reserve quota up front so concurrent sweeps on the same key see it.
  await PageSpeedRepository.addUsage(day, pending.length);
  const apiKey = await getApiKey();
  let hitDailyQuota = false;
  let hitRateLimit = false;
  let processed = 0;
  let next = 0;
  const worker = async () => {
    while (!hitDailyQuota && !hitRateLimit && next < pending.length) {
      const row = pending[next++];
      if (!row) break;
      const fetchedAt = new Date().toISOString();
      try {
        const result = await runPageSpeedInsights({
          url: row.url,
          strategy: "mobile",
          apiKey,
        });
        const { fields, issues } = toStoredResult(result, fetchedAt);
        await PageSpeedRepository.saveResult(row.id, fields, issues);
        processed++;
      } catch (error) {
        if (error instanceof PageSpeedApiError && error.status === 429) {
          if (isPageSpeedDailyQuotaError(error)) hitDailyQuota = true;
          else hitRateLimit = true;
          continue;
        }
        const message =
          error instanceof Error ? error.message : "PageSpeed run failed";
        await PageSpeedRepository.failResult(row.id, message, fetchedAt);
        processed++;
      }
    }
  };
  await Promise.all(
    Array.from({ length: PAGESPEED_BATCH_CONCURRENCY }, worker),
  );
  await refreshCounts(sweepId);

  if (hitDailyQuota) {
    await PageSpeedRepository.markUsageExhausted(day, PAGESPEED_DAILY_BUDGET);
    return pauseForQuota(sweepId, now);
  }
  if (hitRateLimit) {
    return { state: "rate_limited", processed, waitMs: RATE_LIMIT_BACKOFF_MS };
  }
  return { state: "continue", processed };
}

/** Out of workflow steps with work left: park it for the cron to relaunch. */
async function yieldSweep(sweepId: string) {
  await PageSpeedRepository.updateSweep(sweepId, {
    status: "waiting_quota",
    resumeAt: new Date().toISOString(),
  });
}

async function failSweep(sweepId: string, error: unknown) {
  await PageSpeedRepository.updateSweep(sweepId, {
    status: "failed",
    error: (error instanceof Error ? error.message : String(error)).slice(
      0,
      500,
    ),
    completedAt: new Date().toISOString(),
  });
}

export const PageSpeedSweepService = {
  queueSweep,
  startQueuedSweeps,
  prepareSweep,
  processBatch,
  yieldSweep,
  failSweep,
} as const;

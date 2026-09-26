import { chunk } from "remeda";
import { runBatch } from "@/db/runBatch";
import { GscService } from "@/server/features/gsc/services/GscService";
import { SeoChangeRepository } from "@/server/features/seo-changes/repositories/SeoChangeRepository";
import {
  metricsByDevice,
  targetFilter,
} from "@/server/features/seo-changes/seoChangeMeasurement";
import { GscNotConnectedError, GscTokenError } from "@/server/lib/gscErrors";
import type { SeoChangeTargetKind } from "@/shared/seo-changes";
import type { SeoChangeTarget } from "@/types/schemas/seoChanges";

// Taking Search Console measurements for change-log checkpoints: once when a
// change is logged (the baseline), from the cron as post-change windows
// settle, and inline when an impact read finds a window that is due.

// A failed measurement retries daily. Two weeks covers a Search Console
// connection that was missing or expired when the change was logged; the
// baseline window's data stays available for 16 months.
const MAX_MEASURE_ATTEMPTS = 14;
const RETRY_DELAY_MS = 24 * 60 * 60 * 1000;
// Search Console calls made at once while measuring one checkpoint.
const GSC_CONCURRENCY = 5;
// Checkpoints measured per cron tick. Each costs targets + 1 GSC calls.
const DUE_BATCH_SIZE = 50;
// Kept short: this runs ahead of the rank checks on the same 5-minute tick.
const TICK_DEADLINE_MS = 60_000;

type CheckpointRow = Awaited<
  ReturnType<typeof SeoChangeRepository.listCheckpoints>
>[number];

function describeMeasureError(error: unknown): string {
  if (error instanceof GscNotConnectedError) {
    return "Search Console is not connected for this project. Connect it and the measurement retries daily.";
  }
  if (error instanceof GscTokenError) {
    return "The Search Console connection has expired or was revoked. Reconnect it and the measurement retries daily.";
  }
  return error instanceof Error ? error.message : String(error);
}

async function fetchDeviceMetrics(
  projectId: string,
  windowStart: string,
  windowEnd: string,
  target: { kind: SeoChangeTargetKind; value: string } | null,
) {
  const { rows } = await GscService.getPerformance({
    projectId,
    startDate: windowStart,
    endDate: windowEnd,
    dimensions: ["device"],
    filters: target ? [targetFilter(target)] : undefined,
  });
  return metricsByDevice(rows);
}

/**
 * Measure one pending checkpoint and store the result. Claims the row first so
 * a cron tick and an inline impact read can't both measure it. Failures are
 * recorded on the row and retried daily; they never throw to the caller.
 */
export async function measureCheckpoint(
  projectId: string,
  checkpoint: CheckpointRow,
  targets: SeoChangeTarget[],
): Promise<"measured" | "failed" | "not_claimed"> {
  const claimed = await SeoChangeRepository.claimCheckpoint(
    checkpoint.id,
    checkpoint.attempts,
  );
  if (!claimed) return "not_claimed";

  try {
    // The whole site over the same window (target null) is measured with the
    // targets: it is what separates a change's effect from a sitewide trend.
    const scopes: (SeoChangeTarget | null)[] = [null, ...targets];
    const measured: {
      targetId: string | null;
      devices: Awaited<ReturnType<typeof fetchDeviceMetrics>>;
    }[] = [];
    for (const batch of chunk(scopes, GSC_CONCURRENCY)) {
      measured.push(
        ...(await Promise.all(
          batch.map(async (target) => ({
            targetId: target?.id ?? null,
            devices: await fetchDeviceMetrics(
              projectId,
              checkpoint.windowStart,
              checkpoint.windowEnd,
              target,
            ),
          })),
        )),
      );
    }

    const now = new Date().toISOString();
    await runBatch((tx) => [
      ...measured.flatMap((scope) =>
        scope.devices.map(({ device, metrics }) =>
          SeoChangeRepository.insertMetric(tx, {
            id: crypto.randomUUID(),
            checkpointId: checkpoint.id,
            targetId: scope.targetId,
            device,
            clicks: metrics.clicks,
            impressions: metrics.impressions,
            ctr: metrics.ctr,
            position: metrics.position,
          }),
        ),
      ),
      SeoChangeRepository.markCheckpointMeasured(tx, checkpoint.id, now),
    ]);
    return "measured";
  } catch (error) {
    const attempts = checkpoint.attempts + 1;
    const expected =
      error instanceof GscNotConnectedError || error instanceof GscTokenError;
    if (!expected) {
      console.error("[seo-changes] checkpoint measurement failed", {
        checkpointId: checkpoint.id,
        attempts,
        error,
      });
    }
    await SeoChangeRepository.recordCheckpointFailure({
      checkpointId: checkpoint.id,
      error: describeMeasureError(error),
      retryAt:
        attempts < MAX_MEASURE_ATTEMPTS
          ? new Date(Date.now() + RETRY_DELAY_MS).toISOString()
          : null,
    });
    return "failed";
  }
}

export async function measureDueCheckpoints(
  projectId: string,
  checkpoints: CheckpointRow[],
  targets: SeoChangeTarget[],
): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const due = checkpoints.filter(
    (checkpoint) =>
      checkpoint.status === "pending" && checkpoint.dueAt <= nowIso,
  );
  for (const checkpoint of due) {
    await measureCheckpoint(projectId, checkpoint, targets);
  }
  return due.length > 0;
}

/**
 * Cron body: measure every checkpoint whose window has settled. Wrapped in
 * `withPgClient` at the entrypoint. Stopping early is safe — unmeasured rows
 * stay due and the next tick picks them up oldest-first.
 */
export async function runDueChangeMeasurements(): Promise<void> {
  const due = await SeoChangeRepository.listDueCheckpoints(
    new Date().toISOString(),
    DUE_BATCH_SIZE,
  );
  if (due.length === 0) return;

  const deadline = Date.now() + TICK_DEADLINE_MS;
  const counts = { measured: 0, failed: 0, notClaimed: 0, errors: 0 };
  let stoppedByDeadline = false;
  const targetsByChange = new Map<string, SeoChangeTarget[]>();
  const targetRows = await SeoChangeRepository.listTargets([
    ...new Set(due.map((row) => row.checkpoint.changeId)),
  ]);
  for (const target of targetRows) {
    const list = targetsByChange.get(target.changeId) ?? [];
    list.push({ id: target.id, kind: target.kind, value: target.value });
    targetsByChange.set(target.changeId, list);
  }

  for (const { checkpoint, projectId } of due) {
    if (Date.now() >= deadline) {
      stoppedByDeadline = true;
      break;
    }
    // One bad row must not starve the rest of the tick.
    try {
      const outcome = await measureCheckpoint(
        projectId,
        checkpoint,
        targetsByChange.get(checkpoint.changeId) ?? [],
      );
      if (outcome === "measured") counts.measured++;
      else if (outcome === "failed") counts.failed++;
      else counts.notClaimed++;
    } catch (error) {
      counts.errors++;
      console.error("[seo-changes] checkpoint tick error", {
        checkpointId: checkpoint.id,
        error,
      });
    }
  }

  const summary = { due: due.length, ...counts, stoppedByDeadline };
  if (counts.errors > 0) {
    console.error("[cron] SEO change measurements", summary);
  } else {
    console.log("[cron] SEO change measurements", summary);
  }
}

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { withPgClient } from "@/db";
import { pgStep } from "@/server/workflows/pgStep";
import {
  GscIndexService,
  SWEEP_BATCH_SIZE,
} from "@/server/features/gsc/services/GscIndexService";
import {
  minuteWaitMs,
  type InspectionBurst,
} from "@/server/features/gsc/inspectionQuota";

type IndexSweepParams = { sweepId: string };

const STEP_CONFIG = {
  retries: {
    limit: 2,
    delay: "30 seconds" as const,
    backoff: "exponential" as const,
  },
  timeout: "10 minutes" as const,
};

// Workflow instances have a step budget; a sweep that outlives it pauses as
// waiting_quota and the cron relaunches it with a fresh instance. 300 steps is
// several quota days of batches plus their sleeps.
const MAX_LOOP_STEPS = 300;
// A quota pause longer than this ends the instance instead of sleeping, so a
// sweep doesn't hold a workflow open for days; the cron resumes it.
const MAX_QUOTA_SLEEP_MS = 26 * 3600_000;

/** Inspects a project's URL set with the URL Inspection API, one batch per
 *  step. All progress is on the URL rows, so a retried step or a relaunched
 *  instance resumes where the last one stopped. */
export class IndexSweepWorkflow extends WorkflowEntrypoint<
  Env,
  IndexSweepParams
> {
  async run(event: WorkflowEvent<IndexSweepParams>, step: WorkflowStep) {
    const { sweepId } = event.payload;
    try {
      const { pending } = await pgStep(step, "prepare", STEP_CONFIG, () =>
        GscIndexService.prepareSweep(sweepId),
      );
      if (pending === 0) {
        await pgStep(step, "finish-empty", STEP_CONFIG, async () => {
          await GscIndexService.processBatch(sweepId);
          return null;
        });
        return;
      }

      // Recent bursts for the per-minute budget. Rebuilt deterministically on
      // replay because each burst's timestamp comes from a step result.
      const bursts: InspectionBurst[] = [];
      for (let i = 0; i < MAX_LOOP_STEPS; i++) {
        const lastAt = bursts.at(-1)?.at ?? 0;
        const wait = minuteWaitMs(bursts, lastAt, SWEEP_BATCH_SIZE);
        if (wait > 0) await step.sleep(`minute-budget-${i}`, wait);

        const outcome = await pgStep(
          step,
          `batch-${i}`,
          STEP_CONFIG,
          async () => {
            const result = await GscIndexService.processBatch(sweepId);
            return { ...result, at: Date.now() };
          },
        );
        console.log(
          `[gsc-sweep] ${sweepId} batch ${i}: ${outcome.state}${"inspected" in outcome ? ` inspected=${outcome.inspected}` : ""}`,
        );
        if (outcome.state === "done") return;
        if (outcome.state === "continue") {
          bursts.push({ at: outcome.at, count: outcome.inspected });
          continue;
        }
        if (outcome.state === "rate_limited") {
          bursts.push({ at: outcome.at, count: outcome.inspected });
          await step.sleep(`rate-limit-${i}`, outcome.waitMs);
          continue;
        }
        // Daily quota spent: sleep to the reset when it's close, else leave
        // the sweep paused for the cron.
        const sleepMs = Date.parse(outcome.resumeAt) - outcome.at;
        if (sleepMs > MAX_QUOTA_SLEEP_MS) return;
        await step.sleep(`quota-reset-${i}`, Math.max(sleepMs, 1_000) + 60_000);
        bursts.length = 0;
      }
      // Out of steps with work left: park the sweep for the cron to relaunch.
      await pgStep(step, "yield", STEP_CONFIG, async () => {
        await GscIndexService.yieldSweep(sweepId);
        return null;
      });
    } catch (error) {
      await withPgClient(() => GscIndexService.failSweep(sweepId, error));
      throw error;
    }
  }
}

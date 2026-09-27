import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { withPgClient } from "@/db";
import { pgStep } from "@/server/workflows/pgStep";
import { PageSpeedSweepService } from "@/server/features/pagespeed/services/PageSpeedSweepService";
import {
  minuteWaitMs,
  type InspectionBurst,
} from "@/server/features/gsc/inspectionQuota";
import {
  PAGESPEED_BATCH_SIZE,
  PAGESPEED_MINUTE_BUDGET,
} from "@/shared/pagespeed";

type PageSpeedSweepParams = { sweepId: string; attempt: number };

const STEP_CONFIG = {
  retries: {
    limit: 2,
    delay: "30 seconds" as const,
    backoff: "exponential" as const,
  },
  timeout: "10 minutes" as const,
};

// Workflow instances have a step budget; a sweep that outlives it is parked
// and the cron relaunches it with a fresh instance.
const MAX_LOOP_STEPS = 300;

/** Runs mobile PageSpeed Insights on every sitemap URL of a site, one batch
 *  per step. All progress is on the result rows, so a retried step or a
 *  relaunched instance resumes where the last one stopped. When the daily
 *  quota is spent the instance ends and the cron relaunches it after the
 *  reset. */
export class PageSpeedSweepWorkflow extends WorkflowEntrypoint<
  Env,
  PageSpeedSweepParams
> {
  async run(event: WorkflowEvent<PageSpeedSweepParams>, step: WorkflowStep) {
    const { sweepId, attempt } = event.payload;
    try {
      await pgStep(step, "prepare", STEP_CONFIG, () =>
        PageSpeedSweepService.prepareSweep(sweepId),
      );

      // Recent bursts for the per-minute budget. Rebuilt deterministically on
      // replay because each burst's timestamp comes from a step result.
      const bursts: InspectionBurst[] = [];
      for (let i = 0; i < MAX_LOOP_STEPS; i++) {
        const lastAt = bursts.at(-1)?.at ?? 0;
        const wait = minuteWaitMs(
          bursts,
          lastAt,
          PAGESPEED_BATCH_SIZE,
          PAGESPEED_MINUTE_BUDGET,
        );
        if (wait > 0) await step.sleep(`minute-budget-${i}`, wait);

        const outcome = await pgStep(
          step,
          `batch-${i}`,
          STEP_CONFIG,
          async () => {
            const result = await PageSpeedSweepService.processBatch(
              sweepId,
              attempt,
            );
            return { ...result, at: Date.now() };
          },
        );
        console.log(
          `[pagespeed-sweep] ${sweepId} batch ${i}: ${outcome.state}${"processed" in outcome ? ` processed=${outcome.processed}` : ""}`,
        );
        if (outcome.state === "done" || outcome.state === "quota") return;
        bursts.push({ at: outcome.at, count: outcome.processed });
        if (outcome.state === "rate_limited") {
          await step.sleep(`rate-limit-${i}`, outcome.waitMs);
        }
      }
      await pgStep(step, "yield", STEP_CONFIG, async () => {
        await PageSpeedSweepService.yieldSweep(sweepId);
        return null;
      });
    } catch (error) {
      await withPgClient(() => PageSpeedSweepService.failSweep(sweepId, error));
      throw error;
    }
  }
}

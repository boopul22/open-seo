import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import { AuditScheduleRepository } from "@/server/features/audit/repositories/AuditScheduleRepository";
import { AUDIT_LIMITS } from "@/server/features/audit/services/audit-capacity";
import { AuditService } from "@/server/features/audit/services/AuditService";
import { PageSpeedSweepService } from "@/server/features/pagespeed/services/PageSpeedSweepService";
import { AppError } from "@/server/lib/errors";

export const SCHEDULED_AUDIT_DEFAULT_PAGES = 500;
const SCHEDULED_AUDIT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

// Starts admitted per tick. Each start is a workflow the audit worker runs in
// the background, so this only bounds how many crawls begin at once; the rest
// stay due for the next tick.
const MAX_STARTS_PER_TICK = 5;
const TICK_DEADLINE_MS = 2 * 60_000;

// Cron body (the hourly "7 * * * *" trigger, which the Docker entrypoint also
// fires): start a crawl for every due weekly audit schedule. Wrapped in
// `withPgClient` at the entrypoint (server.ts).
export async function runScheduledAudits() {
  const now = new Date();
  const due = await AuditScheduleRepository.getDue(
    now.toISOString(),
    MAX_STARTS_PER_TICK,
  );
  const deadline = Date.now() + TICK_DEADLINE_MS;
  const summary = { due: due.length, started: 0, skipped: 0, errors: 0 };

  for (const schedule of due) {
    if (Date.now() >= deadline) break;
    try {
      // A crawl still running from last week: try again next tick rather than
      // stacking a second one or losing a week.
      const last = schedule.lastAuditId
        ? await AuditRepository.getAuditForProject(
            schedule.lastAuditId,
            schedule.projectId,
          )
        : undefined;
      if (last?.status === "running") {
        await AuditScheduleRepository.recordSkip(
          schedule.id,
          "previous_still_running",
        );
        summary.skipped++;
        continue;
      }

      const claimed = await AuditScheduleRepository.claimRun({
        id: schedule.id,
        observedNextRunAt: schedule.nextRunAt,
        nextRunAt: new Date(
          now.getTime() + SCHEDULED_AUDIT_INTERVAL_MS,
        ).toISOString(),
      });
      if (!claimed) continue;

      const billingCustomer = {
        userId: schedule.createdByUserId,
        userEmail: schedule.userEmail,
        organizationId: schedule.organizationId,
        projectId: schedule.projectId,
      };
      let auditId: string;
      try {
        const limitTier =
          await AuditService.resolveAuditLimitTier(billingCustomer);
        // Keep the last two scheduled audits: drop the one before last so
        // the schedule never grows the org's audit capacity.
        if (schedule.previousAuditId) {
          await AuditService.remove(
            schedule.previousAuditId,
            schedule.projectId,
          ).catch((error: unknown) => {
            if (!(error instanceof AppError && error.code === "NOT_FOUND")) {
              throw error;
            }
          });
        }
        ({ auditId } = await AuditService.startAudit({
          actorUserId: schedule.createdByUserId,
          billingCustomer,
          projectId: schedule.projectId,
          startUrl: schedule.startUrl,
          maxPages: Math.min(
            schedule.maxPages,
            AUDIT_LIMITS[limitTier].maxPagesPerAudit,
          ),
          lighthouseStrategy: "none",
          limitTier,
        }));
      } catch (error) {
        // Plan limits and the like: recorded for get_scheduled_audit_report,
        // retried next week (the claim already advanced next_run_at).
        if (!(error instanceof AppError)) throw error;
        await AuditScheduleRepository.recordSkip(schedule.id, error.code);
        summary.skipped++;
        continue;
      }

      // Every sitemap URL gets a mobile PageSpeed run alongside the crawl;
      // the cron starts queued sweeps a few at a time.
      await PageSpeedSweepService.queueSweep(
        schedule.projectId,
        schedule.startUrl,
      );
      await AuditScheduleRepository.recordRun({
        id: schedule.id,
        lastRunAt: now.toISOString(),
        lastAuditId: auditId,
        previousAuditId: last ? last.id : null,
      });
      summary.started++;
    } catch (error) {
      summary.errors++;
      await AuditScheduleRepository.recordSkip(
        schedule.id,
        "start_failed",
      ).catch(() => {});
      console.error(
        `[cron] Scheduled audit ${schedule.id} failed to start:`,
        error,
      );
    }
  }

  if (summary.due > 0) console.log("[cron] Scheduled audits", summary);
  return summary;
}

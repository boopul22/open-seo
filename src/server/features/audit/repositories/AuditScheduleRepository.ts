/**
 * Data access for weekly audit schedules (audit_schedules). Provider-aware
 * (D1 or Postgres) via the `@/db` handle.
 */
import { and, asc, eq, isNull, lte } from "drizzle-orm";
import { db } from "@/db";
import { auditSchedules, projects, user } from "@/db/schema";

async function getForProject(projectId: string) {
  return db.query.auditSchedules.findFirst({
    where: eq(auditSchedules.projectId, projectId),
  });
}

async function upsertForProject(input: {
  projectId: string;
  startUrl: string;
  maxPages: number;
  createdByUserId: string;
  nextRunAt: string;
}) {
  await db
    .insert(auditSchedules)
    .values({ id: crypto.randomUUID(), ...input })
    .onConflictDoUpdate({
      target: auditSchedules.projectId,
      set: {
        startUrl: input.startUrl,
        maxPages: input.maxPages,
        createdByUserId: input.createdByUserId,
        nextRunAt: input.nextRunAt,
        lastSkipReason: null,
      },
    });
}

async function deleteForProject(projectId: string) {
  const deleted = await db
    .delete(auditSchedules)
    .where(eq(auditSchedules.projectId, projectId))
    .returning({ id: auditSchedules.id });
  return deleted.length > 0;
}

// Due schedules with the org and the creator's email the audit's billing
// context needs, oldest first so a backlog drains in order.
async function getDue(nowIso: string, limit: number) {
  return db
    .select({
      id: auditSchedules.id,
      projectId: auditSchedules.projectId,
      startUrl: auditSchedules.startUrl,
      maxPages: auditSchedules.maxPages,
      createdByUserId: auditSchedules.createdByUserId,
      nextRunAt: auditSchedules.nextRunAt,
      lastAuditId: auditSchedules.lastAuditId,
      previousAuditId: auditSchedules.previousAuditId,
      organizationId: projects.organizationId,
      userEmail: user.email,
    })
    .from(auditSchedules)
    .innerJoin(projects, eq(auditSchedules.projectId, projects.id))
    .innerJoin(user, eq(auditSchedules.createdByUserId, user.id))
    .where(
      and(lte(auditSchedules.nextRunAt, nowIso), isNull(projects.archivedAt)),
    )
    .orderBy(asc(auditSchedules.nextRunAt), asc(auditSchedules.id))
    .limit(limit);
}

// Compare-and-set on next_run_at so overlapping cron ticks can't both start
// an audit for the same schedule.
async function claimRun(input: {
  id: string;
  observedNextRunAt: string;
  nextRunAt: string;
}) {
  const claimed = await db
    .update(auditSchedules)
    .set({ nextRunAt: input.nextRunAt })
    .where(
      and(
        eq(auditSchedules.id, input.id),
        eq(auditSchedules.nextRunAt, input.observedNextRunAt),
      ),
    )
    .returning({ id: auditSchedules.id });
  return claimed.length > 0;
}

async function recordRun(input: {
  id: string;
  lastRunAt: string;
  lastAuditId: string;
  previousAuditId: string | null;
}) {
  await db
    .update(auditSchedules)
    .set({
      lastRunAt: input.lastRunAt,
      lastAuditId: input.lastAuditId,
      previousAuditId: input.previousAuditId,
      lastSkipReason: null,
    })
    .where(eq(auditSchedules.id, input.id));
}

async function recordSkip(id: string, reason: string) {
  await db
    .update(auditSchedules)
    .set({ lastSkipReason: reason })
    .where(eq(auditSchedules.id, id));
}

export const AuditScheduleRepository = {
  getForProject,
  upsertForProject,
  deleteForProject,
  getDue,
  claimRun,
  recordRun,
  recordSkip,
} as const;

import { and, asc, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { chunk } from "remeda";
import { db } from "@/db";
import type { runBatch } from "@/db/runBatch";
import {
  projects,
  seoChangeCheckpoints,
  seoChangeMetrics,
  seoChanges,
  seoChangeTargets,
} from "@/db/schema";
import type { SeoChangeType } from "@/shared/seo-changes";

// Backing store for the SEO change log. Every change read filters on
// `project_id` as well as `id`: callers authorize the projectId they were
// given, not the row. Targets, checkpoints and metrics are only ever reached
// through a change that passed that filter.
//
// Writes that must land together are statement builders taking a `Tx`, run by
// the service inside one runBatch.

type Tx = Parameters<Parameters<typeof runBatch>[0]>[0];

// D1 caps bound parameters per statement at ~100.
const VALUES_PER_IN = 90;

type ChangeRow = typeof seoChanges.$inferSelect;
type TargetRow = typeof seoChangeTargets.$inferSelect;
type CheckpointRow = typeof seoChangeCheckpoints.$inferSelect;
type MetricRow = typeof seoChangeMetrics.$inferSelect;

function insertChange(tx: Tx, row: typeof seoChanges.$inferInsert) {
  return tx.insert(seoChanges).values(row);
}

function insertTarget(tx: Tx, row: typeof seoChangeTargets.$inferInsert) {
  return tx.insert(seoChangeTargets).values(row);
}

function insertCheckpoint(
  tx: Tx,
  row: typeof seoChangeCheckpoints.$inferInsert,
) {
  return tx.insert(seoChangeCheckpoints).values(row);
}

// One statement per row: a checkpoint can carry 80+ metric rows, and a
// multi-row insert of that size would exceed D1's bound-parameter cap.
function insertMetric(tx: Tx, row: typeof seoChangeMetrics.$inferInsert) {
  return tx.insert(seoChangeMetrics).values(row);
}

function markCheckpointMeasured(tx: Tx, checkpointId: string, now: string) {
  return tx
    .update(seoChangeCheckpoints)
    .set({ status: "measured", measuredAt: now, error: null })
    .where(eq(seoChangeCheckpoints.id, checkpointId));
}

async function listChanges(params: {
  projectId: string;
  type?: SeoChangeType;
  from?: string;
  to?: string;
  limit: number;
}): Promise<ChangeRow[]> {
  return (
    db
      .select()
      .from(seoChanges)
      .where(
        and(
          eq(seoChanges.projectId, params.projectId),
          params.type ? eq(seoChanges.type, params.type) : undefined,
          params.from ? gte(seoChanges.shipDate, params.from) : undefined,
          params.to ? lte(seoChanges.shipDate, params.to) : undefined,
        ),
      )
      // Matches seo_changes_project_ship_date_idx; shippedAt then id make the
      // order total for same-day changes.
      .orderBy(
        desc(seoChanges.shipDate),
        desc(seoChanges.shippedAt),
        desc(seoChanges.id),
      )
      .limit(params.limit)
  );
}

async function getChange(
  projectId: string,
  changeId: string,
): Promise<ChangeRow | null> {
  const [row] = await db
    .select()
    .from(seoChanges)
    .where(
      and(eq(seoChanges.id, changeId), eq(seoChanges.projectId, projectId)),
    )
    .limit(1);
  return row ?? null;
}

async function listTargets(changeIds: string[]): Promise<TargetRow[]> {
  const rows: TargetRow[] = [];
  for (const ids of chunk(changeIds, VALUES_PER_IN)) {
    rows.push(
      ...(await db
        .select()
        .from(seoChangeTargets)
        .where(inArray(seoChangeTargets.changeId, ids))
        .orderBy(asc(seoChangeTargets.kind), asc(seoChangeTargets.value))),
    );
  }
  return rows;
}

async function listCheckpoints(changeId: string): Promise<CheckpointRow[]> {
  return db
    .select()
    .from(seoChangeCheckpoints)
    .where(eq(seoChangeCheckpoints.changeId, changeId))
    .orderBy(asc(seoChangeCheckpoints.dueAt));
}

async function listMetrics(checkpointIds: string[]): Promise<MetricRow[]> {
  if (checkpointIds.length === 0) return [];
  return db
    .select()
    .from(seoChangeMetrics)
    .where(inArray(seoChangeMetrics.checkpointId, checkpointIds));
}

/** Pending checkpoints whose window has settled, oldest due first, with the
 *  owning project so the caller can reach its Search Console connection. */
async function listDueCheckpoints(nowIso: string, limit: number) {
  return (
    db
      .select({
        checkpoint: seoChangeCheckpoints,
        projectId: seoChanges.projectId,
      })
      .from(seoChangeCheckpoints)
      .innerJoin(seoChanges, eq(seoChanges.id, seoChangeCheckpoints.changeId))
      // Archived projects stop being measured; their checkpoints stay pending.
      .innerJoin(projects, eq(projects.id, seoChanges.projectId))
      .where(
        and(
          eq(seoChangeCheckpoints.status, "pending"),
          lte(seoChangeCheckpoints.dueAt, nowIso),
          isNull(projects.archivedAt),
        ),
      )
      .orderBy(asc(seoChangeCheckpoints.dueAt))
      .limit(limit)
  );
}

/**
 * Compare-and-swap claim on a pending checkpoint: bumps `attempts` only if no
 * other tick (or an impact read measuring inline) got there first, so one
 * window is never measured twice concurrently.
 */
async function claimCheckpoint(
  checkpointId: string,
  observedAttempts: number,
): Promise<boolean> {
  const claimed = await db
    .update(seoChangeCheckpoints)
    .set({ attempts: observedAttempts + 1 })
    .where(
      and(
        eq(seoChangeCheckpoints.id, checkpointId),
        eq(seoChangeCheckpoints.status, "pending"),
        eq(seoChangeCheckpoints.attempts, observedAttempts),
      ),
    )
    .returning({ id: seoChangeCheckpoints.id });
  return claimed.length > 0;
}

async function recordCheckpointFailure(params: {
  checkpointId: string;
  error: string;
  /** Next retry, or null to give up and mark the checkpoint failed. */
  retryAt: string | null;
}): Promise<void> {
  await db
    .update(seoChangeCheckpoints)
    .set(
      params.retryAt
        ? { error: params.error, dueAt: params.retryAt }
        : { error: params.error, status: "failed" },
    )
    .where(eq(seoChangeCheckpoints.id, params.checkpointId));
}

async function updateChange(
  projectId: string,
  changeId: string,
  values: Partial<
    Pick<
      ChangeRow,
      | "summary"
      | "notes"
      | "status"
      | "revertedAt"
      | "commitHash"
      | "deployId"
      | "prUrl"
    >
  >,
): Promise<void> {
  await db
    .update(seoChanges)
    .set({ ...values, updatedAt: new Date().toISOString() })
    .where(
      and(eq(seoChanges.id, changeId), eq(seoChanges.projectId, projectId)),
    );
}

/** Skip checkpoints still pending whose window runs past `date`: a revert
 *  inside the window would contaminate the measurement. */
async function skipPendingCheckpointsEndingOnOrAfter(
  changeId: string,
  date: string,
  reason: string,
): Promise<void> {
  await db
    .update(seoChangeCheckpoints)
    .set({ status: "skipped", error: reason })
    .where(
      and(
        eq(seoChangeCheckpoints.changeId, changeId),
        eq(seoChangeCheckpoints.status, "pending"),
        gte(seoChangeCheckpoints.windowEnd, date),
      ),
    );
}

/** Un-reverting brings skipped checkpoints back; the cron measures any that
 *  are already due. */
async function reopenSkippedCheckpoints(changeId: string): Promise<void> {
  await db
    .update(seoChangeCheckpoints)
    .set({ status: "pending", error: null })
    .where(
      and(
        eq(seoChangeCheckpoints.changeId, changeId),
        eq(seoChangeCheckpoints.status, "skipped"),
      ),
    );
}

async function deleteChange(
  projectId: string,
  changeId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(seoChanges)
    .where(
      and(eq(seoChanges.id, changeId), eq(seoChanges.projectId, projectId)),
    )
    .returning({ id: seoChanges.id });
  return deleted.length > 0;
}

export const SeoChangeRepository = {
  insertChange,
  insertTarget,
  insertCheckpoint,
  insertMetric,
  markCheckpointMeasured,
  listChanges,
  getChange,
  listTargets,
  listCheckpoints,
  listMetrics,
  listDueCheckpoints,
  claimCheckpoint,
  recordCheckpointFailure,
  updateChange,
  skipPendingCheckpointsEndingOnOrAfter,
  reopenSkippedCheckpoints,
  deleteChange,
} as const;

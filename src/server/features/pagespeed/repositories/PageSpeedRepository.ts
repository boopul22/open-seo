/**
 * Data access for sitemap-wide PageSpeed sweeps. Provider-aware (D1 or
 * Postgres) via the `@/db` handle.
 */
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  lte,
  notInArray,
  sql,
} from "drizzle-orm";
import { db } from "@/db";
import {
  pagespeedResultIssues,
  pagespeedResults,
  pagespeedSweeps,
  pagespeedUsage,
} from "@/db/schema";
import { executeInBatches, runBatch } from "@/db/runBatch";
import type { PageSpeedSweepStatus } from "@/shared/pagespeed";

export type PageSpeedSweepRow = typeof pagespeedSweeps.$inferSelect;
type ResultFields = Omit<
  typeof pagespeedResults.$inferInsert,
  "id" | "sweepId" | "url" | "status"
>;
export type PageSpeedIssueInput = Omit<
  typeof pagespeedResultIssues.$inferInsert,
  "id" | "resultId"
>;

const ACTIVE_STATUSES: PageSpeedSweepStatus[] = [
  "queued",
  "running",
  "waiting_quota",
];

// ─── Sweeps ──────────────────────────────────────────────────────────────────

/** Insert a queued sweep, or return the project's active one; the partial
 *  unique index makes concurrent callers converge on a single sweep. */
async function createSweep(projectId: string, startUrl: string) {
  const [inserted] = await db
    .insert(pagespeedSweeps)
    .values({ id: crypto.randomUUID(), projectId, startUrl, status: "queued" })
    .onConflictDoNothing()
    .returning({ id: pagespeedSweeps.id });
  if (inserted) return { sweepId: inserted.id, created: true };
  const active = await getActiveSweep(projectId);
  if (!active) throw new Error("Failed to create or find a PageSpeed sweep");
  return { sweepId: active.id, created: false };
}

async function getSweep(id: string) {
  return db.query.pagespeedSweeps.findFirst({
    where: eq(pagespeedSweeps.id, id),
  });
}

async function getActiveSweep(projectId: string) {
  return db.query.pagespeedSweeps.findFirst({
    where: and(
      eq(pagespeedSweeps.projectId, projectId),
      inArray(pagespeedSweeps.status, ACTIVE_STATUSES),
    ),
    orderBy: desc(pagespeedSweeps.createdAt),
  });
}

/** Newest first. */
async function listCompletedSweeps(projectId: string, limit: number) {
  return db.query.pagespeedSweeps.findMany({
    where: and(
      eq(pagespeedSweeps.projectId, projectId),
      eq(pagespeedSweeps.status, "completed"),
    ),
    orderBy: desc(pagespeedSweeps.completedAt),
    limit,
  });
}

async function updateSweep(
  id: string,
  patch: Partial<typeof pagespeedSweeps.$inferInsert>,
) {
  await db.update(pagespeedSweeps).set(patch).where(eq(pagespeedSweeps.id, id));
}

async function countSweepsByStatus(statuses: PageSpeedSweepStatus[]) {
  const [row] = await db
    .select({ n: count() })
    .from(pagespeedSweeps)
    .where(inArray(pagespeedSweeps.status, statuses));
  return row?.n ?? 0;
}

async function listSweepsByStatus(status: PageSpeedSweepStatus, limit: number) {
  return db.query.pagespeedSweeps.findMany({
    where: eq(pagespeedSweeps.status, status),
    orderBy: asc(pagespeedSweeps.createdAt),
    limit,
  });
}

/** Quota-paused sweeps whose reset time has passed, oldest first. */
async function listResumableSweeps(nowIso: string, limit: number) {
  if (limit <= 0) return [];
  return db.query.pagespeedSweeps.findMany({
    where: and(
      eq(pagespeedSweeps.status, "waiting_quota"),
      lte(pagespeedSweeps.resumeAt, nowIso),
    ),
    orderBy: asc(pagespeedSweeps.createdAt),
    limit,
  });
}

/** Running sweeps with no batch progress since `beforeIso`: their workflow
 *  instance died. */
async function listStalledSweeps(beforeIso: string) {
  return db.query.pagespeedSweeps.findMany({
    where: and(
      eq(pagespeedSweeps.status, "running"),
      lte(pagespeedSweeps.heartbeatAt, beforeIso),
    ),
  });
}

/** Keep the given completed sweeps (and any active one); delete the rest. */
async function deleteCompletedSweepsExcept(
  projectId: string,
  keepIds: string[],
) {
  await db
    .delete(pagespeedSweeps)
    .where(
      and(
        eq(pagespeedSweeps.projectId, projectId),
        eq(pagespeedSweeps.status, "completed"),
        keepIds.length > 0
          ? notInArray(pagespeedSweeps.id, keepIds)
          : undefined,
      ),
    );
}

// ─── Results ─────────────────────────────────────────────────────────────────

async function insertPendingUrls(sweepId: string, urls: string[]) {
  await executeInBatches(urls, (tx, url) =>
    tx
      .insert(pagespeedResults)
      .values({ id: crypto.randomUUID(), sweepId, url })
      .onConflictDoNothing(),
  );
}

async function nextPendingResults(sweepId: string, limit: number) {
  return db
    .select({ id: pagespeedResults.id, url: pagespeedResults.url })
    .from(pagespeedResults)
    .where(
      and(
        eq(pagespeedResults.sweepId, sweepId),
        eq(pagespeedResults.status, "pending"),
      ),
    )
    .orderBy(asc(pagespeedResults.url))
    .limit(limit);
}

async function saveResult(
  resultId: string,
  fields: ResultFields,
  issues: PageSpeedIssueInput[],
) {
  await runBatch((tx) => [
    // A replayed step may save the same result twice.
    tx
      .delete(pagespeedResultIssues)
      .where(eq(pagespeedResultIssues.resultId, resultId)),
    tx
      .update(pagespeedResults)
      .set({ ...fields, status: "done", error: null })
      .where(eq(pagespeedResults.id, resultId)),
    ...issues.map((issue) =>
      tx
        .insert(pagespeedResultIssues)
        .values({ id: crypto.randomUUID(), resultId, ...issue }),
    ),
  ]);
}

async function failResult(resultId: string, error: string, fetchedAt: string) {
  await db
    .update(pagespeedResults)
    .set({ status: "failed", error: error.slice(0, 500), fetchedAt })
    .where(eq(pagespeedResults.id, resultId));
}

async function countResultsByStatus(sweepId: string) {
  const rows = await db
    .select({ status: pagespeedResults.status, n: count() })
    .from(pagespeedResults)
    .where(eq(pagespeedResults.sweepId, sweepId))
    .groupBy(pagespeedResults.status);
  const counts = { pending: 0, done: 0, failed: 0 };
  for (const row of rows) counts[row.status] = row.n;
  return counts;
}

/** Every finished row of a sweep, for site-wide summaries. */
async function listDoneResults(sweepId: string) {
  return db.query.pagespeedResults.findMany({
    where: and(
      eq(pagespeedResults.sweepId, sweepId),
      eq(pagespeedResults.status, "done"),
    ),
  });
}

async function listFailedResults(sweepId: string, limit: number) {
  return db
    .select({ url: pagespeedResults.url, error: pagespeedResults.error })
    .from(pagespeedResults)
    .where(
      and(
        eq(pagespeedResults.sweepId, sweepId),
        eq(pagespeedResults.status, "failed"),
      ),
    )
    .limit(limit);
}

async function getResultByUrl(sweepId: string, url: string) {
  return db.query.pagespeedResults.findFirst({
    where: and(
      eq(pagespeedResults.sweepId, sweepId),
      eq(pagespeedResults.url, url),
    ),
  });
}

async function listIssuesForResult(resultId: string) {
  return db.query.pagespeedResultIssues.findMany({
    where: eq(pagespeedResultIssues.resultId, resultId),
  });
}

/** How many pages each failing audit affects across a sweep. */
async function countIssuesByAudit(sweepId: string) {
  return db
    .select({
      auditKey: pagespeedResultIssues.auditKey,
      title: sql<string>`max(${pagespeedResultIssues.title})`,
      category: sql<string>`max(${pagespeedResultIssues.category})`,
      pages: count(),
      criticalPages: sql<number>`sum(case when ${pagespeedResultIssues.severity} = 'critical' then 1 else 0 end)`,
      totalImpactMs: sql<number>`coalesce(sum(${pagespeedResultIssues.impactMs}), 0)`,
    })
    .from(pagespeedResultIssues)
    .innerJoin(
      pagespeedResults,
      eq(pagespeedResultIssues.resultId, pagespeedResults.id),
    )
    .where(eq(pagespeedResults.sweepId, sweepId))
    .groupBy(pagespeedResultIssues.auditKey);
}

/** URLs of a sweep affected by one audit. */
async function listUrlsWithAudit(sweepId: string, auditKey: string) {
  const rows = await db
    .select({ url: pagespeedResults.url })
    .from(pagespeedResultIssues)
    .innerJoin(
      pagespeedResults,
      eq(pagespeedResultIssues.resultId, pagespeedResults.id),
    )
    .where(
      and(
        eq(pagespeedResults.sweepId, sweepId),
        eq(pagespeedResultIssues.auditKey, auditKey),
      ),
    );
  return rows.map((row) => row.url);
}

// ─── Quota ───────────────────────────────────────────────────────────────────

async function getUsage(day: string) {
  const row = await db.query.pagespeedUsage.findFirst({
    where: eq(pagespeedUsage.day, day),
  });
  return row?.used ?? 0;
}

/** Atomically add `n` calls to the quota day; returns the new total. */
async function addUsage(day: string, n: number) {
  const [row] = await db
    .insert(pagespeedUsage)
    .values({ day, used: n })
    .onConflictDoUpdate({
      target: pagespeedUsage.day,
      set: { used: sql`${pagespeedUsage.used} + ${n}` },
    })
    .returning({ used: pagespeedUsage.used });
  return row?.used ?? n;
}

/** Google said the day is spent; pin the count so sweeps stop asking. */
async function markUsageExhausted(day: string, limit: number) {
  await db
    .insert(pagespeedUsage)
    .values({ day, used: limit })
    .onConflictDoUpdate({ target: pagespeedUsage.day, set: { used: limit } });
}

export const PageSpeedRepository = {
  createSweep,
  getSweep,
  getActiveSweep,
  listCompletedSweeps,
  updateSweep,
  countSweepsByStatus,
  listSweepsByStatus,
  listResumableSweeps,
  listStalledSweeps,
  deleteCompletedSweepsExcept,
  insertPendingUrls,
  nextPendingResults,
  saveResult,
  failResult,
  countResultsByStatus,
  listDoneResults,
  listFailedResults,
  getResultByUrl,
  listIssuesForResult,
  countIssuesByAudit,
  listUrlsWithAudit,
  getUsage,
  addUsage,
  markUsageExhausted,
} as const;

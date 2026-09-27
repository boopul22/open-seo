/* eslint-disable max-lines */
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { db } from "@/db";
import { executeInBatches, runBatch } from "@/db/runBatch";
import {
  gscConnections,
  gscIndexSweeps,
  gscIndexUrls,
  gscInspectionUsage,
  gscSitemapContents,
  gscSitemaps,
  gscUrlInspectionLinks,
  gscUrlInspections,
  gscUrlRichResultIssues,
} from "@/db/schema";
import type { CoverageGroupRow, RichResultIssueRow } from "../indexCoverage";
import {
  GSC_ACTIVE_SWEEP_STATUSES,
  type GscSweepKind,
  type GscSweepTrigger,
} from "@/shared/gsc-index";

// Every read filters on project_id: callers authorize the projectId they were
// given, and URL/inspection rows are only reached through it.

export type SweepRow = typeof gscIndexSweeps.$inferSelect;
export type SitemapRow = typeof gscSitemaps.$inferSelect;
export type InspectionRow = typeof gscUrlInspections.$inferSelect;
type InspectionInsert = Omit<
  typeof gscUrlInspections.$inferInsert,
  "id" | "urlId"
>;

// ---------------------------------------------------------------------------
// Sitemaps
// ---------------------------------------------------------------------------

export type SitemapSnapshot = {
  sitemap: Omit<typeof gscSitemaps.$inferInsert, "id" | "projectId">;
  contents: Array<{ type: string; submitted: number }>;
};

/** Replace the project's sitemap snapshot with what Google returned now. */
async function replaceSitemaps(
  projectId: string,
  snapshots: SitemapSnapshot[],
): Promise<void> {
  await runBatch((tx) => [
    tx.delete(gscSitemaps).where(eq(gscSitemaps.projectId, projectId)),
    ...snapshots.flatMap(({ sitemap, contents }) => {
      const sitemapId = crypto.randomUUID();
      return [
        tx.insert(gscSitemaps).values({ id: sitemapId, projectId, ...sitemap }),
        ...contents.map((content) =>
          tx.insert(gscSitemapContents).values({
            id: crypto.randomUUID(),
            sitemapId,
            ...content,
          }),
        ),
      ];
    }),
  ]);
}

async function listSitemaps(projectId: string) {
  const sitemaps = await db
    .select()
    .from(gscSitemaps)
    .where(eq(gscSitemaps.projectId, projectId))
    // Each index, then its children, then standalone sitemaps.
    .orderBy(
      sql`coalesce(${gscSitemaps.parentPath}, ${gscSitemaps.path})`,
      sql`case when ${gscSitemaps.parentPath} is null then 0 else 1 end`,
      asc(gscSitemaps.path),
    );
  const contents =
    sitemaps.length === 0
      ? []
      : await db
          .select()
          .from(gscSitemapContents)
          .where(
            inArray(
              gscSitemapContents.sitemapId,
              sitemaps.map((s) => s.id),
            ),
          );
  return sitemaps.map((sitemap) => ({
    ...sitemap,
    contents: contents
      .filter((c) => c.sitemapId === sitemap.id)
      .map((c) => ({ type: c.type, submitted: c.submitted })),
  }));
}

// ---------------------------------------------------------------------------
// URL set
// ---------------------------------------------------------------------------

export type DiscoveredUrl = {
  url: string;
  inSitemap: boolean;
  inSearchAnalytics: boolean;
  impressions: number;
};

/** Record a freshly collected URL set. Membership flags describe the latest
 *  collection, so they are cleared first; URLs that dropped out of both
 *  sources stay (a vanished page is often exactly the 404 worth reporting). */
async function saveCollectedUrls(
  projectId: string,
  urls: DiscoveredUrl[],
): Promise<void> {
  await db
    .update(gscIndexUrls)
    .set({ inSitemap: false, inSearchAnalytics: false, impressions: 0 })
    .where(eq(gscIndexUrls.projectId, projectId));
  await executeInBatches(urls, (tx, item) =>
    tx
      .insert(gscIndexUrls)
      .values({ id: crypto.randomUUID(), projectId, ...item })
      .onConflictDoUpdate({
        target: [gscIndexUrls.projectId, gscIndexUrls.url],
        set: {
          inSitemap: item.inSitemap,
          inSearchAnalytics: item.inSearchAnalytics,
          impressions: item.impressions,
        },
      }),
  );
}

/** Put specific URLs at the front of the queue. */
async function requestUrls(
  projectId: string,
  urls: string[],
  now: string,
): Promise<void> {
  await executeInBatches(urls, (tx, url) =>
    tx
      .insert(gscIndexUrls)
      .values({ id: crypto.randomUUID(), projectId, url, requestedAt: now })
      .onConflictDoUpdate({
        target: [gscIndexUrls.projectId, gscIndexUrls.url],
        set: { requestedAt: now },
      }),
  );
}

// Explicit requests first, then never-inspected URLs, then the stalest
// results, with search impressions breaking ties. CASE keeps NULL ordering
// identical on SQLite (NULLs first) and Postgres (NULLs last).
function pendingFilter(
  projectId: string,
  sweep: { kind: GscSweepKind; createdAt: string },
) {
  const requested = isNotNull(gscIndexUrls.requestedAt);
  return and(
    eq(gscIndexUrls.projectId, projectId),
    sweep.kind === "urls"
      ? requested
      : or(
          requested,
          isNull(gscIndexUrls.lastInspectedAt),
          lt(gscIndexUrls.lastInspectedAt, sweep.createdAt),
        ),
  );
}

async function nextPendingUrls(
  projectId: string,
  sweep: { kind: GscSweepKind; createdAt: string },
  limit: number,
) {
  return db
    .select({
      id: gscIndexUrls.id,
      url: gscIndexUrls.url,
      lastInspectionId: gscIndexUrls.lastInspectionId,
      coverageStateSince: gscIndexUrls.coverageStateSince,
      previousCoverageState: gscUrlInspections.coverageState,
      previousVerdict: gscUrlInspections.verdict,
    })
    .from(gscIndexUrls)
    .leftJoin(
      gscUrlInspections,
      eq(gscUrlInspections.id, gscIndexUrls.lastInspectionId),
    )
    .where(pendingFilter(projectId, sweep))
    .orderBy(
      sql`case when ${gscIndexUrls.requestedAt} is null then 1 else 0 end`,
      sql`case when ${gscIndexUrls.lastInspectedAt} is null then 0 else 1 end`,
      asc(gscIndexUrls.lastInspectedAt),
      desc(gscIndexUrls.impressions),
      asc(gscIndexUrls.url),
    )
    .limit(limit);
}

async function countPendingUrls(
  projectId: string,
  sweep: { kind: GscSweepKind; createdAt: string },
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(gscIndexUrls)
    .where(pendingFilter(projectId, sweep));
  return row?.n ?? 0;
}

async function countUrls(projectId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(gscIndexUrls)
    .where(eq(gscIndexUrls.projectId, projectId));
  return row?.n ?? 0;
}

export type InspectionDetails = {
  inspection: InspectionInsert;
  links: Array<{ kind: "sitemap" | "referring"; url: string }>;
  richResults: Array<{
    richResultType: string;
    itemName: string | null;
    issueMessage: string | null;
    severity: string | null;
  }>;
};

/** Store one inspection attempt and advance the URL's queue position. A
 *  failed attempt keeps the URL's last good result as its current state. */
async function recordInspection(input: {
  url: {
    id: string;
    lastInspectionId: string | null;
    coverageStateSince: string | null;
    previousCoverageState: string | null;
  };
  details: InspectionDetails;
  now: string;
}): Promise<void> {
  const { url, details, now } = input;
  const inspectionId = crypto.randomUUID();
  const succeeded = !details.inspection.error;
  const coverageState = details.inspection.coverageState ?? null;
  const stateChanged =
    succeeded &&
    (url.lastInspectionId === null ||
      url.previousCoverageState !== coverageState);
  await runBatch((tx) => [
    tx
      .insert(gscUrlInspections)
      .values({ id: inspectionId, urlId: url.id, ...details.inspection }),
    ...details.links.map((link) =>
      tx.insert(gscUrlInspectionLinks).values({
        id: crypto.randomUUID(),
        inspectionId,
        ...link,
      }),
    ),
    ...details.richResults.map((item) =>
      tx.insert(gscUrlRichResultIssues).values({
        id: crypto.randomUUID(),
        inspectionId,
        ...item,
      }),
    ),
    tx
      .update(gscIndexUrls)
      .set({
        lastInspectedAt: now,
        requestedAt: null,
        lastInspectionId:
          succeeded || !url.lastInspectionId
            ? inspectionId
            : url.lastInspectionId,
        coverageStateSince: stateChanged ? now : url.coverageStateSince,
      })
      .where(eq(gscIndexUrls.id, url.id)),
  ]);
}

// ---------------------------------------------------------------------------
// Coverage reads
// ---------------------------------------------------------------------------

async function coverageGroups(
  projectId: string,
  newSince: string | null,
): Promise<CoverageGroupRow[]> {
  const newCase = newSince
    ? sql<number>`sum(case when ${gscIndexUrls.coverageStateSince} >= ${newSince} then 1 else 0 end)`
    : sql<number>`0`;
  const rows = await db
    .select({
      verdict: gscUrlInspections.verdict,
      coverageState: gscUrlInspections.coverageState,
      error: gscUrlInspections.error,
      inspected: sql<number>`case when ${gscIndexUrls.lastInspectionId} is null then 0 else 1 end`,
      count: count(),
      newCount: newCase,
    })
    .from(gscIndexUrls)
    .leftJoin(
      gscUrlInspections,
      eq(gscUrlInspections.id, gscIndexUrls.lastInspectionId),
    )
    .where(eq(gscIndexUrls.projectId, projectId))
    .groupBy(
      gscUrlInspections.verdict,
      gscUrlInspections.coverageState,
      gscUrlInspections.error,
      sql`case when ${gscIndexUrls.lastInspectionId} is null then 0 else 1 end`,
    );
  return rows.map((row) => ({
    ...row,
    // Drivers return aggregates as strings or bigints on Postgres.
    inspected: Number(row.inspected) === 1,
    count: Number(row.count),
    newCount: Number(row.newCount ?? 0),
  }));
}

export type UrlListFilter = {
  projectId: string;
  // Exact Google coverage state; null lists never-inspected URLs.
  coverageState?: string | null;
  verdict?: "PASS" | "NOT_PASS";
  errorsOnly?: boolean;
  sinceDate?: string;
  limit: number;
  offset: number;
};

async function listUrls(filter: UrlListFilter) {
  const conditions = and(
    eq(gscIndexUrls.projectId, filter.projectId),
    filter.coverageState === null
      ? isNull(gscIndexUrls.lastInspectionId)
      : filter.coverageState !== undefined
        ? eq(gscUrlInspections.coverageState, filter.coverageState)
        : undefined,
    filter.verdict === "PASS"
      ? eq(gscUrlInspections.verdict, "PASS")
      : filter.verdict === "NOT_PASS"
        ? and(
            isNotNull(gscIndexUrls.lastInspectionId),
            or(
              isNull(gscUrlInspections.verdict),
              sql`${gscUrlInspections.verdict} <> 'PASS'`,
            ),
          )
        : undefined,
    filter.errorsOnly
      ? and(
          isNull(gscUrlInspections.verdict),
          isNotNull(gscUrlInspections.error),
        )
      : undefined,
    filter.sinceDate
      ? sql`${gscIndexUrls.coverageStateSince} >= ${filter.sinceDate}`
      : undefined,
  );
  const rows = await db
    .select({
      url: gscIndexUrls.url,
      inSitemap: gscIndexUrls.inSitemap,
      inSearchAnalytics: gscIndexUrls.inSearchAnalytics,
      impressions: gscIndexUrls.impressions,
      lastInspectedAt: gscIndexUrls.lastInspectedAt,
      coverageStateSince: gscIndexUrls.coverageStateSince,
      inspection: gscUrlInspections,
    })
    .from(gscIndexUrls)
    .leftJoin(
      gscUrlInspections,
      eq(gscUrlInspections.id, gscIndexUrls.lastInspectionId),
    )
    .where(conditions)
    .orderBy(desc(gscIndexUrls.impressions), asc(gscIndexUrls.url))
    .limit(filter.limit + 1)
    .offset(filter.offset);
  return {
    rows: rows.slice(0, filter.limit),
    hasMore: rows.length > filter.limit,
  };
}

async function getUrlDetail(projectId: string, url: string) {
  const [urlRow] = await db
    .select()
    .from(gscIndexUrls)
    .where(
      and(eq(gscIndexUrls.projectId, projectId), eq(gscIndexUrls.url, url)),
    )
    .limit(1);
  if (!urlRow) return null;
  const history = await db
    .select()
    .from(gscUrlInspections)
    .where(eq(gscUrlInspections.urlId, urlRow.id))
    .orderBy(desc(gscUrlInspections.inspectedAt))
    .limit(20);
  const latestId = urlRow.lastInspectionId;
  const [links, richResults] = latestId
    ? await Promise.all([
        db
          .select({
            kind: gscUrlInspectionLinks.kind,
            url: gscUrlInspectionLinks.url,
          })
          .from(gscUrlInspectionLinks)
          .where(eq(gscUrlInspectionLinks.inspectionId, latestId)),
        db
          .select({
            richResultType: gscUrlRichResultIssues.richResultType,
            itemName: gscUrlRichResultIssues.itemName,
            issueMessage: gscUrlRichResultIssues.issueMessage,
            severity: gscUrlRichResultIssues.severity,
          })
          .from(gscUrlRichResultIssues)
          .where(eq(gscUrlRichResultIssues.inspectionId, latestId)),
      ])
    : [[], []];
  return {
    url: urlRow,
    latest: history.find((h) => h.id === latestId) ?? null,
    history,
    links,
    richResults,
  };
}

/** Rich result items on each URL's latest inspection. */
async function richResultRows(
  projectId: string,
): Promise<RichResultIssueRow[]> {
  return db
    .select({
      richResultType: gscUrlRichResultIssues.richResultType,
      issueMessage: gscUrlRichResultIssues.issueMessage,
      severity: gscUrlRichResultIssues.severity,
      url: gscIndexUrls.url,
    })
    .from(gscIndexUrls)
    .innerJoin(
      gscUrlRichResultIssues,
      eq(gscUrlRichResultIssues.inspectionId, gscIndexUrls.lastInspectionId),
    )
    .where(eq(gscIndexUrls.projectId, projectId));
}

// ---------------------------------------------------------------------------
// Sweeps
// ---------------------------------------------------------------------------

const activeStatus = inArray(gscIndexSweeps.status, [
  ...GSC_ACTIVE_SWEEP_STATUSES,
]);

async function getActiveSweep(projectId: string): Promise<SweepRow | null> {
  const [row] = await db
    .select()
    .from(gscIndexSweeps)
    .where(and(eq(gscIndexSweeps.projectId, projectId), activeStatus))
    .limit(1);
  return row ?? null;
}

/** Insert a sweep unless one is already active; returns whichever is active.
 *  The partial unique index makes the check race-free. */
async function createSweepIfNone(input: {
  projectId: string;
  siteUrl: string;
  kind: GscSweepKind;
  trigger: GscSweepTrigger;
  now: string;
}): Promise<{ sweep: SweepRow; created: boolean }> {
  const inserted = await db
    .insert(gscIndexSweeps)
    .values({
      id: crypto.randomUUID(),
      projectId: input.projectId,
      siteUrl: input.siteUrl,
      kind: input.kind,
      trigger: input.trigger,
      status: "queued",
      createdAt: input.now,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return { sweep: inserted[0], created: true };
  const active = await getActiveSweep(input.projectId);
  if (!active) throw new Error("Failed to create or find an index sweep");
  return { sweep: active, created: false };
}

async function getSweep(sweepId: string): Promise<SweepRow | null> {
  const [row] = await db
    .select()
    .from(gscIndexSweeps)
    .where(eq(gscIndexSweeps.id, sweepId))
    .limit(1);
  return row ?? null;
}

async function listSweeps(projectId: string, limit: number) {
  return db
    .select()
    .from(gscIndexSweeps)
    .where(eq(gscIndexSweeps.projectId, projectId))
    .orderBy(desc(gscIndexSweeps.createdAt))
    .limit(limit);
}

async function lastCompletedSweep(
  projectId: string,
  before?: string,
): Promise<SweepRow | null> {
  const [row] = await db
    .select()
    .from(gscIndexSweeps)
    .where(
      and(
        eq(gscIndexSweeps.projectId, projectId),
        eq(gscIndexSweeps.status, "completed"),
        eq(gscIndexSweeps.kind, "full"),
        before ? lt(gscIndexSweeps.createdAt, before) : undefined,
      ),
    )
    .orderBy(desc(gscIndexSweeps.createdAt))
    .limit(1);
  return row ?? null;
}

async function updateSweep(
  sweepId: string,
  patch: Partial<
    Pick<
      SweepRow,
      "status" | "totalUrls" | "attempt" | "resumeAt" | "error" | "finishedAt"
    >
  >,
): Promise<void> {
  await db
    .update(gscIndexSweeps)
    .set(patch)
    .where(eq(gscIndexSweeps.id, sweepId));
}

async function addSweepProgress(
  sweepId: string,
  inspected: number,
  errors: number,
): Promise<void> {
  await db
    .update(gscIndexSweeps)
    .set({
      inspectedCount: sql`${gscIndexSweeps.inspectedCount} + ${inspected}`,
      errorCount: sql`${gscIndexSweeps.errorCount} + ${errors}`,
    })
    .where(eq(gscIndexSweeps.id, sweepId));
}

/** Paused sweeps whose quota day has rolled over. */
async function listResumableSweeps(now: string): Promise<SweepRow[]> {
  return db
    .select()
    .from(gscIndexSweeps)
    .where(
      and(
        eq(gscIndexSweeps.status, "waiting_quota"),
        lte(gscIndexSweeps.resumeAt, now),
      ),
    )
    .limit(50);
}

/** Sweeps a workflow instance should currently be driving. */
async function listRunningSweeps(): Promise<SweepRow[]> {
  return db
    .select()
    .from(gscIndexSweeps)
    .where(inArray(gscIndexSweeps.status, ["queued", "collecting", "running"]))
    .limit(100);
}

/** Sweeps marked in progress that have inspected nothing since `cutoff`:
 *  their workflow instance died (a restart, an evicted instance). */
async function listStalledSweeps(cutoff: string): Promise<SweepRow[]> {
  return db
    .select()
    .from(gscIndexSweeps)
    .where(
      and(
        inArray(gscIndexSweeps.status, ["queued", "collecting", "running"]),
        lt(gscIndexSweeps.createdAt, cutoff),
        sql`not exists (
          select 1 from ${gscIndexUrls}
          where ${gscIndexUrls.projectId} = ${gscIndexSweeps.projectId}
            and ${gscIndexUrls.lastInspectedAt} >= ${cutoff}
        )`,
      ),
    )
    .limit(50);
}

/** Connected projects with no active sweep and no sweep started since
 *  `startedBefore` — due for their daily full sweep. */
async function listProjectsDueForSweep(startedBefore: string) {
  const latest = db
    .select({
      projectId: gscIndexSweeps.projectId,
      lastCreatedAt: sql<string>`max(${gscIndexSweeps.createdAt})`.as(
        "last_created_at",
      ),
    })
    .from(gscIndexSweeps)
    .groupBy(gscIndexSweeps.projectId)
    .as("latest_sweeps");
  return db
    .select({
      projectId: gscConnections.projectId,
      siteUrl: gscConnections.siteUrl,
    })
    .from(gscConnections)
    .leftJoin(latest, eq(latest.projectId, gscConnections.projectId))
    .where(
      or(isNull(latest.lastCreatedAt), lt(latest.lastCreatedAt, startedBefore)),
    )
    .limit(50);
}

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

async function getUsage(siteUrl: string, day: string): Promise<number> {
  const [row] = await db
    .select({ used: gscInspectionUsage.used })
    .from(gscInspectionUsage)
    .where(
      and(
        eq(gscInspectionUsage.siteUrl, siteUrl),
        eq(gscInspectionUsage.day, day),
      ),
    )
    .limit(1);
  return row?.used ?? 0;
}

/** Atomically add `n` inspections to the property's day; returns the new total. */
async function addUsage(
  siteUrl: string,
  day: string,
  n: number,
): Promise<number> {
  const [row] = await db
    .insert(gscInspectionUsage)
    .values({ id: crypto.randomUUID(), siteUrl, day, used: n })
    .onConflictDoUpdate({
      target: [gscInspectionUsage.siteUrl, gscInspectionUsage.day],
      set: { used: sql`${gscInspectionUsage.used} + ${n}` },
    })
    .returning({ used: gscInspectionUsage.used });
  return row?.used ?? n;
}

/** Google said the day is spent even if our count disagrees (another tool
 *  using the same property); pin the count so the sweep stops asking. */
async function markUsageExhausted(
  siteUrl: string,
  day: string,
  limit: number,
): Promise<void> {
  await db
    .insert(gscInspectionUsage)
    .values({ id: crypto.randomUUID(), siteUrl, day, used: limit })
    .onConflictDoUpdate({
      target: [gscInspectionUsage.siteUrl, gscInspectionUsage.day],
      set: { used: limit },
    });
}

export const GscIndexRepository = {
  replaceSitemaps,
  listSitemaps,
  saveCollectedUrls,
  requestUrls,
  nextPendingUrls,
  countPendingUrls,
  countUrls,
  recordInspection,
  coverageGroups,
  listUrls,
  getUrlDetail,
  richResultRows,
  getActiveSweep,
  createSweepIfNone,
  getSweep,
  listSweeps,
  lastCompletedSweep,
  updateSweep,
  addSweepProgress,
  listResumableSweeps,
  listStalledSweeps,
  listRunningSweeps,
  listProjectsDueForSweep,
  getUsage,
  addUsage,
  markUsageExhausted,
};

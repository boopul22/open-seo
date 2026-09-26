import { uniqueBy } from "remeda";
import { runBatch } from "@/db/runBatch";
import { SeoChangeRepository } from "@/server/features/seo-changes/repositories/SeoChangeRepository";
import {
  buildChangeImpact,
  toCheckpointSummary,
} from "@/server/features/seo-changes/seoChangeImpact";
import {
  addDays,
  classifyUrl,
  localDate,
  planCheckpoints,
  targetMatchesUrl,
} from "@/server/features/seo-changes/seoChangeMeasurement";
import {
  measureCheckpoint,
  measureDueCheckpoints,
} from "@/server/features/seo-changes/services/SeoChangeMeasurementService";
import { AppError } from "@/server/lib/errors";
import {
  SEO_CHANGE_DEFAULT_LIST_LIMIT,
  SEO_CHANGE_MAX_LIST_LIMIT,
  type SeoChange,
  type SeoChangeCheckpointSummary,
  type SeoChangeImpact,
  type SeoChangeInput,
  type SeoChangeListFilters,
  type SeoChangeTarget,
  type SeoChangeUpdate,
} from "@/types/schemas/seoChanges";

// The SEO change log: record what shipped, snapshot Search Console before it,
// and measure the same targets 14 and 28 days after. Measurements are written
// once and never recomputed, so the numbers a change was judged on stay put.

// A change logged ahead of its deploy is fine; one dated further out is a typo.
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;
// A URL filter matches in memory (patterns cannot be matched in SQL), so it
// scans this many recent changes.
const URL_FILTER_SCAN_LIMIT = 500;
/** How far back the project context digest looks. */
export const RECENT_CHANGES_DAYS = 90;
export const RECENT_CHANGES_LIMIT = 20;

type ChangeRow = NonNullable<
  Awaited<ReturnType<typeof SeoChangeRepository.getChange>>
>;

function toChange(row: ChangeRow, targets: SeoChangeTarget[]): SeoChange {
  return {
    id: row.id,
    projectId: row.projectId,
    shippedAt: row.shippedAt,
    timezone: row.timezone,
    shipDate: row.shipDate,
    type: row.type,
    summary: row.summary,
    titleBefore: row.titleBefore,
    titleAfter: row.titleAfter,
    metaDescriptionBefore: row.metaDescriptionBefore,
    metaDescriptionAfter: row.metaDescriptionAfter,
    commitHash: row.commitHash,
    deployId: row.deployId,
    prUrl: row.prUrl,
    author: row.author,
    authorKind: row.authorKind,
    notes: row.notes,
    status: row.status,
    revertedAt: row.revertedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    targets,
  };
}

async function withTargets(rows: ChangeRow[]): Promise<SeoChange[]> {
  const targets = await SeoChangeRepository.listTargets(
    rows.map((row) => row.id),
  );
  return rows.map((row) =>
    toChange(
      row,
      targets
        .filter((target) => target.changeId === row.id)
        .map(({ id, kind, value }) => ({ id, kind, value })),
    ),
  );
}

async function requireChange(
  projectId: string,
  changeId: string,
): Promise<ChangeRow> {
  const row = await SeoChangeRepository.getChange(projectId, changeId);
  if (!row) {
    throw new AppError(
      "NOT_FOUND",
      `No change ${changeId} in this project. Call list_changes to find it.`,
    );
  }
  return row;
}

// ---------------------------------------------------------------------- CRUD

async function logChange(params: {
  projectId: string;
  createdByUserId: string;
  author: string;
  authorKind: "user" | "agent";
  input: SeoChangeInput;
}): Promise<{ change: SeoChange; baseline: SeoChangeCheckpointSummary }> {
  const { input } = params;
  const shippedAtMs = Date.parse(input.shippedAt);
  if (shippedAtMs > Date.now() + MAX_FUTURE_MS) {
    throw new AppError(
      "VALIDATION_ERROR",
      "shippedAt is more than 24 hours in the future. Log the change once it ships.",
    );
  }

  const shippedAt = new Date(shippedAtMs).toISOString();
  const shipDate = localDate(shippedAt, input.timezone);
  const changeId = crypto.randomUUID();
  const now = new Date();
  const nowIso = now.toISOString();
  const targets: SeoChangeTarget[] = uniqueBy(
    [
      ...input.urls.map((url) => ({ kind: classifyUrl(url), value: url })),
      ...(input.queries ?? []).map((query) => ({
        kind: "query" as const,
        value: query,
      })),
    ],
    (target) => `${target.kind}\u0000${target.value}`,
  ).map((target) => ({ id: crypto.randomUUID(), ...target }));
  const checkpoints = planCheckpoints(shipDate, now).map((checkpoint) => ({
    id: crypto.randomUUID(),
    changeId,
    ...checkpoint,
    status: "pending" as const,
    attempts: 0,
    measuredAt: null,
    error: null,
  }));

  await runBatch((tx) => [
    SeoChangeRepository.insertChange(tx, {
      id: changeId,
      projectId: params.projectId,
      shippedAt,
      timezone: input.timezone,
      shipDate,
      type: input.type,
      summary: input.summary,
      titleBefore: input.titleBefore ?? null,
      titleAfter: input.titleAfter ?? null,
      metaDescriptionBefore: input.metaDescriptionBefore ?? null,
      metaDescriptionAfter: input.metaDescriptionAfter ?? null,
      commitHash: input.commitHash ?? null,
      deployId: input.deployId ?? null,
      prUrl: input.prUrl ?? null,
      author: params.author,
      authorKind: params.authorKind,
      createdByUserId: params.createdByUserId,
      notes: input.notes ?? null,
      status: "active",
      revertedAt: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    }),
    ...targets.map((target) =>
      SeoChangeRepository.insertTarget(tx, { ...target, changeId }),
    ),
    ...checkpoints.map((checkpoint) =>
      SeoChangeRepository.insertCheckpoint(tx, checkpoint),
    ),
  ]);

  // The baseline is taken now, while the change is being logged, so the
  // "before" numbers are pinned before anything else touches them.
  const baseline = checkpoints[0];
  await measureCheckpoint(params.projectId, baseline, targets);
  const [row, stored] = await Promise.all([
    requireChange(params.projectId, changeId),
    SeoChangeRepository.listCheckpoints(changeId),
  ]);
  const storedBaseline = stored.find((c) => c.kind === "baseline") ?? baseline;
  return {
    change: toChange(row, targets),
    baseline: toCheckpointSummary(storedBaseline),
  };
}

async function listChanges(
  projectId: string,
  filters: SeoChangeListFilters,
): Promise<SeoChange[]> {
  const limit = Math.min(
    filters.limit ?? SEO_CHANGE_DEFAULT_LIST_LIMIT,
    SEO_CHANGE_MAX_LIST_LIMIT,
  );
  const rows = await SeoChangeRepository.listChanges({
    projectId,
    type: filters.type,
    from: filters.from,
    to: filters.to,
    limit: filters.url ? URL_FILTER_SCAN_LIMIT : limit,
  });
  const changes = await withTargets(rows);
  const url = filters.url;
  if (!url) return changes;
  return changes
    .filter((change) =>
      change.targets.some((target) => targetMatchesUrl(target, url)),
    )
    .slice(0, limit);
}

/** Changes shipped in the last RECENT_CHANGES_DAYS, for the context digest. */
async function listRecentChanges(projectId: string): Promise<SeoChange[]> {
  const today = new Date().toISOString().slice(0, 10);
  return listChanges(projectId, {
    from: addDays(today, -RECENT_CHANGES_DAYS),
    limit: RECENT_CHANGES_LIMIT,
  });
}

async function getChange(
  projectId: string,
  changeId: string,
): Promise<SeoChange> {
  const [change] = await withTargets([
    await requireChange(projectId, changeId),
  ]);
  return change;
}

async function updateChange(
  projectId: string,
  changeId: string,
  update: SeoChangeUpdate,
): Promise<SeoChange> {
  const row = await requireChange(projectId, changeId);
  const today = new Date().toISOString().slice(0, 10);

  let status = row.status;
  let revertedAt = row.revertedAt;
  if (update.reverted === true) {
    status = "reverted";
    revertedAt = new Date(update.revertedAt ?? Date.now()).toISOString();
    if (revertedAt < row.shippedAt) {
      throw new AppError(
        "VALIDATION_ERROR",
        "revertedAt is before the change shipped.",
      );
    }
  } else if (update.reverted === false) {
    status = "active";
    revertedAt = null;
  }

  await SeoChangeRepository.updateChange(projectId, changeId, {
    summary: update.summary,
    commitHash: update.commitHash,
    deployId: update.deployId,
    prUrl: update.prUrl,
    notes: update.appendNote
      ? [row.notes, `[${today}] ${update.appendNote}`]
          .filter(Boolean)
          .join("\n\n")
      : undefined,
    status,
    revertedAt,
  });

  if (update.reverted === true && revertedAt) {
    const revertDate = localDate(revertedAt, row.timezone);
    await SeoChangeRepository.skipPendingCheckpointsEndingOnOrAfter(
      changeId,
      revertDate,
      `Skipped: the change was reverted on ${revertDate}, inside this window.`,
    );
  } else if (update.reverted === false) {
    await SeoChangeRepository.reopenSkippedCheckpoints(changeId);
  }

  return getChange(projectId, changeId);
}

async function deleteChange(projectId: string, changeId: string) {
  const deleted = await SeoChangeRepository.deleteChange(projectId, changeId);
  if (!deleted) await requireChange(projectId, changeId);
}

/**
 * Baseline, post-change metrics and deltas for one change. Any checkpoint that
 * is due but not yet measured (a cron tick hasn't reached it, or the
 * deployment runs no cron) is measured inline first.
 */
async function getChangeImpact(
  projectId: string,
  changeId: string,
): Promise<SeoChangeImpact> {
  const change = await getChange(projectId, changeId);
  let checkpoints = await SeoChangeRepository.listCheckpoints(changeId);
  if (await measureDueCheckpoints(projectId, checkpoints, change.targets)) {
    checkpoints = await SeoChangeRepository.listCheckpoints(changeId);
  }
  const metrics = await SeoChangeRepository.listMetrics(
    checkpoints.filter((c) => c.status === "measured").map((c) => c.id),
  );
  return buildChangeImpact(change, checkpoints, metrics);
}

/** Ship-date markers for trend charts over [from, to]. */
async function listChangeMarkers(projectId: string, from: string, to: string) {
  const rows = await SeoChangeRepository.listChanges({
    projectId,
    from,
    to,
    limit: SEO_CHANGE_MAX_LIST_LIMIT,
  });
  return rows.map((row) => ({
    id: row.id,
    shipDate: row.shipDate,
    type: row.type,
    summary: row.summary,
    status: row.status,
  }));
}

export const SeoChangeService = {
  logChange,
  listChanges,
  listRecentChanges,
  getChange,
  updateChange,
  deleteChange,
  getChangeImpact,
  listChangeMarkers,
} as const;

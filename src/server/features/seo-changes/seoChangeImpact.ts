import type { SeoChangeRepository } from "@/server/features/seo-changes/repositories/SeoChangeRepository";
import {
  buildDelta,
  daysInWindow,
  noiseFlags,
} from "@/server/features/seo-changes/seoChangeMeasurement";
import { SEO_CHANGE_DEVICES, type SeoChangeDevice } from "@/shared/seo-changes";
import type {
  SeoChange,
  SeoChangeCheckpointSummary,
  SeoChangeDelta,
  SeoChangeImpact,
  SeoChangeMetricValues,
  SeoChangeTargetImpact,
} from "@/types/schemas/seoChanges";

// Shapes stored checkpoints and metrics into what a reader sees: the baseline,
// then for each measured post-change window the per-device deltas, the whole
// site's change over the same window, and the noise flags.

type CheckpointRow = Awaited<
  ReturnType<typeof SeoChangeRepository.listCheckpoints>
>[number];
type MetricRow = Awaited<
  ReturnType<typeof SeoChangeRepository.listMetrics>
>[number];

const EMPTY: SeoChangeMetricValues = {
  clicks: 0,
  impressions: 0,
  ctr: 0,
  position: 0,
};

export function toCheckpointSummary(
  row: CheckpointRow,
): SeoChangeCheckpointSummary {
  return {
    kind: row.kind,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    dueAt: row.dueAt,
    status: row.status,
    measuredAt: row.measuredAt,
    error: row.error,
  };
}

const clicksPct = (deltas: SeoChangeDelta[]) =>
  deltas.find((d) => d.device === "all")?.clicksPerDay.changePct ?? null;

function metricsFor(
  rows: MetricRow[],
  checkpointId: string,
  targetId: string | null,
  device: SeoChangeDevice,
): SeoChangeMetricValues | undefined {
  const row = rows.find(
    (metric) =>
      metric.checkpointId === checkpointId &&
      metric.targetId === targetId &&
      metric.device === device,
  );
  return row
    ? {
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
        position: row.position,
      }
    : undefined;
}

export function buildChangeImpact(
  change: SeoChange,
  checkpoints: CheckpointRow[],
  metrics: MetricRow[],
): SeoChangeImpact {
  const measured = checkpoints.filter((c) => c.status === "measured");
  const baseline = measured.find((c) => c.kind === "baseline");
  const targetsById = new Map(change.targets.map((t) => [t.id, t]));

  const results: SeoChangeImpact["results"] = [];
  for (const checkpoint of measured) {
    if (!baseline || checkpoint.kind === "baseline") continue;
    const beforeDays = daysInWindow(baseline.windowStart, baseline.windowEnd);
    const afterDays = daysInWindow(
      checkpoint.windowStart,
      checkpoint.windowEnd,
    );
    const before = (targetId: string | null, device: SeoChangeDevice) =>
      metricsFor(metrics, baseline.id, targetId, device);
    const after = (targetId: string | null, device: SeoChangeDevice) =>
      metricsFor(metrics, checkpoint.id, targetId, device);
    const deltasFor = (targetId: string | null) =>
      SEO_CHANGE_DEVICES.filter(
        (device) => before(targetId, device) || after(targetId, device),
      ).map((device) =>
        buildDelta(
          device,
          before(targetId, device),
          beforeDays,
          after(targetId, device),
          afterDays,
        ),
      );

    const siteDeltas = deltasFor(null);
    const siteClicksPct = clicksPct(siteDeltas);
    const targets: SeoChangeTargetImpact[] = [
      { target: null, deltas: siteDeltas, clicksVsSitePts: null, noise: [] },
      ...change.targets.map((target) => {
        const deltas = deltasFor(target.id);
        const targetClicksPct = clicksPct(deltas);
        return {
          target,
          deltas,
          clicksVsSitePts:
            targetClicksPct !== null && siteClicksPct !== null
              ? targetClicksPct - siteClicksPct
              : null,
          noise: noiseFlags(
            {
              before: before(target.id, "all") ?? EMPTY,
              after: after(target.id, "all") ?? EMPTY,
            },
            targetClicksPct,
            siteClicksPct,
          ),
        };
      }),
    ];
    results.push({
      kind: checkpoint.kind,
      windowStart: checkpoint.windowStart,
      windowEnd: checkpoint.windowEnd,
      targets,
    });
  }

  return {
    change,
    checkpoints: checkpoints.map(toCheckpointSummary),
    baseline: baseline
      ? metrics
          .filter((metric) => metric.checkpointId === baseline.id)
          .map((metric) => ({
            target:
              metric.targetId === null
                ? null
                : (targetsById.get(metric.targetId) ?? null),
            device: metric.device,
            metrics: {
              clicks: metric.clicks,
              impressions: metric.impressions,
              ctr: metric.ctr,
              position: metric.position,
            },
          }))
      : [],
    results,
  };
}

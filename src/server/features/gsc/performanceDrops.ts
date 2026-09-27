import { sort } from "remeda";
import type { GscSearchAnalyticsRow } from "@/server/lib/gscClient";

type PerformanceDrop = {
  key: string;
  clicks: number;
  previousClicks: number;
  clickChange: number;
  impressions: number;
  previousImpressions: number;
  impressionChange: number;
};

type PeriodTotals = { clicks: number; impressions: number };

function byKey(rows: GscSearchAnalyticsRow[]) {
  const map = new Map<string, { clicks: number; impressions: number }>();
  for (const row of rows) {
    const key = row.keys?.join(" / ");
    if (key) map.set(key, { clicks: row.clicks, impressions: row.impressions });
  }
  return map;
}

function totals(rows: GscSearchAnalyticsRow[]): PeriodTotals {
  return rows.reduce(
    (sum, row) => ({
      clicks: sum.clicks + row.clicks,
      impressions: sum.impressions + row.impressions,
    }),
    { clicks: 0, impressions: 0 },
  );
}

/** Compare two equal-length windows keyed the same way (page or query) and
 *  return the largest click losses and the largest impression losses. A key
 *  missing from the current window lost everything it had. */
export function comparePeriods(
  current: GscSearchAnalyticsRow[],
  previous: GscSearchAnalyticsRow[],
  limit = 10,
) {
  const now = byKey(current);
  const before = byKey(previous);
  const changes: PerformanceDrop[] = [];
  for (const [key, prev] of before) {
    const cur = now.get(key) ?? { clicks: 0, impressions: 0 };
    changes.push({
      key,
      clicks: cur.clicks,
      previousClicks: prev.clicks,
      clickChange: cur.clicks - prev.clicks,
      impressions: cur.impressions,
      previousImpressions: prev.impressions,
      impressionChange: cur.impressions - prev.impressions,
    });
  }
  return {
    current: totals(current),
    previous: totals(previous),
    clickDrops: sort(
      changes.filter((c) => c.clickChange < 0),
      (a, b) => a.clickChange - b.clickChange,
    ).slice(0, limit),
    impressionDrops: sort(
      changes.filter((c) => c.impressionChange < 0),
      (a, b) => a.impressionChange - b.impressionChange,
    ).slice(0, limit),
  };
}

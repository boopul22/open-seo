import { sort } from "remeda";
import { assessCoreWebVitals, rateCwv } from "@/shared/core-web-vitals";
import { ratePerformanceScore, type PageSpeedRating } from "@/shared/pagespeed";

type ResultRow = {
  url: string;
  performance: number | null;
  accessibility: number | null;
  bestPractices: number | null;
  seo: number | null;
  lcpMs: number | null;
  cls: number | null;
  tbtMs: number | null;
  fieldScope: "url" | "origin" | null;
  fieldLcpMs: number | null;
  fieldInpMs: number | null;
  fieldCls: number | null;
};

type Distribution = Record<PageSpeedRating, number>;

const emptyDistribution = (): Distribution => ({
  good: 0,
  needs_improvement: 0,
  poor: 0,
});

// Lighthouse's own lab thresholds for Total Blocking Time.
function rateTbt(ms: number): PageSpeedRating {
  if (ms <= 200) return "good";
  if (ms > 600) return "poor";
  return "needs_improvement";
}

function average(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value != null);
  if (present.length === 0) return null;
  return Math.round(present.reduce((a, b) => a + b, 0) / present.length);
}

/** Site-wide averages and good / needs-improvement / poor page counts. */
export function summarizePageSpeed(rows: ResultRow[]) {
  const performance = emptyDistribution();
  const lcp = emptyDistribution();
  const cls = emptyDistribution();
  const tbt = emptyDistribution();
  let fieldAssessed = 0;
  let fieldPassing = 0;
  for (const row of rows) {
    if (row.performance != null) {
      performance[ratePerformanceScore(row.performance)]++;
    }
    if (row.lcpMs != null) lcp[rateCwv("lcp", row.lcpMs)]++;
    if (row.cls != null) cls[rateCwv("cls", row.cls)]++;
    if (row.tbtMs != null) tbt[rateTbt(row.tbtMs)]++;
    // Only URL-level field data says something about this page; origin data
    // is the same for every page on the site.
    if (row.fieldScope === "url") {
      const assessment = assessCoreWebVitals({
        lcp: row.fieldLcpMs,
        inp: row.fieldInpMs,
        cls: row.fieldCls,
      });
      if (assessment) fieldAssessed++;
      if (assessment === "pass") fieldPassing++;
    }
  }
  return {
    pages: rows.length,
    averages: {
      performance: average(rows.map((row) => row.performance)),
      accessibility: average(rows.map((row) => row.accessibility)),
      bestPractices: average(rows.map((row) => row.bestPractices)),
      seo: average(rows.map((row) => row.seo)),
    },
    distribution: { performance, lcp, cls, tbt },
    fieldCoreWebVitals: { assessed: fieldAssessed, passing: fieldPassing },
  };
}

/** Lowest performance scores first. */
export function slowestPages<T extends ResultRow>(rows: T[], limit: number) {
  return sort(
    rows.filter((row) => row.performance != null),
    (a, b) => (a.performance ?? 0) - (b.performance ?? 0),
  ).slice(0, limit);
}

const REGRESSION_POINTS = 10;

const delta = (a: number | null, b: number | null) =>
  a != null && b != null ? a - b : null;

/** Week-over-week: pages whose performance dropped by 10+ points, pages that
 *  improved by as much, and the change in site averages. */
export function diffPageSpeed(current: ResultRow[], previous: ResultRow[]) {
  const before = new Map(previous.map((row) => [row.url, row]));
  const changes = current.flatMap((row) => {
    const old = before.get(row.url)?.performance;
    if (row.performance == null || old == null) return [];
    return [
      {
        url: row.url,
        previous: old,
        current: row.performance,
        delta: row.performance - old,
      },
    ];
  });
  const currentSummary = summarizePageSpeed(current).averages;
  const previousSummary = summarizePageSpeed(previous).averages;
  return {
    regressions: sort(
      changes.filter((change) => change.delta <= -REGRESSION_POINTS),
      (a, b) => a.delta - b.delta,
    ),
    improvements: changes.filter((change) => change.delta >= REGRESSION_POINTS)
      .length,
    newPages: current.filter((row) => !before.has(row.url)).length,
    averageDeltas: {
      performance: delta(
        currentSummary.performance,
        previousSummary.performance,
      ),
      accessibility: delta(
        currentSummary.accessibility,
        previousSummary.accessibility,
      ),
      bestPractices: delta(
        currentSummary.bestPractices,
        previousSummary.bestPractices,
      ),
      seo: delta(currentSummary.seo, previousSummary.seo),
    },
  };
}

export const CWV_METRICS = ["lcp", "inp", "cls", "fcp", "ttfb"] as const;
export type CwvMetric = (typeof CWV_METRICS)[number];

export const CRUX_FORM_FACTORS = ["PHONE", "DESKTOP"] as const;
export type CruxFormFactor = (typeof CRUX_FORM_FACTORS)[number];

export type CwvRating = "good" | "needs_improvement" | "poor";

// Google's published p75 thresholds (web.dev/articles/vitals). A value at or
// under `good` is good; above `poor` is poor.
const CWV_THRESHOLDS: Record<CwvMetric, { good: number; poor: number }> = {
  lcp: { good: 2500, poor: 4000 },
  inp: { good: 200, poor: 500 },
  cls: { good: 0.1, poor: 0.25 },
  fcp: { good: 1800, poor: 3000 },
  ttfb: { good: 800, poor: 1800 },
};

// The three metrics that make up the Core Web Vitals assessment.
const CORE_WEB_VITALS: readonly CwvMetric[] = ["lcp", "inp", "cls"];

export function rateCwv(metric: CwvMetric, p75: number): CwvRating {
  const { good, poor } = CWV_THRESHOLDS[metric];
  if (p75 <= good) return "good";
  if (p75 > poor) return "poor";
  return "needs_improvement";
}

/** Passes when every core metric CrUX reports is good at p75. A page with no
 *  core metric data has no assessment (null), matching how Search Console
 *  leaves low-traffic URLs out of the report. */
export function assessCoreWebVitals(
  p75s: Partial<Record<CwvMetric, number | null>>,
): "pass" | "fail" | null {
  const rated = CORE_WEB_VITALS.flatMap((metric) => {
    const value = p75s[metric];
    return value == null ? [] : [rateCwv(metric, value)];
  });
  if (rated.length === 0) return null;
  return rated.every((rating) => rating === "good") ? "pass" : "fail";
}

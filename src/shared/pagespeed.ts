// Sitemap-wide PageSpeed sweeps: one mobile PageSpeed Insights run per sitemap
// URL, paced under Google's quota for the single API key the server uses.

// Google allows 25,000/day; reserve under it so the ad-hoc
// get_pagespeed_insights tool keeps headroom on the same key.
export const PAGESPEED_DAILY_BUDGET = 24_000;
// Google allows 240/min per key. Each sweep workflow tracks its own window,
// so split the budget across the concurrent sweeps.
export const PAGESPEED_MAX_CONCURRENT_SWEEPS = 3;
export const PAGESPEED_MINUTE_BUDGET = Math.floor(
  200 / PAGESPEED_MAX_CONCURRENT_SWEEPS,
);
export const PAGESPEED_BATCH_SIZE = 24;
export const PAGESPEED_BATCH_CONCURRENCY = 4;
export const PAGESPEED_MAX_URLS = 50_000;
// Completed sweeps kept per project: this week and last week.
export const PAGESPEED_KEEP_COMPLETED_SWEEPS = 2;

export const PAGESPEED_SWEEP_STATUSES = [
  "queued",
  "running",
  "waiting_quota",
  "completed",
  "failed",
] as const;
export type PageSpeedSweepStatus = (typeof PAGESPEED_SWEEP_STATUSES)[number];

export const PAGESPEED_RESULT_STATUSES = ["pending", "done", "failed"] as const;

export type PageSpeedRating = "good" | "needs_improvement" | "poor";

/** PageSpeed's own score colors: 90+ good, 50-89 needs improvement. */
export function ratePerformanceScore(score: number): PageSpeedRating {
  if (score >= 90) return "good";
  if (score >= 50) return "needs_improvement";
  return "poor";
}

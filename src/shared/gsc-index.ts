// Index coverage sweep: OpenSEO's rebuild of Search Console's Page indexing
// report from the URL Inspection API, which is the only indexing data Google
// exposes programmatically.

export const GSC_SWEEP_KINDS = ["full", "urls"] as const;
export type GscSweepKind = (typeof GSC_SWEEP_KINDS)[number];

export const GSC_SWEEP_TRIGGERS = ["manual", "scheduled", "mcp"] as const;
export type GscSweepTrigger = (typeof GSC_SWEEP_TRIGGERS)[number];

// queued → collecting (full sweeps gather the URL set) → running ⇄
// waiting_quota → completed | failed.
export const GSC_SWEEP_STATUSES = [
  "queued",
  "collecting",
  "running",
  "waiting_quota",
  "completed",
  "failed",
] as const;
export type GscSweepStatus = (typeof GSC_SWEEP_STATUSES)[number];
export const GSC_ACTIVE_SWEEP_STATUSES: readonly GscSweepStatus[] = [
  "queued",
  "collecting",
  "running",
  "waiting_quota",
];

export const GSC_INSPECTION_LINK_KINDS = ["sitemap", "referring"] as const;

// Google's URL Inspection quota per property. We stay a little under the
// per-minute cap because two projects can share one property.
export const GSC_INSPECTIONS_PER_DAY = 2000;
export const GSC_INSPECTIONS_PER_MINUTE = 600;
export const GSC_INSPECTION_MINUTE_BUDGET = 500;

// Search Console reports that have no public API. Named in tool output so an
// agent tells the user to check them in the Search Console UI rather than
// assuming they are clean.
export const GSC_REPORTS_WITHOUT_API = [
  "Page indexing report totals (OpenSEO rebuilds this from URL Inspection)",
  "Core Web Vitals report (OpenSEO uses Chrome UX Report field data instead)",
  "Enhancements / rich result reports (OpenSEO rebuilds these from URL Inspection)",
  "Manual actions",
  "Security issues",
  "Links",
  "Crawl stats",
  "Removals",
] as const;

// Coverage states Google reports for pages it has indexed. Everything else is
// a "not indexed" reason in the Page indexing report.
export function isIndexedCoverageState(state: string | null): boolean {
  if (!state) return false;
  return /^Submitted and indexed$|^Indexed, not submitted in sitemap$|^Indexed, though blocked by robots\.txt$|^Page indexed without content$/i.test(
    state,
  );
}

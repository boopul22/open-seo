import { sort } from "remeda";
import type { UrlInspectionResult } from "@/server/lib/gscClient";
import type { InspectionDetails } from "./repositories/GscIndexRepository";

// Grouping for the rebuilt Page indexing report. Search Console groups pages
// by Google's coverage reason ("Crawled - currently not indexed", "Soft 404",
// ...) under Indexed / Not indexed; the URL Inspection API returns that same
// reason as `coverageState`, so the groups line up with the GSC UI.

export type IndexStatus = "indexed" | "not_indexed" | "error" | "uninspected";

// verdict PASS is Google's "URL is on Google". PARTIAL/NEUTRAL/FAIL are all
// excluded from the index; the coverage state says why.
function indexStatusOf(input: {
  verdict: string | null;
  error: string | null;
  inspected: boolean;
}): IndexStatus {
  if (!input.inspected) return "uninspected";
  if (input.verdict === "PASS") return "indexed";
  if (input.verdict) return "not_indexed";
  return input.error ? "error" : "not_indexed";
}

/** One aggregate row from the repository: URLs sharing a latest verdict and
 *  coverage state, and how many of them entered it since `newSince`. */
export type CoverageGroupRow = {
  verdict: string | null;
  coverageState: string | null;
  error: string | null;
  inspected: boolean;
  count: number;
  newCount: number;
};

export type CoverageReason = {
  reason: string;
  status: IndexStatus;
  count: number;
  newCount: number;
};

export type CoverageSummary = {
  totalUrls: number;
  inspectedUrls: number;
  inspectedPercent: number;
  byStatus: Record<IndexStatus, number>;
  reasons: CoverageReason[];
};

const UNINSPECTED_REASON = "Not inspected yet";
const ERROR_REASON = "Inspection failed";
const UNKNOWN_REASON = "Unknown (no coverage state returned)";

export function reasonOf(row: {
  coverageState: string | null;
  verdict: string | null;
  error: string | null;
  inspected: boolean;
}): string {
  if (!row.inspected) return UNINSPECTED_REASON;
  if (row.coverageState) return row.coverageState;
  if (!row.verdict && row.error) return ERROR_REASON;
  return UNKNOWN_REASON;
}

export function buildCoverageSummary(
  rows: CoverageGroupRow[],
): CoverageSummary {
  const byStatus: Record<IndexStatus, number> = {
    indexed: 0,
    not_indexed: 0,
    error: 0,
    uninspected: 0,
  };
  const reasons = new Map<string, CoverageReason>();
  for (const row of rows) {
    const status = indexStatusOf(row);
    byStatus[status] += row.count;
    const reason = reasonOf(row);
    // The same reason can arrive under two verdicts (NEUTRAL vs FAIL); Search
    // Console shows it once, so merge on the reason and keep its status.
    const key = `${status}\u0000${reason}`;
    const existing = reasons.get(key);
    if (existing) {
      existing.count += row.count;
      existing.newCount += row.newCount;
    } else {
      reasons.set(key, {
        reason,
        status,
        count: row.count,
        newCount: row.newCount,
      });
    }
  }
  const totalUrls = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const inspectedUrls = totalUrls - byStatus.uninspected;
  return {
    totalUrls,
    inspectedUrls,
    inspectedPercent:
      totalUrls === 0 ? 0 : Math.round((inspectedUrls / totalUrls) * 1000) / 10,
    byStatus,
    // Problems first (largest groups first), then indexed, then the queue.
    reasons: sort(
      [...reasons.values()],
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.count - a.count,
    ),
  };
}

const STATUS_ORDER: Record<IndexStatus, number> = {
  not_indexed: 0,
  error: 1,
  indexed: 2,
  uninspected: 3,
};

export type RichResultIssueRow = {
  richResultType: string;
  issueMessage: string | null;
  severity: string | null;
  url: string;
};

type RichResultGroup = {
  richResultType: string;
  // Pages where Google detected this rich result type.
  pages: number;
  issues: Array<{
    issueMessage: string;
    severity: string;
    pages: number;
    sampleUrls: string[];
  }>;
};

/** Search Console's Enhancements view: per rich result type, the distinct
 *  issues and how many pages carry each. */
export function groupRichResultIssues(
  rows: RichResultIssueRow[],
  sampleSize = 5,
): RichResultGroup[] {
  const types = new Map<
    string,
    {
      pages: Set<string>;
      issues: Map<string, { severity: string; urls: Set<string> }>;
    }
  >();
  for (const row of rows) {
    let type = types.get(row.richResultType);
    if (!type) {
      type = { pages: new Set(), issues: new Map() };
      types.set(row.richResultType, type);
    }
    type.pages.add(row.url);
    if (!row.issueMessage) continue;
    const severity = row.severity ?? "UNKNOWN";
    const key = `${severity}\u0000${row.issueMessage}`;
    let issue = type.issues.get(key);
    if (!issue) {
      issue = { severity, urls: new Set() };
      type.issues.set(key, issue);
    }
    issue.urls.add(row.url);
  }
  const groups = [...types.entries()].map(([richResultType, type]) => ({
    richResultType,
    pages: type.pages.size,
    // Errors before warnings, then by reach.
    issues: sort(
      [...type.issues.entries()].map(([key, issue]) => ({
        issueMessage: key.split("\u0000")[1] ?? "",
        severity: issue.severity,
        pages: issue.urls.size,
        sampleUrls: [...issue.urls].slice(0, sampleSize),
      })),
      (a, b) =>
        Number(b.severity === "ERROR") - Number(a.severity === "ERROR") ||
        b.pages - a.pages,
    ),
  }));
  return sort(groups, (a, b) => b.pages - a.pages);
}

// Referring URLs can run long; the first few are what anyone reads.
const MAX_REFERRING_URLS = 20;

/** Flatten a URL Inspection API result into the stored inspection row, its
 *  sitemap/referring links, and one rich-result row per item issue (or per
 *  item when it has none, so detected types still count). */
export function toInspectionDetails(
  result: UrlInspectionResult | null,
  inspectedAt: string,
): InspectionDetails {
  const index = result?.indexStatusResult;
  const richResults = (result?.richResultsResult?.detectedItems ?? []).flatMap(
    (detected) =>
      (detected.items ?? [{}]).flatMap((item) => {
        const base = {
          richResultType: detected.richResultType ?? "Unknown",
          itemName: item.name ?? null,
        };
        const issues = item.issues ?? [];
        return issues.length === 0
          ? [{ ...base, issueMessage: null, severity: null }]
          : issues.map((issue) => ({
              ...base,
              issueMessage: issue.issueMessage ?? null,
              severity: issue.severity ?? null,
            }));
      }),
  );
  return {
    inspection: {
      inspectedAt,
      error: result ? null : "Google returned no inspection result",
      verdict: index?.verdict ?? null,
      coverageState: index?.coverageState ?? null,
      robotsTxtState: index?.robotsTxtState ?? null,
      indexingState: index?.indexingState ?? null,
      pageFetchState: index?.pageFetchState ?? null,
      lastCrawlTime: index?.lastCrawlTime ?? null,
      crawledAs: index?.crawledAs ?? null,
      googleCanonical: index?.googleCanonical ?? null,
      userCanonical: index?.userCanonical ?? null,
      richResultsVerdict: result?.richResultsResult?.verdict ?? null,
      mobileUsabilityVerdict: result?.mobileUsabilityResult?.verdict ?? null,
      inspectionLink: result?.inspectionResultLink ?? null,
    },
    links: [
      ...(index?.sitemap ?? []).map((url) => ({
        kind: "sitemap" as const,
        url,
      })),
      ...(index?.referringUrls ?? [])
        .slice(0, MAX_REFERRING_URLS)
        .map((url) => ({ kind: "referring" as const, url })),
    ],
    richResults,
  };
}

export function failedInspectionDetails(
  error: string,
  inspectedAt: string,
): InspectionDetails {
  return {
    inspection: { inspectedAt, error },
    links: [],
    richResults: [],
  };
}

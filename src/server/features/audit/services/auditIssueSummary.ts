import { sort } from "remeda";
import {
  getIssueDescriptor,
  ISSUE_SEVERITY_ORDER,
  type IssueSeverity,
} from "@/shared/audit-issues";

type IssueRow = { issueType: string; pageUrl: string };

function describe(issueType: string) {
  const descriptor = getIssueDescriptor(issueType);
  return {
    title: descriptor?.title ?? issueType,
    severity: descriptor?.severity ?? ("info" as IssueSeverity),
  };
}

function countByType(rows: IssueRow[]) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.issueType, (counts.get(row.issueType) ?? 0) + 1);
  }
  return counts;
}

/** Issue counts per type, most severe first, then most frequent. */
export function summarizeIssuesByType(rows: IssueRow[]) {
  return sort(
    Array.from(countByType(rows), ([issueType, count]) => ({
      issueType,
      ...describe(issueType),
      count,
    })),
    (a, b) =>
      ISSUE_SEVERITY_ORDER[a.severity] - ISSUE_SEVERITY_ORDER[b.severity] ||
      b.count - a.count,
  );
}

const MAX_NEW_ISSUES = 50;

const key = (row: IssueRow) => `${row.issueType}\n${row.pageUrl}`;

/** What changed between two audits of the same site: per-type count deltas
 *  (types present in either audit), plus the (type, page) pairs that are new
 *  in `current`. */
export function diffAuditIssues(current: IssueRow[], previous: IssueRow[]) {
  const currentCounts = countByType(current);
  const previousCounts = countByType(previous);
  const types = new Set([...currentCounts.keys(), ...previousCounts.keys()]);

  const byType = sort(
    Array.from(types, (issueType) => {
      const now = currentCounts.get(issueType) ?? 0;
      const before = previousCounts.get(issueType) ?? 0;
      return {
        issueType,
        ...describe(issueType),
        current: now,
        previous: before,
        delta: now - before,
      };
    }).filter((entry) => entry.delta !== 0),
    (a, b) =>
      ISSUE_SEVERITY_ORDER[a.severity] - ISSUE_SEVERITY_ORDER[b.severity] ||
      b.delta - a.delta,
  );

  const previousKeys = new Set(previous.map(key));
  const currentKeys = new Set(current.map(key));
  const newRows = current.filter((row) => !previousKeys.has(key(row)));
  const resolvedCount = new Set(
    previous.filter((row) => !currentKeys.has(key(row))).map(key),
  ).size;

  return {
    byType,
    newIssueCount: new Set(newRows.map(key)).size,
    resolvedIssueCount: resolvedCount,
    newIssues: sort(
      newRows.map((row) => ({
        issueType: row.issueType,
        ...describe(row.issueType),
        url: row.pageUrl,
      })),
      (a, b) =>
        ISSUE_SEVERITY_ORDER[a.severity] - ISSUE_SEVERITY_ORDER[b.severity],
    ).slice(0, MAX_NEW_ISSUES),
  };
}

import { describe, expect, it } from "vitest";
import { diffAuditIssues } from "@/server/features/audit/services/auditIssueSummary";

const row = (issueType: string, pageUrl: string) => ({ issueType, pageUrl });

describe("diffAuditIssues", () => {
  it("reports new and resolved (type, page) pairs and per-type deltas", () => {
    const diff = diffAuditIssues(
      [
        row("missing-title", "/a"),
        row("broken-internal-link", "/b"),
        row("broken-internal-link", "/c"),
      ],
      [row("missing-title", "/a"), row("missing-title", "/old")],
    );

    expect(diff.newIssueCount).toBe(2);
    expect(diff.resolvedIssueCount).toBe(1);
    expect(diff.newIssues.map((issue) => issue.url)).toEqual(["/b", "/c"]);
    expect(
      diff.byType.map(({ issueType, delta }) => ({ issueType, delta })),
    ).toEqual([
      { issueType: "broken-internal-link", delta: 2 },
      { issueType: "missing-title", delta: -1 },
    ]);
  });
});

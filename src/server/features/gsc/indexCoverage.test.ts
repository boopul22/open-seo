import { describe, expect, it } from "vitest";
import {
  buildCoverageSummary,
  groupRichResultIssues,
  toInspectionDetails,
} from "./indexCoverage";
import { comparePeriods } from "./performanceDrops";

const group = (
  overrides: Partial<Parameters<typeof buildCoverageSummary>[0][number]>,
) => ({
  verdict: null,
  coverageState: null,
  error: null,
  inspected: true,
  count: 1,
  newCount: 0,
  ...overrides,
});

describe("buildCoverageSummary", () => {
  it("groups by Google's reason under indexed / not indexed, problems first", () => {
    const summary = buildCoverageSummary([
      group({
        verdict: "PASS",
        coverageState: "Submitted and indexed",
        count: 600,
      }),
      // Google reports the same reason under NEUTRAL and FAIL verdicts.
      group({
        verdict: "NEUTRAL",
        coverageState: "Crawled - currently not indexed",
        count: 30,
        newCount: 2,
      }),
      group({
        verdict: "FAIL",
        coverageState: "Crawled - currently not indexed",
        count: 5,
        newCount: 1,
      }),
      group({ verdict: "FAIL", coverageState: "Not found (404)", count: 40 }),
      group({ error: "Google returned 500", count: 3 }),
      group({ inspected: false, count: 22 }),
    ]);

    expect(summary.byStatus).toEqual({
      indexed: 600,
      not_indexed: 75,
      error: 3,
      uninspected: 22,
    });
    expect(summary.totalUrls).toBe(700);
    expect(summary.inspectedPercent).toBe(96.9);
    expect(summary.reasons.map((r) => [r.reason, r.count, r.newCount])).toEqual(
      [
        ["Not found (404)", 40, 0],
        ["Crawled - currently not indexed", 35, 3],
        ["Inspection failed", 3, 0],
        ["Submitted and indexed", 600, 0],
        ["Not inspected yet", 22, 0],
      ],
    );
  });
});

describe("rich results", () => {
  it("flattens detected items into one row per issue, keeping issue-free items", () => {
    const details = toInspectionDetails(
      {
        indexStatusResult: {
          verdict: "PASS",
          referringUrls: Array.from(
            { length: 30 },
            (_, i) => `https://x.test/${i}`,
          ),
        },
        richResultsResult: {
          verdict: "PARTIAL",
          detectedItems: [
            {
              richResultType: "Breadcrumbs",
              items: [{ name: "Unnamed item" }],
            },
            {
              richResultType: "Product snippets",
              items: [
                {
                  name: "Camera",
                  issues: [
                    {
                      issueMessage: 'Missing field "offers"',
                      severity: "ERROR",
                    },
                    {
                      issueMessage: 'Missing field "brand"',
                      severity: "WARNING",
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
      "2026-09-26T00:00:00.000Z",
    );

    expect(details.richResults).toEqual([
      {
        richResultType: "Breadcrumbs",
        itemName: "Unnamed item",
        issueMessage: null,
        severity: null,
      },
      {
        richResultType: "Product snippets",
        itemName: "Camera",
        issueMessage: 'Missing field "offers"',
        severity: "ERROR",
      },
      {
        richResultType: "Product snippets",
        itemName: "Camera",
        issueMessage: 'Missing field "brand"',
        severity: "WARNING",
      },
    ]);
    expect(details.links).toHaveLength(20);
  });

  it("groups issues by type and message with errors first", () => {
    const groups = groupRichResultIssues([
      { richResultType: "FAQ", issueMessage: null, severity: null, url: "/a" },
      {
        richResultType: "Product",
        issueMessage: "Missing brand",
        severity: "WARNING",
        url: "/b",
      },
      {
        richResultType: "Product",
        issueMessage: "Missing brand",
        severity: "WARNING",
        url: "/c",
      },
      {
        richResultType: "Product",
        issueMessage: "Missing offers",
        severity: "ERROR",
        url: "/b",
      },
    ]);

    expect(groups).toEqual([
      {
        richResultType: "Product",
        pages: 2,
        issues: [
          {
            issueMessage: "Missing offers",
            severity: "ERROR",
            pages: 1,
            sampleUrls: ["/b"],
          },
          {
            issueMessage: "Missing brand",
            severity: "WARNING",
            pages: 2,
            sampleUrls: ["/b", "/c"],
          },
        ],
      },
      { richResultType: "FAQ", pages: 1, issues: [] },
    ]);
  });
});

const row = (key: string, clicks: number, impressions: number) => ({
  keys: [key],
  clicks,
  impressions,
  ctr: 0,
  position: 1,
});

describe("comparePeriods", () => {
  it("counts a key missing from the current window as a full loss", () => {
    const result = comparePeriods(
      [row("/a", 5, 100), row("/b", 50, 900)],
      [row("/a", 20, 120), row("/b", 40, 1000), row("/gone", 8, 300)],
    );

    expect(result.clickDrops.map((d) => [d.key, d.clickChange])).toEqual([
      ["/a", -15],
      ["/gone", -8],
    ]);
    expect(result.impressionDrops.map((d) => d.key)).toEqual([
      "/gone",
      "/b",
      "/a",
    ]);
  });
});

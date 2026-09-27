import { describe, expect, it } from "vitest";
import {
  diffPageSpeed,
  summarizePageSpeed,
} from "@/server/features/pagespeed/services/pagespeedSummary";

const row = (url: string, performance: number, lcpMs = 2000) => ({
  url,
  performance,
  accessibility: null,
  bestPractices: null,
  seo: null,
  lcpMs,
  cls: 0,
  tbtMs: 100,
  fieldScope: null,
  fieldLcpMs: null,
  fieldInpMs: null,
  fieldCls: null,
});

describe("summarizePageSpeed", () => {
  it("buckets pages by PageSpeed score colors and lab LCP thresholds", () => {
    const summary = summarizePageSpeed([
      row("/a", 95),
      row("/b", 70, 3000),
      row("/c", 30, 5000),
    ]);

    expect(summary.averages.performance).toBe(65);
    expect(summary.distribution.performance).toEqual({
      good: 1,
      needs_improvement: 1,
      poor: 1,
    });
    expect(summary.distribution.lcp).toEqual({
      good: 1,
      needs_improvement: 1,
      poor: 1,
    });
  });
});

describe("diffPageSpeed", () => {
  it("flags pages that dropped 10+ points and counts new pages", () => {
    const diff = diffPageSpeed(
      [row("/a", 60), row("/b", 95), row("/new", 80)],
      [row("/a", 90), row("/b", 80)],
    );

    expect(diff.regressions).toEqual([
      { url: "/a", previous: 90, current: 60, delta: -30 },
    ]);
    expect(diff.improvements).toBe(1);
    expect(diff.newPages).toBe(1);
  });
});

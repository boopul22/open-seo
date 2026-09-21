import { describe, expect, it } from "vitest";
import {
  computeChannelStats,
  median,
  scoreVideo,
  videoAgeDays,
} from "./YoutubeOutlierMath";

const NOW = new Date("2026-09-21T12:00:00.000Z");

function publishedDaysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

describe("median", () => {
  it("returns 0 for an empty sample", () => {
    expect(median([])).toBe(0);
  });

  it("returns the middle value for an odd sample", () => {
    expect(median([7, 1, 5])).toBe(5);
  });

  it("averages the two middle values for an even sample", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("does not mutate the input", () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe("videoAgeDays", () => {
  it("floors partial days but never below one", () => {
    expect(videoAgeDays("2026-09-11T12:00:00.000Z", NOW)).toBe(10);
    expect(videoAgeDays("2026-09-21T11:00:00.000Z", NOW)).toBe(1);
  });

  it("treats a future, missing, or invalid date as one day old", () => {
    expect(videoAgeDays("2027-01-01T00:00:00.000Z", NOW)).toBe(1);
    expect(videoAgeDays(null, NOW)).toBe(1);
    expect(videoAgeDays("not-a-date", NOW)).toBe(1);
  });
});

describe("computeChannelStats", () => {
  it("returns zeroed stats for an empty sample", () => {
    expect(computeChannelStats([], NOW)).toEqual({
      sampleSize: 0,
      medianViews: 0,
      averageViews: 0,
      viewsPerDayMedian: 0,
      uploadsPerWeek: 0,
    });
  });

  it("computes median and average views, counting null views as zero", () => {
    const stats = computeChannelStats(
      [
        { views: 100, publishedAt: publishedDaysAgo(1) },
        { views: 300, publishedAt: publishedDaysAgo(1) },
        { views: null, publishedAt: publishedDaysAgo(1) },
      ],
      NOW,
    );
    expect(stats.sampleSize).toBe(3);
    expect(stats.medianViews).toBe(100);
    expect(stats.averageViews).toBe(133.33);
  });

  it("derives uploads per week from the sample's published span", () => {
    const stats = computeChannelStats(
      [
        { views: 10, publishedAt: publishedDaysAgo(0) },
        { views: 10, publishedAt: publishedDaysAgo(7) },
        { views: 10, publishedAt: publishedDaysAgo(14) },
        { views: 10, publishedAt: publishedDaysAgo(21) },
      ],
      NOW,
    );
    expect(stats.uploadsPerWeek).toBe(1.33);
  });

  it("reports per-day views relative to each video's age", () => {
    const stats = computeChannelStats(
      [
        { views: 1000, publishedAt: publishedDaysAgo(10) },
        { views: 1000, publishedAt: publishedDaysAgo(10) },
      ],
      NOW,
    );
    expect(stats.viewsPerDayMedian).toBe(100);
  });
});

describe("scoreVideo", () => {
  const stats = { medianViews: 500, viewsPerDayMedian: 50 };

  it("scores a typical video at 1", () => {
    const score = scoreVideo(
      { views: 500, publishedAt: publishedDaysAgo(10) },
      stats,
      NOW,
    );
    expect(score).toEqual({
      ageDays: 10,
      viewsPerDay: 50,
      outlierScore: 1,
      velocityScore: 1,
    });
  });

  it("rounds outlier and velocity scores to two decimals", () => {
    const score = scoreVideo(
      { views: 1234, publishedAt: publishedDaysAgo(3) },
      stats,
      NOW,
    );
    expect(score.outlierScore).toBe(2.47);
    expect(score.velocityScore).toBe(8.23);
  });

  it("treats missing views as zero", () => {
    expect(
      scoreVideo({ views: null, publishedAt: publishedDaysAgo(5) }, stats, NOW),
    ).toEqual({
      ageDays: 5,
      viewsPerDay: 0,
      outlierScore: 0,
      velocityScore: 0,
    });
  });

  it("avoids dividing by a zero baseline", () => {
    const score = scoreVideo(
      { views: 250, publishedAt: publishedDaysAgo(5) },
      { medianViews: 0, viewsPerDayMedian: 0 },
      NOW,
    );
    expect(score.outlierScore).toBe(250);
    expect(score.velocityScore).toBe(50);
  });
});

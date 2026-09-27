import { beforeEach, describe, expect, it, vi } from "vitest";
import { PageSpeedApiError } from "@/server/lib/pagespeedClient";
import { PageSpeedSweepService } from "@/server/features/pagespeed/services/PageSpeedSweepService";

const mocks = vi.hoisted(() => ({
  getSweep: vi.fn(),
  getUsage: vi.fn(),
  addUsage: vi.fn(),
  markUsageExhausted: vi.fn(),
  nextPendingResults: vi.fn(),
  saveResult: vi.fn(),
  failResult: vi.fn(),
  countResultsByStatus: vi.fn(),
  updateSweep: vi.fn(),
  runPageSpeedInsights: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/pagespeed/repositories/PageSpeedRepository", () => ({
  PageSpeedRepository: mocks,
}));
vi.mock("@/server/lib/pagespeedClient", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runPageSpeedInsights: mocks.runPageSpeedInsights,
}));

const metric = { score: null, displayValue: null, numericValue: 1000 };
const psiResult = {
  scores: {
    performance: 80,
    accessibility: 90,
    "best-practices": 100,
    seo: 100,
  },
  metrics: {
    firstContentfulPaint: metric,
    largestContentfulPaint: metric,
    totalBlockingTime: metric,
    cumulativeLayoutShift: metric,
    speedIndex: metric,
  },
  fieldData: null,
  fieldDataScope: null,
  issues: [],
};

beforeEach(() => {
  mocks.getSweep.mockResolvedValue({
    id: "s1",
    status: "running",
    attempt: 1,
  });
  mocks.getUsage.mockResolvedValue(0);
  mocks.nextPendingResults.mockResolvedValue([
    { id: "r1", url: "https://example.com/a" },
    { id: "r2", url: "https://example.com/b" },
  ]);
  mocks.countResultsByStatus.mockResolvedValue({
    pending: 0,
    done: 2,
    failed: 0,
  });
  mocks.runPageSpeedInsights.mockResolvedValue(psiResult);
});

describe("PageSpeedSweepService.processBatch", () => {
  it("stores a page PageSpeed can't test as failed and keeps going", async () => {
    mocks.runPageSpeedInsights
      .mockRejectedValueOnce(new PageSpeedApiError(500, "Lighthouse error"))
      .mockResolvedValueOnce(psiResult);

    const outcome = await PageSpeedSweepService.processBatch("s1", 1);

    expect(outcome).toEqual({ state: "continue", processed: 2 });
    expect(mocks.failResult).toHaveBeenCalledTimes(1);
    expect(mocks.saveResult).toHaveBeenCalledTimes(1);
  });

  it("backs off on a per-minute 429 and leaves the page pending", async () => {
    mocks.runPageSpeedInsights.mockRejectedValue(
      new PageSpeedApiError(429, "rate", "Queries per minute"),
    );

    const outcome = await PageSpeedSweepService.processBatch("s1", 1);

    expect(outcome.state).toBe("rate_limited");
    expect(mocks.failResult).not.toHaveBeenCalled();
  });

  it("pauses the sweep until the reset when the daily quota is spent", async () => {
    mocks.runPageSpeedInsights.mockRejectedValue(
      new PageSpeedApiError(429, "quota", "Quota exceeded: Queries per day"),
    );

    const outcome = await PageSpeedSweepService.processBatch("s1", 1);

    expect(outcome.state).toBe("quota");
    expect(mocks.updateSweep).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ status: "waiting_quota" }),
    );
  });
});

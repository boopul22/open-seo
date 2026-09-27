import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCruxClient } from "./cruxClient";
import { assessCoreWebVitals } from "@/shared/core-web-vitals";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CrUX client", () => {
  it("reads p75s (CLS arrives as a string) and the good/NI/poor split", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        record: {
          metrics: {
            largest_contentful_paint: {
              histogram: [{ density: 0.7 }, { density: 0.2 }, { density: 0.1 }],
              percentiles: { p75: 2900 },
            },
            cumulative_layout_shift: {
              histogram: [
                { density: 0.9 },
                { density: 0.05 },
                { density: 0.05 },
              ],
              percentiles: { p75: "0.05" },
            },
          },
        },
      }),
    );

    const record = await createCruxClient("key").queryRecord(
      { origin: "https://x.test" },
      "PHONE",
    );

    expect(record?.metrics.lcp).toEqual({
      p75: 2900,
      good: 0.7,
      needsImprovement: 0.2,
      poor: 0.1,
    });
    expect(record?.metrics.cls?.p75).toBe(0.05);
  });

  it("treats 404 as not enough Chrome traffic", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 404 }));
    await expect(
      createCruxClient("key").queryRecord(
        { url: "https://x.test/a" },
        "DESKTOP",
      ),
    ).resolves.toBeNull();
  });
});

describe("Core Web Vitals assessment", () => {
  it("passes only when every reported core metric is good", () => {
    expect(assessCoreWebVitals({ lcp: 2400, cls: 0.05 })).toBe("pass");
    expect(assessCoreWebVitals({ lcp: 2400, inp: 250, cls: 0.05 })).toBe(
      "fail",
    );
    expect(assessCoreWebVitals({ fcp: 900 })).toBeNull();
  });
});

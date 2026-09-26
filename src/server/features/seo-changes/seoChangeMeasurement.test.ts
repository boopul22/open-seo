import { describe, expect, it } from "vitest";
import {
  localDate,
  noiseFlags,
  planCheckpoints,
  targetFilter,
  targetMatchesUrl,
} from "./seoChangeMeasurement";

describe("planCheckpoints", () => {
  it("slides a same-day baseline back to settled data and dates the follow-ups after the ship day", () => {
    const [baseline, day14, day28] = planCheckpoints(
      "2026-09-25",
      new Date("2026-09-25T10:00:00Z"),
    );

    // Search Console has settled through Sep 22, so the 28-day baseline ends
    // there instead of on Sep 24.
    expect(baseline).toMatchObject({
      windowStart: "2026-08-26",
      windowEnd: "2026-09-22",
    });
    expect(day14).toMatchObject({
      windowStart: "2026-09-26",
      windowEnd: "2026-10-09",
      dueAt: "2026-10-12T00:00:00.000Z",
    });
    expect(day28).toMatchObject({
      windowStart: "2026-09-26",
      windowEnd: "2026-10-23",
      dueAt: "2026-10-26T00:00:00.000Z",
    });
  });

  it("uses the 28 days right before a backdated change", () => {
    const [baseline] = planCheckpoints(
      "2026-08-01",
      new Date("2026-09-25T10:00:00Z"),
    );
    expect(baseline).toMatchObject({
      windowStart: "2026-07-04",
      windowEnd: "2026-07-31",
    });
  });
});

it("dates a change by the author's calendar day", () => {
  expect(localDate("2026-09-24T20:00:00.000Z", "Asia/Kolkata")).toBe(
    "2026-09-25",
  );
});

describe("targetFilter", () => {
  const pageMatches = (value: string, url: string) => {
    const filter = targetFilter({
      kind: value.includes("*") ? "page_pattern" : "page",
      value,
    });
    return new RegExp(filter.expression).test(url);
  };

  it("matches a path on any host but only that exact path", () => {
    expect(pageMatches("/", "https://extractpics.com/")).toBe(true);
    expect(pageMatches("/", "https://extractpics.com/image-downloader")).toBe(
      false,
    );
    expect(
      pageMatches(
        "/image-downloader",
        "https://www.extractpics.com/image-downloader",
      ),
    ).toBe(true);
  });

  it("expands * across a template", () => {
    expect(pageMatches("/tools/*", "https://example.com/tools/resize")).toBe(
      true,
    );
    expect(pageMatches("/tools/*", "https://example.com/toolshed")).toBe(false);
  });

  it("compares full URLs and queries exactly", () => {
    expect(
      targetFilter({ kind: "page", value: "https://example.com/pricing" }),
    ).toEqual({
      dimension: "page",
      operator: "equals",
      expression: "https://example.com/pricing",
    });
    expect(targetFilter({ kind: "query", value: "image downloader" })).toEqual({
      dimension: "query",
      operator: "equals",
      expression: "image downloader",
    });
  });
});

it("matches a path filter against full-URL targets", () => {
  expect(
    targetMatchesUrl(
      { kind: "page", value: "https://example.com/pricing/" },
      "/pricing",
    ),
  ).toBe(true);
});

const volume = (impressions: number) => ({
  clicks: 0,
  impressions,
  ctr: 0,
  position: 0,
});

describe("noiseFlags", () => {
  it("flags thin windows", () => {
    expect(
      noiseFlags({ before: volume(40), after: volume(5000) }, 50, 0),
    ).toEqual(["low_volume"]);
  });

  it("flags a page that only moved with the site", () => {
    expect(
      noiseFlags({ before: volume(5000), after: volume(5000) }, 22, 18),
    ).toEqual(["matches_site_trend"]);
    expect(
      noiseFlags({ before: volume(5000), after: volume(5000) }, 60, 18),
    ).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { YoutubeReportError } from "@/server/lib/youtubeErrors";
import {
  latestCompleteYoutubeDate,
  resolveYoutubeRange,
  shiftYoutubeDate,
} from "./YoutubeDates";

const NOW = new Date("2026-09-21T12:00:00Z");

describe("shiftYoutubeDate", () => {
  it("shifts across month and year boundaries", () => {
    expect(shiftYoutubeDate("2026-09-01", -1)).toBe("2026-08-31");
    expect(shiftYoutubeDate("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftYoutubeDate("2026-02-28", 1)).toBe("2026-03-01");
  });
});

describe("latestCompleteYoutubeDate", () => {
  it("backs off the analytics lag", () => {
    expect(latestCompleteYoutubeDate(NOW)).toBe("2026-09-19");
  });
});

describe("resolveYoutubeRange", () => {
  it("defaults to the last 28 complete days with an equal previous period", () => {
    const range = resolveYoutubeRange({ now: NOW });
    expect(range).toMatchObject({
      startDate: "2026-08-23",
      endDate: "2026-09-19",
      previousStartDate: "2026-07-26",
      previousEndDate: "2026-08-22",
      dayCount: 28,
      warnings: [],
    });
  });

  it("clamps a future endDate to the last complete day", () => {
    const range = resolveYoutubeRange({ now: NOW, endDate: "2026-09-25" });
    expect(range.endDate).toBe("2026-09-19");
    expect(range.warnings).toContain("end_date_clamped");
  });

  it("honors an explicit range and derives the previous period", () => {
    const range = resolveYoutubeRange({
      now: NOW,
      startDate: "2026-09-01",
      endDate: "2026-09-10",
    });
    expect(range).toMatchObject({
      startDate: "2026-09-01",
      endDate: "2026-09-10",
      previousStartDate: "2026-08-22",
      previousEndDate: "2026-08-31",
      dayCount: 10,
    });
  });

  it("rejects an inverted range", () => {
    expect(() =>
      resolveYoutubeRange({
        now: NOW,
        startDate: "2026-09-10",
        endDate: "2026-09-01",
      }),
    ).toThrow(YoutubeReportError);
  });

  it("rejects ranges longer than two years", () => {
    expect(() =>
      resolveYoutubeRange({
        now: NOW,
        startDate: "2020-01-01",
        endDate: "2026-09-19",
      }),
    ).toThrow(/730 days/);
  });
});

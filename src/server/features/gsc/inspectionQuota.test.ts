import { describe, expect, it } from "vitest";
import { minuteWaitMs, nextQuotaReset, quotaDay } from "./inspectionQuota";

describe("quota day", () => {
  it("counts against the Pacific calendar day, not UTC", () => {
    // 05:00 UTC is still the previous evening in California.
    expect(quotaDay(new Date("2026-09-27T05:00:00Z"))).toBe("2026-09-26");
    expect(quotaDay(new Date("2026-09-27T08:00:00Z"))).toBe("2026-09-27");
  });

  it("resets at Pacific midnight under both daylight and standard time", () => {
    // PDT (UTC-7)
    expect(nextQuotaReset(new Date("2026-09-26T20:00:00Z")).toISOString()).toBe(
      "2026-09-27T07:00:00.000Z",
    );
    // PST (UTC-8)
    expect(nextQuotaReset(new Date("2026-12-01T20:00:00Z")).toISOString()).toBe(
      "2026-12-02T08:00:00.000Z",
    );
    // The day DST ends (2026-11-01): midnight on Nov 2 is PST.
    expect(nextQuotaReset(new Date("2026-11-01T12:00:00Z")).toISOString()).toBe(
      "2026-11-02T08:00:00.000Z",
    );
  });
});

describe("per-minute budget", () => {
  const now = 1_000_000;

  it("lets a batch through while the window has room", () => {
    expect(minuteWaitMs([{ at: now - 10_000, count: 400 }], now, 50, 500)).toBe(
      0,
    );
  });

  it("waits until enough of the window has aged out", () => {
    const bursts = [
      { at: now - 50_000, count: 250 },
      { at: now - 20_000, count: 240 },
    ];
    // 490 used; 50 more needs the first burst gone, 10s from now.
    expect(minuteWaitMs(bursts, now, 50, 500)).toBe(10_000);
  });

  it("ignores bursts older than a minute", () => {
    expect(minuteWaitMs([{ at: now - 61_000, count: 500 }], now, 50, 500)).toBe(
      0,
    );
  });
});

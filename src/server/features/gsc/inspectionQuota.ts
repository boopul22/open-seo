import { sort } from "remeda";
import {
  GSC_INSPECTION_MINUTE_BUDGET,
  GSC_INSPECTIONS_PER_DAY,
} from "@/shared/gsc-index";

// Google resets Search Console API quotas at midnight Pacific Time.
const QUOTA_TIME_ZONE = "America/Los_Angeles";
const MINUTE_MS = 60_000;

const pacificParts = new Intl.DateTimeFormat("en-US", {
  timeZone: QUOTA_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function partsOf(date: Date) {
  const parts = Object.fromEntries(
    pacificParts.formatToParts(date).map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** The quota day (YYYY-MM-DD, Pacific) an inspection at `now` counts against. */
export function quotaDay(now: Date): string {
  const { year, month, day } = partsOf(now);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The instant the next quota day starts (midnight Pacific, DST-aware). */
export function nextQuotaReset(now: Date): Date {
  const { year, month, day } = partsOf(now);
  // 08:00 UTC the next calendar day is 00:00 or 01:00 Pacific depending on
  // DST; subtract whatever Pacific time it shows to land on midnight.
  const guess = new Date(Date.UTC(year, month - 1, day + 1, 8));
  const at = partsOf(guess);
  return new Date(
    guess.getTime() - (at.hour * 3600 + at.minute * 60 + at.second) * 1000,
  );
}

export function dailyRemaining(
  usedToday: number,
  limit: number = GSC_INSPECTIONS_PER_DAY,
): number {
  return Math.max(0, limit - usedToday);
}

export type InspectionBurst = { at: number; count: number };

/** Sliding one-minute window over recent inspection bursts. Returns how long
 *  to wait before `next` more inspections fit under the per-minute budget
 *  (0 when they fit now). */
export function minuteWaitMs(
  bursts: InspectionBurst[],
  now: number,
  next: number,
  budget: number = GSC_INSPECTION_MINUTE_BUDGET,
): number {
  const recent = sort(
    bursts.filter((b) => b.at > now - MINUTE_MS),
    (a, b) => a.at - b.at,
  );
  let used = recent.reduce((sum, b) => sum + b.count, 0);
  if (used + next <= budget) return 0;
  // Drop the oldest bursts until the next batch fits; wait for the last one
  // dropped to leave the window.
  for (const burst of recent) {
    used -= burst.count;
    if (used + next <= budget) return burst.at + MINUTE_MS - now;
  }
  return MINUTE_MS;
}

import { YOUTUBE_ANALYTICS_LAG_DAYS } from "@/shared/youtube";
import { YoutubeReportError } from "@/server/lib/youtubeErrors";

const YOUTUBE_DEFAULT_RANGE_DAYS = 28;
const YOUTUBE_MAX_RANGE_DAYS = 730;

export type YoutubeResolvedRange = {
  startDate: string;
  endDate: string;
  previousStartDate: string;
  previousEndDate: string;
  dayCount: number;
  warnings: string[];
};

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Calendar-day arithmetic in UTC so ranges never drift across DST. */
export function shiftYoutubeDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return toIsoDate(
    new Date(Date.UTC(year, month - 1, day) + days * 86_400_000),
  );
}

function daysBetweenYoutubeDates(start: string, end: string): number {
  const [startYear, startMonth, startDay] = start.split("-").map(Number);
  const [endYear, endMonth, endDay] = end.split("-").map(Number);
  return Math.round(
    (Date.UTC(endYear, endMonth - 1, endDay) -
      Date.UTC(startYear, startMonth - 1, startDay)) /
      86_400_000,
  );
}

/** The newest day YouTube Analytics treats as complete. */
export function latestCompleteYoutubeDate(now = new Date()): string {
  return shiftYoutubeDate(toIsoDate(now), -YOUTUBE_ANALYTICS_LAG_DAYS);
}

/** Resolve a requested range against the analytics lag, defaulting to the
 *  last 28 complete days, and derive the equal-length previous period. */
export function resolveYoutubeRange(input: {
  startDate?: string;
  endDate?: string;
  now?: Date;
}): YoutubeResolvedRange {
  const warnings: string[] = [];
  const maxEnd = latestCompleteYoutubeDate(input.now ?? new Date());
  let endDate = input.endDate ?? maxEnd;
  if (endDate > maxEnd) {
    endDate = maxEnd;
    warnings.push("end_date_clamped");
  }
  const startDate =
    input.startDate ??
    shiftYoutubeDate(endDate, -(YOUTUBE_DEFAULT_RANGE_DAYS - 1));
  if (startDate > endDate) {
    throw new YoutubeReportError(
      "validation_error",
      `startDate ${startDate} must be on or before endDate ${endDate}.`,
    );
  }
  const dayCount = daysBetweenYoutubeDates(startDate, endDate) + 1;
  if (dayCount > YOUTUBE_MAX_RANGE_DAYS) {
    throw new YoutubeReportError(
      "validation_error",
      `YouTube Analytics ranges are limited to ${YOUTUBE_MAX_RANGE_DAYS} days.`,
    );
  }
  const previousEndDate = shiftYoutubeDate(startDate, -1);
  return {
    startDate,
    endDate,
    previousStartDate: shiftYoutubeDate(previousEndDate, -(dayCount - 1)),
    previousEndDate,
    dayCount,
    warnings,
  };
}

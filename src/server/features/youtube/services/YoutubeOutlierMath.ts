import { sort } from "remeda";

const MS_PER_DAY = 86_400_000;

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Middle value of the sorted sample; the mean of the two middle values when
 *  even-sized; 0 for an empty sample. Does not mutate the input. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = sort(values, (a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Whole days since publication, floored at 1 (a video published today still
 *  gets a per-day denominator of 1). Unknown or unparseable dates floor to 1. */
export function videoAgeDays(publishedAt: string | null, now: Date): number {
  if (!publishedAt) return 1;
  const publishedMs = Date.parse(publishedAt);
  if (!Number.isFinite(publishedMs)) return 1;
  return Math.max(Math.floor((now.getTime() - publishedMs) / MS_PER_DAY), 1);
}

export type YoutubeChannelVideoStats = {
  sampleSize: number;
  medianViews: number;
  averageViews: number;
  viewsPerDayMedian: number;
  uploadsPerWeek: number;
};

/** Baseline stats for a channel sample. Null view counts count as 0 so a
 *  hidden-count video can't inflate the median; rows without a parseable
 *  publishedAt are excluded from the upload-rate span only. */
export function computeChannelStats(
  videos: { views: number | null; publishedAt: string | null }[],
  now: Date = new Date(),
): YoutubeChannelVideoStats {
  const sampleSize = videos.length;
  if (sampleSize === 0) {
    return {
      sampleSize: 0,
      medianViews: 0,
      averageViews: 0,
      viewsPerDayMedian: 0,
      uploadsPerWeek: 0,
    };
  }

  const views = videos.map((video) => video.views ?? 0);
  const viewsPerDay = videos.map(
    (video) => (video.views ?? 0) / videoAgeDays(video.publishedAt, now),
  );

  const publishedMs = videos
    .map((video) => video.publishedAt)
    .map((publishedAt) => (publishedAt ? Date.parse(publishedAt) : NaN))
    .filter((value) => Number.isFinite(value));
  let uploadsPerWeek = 0;
  if (publishedMs.length > 0) {
    const spanDays = Math.max(
      (now.getTime() - Math.min(...publishedMs)) / MS_PER_DAY,
      1,
    );
    uploadsPerWeek = round2(publishedMs.length / (spanDays / 7));
  }

  return {
    sampleSize,
    medianViews: round2(median(views)),
    averageViews: round2(
      views.reduce((sum, value) => sum + value, 0) / sampleSize,
    ),
    viewsPerDayMedian: round2(median(viewsPerDay)),
    uploadsPerWeek,
  };
}

type YoutubeVideoScore = {
  ageDays: number;
  viewsPerDay: number;
  outlierScore: number;
  velocityScore: number;
};

/** Score one video against its channel's baseline:
 *  - outlierScore: views vs the channel's median (1 = exactly typical),
 *  - velocityScore: views/day vs the channel's median views/day.
 *  Both are capped at a 1 denominator so a zero baseline can't divide by zero,
 *  and missing view counts score as 0. */
export function scoreVideo(
  input: { views: number | null; publishedAt: string | null },
  stats: Pick<YoutubeChannelVideoStats, "medianViews" | "viewsPerDayMedian">,
  now: Date = new Date(),
): YoutubeVideoScore {
  const views = input.views ?? 0;
  const ageDays = videoAgeDays(input.publishedAt, now);
  const viewsPerDay = views / ageDays;
  return {
    ageDays,
    viewsPerDay: round2(viewsPerDay),
    outlierScore: round2(views / Math.max(stats.medianViews, 1)),
    velocityScore: round2(viewsPerDay / Math.max(stats.viewsPerDayMedian, 1)),
  };
}

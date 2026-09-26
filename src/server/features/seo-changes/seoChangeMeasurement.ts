import { GSC_DATA_LAG_DAYS } from "@/server/features/gsc/searchAnalytics";
import type { GscPerformanceFilter } from "@/server/features/gsc/searchAnalytics";
import type { GscSearchAnalyticsRow } from "@/server/lib/gscClient";
import { sumSearchTotals } from "@/server/features/gsc/searchPerformanceReport";
import type {
  SeoChangeCheckpointKind,
  SeoChangeDevice,
  SeoChangeTargetKind,
} from "@/shared/seo-changes";
import type {
  SeoChangeDelta,
  SeoChangeMetricValues,
  SeoChangeNoiseFlag,
} from "@/types/schemas/seoChanges";

// Pure rules for measuring a change: which calendar windows each checkpoint
// covers, how a target becomes a Search Console filter, and how two windows
// compare. Kept apart from the service so the date math and the noise rules
// are unit-testable without a GSC client.

const BASELINE_DAYS = 28;
const POST_WINDOW_DAYS: Record<
  Exclude<SeoChangeCheckpointKind, "baseline">,
  number
> = { day_14: 14, day_28: 28 };

// Below this many impressions in either window, CTR and position swing on a
// handful of searches, so a delta says little.
const LOW_VOLUME_IMPRESSIONS = 100;
// A page whose clicks moved within this many percentage points of the whole
// site's, in the same direction, moved with the site.
const SITE_TREND_TOLERANCE_PTS = 10;
const SITE_TREND_MIN_ABS_PCT = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

export function daysInWindow(start: string, end: string): number {
  return (
    Math.round(
      (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
        DAY_MS,
    ) + 1
  );
}

/** Calendar day of an instant in an IANA zone, as YYYY-MM-DD. */
export function localDate(instant: string, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
}

/** The last day Search Console has settled data for, matching the lag the
 *  convenience date ranges use. */
function latestCompleteDate(now: Date): string {
  return addDays(now.toISOString().slice(0, 10), -GSC_DATA_LAG_DAYS);
}

/**
 * The three checkpoints for a change shipped on `shipDate`. The ship day itself
 * belongs to neither side: it is part before, part after.
 *
 * The baseline is the 28 days before the ship day, taken as soon as the change
 * is logged. A change logged the day it ships would otherwise wait for Search
 * Console to catch up, so the window slides back to the latest settled day,
 * keeping its length. Post-change windows start the day after shipping and are
 * due once Search Console has settled their last day.
 */
export function planCheckpoints(shipDate: string, now: Date) {
  const latest = latestCompleteDate(now);
  const idealBaselineEnd = addDays(shipDate, -1);
  const baselineEnd = idealBaselineEnd < latest ? idealBaselineEnd : latest;
  const nowIso = now.toISOString();

  return [
    {
      kind: "baseline" as const,
      windowStart: addDays(baselineEnd, -(BASELINE_DAYS - 1)),
      windowEnd: baselineEnd,
      dueAt: nowIso,
    },
    ...(["day_14", "day_28"] as const).map((kind) => {
      const windowEnd = addDays(shipDate, POST_WINDOW_DAYS[kind]);
      return {
        kind,
        windowStart: addDays(shipDate, 1),
        windowEnd,
        dueAt: `${addDays(windowEnd, GSC_DATA_LAG_DAYS)}T00:00:00.000Z`,
      };
    }),
  ];
}

/** A page target is a pattern when it contains a `*` wildcard. */
export function classifyUrl(
  value: string,
): Extract<SeoChangeTargetKind, "page" | "page_pattern"> {
  return value.includes("*") ? "page_pattern" : "page";
}

const escapeRegex = (value: string) =>
  value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/**
 * The Search Console filter for one target. Full URLs match exactly. Paths
 * match on any host and protocol, so "/pricing" finds the page on both
 * `https://example.com` and `https://www.example.com` properties. `*` matches
 * any run of characters. Queries are compared exactly, site-wide.
 */
export function targetFilter(target: {
  kind: SeoChangeTargetKind;
  value: string;
}): GscPerformanceFilter {
  if (target.kind === "query") {
    return { dimension: "query", operator: "equals", expression: target.value };
  }
  const isPath = target.value.startsWith("/");
  if (!isPath && target.kind === "page") {
    return { dimension: "page", operator: "equals", expression: target.value };
  }
  const pattern = escapeRegex(target.value).replaceAll("*", ".*");
  return {
    dimension: "page",
    operator: "includingRegex",
    expression: isPath ? `^https?://[^/]+${pattern}$` : `^${pattern}$`,
  };
}

/** Does a stored page target cover `url` (a full URL or a path)? Used by the
 *  list filter, so it applies the same matching Search Console does. */
export function targetMatchesUrl(
  target: { kind: SeoChangeTargetKind; value: string },
  url: string,
): boolean {
  if (target.kind === "query") return false;
  const filter = targetFilter(target);
  if (filter.operator === "equals") {
    const stored = url.startsWith("/") ? pathOf(target.value) : target.value;
    return stripTrailingSlash(stored) === stripTrailingSlash(url);
  }
  const candidate = url.startsWith("/") ? `https://host${url}` : url;
  return new RegExp(filter.expression).test(candidate);
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

const stripTrailingSlash = (value: string) =>
  value.length > 1 ? value.replace(/\/$/, "") : value;

/**
 * Totals per device plus an "all" row, from `dimensions: ["device"]` rows.
 * Search Console reports devices in upper case.
 */
export function metricsByDevice(
  rows: GscSearchAnalyticsRow[],
): { device: SeoChangeDevice; metrics: SeoChangeMetricValues }[] {
  const devices: { device: SeoChangeDevice; metrics: SeoChangeMetricValues }[] =
    [{ device: "all", metrics: sumSearchTotals(rows) }];
  for (const device of ["desktop", "mobile", "tablet"] as const) {
    const deviceRows = rows.filter(
      (row) => row.keys?.[0]?.toLowerCase() === device,
    );
    if (deviceRows.length > 0) {
      devices.push({ device, metrics: sumSearchTotals(deviceRows) });
    }
  }
  return devices;
}

const EMPTY_METRICS: SeoChangeMetricValues = {
  clicks: 0,
  impressions: 0,
  ctr: 0,
  position: 0,
};

function compare(before: number, after: number) {
  return {
    before,
    after,
    change: after - before,
    changePct: before === 0 ? null : ((after - before) / before) * 100,
  };
}

/** Before/after for one device. Clicks and impressions are per-day rates so
 *  windows of different lengths compare fairly. */
export function buildDelta(
  device: SeoChangeDevice,
  before: SeoChangeMetricValues | undefined,
  beforeDays: number,
  after: SeoChangeMetricValues | undefined,
  afterDays: number,
): SeoChangeDelta {
  const b = before ?? EMPTY_METRICS;
  const a = after ?? EMPTY_METRICS;
  return {
    device,
    clicksPerDay: compare(b.clicks / beforeDays, a.clicks / afterDays),
    impressionsPerDay: compare(
      b.impressions / beforeDays,
      a.impressions / afterDays,
    ),
    ctr: compare(b.ctr, a.ctr),
    position: compare(b.position, a.position),
  };
}

/**
 * Why a target's result is probably noise. `low_volume` when either window has
 * too few impressions to trust; `matches_site_trend` when the page's clicks
 * moved the same way and by about as much as the whole site's did.
 */
export function noiseFlags(
  target: { before: SeoChangeMetricValues; after: SeoChangeMetricValues },
  targetClicksPct: number | null,
  siteClicksPct: number | null,
): SeoChangeNoiseFlag[] {
  const flags: SeoChangeNoiseFlag[] = [];
  if (
    Math.min(target.before.impressions, target.after.impressions) <
    LOW_VOLUME_IMPRESSIONS
  ) {
    flags.push("low_volume");
  }
  if (
    targetClicksPct !== null &&
    siteClicksPct !== null &&
    Math.abs(siteClicksPct) >= SITE_TREND_MIN_ABS_PCT &&
    Math.sign(targetClicksPct) === Math.sign(siteClicksPct) &&
    Math.abs(targetClicksPct - siteClicksPct) <= SITE_TREND_TOLERANCE_PTS
  ) {
    flags.push("matches_site_trend");
  }
  return flags;
}

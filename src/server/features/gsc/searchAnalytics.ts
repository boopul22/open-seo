import type { GscSearchAnalyticsRequest } from "@/server/lib/gscClient";

// Shared option sets — also drive the MCP tool Zod schemas so the two stay in sync.
export const GSC_DIMENSIONS = [
  "query",
  "page",
  "country",
  "device",
  "date",
  "hour",
  "searchAppearance",
] as const;
export const GSC_FILTER_OPERATORS = [
  "equals",
  "notEquals",
  "contains",
  "notContains",
  "includingRegex",
  "excludingRegex",
] as const;
export const GSC_SEARCH_TYPES = [
  "web",
  "image",
  "video",
  "news",
  "googleNews",
  "discover",
] as const;
export const GSC_AGGREGATION_TYPES = [
  "auto",
  "byPage",
  "byProperty",
  "byNewsShowcasePanel",
] as const;
// hourly_all is required for the `hour` dimension and returns hourly rows.
export const GSC_DATA_STATES = ["final", "all", "hourly_all"] as const;
export const GSC_DATE_RANGES = [
  "last_7_days",
  "last_28_days",
  "last_3_months",
  "last_6_months",
  "last_12_months",
  "last_16_months",
] as const;

// 250 rows fits comfortably inside one MCP tool result; the agent opts into
// more with `rowLimit` or paginates with `startRow`.
export const GSC_DEFAULT_ROW_LIMIT = 250;
// Google's per-request maximum. `fetchAllSearchAnalyticsRows` pages in steps of
// this size until a short page says the data ran out.
export const GSC_API_MAX_ROWS = 25_000;
// Rows one MCP call returns. Larger pulls page with the returned cursor so a
// single tool result stays inside an agent's context window.
export const GSC_MAX_ROW_LIMIT = 5000;
// GSC data trails by ~2-3 days; default the end of convenience ranges before it.
export const GSC_DATA_LAG_DAYS = 3;

export type GscDimension = (typeof GSC_DIMENSIONS)[number];
type GscFilterOperator = (typeof GSC_FILTER_OPERATORS)[number];
export type GscAggregationType = (typeof GSC_AGGREGATION_TYPES)[number];
export type GscDataState = (typeof GSC_DATA_STATES)[number];
export type GscSearchType = (typeof GSC_SEARCH_TYPES)[number];
export type GscDateRange = (typeof GSC_DATE_RANGES)[number];

export type GscPerformanceFilter = {
  dimension: GscDimension;
  operator: GscFilterOperator;
  expression: string;
};

export type GscPerformanceInput = {
  projectId: string;
  dimensions?: GscDimension[];
  dateRange?: GscDateRange;
  startDate?: string;
  endDate?: string;
  // AND-combined. `filterGroups` adds further groups; Google ANDs groups too
  // and only supports groupType "and".
  filters?: GscPerformanceFilter[];
  filterGroups?: Array<{ groupType?: "and"; filters: GscPerformanceFilter[] }>;
  rowLimit?: number;
  startRow?: number;
  type?: GscSearchType;
  dataState?: GscDataState;
  aggregationType?: GscAggregationType;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Subtract calendar months in UTC, clamping the day to the target month's length.
function subtractUtcMonths(date: Date, months: number): Date {
  const day = date.getUTCDate();
  const d = new Date(date);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const daysInTargetMonth = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(day, daysInTargetMonth));
  return d;
}

function subtractRange(end: Date, range: GscDateRange): Date {
  const d = new Date(end);
  switch (range) {
    case "last_7_days":
      d.setUTCDate(d.getUTCDate() - 7);
      break;
    case "last_28_days":
      d.setUTCDate(d.getUTCDate() - 28);
      break;
    case "last_3_months":
      return subtractUtcMonths(d, 3);
    case "last_6_months":
      return subtractUtcMonths(d, 6);
    case "last_12_months":
      return subtractUtcMonths(d, 12);
    case "last_16_months":
      return subtractUtcMonths(d, 16);
  }
  return d;
}

function sixteenMonthFloor(today: Date): string {
  return formatDate(subtractUtcMonths(today, 16));
}

/** Resolve a convenience `dateRange` or explicit start/end into GSC dates.
 *  `today` is injectable for deterministic tests. */
export function resolveDateRange(
  input: Pick<GscPerformanceInput, "dateRange" | "startDate" | "endDate">,
  today: Date = new Date(),
): { startDate: string; endDate: string } {
  const floor = sixteenMonthFloor(today);

  if (input.startDate && input.endDate) {
    // Clamp the start to GSC's 16-month lower bound.
    const startDate = input.startDate < floor ? floor : input.startDate;
    return { startDate, endDate: input.endDate };
  }

  const end = new Date(today);
  end.setUTCDate(end.getUTCDate() - GSC_DATA_LAG_DAYS);
  const start = subtractRange(end, input.dateRange ?? "last_28_days");
  const startDate = formatDate(start);
  return {
    startDate: startDate < floor ? floor : startDate,
    endDate: formatDate(end),
  };
}

/** Build the GSC `searchAnalytics.query` body from validated tool input.
 *  Critically, flat `filters` are wrapped into `dimensionFilterGroups` — GSC
 *  silently ignores a top-level `filters` field. */
export function buildSearchAnalyticsRequest(
  input: GscPerformanceInput,
  today: Date = new Date(),
): GscSearchAnalyticsRequest {
  const { startDate, endDate } = resolveDateRange(input, today);
  const request: GscSearchAnalyticsRequest = {
    startDate,
    endDate,
    dimensions:
      input.dimensions && input.dimensions.length > 0
        ? input.dimensions
        : ["query"],
    rowLimit: clamp(
      input.rowLimit ?? GSC_DEFAULT_ROW_LIMIT,
      1,
      GSC_API_MAX_ROWS,
    ),
    type: input.type ?? "web",
    dataState:
      input.dataState ??
      (input.dimensions?.includes("hour") ? "hourly_all" : "all"),
  };
  if (input.aggregationType) {
    request.aggregationType = input.aggregationType;
  }
  if (input.startRow && input.startRow > 0) {
    request.startRow = input.startRow;
  }
  const groups = [
    ...(input.filters && input.filters.length > 0
      ? [{ groupType: "and" as const, filters: input.filters }]
      : []),
    ...(input.filterGroups ?? [])
      .filter((group) => group.filters.length > 0)
      .map((group) => ({ groupType: "and" as const, filters: group.filters })),
  ];
  if (groups.length > 0) {
    request.dimensionFilterGroups = groups;
  }
  return request;
}

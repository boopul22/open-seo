import { sort } from "remeda";
import { GscService } from "@/server/features/gsc/services/GscService";
import {
  CRUX_API_KEY_ENV,
  CruxNotConfiguredError,
  createCruxClient,
  type CruxHistory,
  type CruxRecord,
} from "@/server/lib/cruxClient";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import {
  assessCoreWebVitals,
  CRUX_FORM_FACTORS,
  CWV_METRICS,
  rateCwv,
  type CruxFormFactor,
  type CwvMetric,
  type CwvRating,
} from "@/shared/core-web-vitals";

const DEFAULT_TOP_PAGES = 10;
export const MAX_TOP_PAGES = 50;
const CRUX_CONCURRENCY = 5;

export type CwvMetricResult = {
  p75: number | null;
  rating: CwvRating | null;
  good: number;
  needsImprovement: number;
  poor: number;
};

export type CwvRecordResult = {
  formFactor: CruxFormFactor;
  // null: CrUX has too little Chrome traffic for this origin/URL.
  assessment: "pass" | "fail" | null;
  metrics: Partial<Record<CwvMetric, CwvMetricResult>>;
  collectionPeriod: { firstDate: string; lastDate: string } | null;
};

function toResult(
  formFactor: CruxFormFactor,
  record: CruxRecord | null,
): CwvRecordResult {
  if (!record) {
    return {
      formFactor,
      assessment: null,
      metrics: {},
      collectionPeriod: null,
    };
  }
  const metrics: CwvRecordResult["metrics"] = {};
  const p75s: Partial<Record<CwvMetric, number | null>> = {};
  for (const metric of CWV_METRICS) {
    const value = record.metrics[metric];
    if (!value) continue;
    p75s[metric] = value.p75;
    metrics[metric] = {
      ...value,
      rating: value.p75 === null ? null : rateCwv(metric, value.p75),
    };
  }
  return {
    formFactor,
    assessment: assessCoreWebVitals(p75s),
    metrics,
    collectionPeriod: record.collectionPeriod,
  };
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        const item = items[index];
        if (item !== undefined) results[index] = await fn(item);
      }
    }),
  );
  return results;
}

async function requireClient() {
  const apiKey = await getOptionalEnvValue(CRUX_API_KEY_ENV);
  if (!apiKey) throw new CruxNotConfiguredError();
  return createCruxClient(apiKey);
}

/** Top pages by impressions over the last 28 days. */
async function topPages(projectId: string, limit: number) {
  const { rows, siteUrl } = await GscService.getPerformance({
    projectId,
    dimensions: ["page"],
    dateRange: "last_28_days",
    rowLimit: 1000,
  });
  return {
    siteUrl,
    pages: sort(
      rows
        .map((row) => ({
          url: row.keys?.[0] ?? "",
          impressions: row.impressions,
        }))
        .filter((row) => row.url),
      (a, b) => b.impressions - a.impressions,
    ).slice(0, limit),
  };
}

/** A URL-prefix property is its own origin. A domain property covers every
 *  host, so pick the host carrying the most search impressions. */
export function originForProperty(
  siteUrl: string,
  pageUrls: string[],
): string | null {
  if (!siteUrl.startsWith("sc-domain:")) {
    try {
      return new URL(siteUrl).origin;
    } catch {
      return null;
    }
  }
  const counts = new Map<string, number>();
  for (const url of pageUrls) {
    try {
      const origin = new URL(url).origin;
      counts.set(origin, (counts.get(origin) ?? 0) + 1);
    } catch {
      // Skip malformed rows.
    }
  }
  const best = sort([...counts.entries()], (a, b) => b[1] - a[1])[0];
  return best?.[0] ?? `https://${siteUrl.slice("sc-domain:".length)}`;
}

async function getCoreWebVitals(input: {
  projectId: string;
  scope: "origin" | "urls";
  formFactor?: CruxFormFactor;
  topPages?: number;
  includeHistory?: boolean;
}) {
  const client = await requireClient();
  const formFactors = input.formFactor
    ? [input.formFactor]
    : [...CRUX_FORM_FACTORS];
  const limit = Math.min(input.topPages ?? DEFAULT_TOP_PAGES, MAX_TOP_PAGES);
  const top = await topPages(
    input.projectId,
    input.scope === "urls" ? limit : 25,
  );

  if (input.scope === "origin") {
    const origin = originForProperty(
      top.siteUrl,
      top.pages.map((p) => p.url),
    );
    if (!origin) throw new Error(`Cannot derive an origin from ${top.siteUrl}`);
    const records = await Promise.all(
      formFactors.map(async (ff) =>
        toResult(ff, await client.queryRecord({ origin }, ff)),
      ),
    );
    const history: Partial<Record<CruxFormFactor, CruxHistory | null>> = {};
    if (input.includeHistory) {
      for (const ff of formFactors) {
        history[ff] = await client.queryHistory({ origin }, ff);
      }
    }
    return {
      source: "chrome_ux_report" as const,
      scope: "origin" as const,
      siteUrl: top.siteUrl,
      origin,
      records,
      history: input.includeHistory ? history : undefined,
    };
  }

  const pages = await mapLimit(top.pages, CRUX_CONCURRENCY, async (page) => {
    const records = await Promise.all(
      formFactors.map(async (ff) =>
        toResult(ff, await client.queryRecord({ url: page.url }, ff)),
      ),
    );
    const assessed = records.filter((r) => r.assessment !== null);
    return {
      url: page.url,
      impressions: page.impressions,
      assessment:
        assessed.length === 0
          ? null
          : assessed.some((r) => r.assessment === "fail")
            ? ("fail" as const)
            : ("pass" as const),
      records,
    };
  });
  return {
    source: "chrome_ux_report" as const,
    scope: "urls" as const,
    siteUrl: top.siteUrl,
    pages,
    failingUrls: pages.filter((p) => p.assessment === "fail").map((p) => p.url),
    noDataUrls: pages.filter((p) => p.assessment === null).map((p) => p.url),
  };
}

export const CruxService = { getCoreWebVitals };

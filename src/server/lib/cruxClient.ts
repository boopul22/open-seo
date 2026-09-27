import { z } from "zod";
import {
  CWV_METRICS,
  type CruxFormFactor,
  type CwvMetric,
} from "@/shared/core-web-vitals";

const CRUX_API_BASE = "https://chromeuxreport.googleapis.com/v1";

// CrUX names each metric by its long id; TTFB is still "experimental".
const CRUX_METRIC_IDS: Record<CwvMetric, string> = {
  lcp: "largest_contentful_paint",
  inp: "interaction_to_next_paint",
  cls: "cumulative_layout_shift",
  fcp: "first_contentful_paint",
  ttfb: "experimental_time_to_first_byte",
};

// CLS p75 arrives as a string ("0.05"); the millisecond metrics as numbers.
const p75Schema = z.union([z.number(), z.string()]).transform(Number);

const metricSchema = z.object({
  histogram: z
    .array(z.object({ density: z.number().optional() }))
    .optional()
    .default([]),
  percentiles: z.object({ p75: p75Schema }).optional(),
});

const recordResponseSchema = z.object({
  record: z.object({
    metrics: z.record(z.string(), metricSchema).default({}),
    collectionPeriod: z
      .object({
        firstDate: z.object({
          year: z.number(),
          month: z.number(),
          day: z.number(),
        }),
        lastDate: z.object({
          year: z.number(),
          month: z.number(),
          day: z.number(),
        }),
      })
      .optional(),
  }),
});

const historyResponseSchema = z.object({
  record: z.object({
    metrics: z
      .record(
        z.string(),
        z.object({
          percentilesTimeseries: z
            .object({ p75s: z.array(p75Schema.nullable()) })
            .optional(),
        }),
      )
      .default({}),
    collectionPeriods: z
      .array(
        z.object({
          lastDate: z.object({
            year: z.number(),
            month: z.number(),
            day: z.number(),
          }),
        }),
      )
      .default([]),
  }),
});

export type CruxMetricValue = {
  p75: number | null;
  // Share of page loads in each bucket, 0-1.
  good: number;
  needsImprovement: number;
  poor: number;
};

export type CruxRecord = {
  metrics: Partial<Record<CwvMetric, CruxMetricValue>>;
  collectionPeriod: { firstDate: string; lastDate: string } | null;
};

export type CruxHistory = {
  dates: string[];
  p75s: Partial<Record<CwvMetric, Array<number | null>>>;
};

export const CRUX_API_KEY_ENV = "CRUX_API_KEY";

export class CruxNotConfiguredError extends Error {
  constructor() {
    super(
      `Core Web Vitals need a Chrome UX Report API key. Set ${CRUX_API_KEY_ENV} (a Google Cloud API key with the Chrome UX Report API enabled).`,
    );
    this.name = "CruxNotConfiguredError";
  }
}

export class CruxApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CruxApiError";
  }
}

type CruxTarget = { origin: string } | { url: string };

function isoDate(d: { year: number; month: number; day: number }): string {
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

/** Chrome UX Report API. Field data from real Chrome users over the trailing
 *  28 days. Needs an API key (CRUX_API_KEY), not the user's OAuth grant. */
export function createCruxClient(apiKey: string) {
  async function post(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(
      `${CRUX_API_BASE}/${path}?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    // 404 means CrUX has too little traffic for this origin/URL.
    if (response.status === 404) return null;
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new CruxApiError(
        response.status,
        response.status === 429
          ? "Chrome UX Report rate limit reached. Retry shortly."
          : `Chrome UX Report API error (${response.status}): ${text.slice(0, 300)}`,
      );
    }
    return response.json();
  }

  return {
    async queryRecord(
      target: CruxTarget,
      formFactor: CruxFormFactor,
    ): Promise<CruxRecord | null> {
      const raw = await post("records:queryRecord", {
        ...target,
        formFactor,
        metrics: Object.values(CRUX_METRIC_IDS),
      });
      if (raw === null) return null;
      const { record } = recordResponseSchema.parse(raw);
      const metrics: CruxRecord["metrics"] = {};
      for (const metric of CWV_METRICS) {
        const value = record.metrics[CRUX_METRIC_IDS[metric]];
        if (!value) continue;
        const [good, ni, poor] = value.histogram.map((b) => b.density ?? 0);
        metrics[metric] = {
          p75: value.percentiles?.p75 ?? null,
          good: good ?? 0,
          needsImprovement: ni ?? 0,
          poor: poor ?? 0,
        };
      }
      return {
        metrics,
        collectionPeriod: record.collectionPeriod
          ? {
              firstDate: isoDate(record.collectionPeriod.firstDate),
              lastDate: isoDate(record.collectionPeriod.lastDate),
            }
          : null,
      };
    },

    /** CrUX History API: weekly p75s over the last ~6 months. */
    async queryHistory(
      target: CruxTarget,
      formFactor: CruxFormFactor,
    ): Promise<CruxHistory | null> {
      const raw = await post("records:queryHistoryRecord", {
        ...target,
        formFactor,
        metrics: Object.values(CRUX_METRIC_IDS),
      });
      if (raw === null) return null;
      const { record } = historyResponseSchema.parse(raw);
      const p75s: CruxHistory["p75s"] = {};
      for (const metric of CWV_METRICS) {
        const series =
          record.metrics[CRUX_METRIC_IDS[metric]]?.percentilesTimeseries?.p75s;
        if (series) p75s[metric] = series;
      }
      return {
        dates: record.collectionPeriods.map((p) => isoDate(p.lastDate)),
        p75s,
      };
    },
  };
}

import { z } from "zod";
import {
  buildStoredLighthouseIssues,
  buildStoredLighthouseMetrics,
  type RawLighthouseAudit,
  type RawLighthouseCategory,
  scoreToPercent,
} from "@/server/lib/lighthouseStoredPayload";
import type { LighthouseStrategy } from "@/server/lib/dataforseoLighthousePayload";
import { LIGHTHOUSE_CATEGORIES } from "@/shared/lighthouse";

const PAGESPEED_API_URL =
  "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

export const PAGESPEED_API_KEY_ENV = "PAGESPEED_API_KEY";

/** Google answers 429 for both the per-minute and the per-day limit; only the
 *  daily one names the day in its quota metric. */
export function isPageSpeedDailyQuotaError(error: PageSpeedApiError) {
  return error.status === 429 && /per\s*day/i.test(error.body);
}

export class PageSpeedApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body = "",
  ) {
    super(message);
    this.name = "PageSpeedApiError";
  }
}

// CrUX field data PSI attaches for the URL (or its origin). Metric keys are
// PSI's own ids, e.g. LARGEST_CONTENTFUL_PAINT_MS.
const loadingExperienceSchema = z
  .object({
    overall_category: z.string().optional(),
    metrics: z
      .record(
        z.string(),
        z.object({
          percentile: z.number().optional(),
          category: z.string().optional(),
        }),
      )
      .optional(),
  })
  .optional();

// Categories and audits stay the provider's own objects: the Lighthouse
// report is multi-MB and the shared builders read only a few fields of it.
const responseSchema = z.object({
  loadingExperience: loadingExperienceSchema,
  originLoadingExperience: loadingExperienceSchema,
  lighthouseResult: z.object({
    requestedUrl: z.string().optional(),
    finalUrl: z.string().optional(),
    lighthouseVersion: z.string().optional(),
    fetchTime: z.string().optional(),
    categories: z
      .record(z.string(), z.custom<RawLighthouseCategory>())
      .default({}),
    audits: z.record(z.string(), z.custom<RawLighthouseAudit>()).default({}),
  }),
});

type FieldData = {
  overall: string | null;
  metrics: Record<string, { p75: number | null; category: string | null }>;
} | null;

function toFieldData(
  experience: z.infer<typeof loadingExperienceSchema>,
): FieldData {
  const metrics = experience?.metrics;
  if (!metrics || Object.keys(metrics).length === 0) return null;
  return {
    overall: experience.overall_category ?? null,
    metrics: Object.fromEntries(
      Object.entries(metrics).map(([key, value]) => [
        key,
        { p75: value.percentile ?? null, category: value.category ?? null },
      ]),
    ),
  };
}

/** Google PageSpeed Insights: a Lighthouse lab run on Google's
 *  infrastructure plus CrUX field data. Free; works without a key on a small
 *  shared quota, 25,000 requests/day with one. */
export async function runPageSpeedInsights(input: {
  url: string;
  strategy: LighthouseStrategy;
  apiKey?: string;
}) {
  const params = new URLSearchParams({
    url: input.url,
    strategy: input.strategy,
  });
  for (const category of LIGHTHOUSE_CATEGORIES) {
    params.append("category", category.toUpperCase().replace("-", "_"));
  }
  if (input.apiKey) params.set("key", input.apiKey);

  // A Lighthouse run takes 10-40s; one stuck page must not hold a sweep batch.
  const response = await fetch(`${PAGESPEED_API_URL}?${params}`, {
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new PageSpeedApiError(
      response.status,
      response.status === 429
        ? `PageSpeed Insights rate limit reached.${input.apiKey ? "" : ` Set ${PAGESPEED_API_KEY_ENV} for a 25,000/day quota.`}`
        : `PageSpeed Insights error (${response.status}): ${text.slice(0, 300)}`,
      text,
    );
  }

  const { lighthouseResult, loadingExperience, originLoadingExperience } =
    responseSchema.parse(await response.json());
  const { categories, audits } = lighthouseResult;
  const urlField = toFieldData(loadingExperience);

  return {
    requestedUrl: lighthouseResult.requestedUrl ?? input.url,
    finalUrl: lighthouseResult.finalUrl ?? input.url,
    strategy: input.strategy,
    fetchedAt: lighthouseResult.fetchTime ?? new Date().toISOString(),
    lighthouseVersion: lighthouseResult.lighthouseVersion ?? null,
    scores: {
      performance: scoreToPercent(categories.performance?.score),
      accessibility: scoreToPercent(categories.accessibility?.score),
      "best-practices": scoreToPercent(categories["best-practices"]?.score),
      seo: scoreToPercent(categories.seo?.score),
    },
    metrics: buildStoredLighthouseMetrics({ audits }),
    // PSI falls back to origin-level field data when the URL itself has too
    // little Chrome traffic.
    fieldData: urlField ?? toFieldData(originLoadingExperience),
    fieldDataScope: urlField
      ? ("url" as const)
      : originLoadingExperience?.metrics
        ? ("origin" as const)
        : null,
    issues: buildStoredLighthouseIssues({ audits, categories }).issues,
  };
}

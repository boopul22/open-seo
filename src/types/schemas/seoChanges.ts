import { z } from "zod";
import {
  SEO_CHANGE_TYPES,
  type SeoChangeCheckpointKind,
  type SeoChangeDevice,
  type SeoChangeStatus,
  type SeoChangeTargetKind,
  type SeoChangeType,
} from "@/shared/seo-changes";

// Input and wire shapes for the SEO change log. The MCP tools and the server
// functions both validate against these, so the two entry points accept
// exactly the same change.

export const SEO_CHANGE_MAX_URLS = 20;
export const SEO_CHANGE_MAX_QUERIES = 20;
const SEO_CHANGE_MAX_SUMMARY_CHARS = 500;
const SEO_CHANGE_MAX_NOTES_CHARS = 4000;
const SEO_CHANGE_MAX_META_CHARS = 1000;
export const SEO_CHANGE_DEFAULT_LIST_LIMIT = 20;
export const SEO_CHANGE_MAX_LIST_LIMIT = 100;

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

function isValidTimeZone(value: string): boolean {
  try {
    // Throws a RangeError for an unknown zone.
    return (
      new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions()
        .timeZone.length > 0
    );
  } catch {
    return false;
  }
}

const optionalText = (max: number) =>
  z.string().trim().min(1).max(max).optional();

export const seoChangeInputSchema = z.object({
  shippedAt: z.iso
    .datetime({ offset: true })
    .describe(
      'When the change went live, as ISO 8601 with a Z or an offset, e.g. "2026-09-25T14:30:00+05:30". Up to 24 hours ahead is accepted for a change about to deploy.',
    ),
  timezone: z
    .string()
    .trim()
    .refine(isValidTimeZone, "Use an IANA time zone like Asia/Kolkata")
    .default("UTC")
    .describe(
      'IANA time zone the site owner works in, e.g. "Asia/Kolkata". Decides which calendar day the change counts as shipped on. Default UTC.',
    ),
  type: z.enum(SEO_CHANGE_TYPES),
  summary: z
    .string()
    .trim()
    .min(1)
    .max(SEO_CHANGE_MAX_SUMMARY_CHARS)
    .describe("One or two sentences: what changed and why."),
  urls: z
    .array(z.string().trim().min(1).max(2048))
    .min(1)
    .max(SEO_CHANGE_MAX_URLS)
    .describe(
      'Affected pages: full URLs ("https://example.com/pricing") or paths ("/pricing", "/" for the homepage). A trailing * matches a whole template, e.g. "/tools/*".',
    ),
  queries: z
    .array(z.string().trim().min(1).max(200))
    .max(SEO_CHANGE_MAX_QUERIES)
    .optional()
    .describe(
      "Search queries the change targets. Each is measured site-wide in Search Console.",
    ),
  titleBefore: optionalText(SEO_CHANGE_MAX_META_CHARS),
  titleAfter: optionalText(SEO_CHANGE_MAX_META_CHARS),
  metaDescriptionBefore: optionalText(SEO_CHANGE_MAX_META_CHARS),
  metaDescriptionAfter: optionalText(SEO_CHANGE_MAX_META_CHARS),
  commitHash: optionalText(100),
  deployId: optionalText(200).describe("Deploy or version ID."),
  prUrl: z.url().max(2048).optional().describe("Pull request link."),
  author: optionalText(100).describe(
    "Who shipped it: a person's name or the agent. Defaults to the signed-in user in the app and to the MCP client's name over MCP.",
  ),
  notes: optionalText(SEO_CHANGE_MAX_NOTES_CHARS),
});
export type SeoChangeInput = z.infer<typeof seoChangeInputSchema>;

export const seoChangeUpdateSchema = z.object({
  summary: z
    .string()
    .trim()
    .min(1)
    .max(SEO_CHANGE_MAX_SUMMARY_CHARS)
    .optional(),
  appendNote: optionalText(SEO_CHANGE_MAX_NOTES_CHARS).describe(
    "A note to add to the change, stamped with today's date. Existing notes are kept.",
  ),
  reverted: z
    .boolean()
    .optional()
    .describe(
      "true marks the change reverted; checkpoints that had not closed by the revert are skipped. false un-reverts it.",
    ),
  revertedAt: z.iso
    .datetime({ offset: true })
    .optional()
    .describe("When it was reverted (ISO 8601). Defaults to now."),
  commitHash: optionalText(100),
  deployId: optionalText(200),
  prUrl: z.url().max(2048).optional(),
});
export type SeoChangeUpdate = z.infer<typeof seoChangeUpdateSchema>;

export const seoChangeListFiltersSchema = z.object({
  url: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .optional()
    .describe(
      "Only changes affecting this page (full URL or path). Pattern targets like /tools/* match the pages under them.",
    ),
  type: z.enum(SEO_CHANGE_TYPES).optional(),
  from: dateSchema.optional().describe("Earliest ship date, YYYY-MM-DD."),
  to: dateSchema.optional().describe("Latest ship date, YYYY-MM-DD."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(SEO_CHANGE_MAX_LIST_LIMIT)
    .optional()
    .describe(
      `Newest ship date first. Default ${SEO_CHANGE_DEFAULT_LIST_LIMIT}, max ${SEO_CHANGE_MAX_LIST_LIMIT}.`,
    ),
});
export type SeoChangeListFilters = z.infer<typeof seoChangeListFiltersSchema>;

export type SeoChangeTarget = {
  id: string;
  kind: SeoChangeTargetKind;
  value: string;
};

export type SeoChange = {
  id: string;
  projectId: string;
  shippedAt: string;
  timezone: string;
  shipDate: string;
  type: SeoChangeType;
  summary: string;
  titleBefore: string | null;
  titleAfter: string | null;
  metaDescriptionBefore: string | null;
  metaDescriptionAfter: string | null;
  commitHash: string | null;
  deployId: string | null;
  prUrl: string | null;
  author: string;
  authorKind: "user" | "agent";
  notes: string | null;
  status: SeoChangeStatus;
  revertedAt: string | null;
  createdAt: string;
  updatedAt: string;
  targets: SeoChangeTarget[];
};

export type SeoChangeMetricValues = {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

type MetricComparison = {
  before: number;
  after: number;
  change: number;
  /** Relative change, null when the baseline is zero. */
  changePct: number | null;
};

export type SeoChangeDelta = {
  device: SeoChangeDevice;
  /** Per-day rates, so a 14-day window compares fairly with a 28-day baseline. */
  clicksPerDay: MetricComparison;
  impressionsPerDay: MetricComparison;
  /** 0..1; `change` is in absolute points. */
  ctr: MetricComparison;
  /** Lower is better; a negative `change` is an improvement. */
  position: MetricComparison;
};

export type SeoChangeNoiseFlag = "low_volume" | "matches_site_trend";

export type SeoChangeTargetImpact = {
  /** Null for the whole-site comparison row. */
  target: SeoChangeTarget | null;
  deltas: SeoChangeDelta[];
  /** Clicks-per-day change minus the site's, in percentage points. */
  clicksVsSitePts: number | null;
  noise: SeoChangeNoiseFlag[];
};

export type SeoChangeCheckpointSummary = {
  kind: SeoChangeCheckpointKind;
  windowStart: string;
  windowEnd: string;
  dueAt: string;
  status: "pending" | "measured" | "failed" | "skipped";
  measuredAt: string | null;
  error: string | null;
};

export type SeoChangeImpact = {
  change: SeoChange;
  checkpoints: SeoChangeCheckpointSummary[];
  baseline: {
    target: SeoChangeTarget | null;
    device: SeoChangeDevice;
    metrics: SeoChangeMetricValues;
  }[];
  /** One entry per measured post-change checkpoint. */
  results: {
    kind: Exclude<SeoChangeCheckpointKind, "baseline">;
    windowStart: string;
    windowEnd: string;
    targets: SeoChangeTargetImpact[];
  }[];
};

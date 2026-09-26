// Shared vocabulary for the SEO change log: the DB enums, the MCP tool and
// server-function schemas, and the app all read these, so a new change type or
// checkpoint is added in one place.

export const SEO_CHANGE_TYPES = [
  "title_meta",
  "content",
  "internal_links",
  "schema",
  "redirect_canonical",
  "technical_performance",
  "other",
] as const;
export type SeoChangeType = (typeof SEO_CHANGE_TYPES)[number];

export const SEO_CHANGE_TYPE_LABELS: Record<SeoChangeType, string> = {
  title_meta: "Title / meta",
  content: "Content",
  internal_links: "Internal links",
  schema: "Schema",
  redirect_canonical: "Redirect / canonical",
  technical_performance: "Technical / performance",
  other: "Other",
};

export const SEO_CHANGE_TARGET_KINDS = [
  "page",
  "page_pattern",
  "query",
] as const;
export type SeoChangeTargetKind = (typeof SEO_CHANGE_TARGET_KINDS)[number];

export const SEO_CHANGE_CHECKPOINT_KINDS = [
  "baseline",
  "day_14",
  "day_28",
] as const;
export type SeoChangeCheckpointKind =
  (typeof SEO_CHANGE_CHECKPOINT_KINDS)[number];

export const SEO_CHANGE_CHECKPOINT_STATUSES = [
  "pending",
  "measured",
  "failed",
  "skipped",
] as const;

export const SEO_CHANGE_DEVICES = [
  "all",
  "desktop",
  "mobile",
  "tablet",
] as const;
export type SeoChangeDevice = (typeof SEO_CHANGE_DEVICES)[number];

export const SEO_CHANGE_STATUSES = ["active", "reverted"] as const;
export type SeoChangeStatus = (typeof SEO_CHANGE_STATUSES)[number];

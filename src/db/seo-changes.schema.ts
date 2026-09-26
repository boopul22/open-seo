import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import {
  SEO_CHANGE_CHECKPOINT_KINDS,
  SEO_CHANGE_CHECKPOINT_STATUSES,
  SEO_CHANGE_DEVICES,
  SEO_CHANGE_STATUSES,
  SEO_CHANGE_TARGET_KINDS,
  SEO_CHANGE_TYPES,
} from "@/shared/seo-changes";
import { projects } from "./app.schema";

// ============================================================================
// SEO change log: what was shipped to a site, and what it did. A change owns
// its targets (pages, page patterns, queries) and its checkpoints (baseline,
// +14 days, +28 days). Each checkpoint stores its own Search Console metrics,
// so a later GSC refresh or the 16-month retention cutoff can never rewrite a
// measurement that was already taken.
// ============================================================================

export const seoChanges = sqliteTable(
  "seo_changes",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // ISO instant (UTC) the change went live.
    shippedAt: text("shipped_at").notNull(),
    // IANA zone the author reported the time in ("Asia/Kolkata").
    timezone: text("timezone").notNull(),
    // YYYY-MM-DD of shippedAt in `timezone`. Every measurement window is
    // anchored to this day, and it is what date filters and chart markers use.
    shipDate: text("ship_date").notNull(),
    type: text("type", { enum: SEO_CHANGE_TYPES }).notNull(),
    summary: text("summary").notNull(),
    titleBefore: text("title_before"),
    titleAfter: text("title_after"),
    metaDescriptionBefore: text("meta_description_before"),
    metaDescriptionAfter: text("meta_description_after"),
    commitHash: text("commit_hash"),
    deployId: text("deploy_id"),
    prUrl: text("pr_url"),
    // Display attribution: a person's name or the agent that shipped it
    // ("Claude Code"). Self-reported, so nothing authorizes on it.
    author: text("author").notNull(),
    authorKind: text("author_kind", { enum: ["user", "agent"] }).notNull(),
    // Identity half of attribution. No FK, mirroring reports, so GDPR can
    // re-attribute an erased user without cascading the log away.
    createdByUserId: text("created_by_user_id").notNull(),
    notes: text("notes"),
    status: text("status", { enum: SEO_CHANGE_STATUSES }).notNull(),
    revertedAt: text("reverted_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    index("seo_changes_project_ship_date_idx").on(
      table.projectId,
      table.shipDate,
    ),
  ],
);

// One row per affected page, page pattern ("/tools/*") or target query.
export const seoChangeTargets = sqliteTable(
  "seo_change_targets",
  {
    id: text("id").primaryKey(),
    changeId: text("change_id")
      .notNull()
      .references(() => seoChanges.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: SEO_CHANGE_TARGET_KINDS }).notNull(),
    value: text("value").notNull(),
  },
  (table) => [
    uniqueIndex("seo_change_targets_change_kind_value_idx").on(
      table.changeId,
      table.kind,
      table.value,
    ),
  ],
);

// One row per measurement window. The baseline is the 28 days before the ship
// date; day_14/day_28 are the 14/28 days after it. `dueAt` is when the window's
// data is complete in Search Console; the cron measures pending rows past it.
export const seoChangeCheckpoints = sqliteTable(
  "seo_change_checkpoints",
  {
    id: text("id").primaryKey(),
    changeId: text("change_id")
      .notNull()
      .references(() => seoChanges.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: SEO_CHANGE_CHECKPOINT_KINDS }).notNull(),
    windowStart: text("window_start").notNull(),
    windowEnd: text("window_end").notNull(),
    dueAt: text("due_at").notNull(),
    status: text("status", { enum: SEO_CHANGE_CHECKPOINT_STATUSES }).notNull(),
    measuredAt: text("measured_at"),
    // Why the last attempt failed, or why the checkpoint was skipped.
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
  },
  (table) => [
    uniqueIndex("seo_change_checkpoints_change_kind_idx").on(
      table.changeId,
      table.kind,
    ),
    index("seo_change_checkpoints_status_due_idx").on(
      table.status,
      table.dueAt,
    ),
  ],
);

// Search Console totals for one checkpoint, per target and device. A null
// target_id is the whole site over the same window — the comparison that
// separates a change's effect from a sitewide trend.
export const seoChangeMetrics = sqliteTable(
  "seo_change_metrics",
  {
    id: text("id").primaryKey(),
    checkpointId: text("checkpoint_id")
      .notNull()
      .references(() => seoChangeCheckpoints.id, { onDelete: "cascade" }),
    targetId: text("target_id").references(() => seoChangeTargets.id, {
      onDelete: "cascade",
    }),
    device: text("device", { enum: SEO_CHANGE_DEVICES }).notNull(),
    clicks: integer("clicks").notNull(),
    impressions: integer("impressions").notNull(),
    // 0..1; impression-weighted average position, 0 without impressions.
    ctr: real("ctr").notNull(),
    position: real("position").notNull(),
  },
  (table) => [
    index("seo_change_metrics_checkpoint_idx").on(table.checkpointId),
  ],
);

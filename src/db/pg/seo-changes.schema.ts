import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  SEO_CHANGE_CHECKPOINT_KINDS,
  SEO_CHANGE_CHECKPOINT_STATUSES,
  SEO_CHANGE_DEVICES,
  SEO_CHANGE_STATUSES,
  SEO_CHANGE_TARGET_KINDS,
  SEO_CHANGE_TYPES,
} from "@/shared/seo-changes";
import { projects } from "./app.schema";

// Same text timestamps as the SQLite schema; see pg/app.schema.ts.
const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// Column notes live in the SQLite schema (src/db/seo-changes.schema.ts).

export const seoChanges = pgTable(
  "seo_changes",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    shippedAt: text("shipped_at").notNull(),
    timezone: text("timezone").notNull(),
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
    author: text("author").notNull(),
    authorKind: text("author_kind", { enum: ["user", "agent"] }).notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    notes: text("notes"),
    status: text("status", { enum: SEO_CHANGE_STATUSES }).notNull(),
    revertedAt: text("reverted_at"),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (table) => [
    index("seo_changes_project_ship_date_idx").on(
      table.projectId,
      table.shipDate,
    ),
  ],
);

export const seoChangeTargets = pgTable(
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

export const seoChangeCheckpoints = pgTable(
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

export const seoChangeMetrics = pgTable(
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
    ctr: real("ctr").notNull(),
    position: real("position").notNull(),
  },
  (table) => [
    index("seo_change_metrics_checkpoint_idx").on(table.checkpointId),
  ],
);

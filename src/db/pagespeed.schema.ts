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
  PAGESPEED_RESULT_STATUSES,
  PAGESPEED_SWEEP_STATUSES,
} from "@/shared/pagespeed";
import { projects } from "./app.schema";

// ============================================================================
// Sitemap-wide PageSpeed: one sweep per weekly audit runs mobile PageSpeed
// Insights on every sitemap URL. Progress lives on the result rows, so a
// retried step or relaunched workflow continues where it stopped. The two
// latest completed sweeps per project are kept for a week-over-week diff.
// ============================================================================

export const pagespeedSweeps = sqliteTable(
  "pagespeed_sweeps",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    startUrl: text("start_url").notNull(),
    status: text("status", { enum: PAGESPEED_SWEEP_STATUSES }).notNull(),
    // Workflow instance ids are `${id}-${attempt}`; a relaunch bumps attempt.
    attempt: integer("attempt").notNull().default(0),
    urlsTotal: integer("urls_total").notNull().default(0),
    urlsDone: integer("urls_done").notNull().default(0),
    urlsFailed: integer("urls_failed").notNull().default(0),
    // Set while status = waiting_quota: when the daily quota resets.
    resumeAt: text("resume_at"),
    error: text("error"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    startedAt: text("started_at"),
    // Last time a batch made progress; the cron relaunches a running sweep
    // whose heartbeat went stale (dead workflow instance).
    heartbeatAt: text("heartbeat_at"),
    completedAt: text("completed_at"),
  },
  (table) => [
    index("pagespeed_sweeps_project_idx").on(table.projectId),
    index("pagespeed_sweeps_status_idx").on(table.status),
  ],
);

export const pagespeedResults = sqliteTable(
  "pagespeed_results",
  {
    id: text("id").primaryKey(),
    sweepId: text("sweep_id")
      .notNull()
      .references(() => pagespeedSweeps.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    status: text("status", { enum: PAGESPEED_RESULT_STATUSES })
      .notNull()
      .default("pending"),
    error: text("error"),
    fetchedAt: text("fetched_at"),
    // Lighthouse category scores, 0-100.
    performance: integer("performance"),
    accessibility: integer("accessibility"),
    bestPractices: integer("best_practices"),
    seo: integer("seo"),
    // Lab metrics from the Lighthouse run.
    lcpMs: real("lcp_ms"),
    cls: real("cls"),
    tbtMs: real("tbt_ms"),
    fcpMs: real("fcp_ms"),
    speedIndexMs: real("speed_index_ms"),
    // CrUX field data (p75) when Chrome has enough traffic; scope says whether
    // it is this URL's or the whole origin's.
    fieldScope: text("field_scope", { enum: ["url", "origin"] }),
    fieldOverall: text("field_overall"),
    fieldLcpMs: real("field_lcp_ms"),
    fieldInpMs: real("field_inp_ms"),
    fieldCls: real("field_cls"),
  },
  (table) => [
    uniqueIndex("pagespeed_results_sweep_url_idx").on(table.sweepId, table.url),
    index("pagespeed_results_sweep_status_idx").on(table.sweepId, table.status),
  ],
);

// The top failing Lighthouse audits for one result.
export const pagespeedResultIssues = sqliteTable(
  "pagespeed_result_issues",
  {
    id: text("id").primaryKey(),
    resultId: text("result_id")
      .notNull()
      .references(() => pagespeedResults.id, { onDelete: "cascade" }),
    auditKey: text("audit_key").notNull(),
    category: text("category").notNull(),
    title: text("title").notNull(),
    severity: text("severity", {
      enum: ["critical", "warning", "info"],
    }).notNull(),
    displayValue: text("display_value"),
    impactMs: real("impact_ms"),
    impactBytes: real("impact_bytes"),
  },
  (table) => [
    index("pagespeed_result_issues_result_idx").on(table.resultId),
    index("pagespeed_result_issues_audit_key_idx").on(table.auditKey),
  ],
);

// PageSpeed Insights calls per Google quota day (Pacific), for the one API key
// the server uses.
export const pagespeedUsage = sqliteTable("pagespeed_usage", {
  day: text("day").primaryKey(),
  used: integer("used").notNull().default(0),
});

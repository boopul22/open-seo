import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  GSC_INSPECTION_LINK_KINDS,
  GSC_SWEEP_KINDS,
  GSC_SWEEP_STATUSES,
  GSC_SWEEP_TRIGGERS,
} from "@/shared/gsc-index";
import { projects } from "./app.schema";

// Same text timestamps as the SQLite schema; see pg/app.schema.ts.
const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// Column notes live in the SQLite schema (src/db/gsc-index.schema.ts).

export const gscSitemaps = pgTable(
  "gsc_sitemaps",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    parentPath: text("parent_path"),
    type: text("type"),
    isPending: boolean("is_pending").notNull().default(false),
    isSitemapsIndex: boolean("is_sitemaps_index").notNull().default(false),
    lastSubmitted: text("last_submitted"),
    lastDownloaded: text("last_downloaded"),
    errors: integer("errors").notNull().default(0),
    warnings: integer("warnings").notNull().default(0),
    fetchedAt: text("fetched_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("gsc_sitemaps_project_path_idx").on(
      table.projectId,
      table.path,
    ),
  ],
);

export const gscSitemapContents = pgTable(
  "gsc_sitemap_contents",
  {
    id: text("id").primaryKey(),
    sitemapId: text("sitemap_id")
      .notNull()
      .references(() => gscSitemaps.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    submitted: integer("submitted").notNull().default(0),
  },
  (table) => [
    uniqueIndex("gsc_sitemap_contents_sitemap_type_idx").on(
      table.sitemapId,
      table.type,
    ),
  ],
);

export const gscIndexUrls = pgTable(
  "gsc_index_urls",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    inSitemap: boolean("in_sitemap").notNull().default(false),
    inSearchAnalytics: boolean("in_search_analytics").notNull().default(false),
    impressions: integer("impressions").notNull().default(0),
    discoveredAt: text("discovered_at").notNull().default(isoNow),
    requestedAt: text("requested_at"),
    lastInspectedAt: text("last_inspected_at"),
    lastInspectionId: text("last_inspection_id"),
    coverageStateSince: text("coverage_state_since"),
  },
  (table) => [
    uniqueIndex("gsc_index_urls_project_url_idx").on(
      table.projectId,
      table.url,
    ),
    index("gsc_index_urls_queue_idx").on(
      table.projectId,
      table.lastInspectedAt,
    ),
  ],
);

export const gscUrlInspections = pgTable(
  "gsc_url_inspections",
  {
    id: text("id").primaryKey(),
    urlId: text("url_id")
      .notNull()
      .references(() => gscIndexUrls.id, { onDelete: "cascade" }),
    inspectedAt: text("inspected_at").notNull(),
    error: text("error"),
    verdict: text("verdict"),
    coverageState: text("coverage_state"),
    robotsTxtState: text("robots_txt_state"),
    indexingState: text("indexing_state"),
    pageFetchState: text("page_fetch_state"),
    lastCrawlTime: text("last_crawl_time"),
    crawledAs: text("crawled_as"),
    googleCanonical: text("google_canonical"),
    userCanonical: text("user_canonical"),
    richResultsVerdict: text("rich_results_verdict"),
    mobileUsabilityVerdict: text("mobile_usability_verdict"),
    inspectionLink: text("inspection_link"),
    pageTitle: text("page_title"),
    pageMetaDescription: text("page_meta_description"),
    pageHttpStatus: integer("page_http_status"),
  },
  (table) => [
    index("gsc_url_inspections_url_idx").on(table.urlId, table.inspectedAt),
  ],
);

export const gscUrlInspectionLinks = pgTable(
  "gsc_url_inspection_links",
  {
    id: text("id").primaryKey(),
    inspectionId: text("inspection_id")
      .notNull()
      .references(() => gscUrlInspections.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: GSC_INSPECTION_LINK_KINDS }).notNull(),
    url: text("url").notNull(),
  },
  (table) => [
    index("gsc_url_inspection_links_inspection_idx").on(table.inspectionId),
  ],
);

export const gscUrlRichResultIssues = pgTable(
  "gsc_url_rich_result_issues",
  {
    id: text("id").primaryKey(),
    inspectionId: text("inspection_id")
      .notNull()
      .references(() => gscUrlInspections.id, { onDelete: "cascade" }),
    richResultType: text("rich_result_type").notNull(),
    itemName: text("item_name"),
    issueMessage: text("issue_message"),
    severity: text("severity"),
  },
  (table) => [
    index("gsc_url_rich_result_issues_inspection_idx").on(table.inspectionId),
  ],
);

export const gscIndexSweeps = pgTable(
  "gsc_index_sweeps",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    siteUrl: text("site_url").notNull(),
    kind: text("kind", { enum: GSC_SWEEP_KINDS }).notNull(),
    trigger: text("trigger", { enum: GSC_SWEEP_TRIGGERS }).notNull(),
    status: text("status", { enum: GSC_SWEEP_STATUSES }).notNull(),
    totalUrls: integer("total_urls").notNull().default(0),
    inspectedCount: integer("inspected_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    attempt: integer("attempt").notNull().default(0),
    resumeAt: text("resume_at"),
    error: text("error"),
    createdAt: text("created_at").notNull().default(isoNow),
    finishedAt: text("finished_at"),
  },
  (table) => [
    index("gsc_index_sweeps_project_idx").on(table.projectId, table.createdAt),
    uniqueIndex("gsc_index_sweeps_one_active_per_project_idx")
      .on(table.projectId)
      .where(
        sql`${table.status} IN ('queued', 'collecting', 'running', 'waiting_quota')`,
      ),
  ],
);

export const gscInspectionUsage = pgTable(
  "gsc_inspection_usage",
  {
    id: text("id").primaryKey(),
    siteUrl: text("site_url").notNull(),
    day: text("day").notNull(),
    used: integer("used").notNull().default(0),
  },
  (table) => [
    uniqueIndex("gsc_inspection_usage_site_day_idx").on(
      table.siteUrl,
      table.day,
    ),
  ],
);

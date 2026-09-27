import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import {
  GSC_INSPECTION_LINK_KINDS,
  GSC_SWEEP_KINDS,
  GSC_SWEEP_STATUSES,
  GSC_SWEEP_TRIGGERS,
} from "@/shared/gsc-index";
import { projects } from "./app.schema";

const isoNow = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

// ============================================================================
// Search Console sitemaps and index coverage. Google exposes no API for the
// Page indexing report, so OpenSEO rebuilds it: collect the property's URL set
// (sitemaps + Search Analytics pages), inspect each URL with the URL
// Inspection API under its 2,000/day quota, and group the latest results by
// Google's coverage reason.
// ============================================================================

// Latest sitemaps.list snapshot per project. Refreshed wholesale on each read
// from Google; child sitemaps of an index carry their index's path.
export const gscSitemaps = sqliteTable(
  "gsc_sitemaps",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    parentPath: text("parent_path"),
    type: text("type"),
    isPending: integer("is_pending", { mode: "boolean" })
      .notNull()
      .default(false),
    isSitemapsIndex: integer("is_sitemaps_index", { mode: "boolean" })
      .notNull()
      .default(false),
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

// sitemaps.contents: submitted URL counts per content type (web, image, ...).
export const gscSitemapContents = sqliteTable(
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

// The URL set a sweep inspects, with its queue state. `lastInspectionId`
// points at the latest history row, which holds the inspection fields.
export const gscIndexUrls = sqliteTable(
  "gsc_index_urls",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    inSitemap: integer("in_sitemap", { mode: "boolean" })
      .notNull()
      .default(false),
    inSearchAnalytics: integer("in_search_analytics", { mode: "boolean" })
      .notNull()
      .default(false),
    // Search impressions over the last 16 months; breaks queue-order ties.
    impressions: integer("impressions").notNull().default(0),
    discoveredAt: text("discovered_at").notNull().default(isoNow),
    // Set when a caller asks for this URL specifically; such URLs jump the
    // queue and the flag clears once inspected.
    requestedAt: text("requested_at"),
    lastInspectedAt: text("last_inspected_at"),
    lastInspectionId: text("last_inspection_id"),
    // When the URL entered its current coverage state (Google's reason). Drives
    // "new issues since the last sweep".
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

// One row per inspection attempt. A failed attempt keeps `error` and no
// result fields, so a bad URL never blocks the rest of a sweep.
export const gscUrlInspections = sqliteTable(
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
    // From OpenSEO fetching the live page at inspection time. Google's APIs
    // return no titles, so this is the page's own <title>, not the SERP title.
    pageTitle: text("page_title"),
    pageMetaDescription: text("page_meta_description"),
    pageHttpStatus: integer("page_http_status"),
  },
  (table) => [
    index("gsc_url_inspections_url_idx").on(table.urlId, table.inspectedAt),
  ],
);

// indexStatusResult.sitemap[] and referringUrls[].
export const gscUrlInspectionLinks = sqliteTable(
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

// richResultsResult.detectedItems flattened to one row per item issue. An item
// with no issues is one row with a null issue, so detected types still count.
export const gscUrlRichResultIssues = sqliteTable(
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

// A sweep inspects the URL set until every URL has a result newer than the
// sweep's start. Progress lives on the URL rows, so a sweep resumes exactly
// where it stopped after a quota pause or a restarted workflow.
export const gscIndexSweeps = sqliteTable(
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
    // Bumped when a paused sweep gets a fresh workflow instance.
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

// URL Inspection calls spent per property per Pacific-time day. Keyed by the
// property, not the project, because Google meters the property.
export const gscInspectionUsage = sqliteTable(
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

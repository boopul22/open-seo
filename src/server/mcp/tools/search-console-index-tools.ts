/* eslint-disable max-lines */
import { z } from "zod";
import { buildProjectMeta, type ToolContext } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { hasSelfHostedGoogleOAuthConfig } from "@/server/features/google/oauth-config";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import { GscService } from "@/server/features/gsc/services/GscService";
import { GscIndexService } from "@/server/features/gsc/services/GscIndexService";
import { GscHealthService } from "@/server/features/gsc/services/GscHealthService";
import {
  CruxService,
  MAX_TOP_PAGES,
} from "@/server/features/gsc/services/CruxService";
import { CruxApiError, CruxNotConfiguredError } from "@/server/lib/cruxClient";
import { GscNotConnectedError } from "@/server/lib/gscErrors";
import {
  connectGscUrl,
  describeGscError,
  missingSelfHostedGoogleClientResponse,
} from "@/server/mcp/tools/search-console-tools";
import type { IndexStatus } from "@/server/features/gsc/indexCoverage";
import { GSC_REPORTS_WITHOUT_API } from "@/shared/gsc-index";
import { CRUX_FORM_FACTORS } from "@/shared/core-web-vitals";
import { GSC_SELF_HOSTED_SETUP_DOCS_URL } from "@/shared/gsc";

const INDEX_STATUSES = [
  "indexed",
  "not_indexed",
  "error",
  "uninspected",
] as const;

const READ_ONLY = {
  readOnlyHint: true,
  openWorldHint: false,
  destructiveHint: false,
} as const;

const baseOutput = {
  ok: z.boolean(),
  reason: z.string().optional(),
  connectUrl: z.string().optional(),
  setupDocsUrl: z.string().optional(),
  siteUrl: z.string().optional(),
  ...optionalMetaOutputSchema,
};

type ProjectContext = Parameters<Parameters<typeof withMcpProjectAuth>[0]>[1];
type Meta = ReturnType<typeof buildProjectMeta>;

function indexingPath(projectId: string) {
  return `/p/${projectId}/indexing`;
}

/** Shared shell for project-scoped Search Console tools: the self-hosted
 *  OAuth setup gate, the dashboard link, and uniform error results. */
function gscTool<TArgs extends { projectId: string }>(
  run: (
    args: TArgs,
    context: ProjectContext,
    meta: Meta,
  ) => Promise<ReturnType<typeof mcpResponse>>,
) {
  return withMcpProjectAuth(async (args: TArgs, context) => {
    const blocked = await missingSelfHostedGoogleClientResponse(
      context,
      args.projectId,
    );
    if (blocked) return blocked;
    const meta = buildProjectMeta(
      context,
      args.projectId,
      indexingPath(args.projectId),
    );
    try {
      // Stored sweep data outlives a disconnect; report the connection state
      // rather than an empty "ok".
      if (!(await GscService.getConnection(args.projectId))) {
        throw new GscNotConnectedError(args.projectId);
      }
      return await run(args, context, meta);
    } catch (error) {
      const connectUrl = connectGscUrl(context.baseUrl, args.projectId);
      const isNotConnected = error instanceof GscNotConnectedError;
      return mcpResponse({
        text: `${describeGscError(error)}${isNotConnected ? ` Connect it here: ${connectUrl}` : ` (reconnect at ${connectUrl} if this persists)`}`,
        meta,
        structuredContent: {
          ok: false,
          reason: isNotConnected ? "not_connected" : "api_error",
          connectUrl,
        },
      });
    }
  });
}

function percent(n: number): string {
  return `${n.toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// list_gsc_properties
// ---------------------------------------------------------------------------

export const listGscPropertiesTool = {
  name: "list_gsc_properties",
  config: {
    title: "List Search Console properties",
    description:
      "List every Google Search Console property the user's connected Google account(s) can see, with permission level and whether each is a Domain property (sc-domain:, covers all hosts and protocols) or a URL-prefix property. Use it to pick the right property before connecting one to a project. Read-only; uses no credits.",
    inputSchema: {} as Record<string, never>,
    outputSchema: z.looseObject({
      ...baseOutput,
      accounts: z
        .array(
          z.looseObject({
            email: z.string().nullable(),
            requiresReconnect: z.boolean(),
            properties: z.array(
              z.looseObject({
                siteUrl: z.string(),
                permissionLevel: z.string(),
                propertyType: z.enum(["domain", "url_prefix"]),
                verified: z.boolean(),
              }),
            ),
          }),
        )
        .optional(),
    }),
    annotations: READ_ONLY,
  },
  handler: async (_args: Record<string, never>, toolContext: ToolContext) => {
    const [hosted, configured] = await Promise.all([
      isHostedServerAuthMode(),
      hasSelfHostedGoogleOAuthConfig(),
    ]);
    if (!hosted && !configured) {
      return mcpResponse({
        text: `Search Console isn't configured on this self-hosted deployment. Setup docs: ${GSC_SELF_HOSTED_SETUP_DOCS_URL}`,
        structuredContent: {
          ok: false,
          reason: "gsc_oauth_not_configured",
          setupDocsUrl: GSC_SELF_HOSTED_SETUP_DOCS_URL,
        },
      });
    }
    const { accounts } = await GscService.listSitesForUserWithGrantStatus(
      toolContext.auth.userId,
    );
    const shaped = accounts.map((account) => ({
      email: account.email,
      requiresReconnect: account.requiresReconnect,
      properties: account.sites.map((site) => ({
        siteUrl: site.siteUrl,
        permissionLevel: site.permissionLevel,
        propertyType: site.siteUrl.startsWith("sc-domain:")
          ? ("domain" as const)
          : ("url_prefix" as const),
        verified: site.permissionLevel !== "siteUnverifiedUser",
      })),
    }));
    const lines = shaped.flatMap((account) => [
      `${account.email ?? "(unknown account)"}${account.requiresReconnect ? " — reconnect required" : ""}`,
      ...account.properties.map(
        (p) =>
          `  ${p.siteUrl} · ${p.propertyType === "domain" ? "Domain" : "URL-prefix"} · ${p.permissionLevel}`,
      ),
    ]);
    return mcpResponse({
      text:
        shaped.length === 0
          ? "No Google account is connected for Search Console. Connect one from a project's Search Performance page."
          : lines.join("\n"),
      structuredContent: { ok: true, accounts: shaped },
    });
  },
};

// ---------------------------------------------------------------------------
// get_sitemaps
// ---------------------------------------------------------------------------

const sitemapsInput = {
  projectId: projectIdSchema,
  refresh: z
    .boolean()
    .optional()
    .describe(
      "Re-read from Google (default true). false returns the last stored snapshot.",
    ),
} as const;

export const getSitemapsTool = {
  name: "get_sitemaps",
  config: {
    title: "Get Search Console sitemaps",
    description:
      "List the sitemaps submitted to the project's Search Console property: path, type, pending state, last submitted/downloaded, error and warning counts, submitted URL counts per content type, and the child sitemaps of each sitemap index (parentPath). Use it to answer 'are my sitemaps healthy?'. Read-only; uses no credits.",
    inputSchema: sitemapsInput,
    outputSchema: z.looseObject({
      ...baseOutput,
      totals: z.looseObject({}).optional(),
      sitemaps: z.array(z.looseObject({ path: z.string() })).optional(),
    }),
    annotations: READ_ONLY,
  },
  handler: gscTool(
    async (
      args: z.infer<z.ZodObject<typeof sitemapsInput>>,
      _context,
      meta,
    ) => {
      const { sitemaps, totals } = await GscIndexService.getSitemaps(
        args.projectId,
        {
          refresh: args.refresh ?? true,
        },
      );
      const shaped = sitemaps.map((s) => ({
        path: s.path,
        parentPath: s.parentPath,
        type: s.type,
        isSitemapsIndex: s.isSitemapsIndex,
        isPending: s.isPending,
        lastSubmitted: s.lastSubmitted,
        lastDownloaded: s.lastDownloaded,
        errors: s.errors,
        warnings: s.warnings,
        contents: s.contents,
      }));
      const lines = shaped.map(
        (s) =>
          `${s.parentPath ? "  ↳ " : ""}${s.path} · ${s.isSitemapsIndex ? "index" : (s.type ?? "sitemap")} · ${s.errors} errors, ${s.warnings} warnings${s.isPending ? " · pending" : ""}${s.lastDownloaded ? ` · read ${s.lastDownloaded.slice(0, 10)}` : ""}`,
      );
      return mcpResponse({
        text:
          shaped.length === 0
            ? "No sitemaps are submitted for this property."
            : `${totals.sitemaps} sitemaps · ${totals.errors} errors · ${totals.warnings} warnings · ${totals.submittedUrls} submitted URLs\n${lines.join("\n")}`,
        meta,
        structuredContent: { ok: true, totals, sitemaps: shaped },
      });
    },
  ),
};

// ---------------------------------------------------------------------------
// submit_sitemap / delete_sitemap (listed only for write-scoped grants)
// ---------------------------------------------------------------------------

const sitemapWriteInput = {
  projectId: projectIdSchema,
  feedpath: z
    .string()
    .url()
    .describe("Absolute sitemap URL, e.g. https://example.com/sitemap.xml."),
} as const;

function sitemapWriteTool(kind: "submit" | "delete") {
  return gscTool(
    async (
      args: z.infer<z.ZodObject<typeof sitemapWriteInput>>,
      _context,
      meta,
    ) => {
      const { connection } = await GscService.getProjectClient(args.projectId);
      if (!(await GscService.connectionCanWrite(connection))) {
        return mcpResponse({
          text: "This project's Search Console connection is read-only. Enable sitemap management on the project's Indexing page (it asks Google for write access), then retry.",
          meta,
          structuredContent: { ok: false, reason: "write_scope_missing" },
        });
      }
      const sitemaps =
        kind === "submit"
          ? await GscIndexService.submitSitemap(args.projectId, args.feedpath)
          : await GscIndexService.deleteSitemap(args.projectId, args.feedpath);
      return mcpResponse({
        text: `${kind === "submit" ? "Submitted" : "Deleted"} ${args.feedpath}. The property now lists ${sitemaps.length} sitemap(s).`,
        meta,
        structuredContent: {
          ok: true,
          siteUrl: connection.siteUrl,
          sitemaps: sitemaps.map((s) => ({
            path: s.path,
            isPending: s.isPending,
          })),
        },
      });
    },
  );
}

const sitemapWriteOutput = z.looseObject({
  ...baseOutput,
  sitemaps: z.array(z.looseObject({ path: z.string() })).optional(),
});

export const submitSitemapTool = {
  name: "submit_sitemap",
  config: {
    title: "Submit a sitemap to Search Console",
    description:
      "Submit (or resubmit) a sitemap URL to the project's Search Console property. Only available when the Search Console connection was granted write access. Uses no credits.",
    inputSchema: sitemapWriteInput,
    outputSchema: sitemapWriteOutput,
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: false,
    },
  },
  handler: sitemapWriteTool("submit"),
};

export const deleteSitemapTool = {
  name: "delete_sitemap",
  config: {
    title: "Delete a sitemap from Search Console",
    description:
      "Remove a sitemap from the project's Search Console property. Google stops reading it; pages stay indexed. Confirm with the user first. Only available when the Search Console connection was granted write access. Uses no credits.",
    inputSchema: sitemapWriteInput,
    outputSchema: sitemapWriteOutput,
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: true,
    },
  },
  handler: sitemapWriteTool("delete"),
};

// ---------------------------------------------------------------------------
// get_index_coverage
// ---------------------------------------------------------------------------

const coverageInput = {
  projectId: projectIdSchema,
  state: z
    .enum(INDEX_STATUSES)
    .optional()
    .describe("Only list reasons in this status. Default: all."),
  limit: z
    .number()
    .int()
    .min(0)
    .max(50)
    .optional()
    .describe("Sample URLs per reason (default 10, 0 for counts only)."),
} as const;

function sweepSummary(
  status: Awaited<ReturnType<typeof GscIndexService.getSweepStatus>>,
) {
  return {
    active: status.active
      ? {
          id: status.active.id,
          kind: status.active.kind,
          status: status.active.status,
          inspected: status.active.inspectedCount,
          errors: status.active.errorCount,
          total: status.active.totalUrls,
          startedAt: status.active.createdAt,
          resumeAt: status.active.resumeAt,
        }
      : null,
    lastCompletedAt: status.lastCompleted?.finishedAt ?? null,
    pendingUrls: status.pending,
    quota: status.quota,
  };
}

export const getIndexCoverageTool = {
  name: "get_index_coverage",
  config: {
    title: "Get index coverage (Page indexing)",
    description:
      "OpenSEO's rebuild of Search Console's Page indexing report. Google has no API for that report, so OpenSEO inspects every URL in the property's sitemaps and Search Analytics pages with the URL Inspection API (2,000 per day) and groups the latest results by Google's own reason ('Crawled - currently not indexed', 'Duplicate, Google chose different canonical than user', 'Not found (404)', ...). Returns counts by status and by reason with sample URLs, how many entered each reason since the previous sweep (newCount), the share of the URL set inspected so far, and sweep/quota status. If inspectedPercent is low, say so: counts cover only inspected URLs. Use list_index_issues for the full URL list of one reason. Read-only; uses no credits.",
    inputSchema: coverageInput,
    outputSchema: z.looseObject({
      ...baseOutput,
      totalUrls: z.number().optional(),
      inspectedUrls: z.number().optional(),
      inspectedPercent: z.number().optional(),
      byStatus: z.looseObject({}).optional(),
      reasons: z
        .array(
          z.looseObject({
            reason: z.string(),
            status: z.string(),
            count: z.number(),
            newCount: z.number(),
          }),
        )
        .optional(),
      sweep: z.looseObject({}).optional(),
    }),
    annotations: READ_ONLY,
  },
  handler: gscTool(
    async (
      args: z.infer<z.ZodObject<typeof coverageInput>>,
      _context,
      meta,
    ) => {
      const [coverage, status] = await Promise.all([
        GscIndexService.getCoverage(args.projectId, {
          status: args.state as IndexStatus | undefined,
          sampleSize: args.limit,
        }),
        GscIndexService.getSweepStatus(args.projectId),
      ]);
      const sweep = sweepSummary(status);
      const reasons = coverage.reasons.map((r) => ({
        ...r,
        sampleUrls: coverage.samples[r.reason] ?? [],
      }));
      const header =
        coverage.totalUrls === 0
          ? "No URLs collected yet. Start a sweep with start_index_sweep (or wait for the daily sweep)."
          : `${coverage.totalUrls} URLs · ${percent(coverage.inspectedPercent)} inspected · indexed ${coverage.byStatus.indexed} · not indexed ${coverage.byStatus.not_indexed} · failed ${coverage.byStatus.error} · not yet inspected ${coverage.byStatus.uninspected}`;
      const sweepLine = sweep.active
        ? `Sweep ${sweep.active.status}: ${sweep.active.inspected}/${sweep.active.total} inspected${sweep.active.resumeAt ? `, resumes ${sweep.active.resumeAt}` : ""}. Quota today ${sweep.quota.used}/${sweep.quota.limit}.`
        : `Last full sweep finished ${sweep.lastCompletedAt ?? "never"}. Quota today ${sweep.quota.used}/${sweep.quota.limit}.`;
      const reasonLines = reasons.map(
        (r) =>
          `  [${r.status}] ${r.reason}: ${r.count}${r.newCount > 0 ? ` (${r.newCount} new)` : ""}${r.sampleUrls.length > 0 ? ` — e.g. ${r.sampleUrls.slice(0, 3).join(", ")}` : ""}`,
      );
      return mcpResponse({
        text: [header, sweepLine, ...reasonLines].join("\n"),
        meta,
        structuredContent: {
          ok: true,
          totalUrls: coverage.totalUrls,
          inspectedUrls: coverage.inspectedUrls,
          inspectedPercent: coverage.inspectedPercent,
          byStatus: coverage.byStatus,
          newSince: coverage.newSince,
          reasons,
          sweep,
        },
      });
    },
  ),
};

// ---------------------------------------------------------------------------
// list_index_issues
// ---------------------------------------------------------------------------

const issuesInput = {
  projectId: projectIdSchema,
  reason: z
    .string()
    .optional()
    .describe(
      "Exact reason from get_index_coverage (Google's coverageState), e.g. 'Crawled - currently not indexed'.",
    ),
  status: z
    .enum(INDEX_STATUSES)
    .optional()
    .describe(
      "Filter by status instead of (or with) reason. Default when neither is given: every URL that is not indexed.",
    ),
  sinceDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}/)
    .optional()
    .describe(
      "Only URLs that entered their current reason on/after this date (new issues).",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Default 50, max 500."),
  cursor: z
    .string()
    .regex(/^\d+$/)
    .optional()
    .describe("nextCursor from the previous page."),
} as const;

export const listIndexIssuesTool = {
  name: "list_index_issues",
  config: {
    title: "List index coverage issues",
    description:
      "List the URLs behind an index coverage reason with their stored URL Inspection fields: verdict, coverageState, robots.txt state, indexing state, page fetch state, last crawl time, crawled-as, Google vs user canonical, rich results verdict, impressions, when the URL entered its reason, and the page's own <title>, meta description and HTTP status (read from the live page during the sweep; Google's APIs return no titles). Default lists every not-indexed URL, highest-impression first. Page with cursor. Results are from the last sweep; use inspect_urls for a live re-check. Read-only; uses no credits.",
    inputSchema: issuesInput,
    outputSchema: z.looseObject({
      ...baseOutput,
      urls: z.array(z.looseObject({ url: z.string() })).optional(),
      hasMore: z.boolean().optional(),
      nextCursor: z.string().optional(),
    }),
    annotations: READ_ONLY,
  },
  handler: gscTool(
    async (args: z.infer<z.ZodObject<typeof issuesInput>>, _context, meta) => {
      const limit = args.limit ?? 50;
      const result = await GscIndexService.listIssues({
        projectId: args.projectId,
        reason: args.reason,
        status: args.status as IndexStatus | undefined,
        sinceDate: args.sinceDate,
        limit,
        offset: args.cursor ? Number(args.cursor) : 0,
      });
      const lines = result.urls
        .slice(0, 30)
        .map(
          (u) =>
            `  ${u.url}${u.pageTitle ? ` "${u.pageTitle}"` : ""} — ${u.reason}${u.lastCrawlTime ? ` · crawled ${u.lastCrawlTime.slice(0, 10)}` : ""}${u.googleCanonical && u.googleCanonical !== u.url ? ` · google canonical ${u.googleCanonical}` : ""}${u.error ? ` · error: ${u.error}` : ""}`,
        );
      return mcpResponse({
        text:
          result.urls.length === 0
            ? "No URLs match."
            : `${result.urls.length} URL(s)${result.hasMore ? ` (more — pass cursor "${result.nextOffset}")` : ""}\n${lines.join("\n")}${result.urls.length > 30 ? `\n… ${result.urls.length - 30} more in structuredContent.urls` : ""}`,
        meta,
        structuredContent: {
          ok: true,
          urls: result.urls,
          hasMore: result.hasMore,
          nextCursor:
            result.nextOffset === null ? undefined : String(result.nextOffset),
        },
      });
    },
  ),
};

// ---------------------------------------------------------------------------
// list_indexed_urls
// ---------------------------------------------------------------------------

const indexedInput = {
  projectId: projectIdSchema,
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Default 100, max 500."),
  cursor: z
    .string()
    .regex(/^\d+$/)
    .optional()
    .describe("nextCursor from the previous page."),
} as const;

export const listIndexedUrlsTool = {
  name: "list_indexed_urls",
  config: {
    title: "List indexed URLs with titles",
    description:
      "List the project's URLs that Google reports as indexed (URL Inspection verdict PASS), highest-impression first, each with its coverage state, last crawl time, Google-selected canonical, and the page's <title>, meta description and HTTP status. Titles are read from the live page during the index sweep — Google's APIs don't return the title shown in results, so treat them as the page's own title. Covers inspected URLs only; check get_index_coverage for how much of the site is inspected. Read-only; uses no credits.",
    inputSchema: indexedInput,
    outputSchema: z.looseObject({
      ...baseOutput,
      urls: z.array(z.looseObject({ url: z.string() })).optional(),
      hasMore: z.boolean().optional(),
      nextCursor: z.string().optional(),
    }),
    annotations: READ_ONLY,
  },
  handler: gscTool(
    async (args: z.infer<z.ZodObject<typeof indexedInput>>, _context, meta) => {
      const result = await GscIndexService.listIssues({
        projectId: args.projectId,
        status: "indexed",
        limit: args.limit ?? 100,
        offset: args.cursor ? Number(args.cursor) : 0,
      });
      const urls = result.urls.map((u) => ({
        url: u.url,
        title: u.pageTitle,
        metaDescription: u.pageMetaDescription,
        httpStatus: u.pageHttpStatus,
        coverageState: u.coverageState,
        lastCrawlTime: u.lastCrawlTime,
        googleCanonical: u.googleCanonical,
        impressions: u.impressions,
        lastInspectedAt: u.lastInspectedAt,
      }));
      const lines = urls
        .slice(0, 40)
        .map((u) => `  ${u.url} — ${u.title ?? "(no title)"}`);
      return mcpResponse({
        text:
          urls.length === 0
            ? "No indexed URLs recorded yet. Run start_index_sweep, then check back."
            : `${urls.length} indexed URL(s)${result.hasMore ? ` (more — pass cursor "${result.nextOffset}")` : ""}\n${lines.join("\n")}${urls.length > 40 ? `\n… ${urls.length - 40} more in structuredContent.urls` : ""}`,
        meta,
        structuredContent: {
          ok: true,
          urls,
          hasMore: result.hasMore,
          nextCursor:
            result.nextOffset === null ? undefined : String(result.nextOffset),
        },
      });
    },
  ),
};

// ---------------------------------------------------------------------------
// get_rich_result_issues
// ---------------------------------------------------------------------------

const projectOnlyInput = { projectId: projectIdSchema } as const;

export const getRichResultIssuesTool = {
  name: "get_rich_result_issues",
  config: {
    title: "Get rich result (Enhancements) issues",
    description:
      "OpenSEO's rebuild of Search Console's Enhancements reports from URL Inspection results: per rich result type (Breadcrumbs, FAQ, Product snippets, Videos, Review snippets, ...) the pages where Google detected it and each distinct issue with severity (ERROR invalidates the item, WARNING limits it), affected page count, and sample URLs. Covers inspected URLs only. Read-only; uses no credits.",
    inputSchema: projectOnlyInput,
    outputSchema: z.looseObject({
      ...baseOutput,
      types: z.array(z.looseObject({ richResultType: z.string() })).optional(),
    }),
    annotations: READ_ONLY,
  },
  handler: gscTool(
    async (
      args: z.infer<z.ZodObject<typeof projectOnlyInput>>,
      _context,
      meta,
    ) => {
      const types = await GscIndexService.getRichResultIssues(args.projectId);
      const lines = types.flatMap((t) => [
        `${t.richResultType}: detected on ${t.pages} page(s)${t.issues.length === 0 ? ", no issues" : ""}`,
        ...t.issues.map(
          (i) =>
            `  [${i.severity}] ${i.issueMessage} — ${i.pages} page(s), e.g. ${i.sampleUrls[0] ?? ""}`,
        ),
      ]);
      return mcpResponse({
        text:
          types.length === 0
            ? "No rich results detected on inspected URLs (or no URLs inspected yet)."
            : lines.join("\n"),
        meta,
        structuredContent: { ok: true, types },
      });
    },
  ),
};

// ---------------------------------------------------------------------------
// start_index_sweep
// ---------------------------------------------------------------------------

const sweepInput = {
  projectId: projectIdSchema,
  urls: z
    .array(z.string().url())
    .max(2000)
    .optional()
    .describe(
      "Inspect just these URLs (they jump the queue). Omit to sweep the whole URL set (sitemaps + Search Analytics pages).",
    ),
} as const;

export const startIndexSweepTool = {
  name: "start_index_sweep",
  config: {
    title: "Start an index coverage sweep",
    description:
      "Queue URL Inspection for the project's whole URL set (or specific URLs) in the background. Sweeps respect Google's quota (2,000 inspections per property per day, 600 per minute), pause at the daily limit and resume after midnight Pacific. If a sweep is already running, requested URLs join it at the front of the queue. Returns the sweep status; poll get_index_coverage for progress. A daily sweep already runs automatically. Uses no credits.",
    inputSchema: sweepInput,
    outputSchema: z.looseObject({
      ...baseOutput,
      created: z.boolean().optional(),
      sweep: z.looseObject({}).optional(),
    }),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: gscTool(
    async (args: z.infer<z.ZodObject<typeof sweepInput>>, _context, meta) => {
      const { created } = await GscIndexService.startSweep({
        projectId: args.projectId,
        trigger: "mcp",
        urls: args.urls,
      });
      const sweep = sweepSummary(
        await GscIndexService.getSweepStatus(args.projectId),
      );
      const what = args.urls?.length
        ? `${args.urls.length} URL(s)`
        : "the full URL set";
      return mcpResponse({
        text: `${created ? "Started" : "Added to the running"} sweep for ${what}. Status ${sweep.active?.status ?? "done"} · ${sweep.pendingUrls} URL(s) queued · quota today ${sweep.quota.used}/${sweep.quota.limit} (resets ${sweep.quota.resetsAt}).`,
        meta,
        structuredContent: { ok: true, created, sweep },
      });
    },
  ),
};

// ---------------------------------------------------------------------------
// get_core_web_vitals
// ---------------------------------------------------------------------------

function describeCwvRecord(r: {
  formFactor: string;
  assessment: string | null;
  metrics: Record<string, { p75: number | null } | undefined>;
}) {
  return `${r.formFactor}: ${r.assessment ?? "no data"}${r.assessment ? ` (LCP ${r.metrics.lcp?.p75 ?? "—"}ms, INP ${r.metrics.inp?.p75 ?? "—"}ms, CLS ${r.metrics.cls?.p75 ?? "—"})` : ""}`;
}

const cwvInput = {
  projectId: projectIdSchema,
  scope: z
    .enum(["origin", "urls"])
    .describe(
      "'origin' for the site as a whole; 'urls' for the top pages by Search Console impressions.",
    ),
  formFactor: z
    .enum(CRUX_FORM_FACTORS)
    .optional()
    .describe("PHONE or DESKTOP. Default: both."),
  topPages: z
    .number()
    .int()
    .min(1)
    .max(MAX_TOP_PAGES)
    .optional()
    .describe(
      `With scope 'urls': how many top pages (default 10, max ${MAX_TOP_PAGES}).`,
    ),
  includeHistory: z
    .boolean()
    .optional()
    .describe(
      "With scope 'origin': add ~6 months of weekly p75s from the CrUX History API.",
    ),
} as const;

export const getCoreWebVitalsTool = {
  name: "get_core_web_vitals",
  config: {
    title: "Get Core Web Vitals (CrUX field data)",
    description:
      "Core Web Vitals from the Chrome UX Report (real Chrome users, trailing 28 days) — the same field data behind Search Console's Core Web Vitals report, which itself has no API. Per origin or per top page by impressions, for PHONE and DESKTOP: p75 LCP, INP, CLS, FCP, TTFB with good/needs-improvement/poor shares, a rating per metric, and a pass/fail assessment (pass = LCP, INP and CLS all good). A null assessment means too little Chrome traffic. Always label results as CrUX field data, not the GSC report. Requires CRUX_API_KEY. Read-only; uses no credits.",
    inputSchema: cwvInput,
    outputSchema: z.looseObject({
      ...baseOutput,
      source: z.string().optional(),
      scope: z.string().optional(),
      origin: z.string().optional(),
      records: z.array(z.looseObject({})).optional(),
      pages: z.array(z.looseObject({ url: z.string() })).optional(),
      failingUrls: z.array(z.string()).optional(),
    }),
    annotations: READ_ONLY,
  },
  handler: gscTool(
    async (args: z.infer<z.ZodObject<typeof cwvInput>>, _context, meta) => {
      try {
        const result = await CruxService.getCoreWebVitals({
          projectId: args.projectId,
          scope: args.scope,
          formFactor: args.formFactor,
          topPages: args.topPages,
          includeHistory: args.includeHistory,
        });
        const text =
          result.scope === "origin"
            ? `CrUX field data for ${result.origin}\n${result.records.map((r) => `  ${describeCwvRecord(r)}`).join("\n")}`
            : `CrUX field data for the top ${result.pages.length} pages by impressions · ${result.failingUrls.length} failing · ${result.noDataUrls.length} without enough data\n${result.pages
                .map(
                  (p) =>
                    `  ${p.url}: ${p.assessment ?? "no data"}${p.records.map((r) => ` · ${describeCwvRecord(r)}`).join("")}`,
                )
                .join("\n")}`;
        return mcpResponse({
          text,
          meta,
          structuredContent: { ok: true, ...result },
        });
      } catch (error) {
        if (
          error instanceof CruxNotConfiguredError ||
          error instanceof CruxApiError
        ) {
          return mcpResponse({
            text: error.message,
            meta,
            structuredContent: {
              ok: false,
              reason:
                error instanceof CruxNotConfiguredError
                  ? "crux_not_configured"
                  : "crux_api_error",
            },
          });
        }
        throw error;
      }
    },
  ),
};

// ---------------------------------------------------------------------------
// get_search_console_health
// ---------------------------------------------------------------------------

export const getSearchConsoleHealthTool = {
  name: "get_search_console_health",
  config: {
    title: "Get Search Console health summary",
    description:
      "One-call Search Console health check for a project — start here for 'list all Search Console errors' or 'is my site healthy in Google?'. Returns: property info; sitemaps with errors/warnings; index coverage summary (rebuilt from URL Inspection) with new issues since the previous sweep and the top not-indexed reasons with sample URLs; sweep progress and quota; rich result (Enhancements) issues; Core Web Vitals pass/fail from CrUX field data; the biggest page-level click and impression drops, last 28 days vs the 28 before; and notAvailableViaApi, the Search Console reports Google exposes no API for (manual actions, security issues, links, crawl stats, removals) — tell the user to check those in the Search Console UI rather than assuming they are clean. Each section reports its own error without failing the rest. Read-only; uses no credits.",
    inputSchema: projectOnlyInput,
    outputSchema: z.looseObject({
      ...baseOutput,
      property: z.looseObject({}).optional(),
      sitemaps: z.looseObject({}).optional(),
      indexCoverage: z.looseObject({}).optional(),
      sweep: z.looseObject({}).optional(),
      richResults: z.looseObject({}).optional(),
      coreWebVitals: z.looseObject({}).optional(),
      performanceDrops: z.looseObject({}).optional(),
      notAvailableViaApi: z.array(z.string()).optional(),
    }),
    annotations: READ_ONLY,
  },
  handler: gscTool(
    async (
      args: z.infer<z.ZodObject<typeof projectOnlyInput>>,
      _context,
      meta,
    ) => {
      const health = await GscHealthService.getHealth(args.projectId);
      const lines: string[] = [];
      if (health.property.ok) {
        const p = health.property.data;
        lines.push(
          `Property ${p.siteUrl} (${p.propertyType === "domain" ? "Domain" : "URL-prefix"}, ${p.permissionLevel ?? "unknown permission"})`,
        );
      }
      lines.push(
        health.sitemaps.ok
          ? `Sitemaps: ${health.sitemaps.data.totals.sitemaps} · ${health.sitemaps.data.totals.errors} errors · ${health.sitemaps.data.totals.warnings} warnings${health.sitemaps.data.withIssues.map((s) => `\n  ${s.path}: ${s.errors} errors, ${s.warnings} warnings${s.isPending ? ", pending" : ""}`).join("")}`
          : `Sitemaps: unavailable (${health.sitemaps.error})`,
      );
      if (health.indexCoverage.ok) {
        const c = health.indexCoverage.data;
        lines.push(
          `Index coverage: ${c.totalUrls} URLs, ${percent(c.inspectedPercent)} inspected · indexed ${c.byStatus.indexed} · not indexed ${c.byStatus.not_indexed} · failed ${c.byStatus.error} · uninspected ${c.byStatus.uninspected}`,
          ...c.topReasons.map(
            (r) =>
              `  ${r.reason}: ${r.count}${r.newCount ? ` (${r.newCount} new)` : ""}${r.sampleUrls.length ? ` — e.g. ${r.sampleUrls[0]}` : ""}`,
          ),
        );
      } else {
        lines.push(
          `Index coverage: unavailable (${health.indexCoverage.error})`,
        );
      }
      if (health.sweep.ok && health.sweep.data.active) {
        const a = health.sweep.data.active;
        lines.push(
          `Sweep ${a.status}: ${a.inspected}/${a.total}${a.resumeAt ? `, resumes ${a.resumeAt}` : ""}`,
        );
      }
      if (health.richResults.ok) {
        const issues = health.richResults.data.flatMap((t) =>
          t.issues.map(
            (i) =>
              `  ${t.richResultType} [${i.severity}] ${i.issueMessage}: ${i.pages} page(s)`,
          ),
        );
        lines.push(
          `Rich results: ${health.richResults.data.length} type(s) detected${issues.length ? "" : ", no issues"}`,
          ...issues,
        );
      }
      if (health.coreWebVitals.ok) {
        const cwv = health.coreWebVitals.data;
        lines.push(
          !cwv.configured
            ? `Core Web Vitals: ${cwv.message}`
            : cwv.scope === "origin"
              ? `Core Web Vitals (CrUX field data, ${cwv.origin}): ${cwv.records.map((r) => `${r.formFactor} ${r.assessment ?? "no data"}`).join(", ")}`
              : "",
        );
      } else {
        lines.push(
          `Core Web Vitals: unavailable (${health.coreWebVitals.error})`,
        );
      }
      if (health.performanceDrops.ok) {
        const d = health.performanceDrops.data;
        lines.push(
          `Clicks ${d.previous.clicks} → ${d.current.clicks}, impressions ${d.previous.impressions} → ${d.current.impressions} (28d vs prior 28d)`,
          ...d.clickDrops
            .slice(0, 5)
            .map((x) => `  ${x.key}: clicks ${x.previousClicks} → ${x.clicks}`),
        );
      }
      lines.push(
        `Not available via API (check in the Search Console UI): ${GSC_REPORTS_WITHOUT_API.slice(3).join(", ")}`,
      );
      return mcpResponse({
        text: lines.join("\n"),
        meta,
        structuredContent: { ok: true, ...health },
      });
    },
  ),
};

import { sort } from "remeda";
import { z } from "zod";
import {
  getPageSpeedApiKey,
  PageSpeedApiError,
  runPageSpeedInsights,
} from "@/server/lib/pagespeedClient";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { PageSpeedReportService } from "@/server/features/pagespeed/services/PageSpeedReportService";
import { PageSpeedSweepService } from "@/server/features/pagespeed/services/PageSpeedSweepService";
import { buildProjectMeta } from "@/server/mcp/context";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";

const MAX_ISSUES = 15;

const inputSchema = {
  url: z
    .url()
    .describe("Full page URL to test, e.g. https://example.com/pricing."),
  strategy: z
    .enum(["mobile", "desktop"])
    .default("mobile")
    .describe("Device to emulate. Google indexes mobile-first."),
} as const;

const outputSchema = z.looseObject({
  ok: z.boolean(),
  reason: z.string().optional(),
  finalUrl: z.string().optional(),
  strategy: z.string().optional(),
  scores: z.looseObject({}).optional(),
  metrics: z.looseObject({}).optional(),
  fieldData: z.looseObject({}).nullable().optional(),
  fieldDataScope: z.string().nullable().optional(),
  issues: z.array(z.looseObject({})).optional(),
  ...optionalMetaOutputSchema,
});

export const getPageSpeedInsightsTool = {
  name: "get_pagespeed_insights",
  config: {
    title: "Get PageSpeed Insights",
    description:
      "Runs Google PageSpeed Insights on any public URL: a fresh Lighthouse lab run (performance, accessibility, best-practices, and SEO scores; LCP, CLS, TBT, FCP, Speed Index), CrUX field data for the URL or its origin when Chrome has enough traffic, and the top failing audits with their estimated savings. Takes 10-40 seconds. Free, no credits and no project needed. Label lab scores as lab data; for field data across a Search Console project's top pages use get_core_web_vitals.",
    inputSchema,
    outputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
      destructiveHint: false,
    },
  },
  handler: async (args: z.infer<z.ZodObject<typeof inputSchema>>) => {
    const apiKey = await getPageSpeedApiKey();
    let result: Awaited<ReturnType<typeof runPageSpeedInsights>>;
    try {
      result = await runPageSpeedInsights({ ...args, apiKey });
    } catch (error) {
      if (!(error instanceof PageSpeedApiError)) throw error;
      return mcpResponse({
        text: error.message,
        structuredContent: { ok: false, reason: "pagespeed_api_error" },
      });
    }

    const issues = sort(
      result.issues,
      (a, b) => (b.impactMs ?? 0) - (a.impactMs ?? 0),
    )
      .slice(0, MAX_ISSUES)
      .map(({ items, description: _description, ...issue }) => ({
        ...issue,
        items: items.slice(0, 3),
      }));
    const { scores, metrics, fieldData } = result;
    const lines = [
      `PageSpeed Insights (${result.strategy}) for ${result.finalUrl}`,
      `Lab scores: performance ${scores.performance ?? "n/a"} · accessibility ${scores.accessibility ?? "n/a"} · best-practices ${scores["best-practices"] ?? "n/a"} · SEO ${scores.seo ?? "n/a"}`,
      `Lab metrics: LCP ${metrics.largestContentfulPaint.displayValue ?? "n/a"} · CLS ${metrics.cumulativeLayoutShift.displayValue ?? "n/a"} · TBT ${metrics.totalBlockingTime.displayValue ?? "n/a"} · FCP ${metrics.firstContentfulPaint.displayValue ?? "n/a"} · Speed Index ${metrics.speedIndex.displayValue ?? "n/a"}`,
      fieldData
        ? `Field data (CrUX, ${result.fieldDataScope}, p75): overall ${fieldData.overall ?? "n/a"} · ${Object.entries(
            fieldData.metrics,
          )
            .map(
              ([key, m]) => `${key} ${m.p75 ?? "n/a"} (${m.category ?? "n/a"})`,
            )
            .join(" · ")}`
        : "Field data: not enough Chrome traffic for this URL or origin.",
      "",
      issues.length > 0
        ? `Top failing audits (${issues.length} of ${result.issues.length}):`
        : "No failing audits.",
      ...issues.map(
        (issue) =>
          `- [${issue.severity}] ${issue.category}: ${issue.title}${issue.displayValue ? ` (${issue.displayValue})` : ""}${issue.items.length > 0 ? `\n    ${issue.items.join("\n    ")}` : ""}`,
      ),
    ];

    return mcpResponse({
      text: lines.join("\n"),
      structuredContent: {
        ok: true,
        finalUrl: result.finalUrl,
        strategy: result.strategy,
        fetchedAt: result.fetchedAt,
        scores,
        metrics,
        fieldData,
        fieldDataScope: result.fieldDataScope,
        issues,
      },
    });
  },
};

type SweepProgress = {
  urlsDone: number;
  urlsFailed: number;
  urlsTotal: number;
  status: string;
  resumeAt: string | null;
};
const progress = (s: SweepProgress) =>
  `${s.urlsDone + s.urlsFailed}/${s.urlsTotal} URLs tested${s.status === "waiting_quota" ? `, paused for the daily quota until ${s.resumeAt}` : ""}`;

// ─── get_pagespeed_report ────────────────────────────────────────────────────

const fmtMs = (ms: number | null) =>
  ms == null
    ? "n/a"
    : ms >= 1000
      ? `${(ms / 1000).toFixed(1)} s`
      : `${Math.round(ms)} ms`;
const fmtCls = (cls: number | null) => (cls == null ? "n/a" : cls.toFixed(2));
const signed = (n: number | null) =>
  n == null ? "" : ` (${n > 0 ? "+" : ""}${n} vs last week)`;

const reportInputSchema = {
  projectId: projectIdSchema,
  url: z
    .string()
    .optional()
    .describe(
      "A page URL from the report to get its scores, metrics and failing audits.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("How many of the slowest pages to list (default 10)."),
} as const;

type ReportArgs = z.infer<z.ZodObject<typeof reportInputSchema>>;

export const getPageSpeedReportTool = {
  name: "get_pagespeed_report",
  config: {
    title: "Get sitemap PageSpeed report",
    description:
      "Read the project's sitemap-wide PageSpeed results: every sitemap URL is tested on mobile each week alongside the weekly site audit. Returns sweep progress, site-average Lighthouse scores, how many pages are good / need improvement / poor for performance, LCP, CLS and TBT, the slowest pages, the most common failing audits with how many pages each affects, and changes since last week (pages that regressed). Pass url for one page's scores, lab and field metrics, and failing audits. Use this for questions about site speed or Core Web Vitals before running new PageSpeed tests. Free, no credits.",
    inputSchema: reportInputSchema,
    outputSchema: z
      .object({
        sweep: z.looseObject({}).nullable().optional(),
        active: z.looseObject({}).nullable().optional(),
        summary: z.looseObject({}).nullable().optional(),
        slowest: z.array(z.looseObject({})).optional(),
        topIssues: z.array(z.looseObject({})).optional(),
        changes: z.looseObject({}).nullable().optional(),
        page: z.looseObject({}).nullable().optional(),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: ReportArgs, context) => {
    const meta = buildProjectMeta(
      context,
      args.projectId,
      `/p/${args.projectId}/pagespeed`,
    );

    if (args.url) {
      const detail = await PageSpeedReportService.getUrlDetail(
        args.projectId,
        args.url,
      );
      if (!detail) {
        return mcpResponse({
          text: `No PageSpeed result for ${args.url} in the latest sweep. Use get_pagespeed_insights to test it live.`,
          meta,
          structuredContent: { page: null },
        });
      }
      const r = detail.result;
      const lines = [
        `${r.url} (mobile, ${r.fetchedAt ?? "not fetched"})`,
        r.status === "failed"
          ? `PageSpeed could not test this page: ${r.error ?? "unknown error"}`
          : `Scores: performance ${r.performance ?? "n/a"}${signed(detail.previousPerformance != null && r.performance != null ? r.performance - detail.previousPerformance : null)} · accessibility ${r.accessibility ?? "n/a"} · best-practices ${r.bestPractices ?? "n/a"} · SEO ${r.seo ?? "n/a"}`,
        `Lab: LCP ${fmtMs(r.lcpMs)} · CLS ${fmtCls(r.cls)} · TBT ${fmtMs(r.tbtMs)} · FCP ${fmtMs(r.fcpMs)} · Speed Index ${fmtMs(r.speedIndexMs)}`,
        r.fieldScope
          ? `Field (CrUX ${r.fieldScope}, p75): ${r.fieldOverall ?? "n/a"} · LCP ${fmtMs(r.fieldLcpMs)} · INP ${fmtMs(r.fieldInpMs)} · CLS ${fmtCls(r.fieldCls)}`
          : "Field data: not enough Chrome traffic.",
        "",
        detail.issues.length > 0 ? "Failing audits:" : "No failing audits.",
        ...detail.issues.map(
          (issue) =>
            `- [${issue.severity}] ${issue.category}: ${issue.title}${issue.displayValue ? ` (${issue.displayValue})` : ""}`,
        ),
      ];
      return mcpResponse({
        text: lines.join("\n"),
        meta,
        structuredContent: { page: detail },
      });
    }

    const report = await PageSpeedReportService.getReport(args.projectId, {
      limit: args.limit,
    });
    if (!report.sweep || !report.summary) {
      return mcpResponse({
        text: "No PageSpeed sweep has run for this project yet. It runs with the weekly site audit (schedule_site_audit), or start one now with run_pagespeed_sweep.",
        meta,
        structuredContent: { sweep: null },
      });
    }
    const { sweep, active, summary, changes } = report;
    const d = summary.distribution;
    const lines = [
      `PageSpeed (mobile) for ${sweep.startUrl}: ${sweep.status === "completed" ? `sweep completed ${sweep.completedAt}` : `first sweep in progress (${progress(sweep)}); partial results`}.`,
      ...(active && active.id !== sweep.id
        ? [`A newer sweep is ${active.status}: ${progress(active)}.`]
        : []),
      `${summary.pages} pages tested${sweep.urlsFailed > 0 ? `, ${sweep.urlsFailed} could not be tested` : ""}.`,
      `Average scores: performance ${summary.averages.performance ?? "n/a"}${signed(changes?.averageDeltas.performance ?? null)} · accessibility ${summary.averages.accessibility ?? "n/a"} · best-practices ${summary.averages.bestPractices ?? "n/a"} · SEO ${summary.averages.seo ?? "n/a"}${signed(changes?.averageDeltas.seo ?? null)}`,
      `Performance: ${d.performance.good} good · ${d.performance.needs_improvement} need improvement · ${d.performance.poor} poor`,
      `LCP: ${d.lcp.good} good · ${d.lcp.needs_improvement} NI · ${d.lcp.poor} poor | CLS: ${d.cls.good} good · ${d.cls.needs_improvement} NI · ${d.cls.poor} poor | TBT: ${d.tbt.good} good · ${d.tbt.needs_improvement} NI · ${d.tbt.poor} poor`,
      ...(summary.fieldCoreWebVitals.assessed > 0
        ? [
            `Field Core Web Vitals (CrUX, pages with their own data): ${summary.fieldCoreWebVitals.passing}/${summary.fieldCoreWebVitals.assessed} pass`,
          ]
        : []),
      "",
      "Slowest pages:",
      ...report.slowest.map(
        (page) =>
          `- ${page.performance} ${page.url} (LCP ${fmtMs(page.lcpMs)}, CLS ${fmtCls(page.cls)}, TBT ${fmtMs(page.tbtMs)})`,
      ),
      "",
      "Most common failing audits:",
      ...report.topIssues.map(
        (issue) =>
          `- ${issue.title} (${issue.category}): ${issue.pages} pages${issue.criticalPages > 0 ? `, critical on ${issue.criticalPages}` : ""}`,
      ),
    ];
    if (changes) {
      lines.push(
        "",
        `Since last week: ${changes.regressions.length} pages dropped 10+ points, ${changes.improvements} improved 10+, ${changes.newPages} new pages.`,
        ...changes.regressions
          .slice(0, 10)
          .map(
            (change) =>
              `- ${change.url}: ${change.previous} → ${change.current}`,
          ),
      );
    }
    lines.push(
      "",
      'Per-page detail: get_pagespeed_report({ projectId, url: "<page>" }).',
    );
    return mcpResponse({
      text: lines.join("\n"),
      meta,
      structuredContent: {
        sweep,
        active,
        summary,
        slowest: report.slowest,
        topIssues: report.topIssues,
        changes: changes
          ? { ...changes, regressions: changes.regressions.slice(0, 25) }
          : null,
      },
    });
  }),
};

// ─── run_pagespeed_sweep ─────────────────────────────────────────────────────

const runInputSchema = { projectId: projectIdSchema } as const;

export const runPageSpeedSweepTool = {
  name: "run_pagespeed_sweep",
  config: {
    title: "Run sitemap PageSpeed sweep",
    description:
      "Queue a PageSpeed sweep now: every sitemap URL of the project's site gets a mobile PageSpeed Insights test, paced under Google's quota. It normally runs with the weekly site audit; use this for an on-demand refresh. Starts within the hour; read progress and results with get_pagespeed_report. Uses no credits; on hosted OpenSEO it needs a paid plan.",
    inputSchema: runInputSchema,
    outputSchema: z
      .object({
        sweepId: z.string().optional(),
        created: z.boolean().optional(),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<z.ZodObject<typeof runInputSchema>>, context) => {
      const { created, sweepId, startUrl } =
        await PageSpeedSweepService.queueSweepForProject(
          args.projectId,
          context.auth.organizationId,
        );
      return mcpResponse({
        text: created
          ? `PageSpeed sweep queued for ${startUrl}. It starts within the hour; check get_pagespeed_report for progress.`
          : "A PageSpeed sweep is already queued or running for this project; check get_pagespeed_report for progress.",
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/pagespeed`,
        ),
        structuredContent: { sweepId, created },
      });
    },
  ),
};

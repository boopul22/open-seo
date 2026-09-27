import { z } from "zod";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import { AuditScheduleRepository } from "@/server/features/audit/repositories/AuditScheduleRepository";
import { PageSpeedRepository } from "@/server/features/pagespeed/repositories/PageSpeedRepository";
import { AUDIT_LIMITS } from "@/server/features/audit/services/audit-capacity";
import { AuditService } from "@/server/features/audit/services/AuditService";
import {
  diffAuditIssues,
  summarizeIssuesByType,
} from "@/server/features/audit/services/auditIssueSummary";
import { SCHEDULED_AUDIT_DEFAULT_PAGES } from "@/server/features/audit/services/scheduledAudits";
import { normalizeAndValidateStartUrl } from "@/server/lib/audit/url-policy";
import { AppError } from "@/server/lib/errors";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";

const auditPagePath = (projectId: string) => `/p/${projectId}/audit`;

// ─── schedule_site_audit ─────────────────────────────────────────────────────

const scheduleInputSchema = {
  projectId: projectIdSchema,
  url: z
    .string()
    .min(1)
    .max(2048)
    .optional()
    .describe("Start URL to crawl. Defaults to the project's domain."),
  maxPages: z
    .number()
    .int()
    .min(10)
    .max(10_000)
    .optional()
    .describe(
      `Page budget per weekly crawl (default ${SCHEDULED_AUDIT_DEFAULT_PAGES}), capped at the plan's per-audit limit.`,
    ),
  enabled: z
    .boolean()
    .optional()
    .describe("Pass false to turn the weekly audit off. Default true."),
} as const;

type ScheduleArgs = z.infer<z.ZodObject<typeof scheduleInputSchema>>;

export const scheduleSiteAuditTool = {
  name: "schedule_site_audit",
  config: {
    title: "Schedule weekly site audit",
    description:
      "Turn on (or off) an automatic weekly site audit for a project. OpenSEO crawls the site once a week without Lighthouse and runs mobile PageSpeed on every sitemap URL, keeps the two most recent scheduled audits (older scheduled ones are deleted; manual audits are never touched), and records why a week was skipped when a plan limit blocks it. The first crawl starts within the hour. Read the results with get_scheduled_audit_report. Free, no credits.",
    inputSchema: scheduleInputSchema,
    outputSchema: z
      .object({
        enabled: z.boolean(),
        startUrl: z.string().optional(),
        maxPages: z.number().optional(),
        nextRunAt: z.string().optional(),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: ScheduleArgs, context) => {
    const meta = buildProjectMeta(
      context,
      args.projectId,
      auditPagePath(args.projectId),
    );
    if (args.enabled === false) {
      const removed = await AuditScheduleRepository.deleteForProject(
        args.projectId,
      );
      return mcpResponse({
        text: removed
          ? "Weekly site audit turned off. Existing audits are kept."
          : "This project had no weekly site audit.",
        meta,
        structuredContent: { enabled: false },
      });
    }

    const rawUrl = args.url ?? context.project.domain;
    if (!rawUrl) {
      throw new AppError(
        "VALIDATION_ERROR",
        "This project has no domain. Pass url with the site to audit.",
      );
    }
    const startUrl = await normalizeAndValidateStartUrl(rawUrl);
    const limitTier = await AuditService.resolveAuditLimitTier(context.billing);
    const maxPages = Math.min(
      args.maxPages ?? SCHEDULED_AUDIT_DEFAULT_PAGES,
      AUDIT_LIMITS[limitTier].maxPagesPerAudit,
    );
    const nextRunAt = new Date().toISOString();
    await AuditScheduleRepository.upsertForProject({
      projectId: args.projectId,
      startUrl,
      maxPages,
      createdByUserId: context.auth.userId,
      nextRunAt,
    });

    return mcpResponse({
      text: `Weekly site audit on for ${startUrl}, up to ${maxPages} pages per crawl${args.maxPages && maxPages < args.maxPages ? ` (capped from ${args.maxPages} by the plan limit)` : ""}. The first crawl starts within the hour, then every 7 days. Read results with get_scheduled_audit_report.`,
      meta,
      structuredContent: { enabled: true, startUrl, maxPages, nextRunAt },
    });
  }),
};

// ─── get_scheduled_audit_report ──────────────────────────────────────────────

const reportInputSchema = { projectId: projectIdSchema } as const;

type ReportArgs = z.infer<z.ZodObject<typeof reportInputSchema>>;

export const getScheduledAuditReportTool = {
  name: "get_scheduled_audit_report",
  config: {
    title: "Get weekly audit report",
    description:
      "Read the project's weekly automatic site audit: schedule state (next run, last run, why a week was skipped), the latest completed crawl's issue counts by type and severity, and what changed since the previous week (new issues with their pages, resolved issues, issue types that got worse). Use it first for questions about site health or what is broken, before starting a new audit. For fix steps, call get_audit_issues with the returned auditId. Free, no credits.",
    inputSchema: reportInputSchema,
    outputSchema: z
      .object({
        scheduled: z.boolean(),
        schedule: looseObjectOutputSchema.optional(),
        audit: looseObjectOutputSchema.nullable().optional(),
        summary: z.array(looseObjectOutputSchema).optional(),
        changes: looseObjectOutputSchema.nullable().optional(),
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
      auditPagePath(args.projectId),
    );
    const schedule = await AuditScheduleRepository.getForProject(
      args.projectId,
    );
    if (!schedule) {
      return mcpResponse({
        text: "No weekly site audit is set up for this project. Turn one on with schedule_site_audit, or run a one-off crawl with run_site_audit.",
        meta,
        structuredContent: { scheduled: false },
      });
    }

    const [last, previous] = await Promise.all(
      [schedule.lastAuditId, schedule.previousAuditId].map((id) =>
        id ? AuditRepository.getAuditForProject(id, args.projectId) : null,
      ),
    );
    // While this week's crawl runs, report last week's finished one.
    const runningAudit = last?.status === "running" ? last : null;
    const reportAudit = runningAudit ? previous : last;
    const compareAudit = runningAudit ? null : previous;

    const scheduleInfo = {
      startUrl: schedule.startUrl,
      maxPages: schedule.maxPages,
      nextRunAt: schedule.nextRunAt,
      lastRunAt: schedule.lastRunAt,
      lastSkipReason: schedule.lastSkipReason,
      runningAuditId: runningAudit?.id ?? null,
    };
    const lines = [
      `Weekly audit of ${schedule.startUrl} (up to ${schedule.maxPages} pages). Next run ${schedule.nextRunAt}${schedule.lastRunAt ? `, last run ${schedule.lastRunAt}` : ""}.`,
      ...(schedule.lastSkipReason
        ? [`Last due run was skipped: ${schedule.lastSkipReason}.`]
        : []),
      ...(runningAudit
        ? [`This week's crawl (${runningAudit.id}) is still running.`]
        : []),
    ];

    if (!reportAudit || reportAudit.status === "running") {
      lines.push(
        "No finished scheduled crawl yet. Check back after the first run completes.",
      );
      return mcpResponse({
        text: lines.join("\n"),
        meta,
        structuredContent: {
          scheduled: true,
          schedule: scheduleInfo,
          audit: null,
        },
      });
    }

    const [currentRows, previousRows] = await Promise.all([
      AuditRepository.getIssuesForAudit(reportAudit.id, {}),
      compareAudit?.status === "completed"
        ? AuditRepository.getIssuesForAudit(compareAudit.id, {})
        : null,
    ]);
    const summary = summarizeIssuesByType(currentRows);
    const changes = previousRows
      ? diffAuditIssues(currentRows, previousRows)
      : null;
    const bySeverity = { critical: 0, warning: 0, info: 0 };
    for (const entry of summary) bySeverity[entry.severity] += entry.count;

    lines.push(
      "",
      `Latest crawl ${reportAudit.id} (${reportAudit.status}, ${reportAudit.completedAt ?? reportAudit.startedAt}, ${reportAudit.pagesCrawled} pages): ${bySeverity.critical} critical, ${bySeverity.warning} warnings, ${bySeverity.info} info.`,
      ...summary.map(
        (entry) =>
          `- [${entry.severity}] ${entry.title} (${entry.issueType}): ${entry.count}`,
      ),
    );
    if (changes && compareAudit) {
      lines.push(
        "",
        `Since the previous crawl ${compareAudit.id} (${compareAudit.completedAt ?? compareAudit.startedAt}): ${changes.newIssueCount} new, ${changes.resolvedIssueCount} resolved.`,
        ...changes.byType.map(
          (entry) =>
            `- ${entry.delta > 0 ? "+" : ""}${entry.delta} [${entry.severity}] ${entry.title}: ${entry.previous} → ${entry.current}`,
        ),
        ...(changes.newIssues.length > 0
          ? [
              `New issues${changes.newIssueCount > changes.newIssues.length ? ` (first ${changes.newIssues.length})` : ""}:`,
              ...changes.newIssues.map(
                (issue) => `- [${issue.severity}] ${issue.title}: ${issue.url}`,
              ),
            ]
          : []),
      );
    } else {
      lines.push(
        "",
        "No earlier completed scheduled crawl to compare with yet.",
      );
    }
    const speed = await PageSpeedRepository.getActiveSweep(args.projectId);
    const [lastSpeed] = await PageSpeedRepository.listCompletedSweeps(
      args.projectId,
      1,
    );
    lines.push(
      "",
      lastSpeed
        ? `PageSpeed (mobile, every sitemap URL): last sweep ${lastSpeed.completedAt}, ${lastSpeed.urlsDone} pages tested${speed ? `; a new sweep is ${speed.status}` : ""}. Read get_pagespeed_report for slow pages and common problems.`
        : speed
          ? `PageSpeed (mobile, every sitemap URL): first sweep is ${speed.status} (${speed.urlsDone + speed.urlsFailed}/${speed.urlsTotal}). Read get_pagespeed_report for partial results.`
          : "PageSpeed: no sitemap sweep yet; it runs with the next weekly audit.",
      `Fix steps per issue: get_audit_issues({ projectId, auditId: "${reportAudit.id}" }).`,
    );

    return mcpResponse({
      text: lines.join("\n"),
      meta,
      structuredContent: {
        scheduled: true,
        schedule: scheduleInfo,
        audit: {
          id: reportAudit.id,
          status: reportAudit.status,
          startedAt: reportAudit.startedAt,
          completedAt: reportAudit.completedAt,
          pagesCrawled: reportAudit.pagesCrawled,
          issuesBySeverity: bySeverity,
          comparedToAuditId: changes ? (compareAudit?.id ?? null) : null,
        },
        summary,
        changes,
      },
    });
  }),
};

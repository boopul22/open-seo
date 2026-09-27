import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { AuditScheduleRepository } from "@/server/features/audit/repositories/AuditScheduleRepository";
import {
  PAGESPEED_URL_SORTS,
  PageSpeedReportService,
} from "@/server/features/pagespeed/services/PageSpeedReportService";
import { PageSpeedSweepService } from "@/server/features/pagespeed/services/PageSpeedSweepService";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { normalizeAndValidateStartUrl } from "@/server/lib/audit/url-policy";
import { AppError } from "@/server/lib/errors";
import { requireProjectContext } from "@/serverFunctions/middleware";

// Sitemap-wide PageSpeed results for the app. `projectId` in each validator
// triggers project authorization; the service never authorizes.

const projectScoped = z.object({ projectId: z.string().min(1) });

export const getPageSpeedOverview = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScoped)
  .handler(({ context }) =>
    PageSpeedReportService.getReport(context.projectId, { limit: 5 }),
  );

export const listPageSpeedUrls = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    projectScoped.extend({
      sort: z.enum(PAGESPEED_URL_SORTS).default("performance"),
      rating: z.enum(["good", "needs_improvement", "poor"]).optional(),
      auditKey: z.string().max(200).optional(),
      search: z.string().max(500).optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(50),
    }),
  )
  .handler(({ data, context }) =>
    PageSpeedReportService.listUrls(context.projectId, data),
  );

export const getPageSpeedUrl = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScoped.extend({ url: z.string().min(1).max(4096) }))
  .handler(({ data, context }) =>
    PageSpeedReportService.getUrlDetail(context.projectId, data.url),
  );

export const runPageSpeedSweep = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScoped)
  .handler(async ({ context }) => {
    const startUrl =
      (await AuditScheduleRepository.getForProject(context.projectId))
        ?.startUrl ??
      (await ProjectRepository.getProjectById(context.projectId))?.domain;
    if (!startUrl) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Add the site's domain to this project first.",
      );
    }
    return PageSpeedSweepService.queueSweep(
      context.projectId,
      await normalizeAndValidateStartUrl(startUrl),
    );
  });

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  GscNotConnectedError,
  GscService,
  isExpectedGrantFailure,
} from "@/server/features/gsc/services/GscService";
import { GscIndexService } from "@/server/features/gsc/services/GscIndexService";
import { CruxService } from "@/server/features/gsc/services/CruxService";
import { CruxNotConfiguredError } from "@/server/lib/cruxClient";
import { captureServerEvent } from "@/server/lib/posthog";
import { requireOrgPermission } from "@/server/auth/org-gate";
import { AppError } from "@/server/lib/errors";
import { requireProjectContext } from "@/serverFunctions/middleware";
import { CRUX_FORM_FACTORS } from "@/shared/core-web-vitals";

// Index coverage (rebuilt Page indexing report), sitemaps, and CrUX Core Web
// Vitals for the app. `projectId` in each validator triggers project
// authorization; the services never authorize.

const projectScoped = z.object({ projectId: z.string().min(1) });

function isNotConnected(error: unknown) {
  return error instanceof GscNotConnectedError || isExpectedGrantFailure(error);
}

export const getIndexingOverview = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScoped)
  .handler(async ({ context }) => {
    const connection = await GscService.getConnection(context.projectId);
    if (!connection) return { connected: false as const };
    const [coverage, sweep, sitemaps, richResults, canWrite] =
      await Promise.all([
        GscIndexService.getCoverage(context.projectId, { sampleSize: 0 }),
        GscIndexService.getSweepStatus(context.projectId),
        GscIndexService.getSitemaps(context.projectId, { refresh: false }),
        GscIndexService.getRichResultIssues(context.projectId),
        GscService.connectionCanWrite(connection),
      ]);
    return {
      connected: true as const,
      siteUrl: connection.siteUrl,
      sitemapWriteEnabled: canWrite,
      coverage,
      sweep,
      sitemaps,
      richResults,
    };
  });

export const refreshIndexingSitemaps = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScoped)
  .handler(async ({ context }) => {
    try {
      return await GscIndexService.getSitemaps(context.projectId, {
        refresh: true,
      });
    } catch (error) {
      if (isNotConnected(error))
        throw new AppError(
          "FORBIDDEN",
          "Reconnect Search Console to refresh sitemaps.",
        );
      throw error;
    }
  });

export const startIndexingSweep = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    projectScoped.extend({
      urls: z.array(z.string().url()).max(2000).optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const result = await GscIndexService.startSweep({
      projectId: context.projectId,
      trigger: "manual",
      urls: data.urls,
    });
    await captureServerEvent({
      distinctId: context.userId,
      event: "gsc:index_sweep_start",
      organizationId: context.organizationId,
      properties: {
        project_id: context.projectId,
        created: result.created,
        kind: result.sweep.kind,
      },
    });
    return { created: result.created, status: result.sweep.status };
  });

const listSchema = projectScoped.extend({
  reason: z.string().optional(),
  status: z.enum(["indexed", "not_indexed", "error", "uninspected"]).optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(200).default(50),
});

export const listIndexingUrls = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(listSchema)
  .handler(async ({ data, context }) =>
    GscIndexService.listIssues({
      projectId: context.projectId,
      reason: data.reason,
      status: data.status,
      limit: data.limit,
      offset: data.offset,
    }),
  );

export const getIndexingUrlDetail = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScoped.extend({ url: z.string().min(1) }))
  .handler(async ({ data, context }) =>
    GscIndexService.getUrlDetail(context.projectId, data.url),
  );

const sitemapWriteSchema = projectScoped.extend({
  feedpath: z.string().url(),
  action: z.enum(["submit", "delete"]),
});

export const writeIndexingSitemap = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(sitemapWriteSchema)
  .handler(async ({ data, context }) => {
    requireOrgPermission(context, { integration: ["manage"] });
    const { connection } = await GscService.getProjectClient(context.projectId);
    if (!(await GscService.connectionCanWrite(connection))) {
      throw new AppError(
        "FORBIDDEN",
        "Enable sitemap management first; this connection is read-only.",
      );
    }
    return data.action === "submit"
      ? GscIndexService.submitSitemap(context.projectId, data.feedpath)
      : GscIndexService.deleteSitemap(context.projectId, data.feedpath);
  });

const cwvSchema = projectScoped.extend({
  scope: z.enum(["origin", "urls"]),
  formFactor: z.enum(CRUX_FORM_FACTORS).optional(),
});

export const getCoreWebVitals = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(cwvSchema)
  .handler(async ({ data, context }) => {
    try {
      return {
        status: "ok" as const,
        result: await CruxService.getCoreWebVitals({
          projectId: context.projectId,
          scope: data.scope,
          formFactor: data.formFactor,
          includeHistory: data.scope === "origin",
        }),
      };
    } catch (error) {
      if (error instanceof CruxNotConfiguredError) {
        return { status: "not_configured" as const, message: error.message };
      }
      if (isNotConnected(error)) return { status: "not_connected" as const };
      throw error;
    }
  });

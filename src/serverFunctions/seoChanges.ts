import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { AuthRepository } from "@/server/auth/repositories/AuthRepository";
import { SeoChangeService } from "@/server/features/seo-changes/services/SeoChangeService";
import { captureServerEvent } from "@/server/lib/posthog";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  seoChangeInputSchema,
  seoChangeListFiltersSchema,
  seoChangeUpdateSchema,
} from "@/types/schemas/seoChanges";

// SEO change log for the app. The `projectId` field in each validator is what
// triggers project authorization (ADR 0001); the service never authorizes.

const projectIdField = { projectId: z.string().min(1) };
const changeRefSchema = z.object({
  ...projectIdField,
  changeId: z.string().min(1),
});

export const listSeoChanges = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(seoChangeListFiltersSchema.extend(projectIdField))
  .handler(async ({ data, context }) => {
    const { projectId: _projectId, ...filters } = data;
    return SeoChangeService.listChanges(context.projectId, filters);
  });

export const getSeoChangeImpact = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(changeRefSchema)
  .handler(async ({ data, context }) =>
    SeoChangeService.getChangeImpact(context.projectId, data.changeId),
  );

export const logSeoChange = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(seoChangeInputSchema.extend(projectIdField))
  .handler(async ({ data, context }) => {
    const { projectId: _projectId, ...input } = data;
    let author = input.author;
    if (!author) {
      const [user] = await AuthRepository.getHostedUserNames([context.userId]);
      author = user?.name || context.userEmail;
    }
    const result = await SeoChangeService.logChange({
      projectId: context.projectId,
      createdByUserId: context.userId,
      author,
      authorKind: "user",
      input,
    });
    await captureServerEvent({
      distinctId: context.userId,
      event: "seo_change:logged",
      organizationId: context.organizationId,
      properties: {
        project_id: context.projectId,
        type: result.change.type,
        target_count: result.change.targets.length,
        baseline_status: result.baseline.status,
        source: "app",
      },
    });
    return result;
  });

export const updateSeoChange = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(seoChangeUpdateSchema.extend(changeRefSchema.shape))
  .handler(async ({ data, context }) => {
    const { projectId: _projectId, changeId, ...update } = data;
    return SeoChangeService.updateChange(context.projectId, changeId, update);
  });

export const deleteSeoChange = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(changeRefSchema)
  .handler(async ({ data, context }) => {
    await SeoChangeService.deleteChange(context.projectId, data.changeId);
    return { changeId: data.changeId };
  });

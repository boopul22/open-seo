import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { YoutubeKeywordService } from "@/server/features/youtube/services/YoutubeKeywordService";
import { requireProjectContext } from "@/serverFunctions/middleware";

// Type-only re-exports so client code can type its rows without importing the
// server service module at runtime.
export type {
  HighPerformanceKeywords,
  KeywordChannel,
  KeywordComparison,
  KeywordComparisonRow,
  KeywordGap,
  KeywordIdea,
  KeywordIdeas,
  KeywordIdeaSource,
  KeywordPerformance,
  KeywordPerformanceVideo,
} from "@/server/features/youtube/services/YoutubeKeywordService";

const projectScopedSchema = z.object({ projectId: z.string().min(1) });
const regionCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/)
  .optional();
const seedSchema = z.string().trim().min(1).max(200);
const keywordSchema = z.string().trim().min(1).max(200);

export const getYoutubeKeywordIdeas = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    projectScopedSchema.extend({
      seed: seedSchema,
      regionCode: regionCodeSchema,
      limit: z.number().int().min(1).max(50).optional(),
    }),
  )
  .handler(async ({ data, context }) =>
    YoutubeKeywordService.getKeywordIdeas({
      projectId: context.projectId,
      userId: context.userId,
      seed: data.seed,
      regionCode: data.regionCode?.toUpperCase(),
      limit: data.limit,
    }),
  );

export const getYoutubeKeywordPerformance = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    projectScopedSchema.extend({
      keyword: keywordSchema,
      regionCode: regionCodeSchema,
      force: z.boolean().optional(),
    }),
  )
  .handler(async ({ data, context }) =>
    YoutubeKeywordService.getKeywordPerformance({
      projectId: context.projectId,
      userId: context.userId,
      keyword: data.keyword,
      regionCode: data.regionCode?.toUpperCase(),
      force: data.force,
    }),
  );

export const getYoutubeHighPerformanceKeywords = createServerFn({
  method: "POST",
})
  .middleware(requireProjectContext)
  .validator(
    projectScopedSchema.extend({
      channelId: z
        .string()
        .regex(/^UC[A-Za-z0-9_-]{22}$/)
        .optional(),
      minVideos: z.number().int().min(2).max(100).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
  )
  .handler(async ({ data, context }) =>
    YoutubeKeywordService.getHighPerformanceKeywords({
      projectId: context.projectId,
      userId: context.userId,
      channelId: data.channelId,
      minVideos: data.minVideos,
      limit: data.limit,
    }),
  );

export const getYoutubeKeywordGap = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    projectScopedSchema.extend({
      competitorChannel: z.string().trim().min(1).max(300),
      minVideos: z.number().int().min(2).max(100).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
  )
  .handler(async ({ data, context }) =>
    YoutubeKeywordService.getKeywordGap({
      projectId: context.projectId,
      userId: context.userId,
      competitorChannel: data.competitorChannel,
      minVideos: data.minVideos,
      limit: data.limit,
    }),
  );

export const compareYoutubeKeywords = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    projectScopedSchema.extend({
      keywords: z.array(keywordSchema).min(2).max(5),
      regionCode: regionCodeSchema,
    }),
  )
  .handler(async ({ data, context }) =>
    YoutubeKeywordService.compareKeywords({
      projectId: context.projectId,
      userId: context.userId,
      keywords: data.keywords,
      regionCode: data.regionCode?.toUpperCase(),
    }),
  );

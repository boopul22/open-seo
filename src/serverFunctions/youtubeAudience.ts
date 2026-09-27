import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { YoutubeAudienceService } from "@/server/features/youtube/services/YoutubeAudienceService";
import { requireProjectContext } from "@/serverFunctions/middleware";

// Type-only re-exports so client code can type its rows without importing the
// server service module at runtime.
export type {
  YoutubeAudienceDimension,
  YoutubeAudienceRow,
  YoutubeRetentionPoint,
} from "@/server/features/youtube/services/YoutubeAudienceService";

const projectScopedSchema = z.object({ projectId: z.string().min(1) });
const videoIdSchema = z.string().regex(/^[A-Za-z0-9_-]{11}$/);
const audienceDimensionSchema = z.enum([
  "country",
  "ageGroup",
  "gender",
  "deviceType",
  "subscribedStatus",
]);
const limitSchema = z.number().int().min(1).max(200).optional();

/** Average retention curve and average view percentage for one video. */
export const getYoutubeVideoRetention = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    projectScopedSchema.extend({
      videoId: videoIdSchema,
    }),
  )
  .handler(async ({ data, context }) =>
    YoutubeAudienceService.getVideoRetention({
      projectId: context.projectId,
      videoId: data.videoId,
    }),
  );

/** Audience composition by country, age group, gender, device, or subscriber
 *  status. */
export const getYoutubeAudienceBreakdown = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    projectScopedSchema.extend({
      dimension: audienceDimensionSchema,
      limit: limitSchema,
    }),
  )
  .handler(async ({ data, context }) =>
    YoutubeAudienceService.getAudienceBreakdown({
      projectId: context.projectId,
      dimension: data.dimension,
      limit: data.limit,
    }),
  );

/** Where the audience watched: location type, or per-type detail rows. */
export const getYoutubePlaybackLocations = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    projectScopedSchema.extend({
      limit: limitSchema,
      detail: z.boolean().optional(),
    }),
  )
  .handler(async ({ data, context }) =>
    YoutubeAudienceService.getPlaybackLocations({
      projectId: context.projectId,
      limit: data.limit,
      detail: data.detail,
    }),
  );

/** Traffic sources for one video. */
export const getYoutubeVideoTraffic = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    projectScopedSchema.extend({
      videoId: videoIdSchema,
      limit: limitSchema,
    }),
  )
  .handler(async ({ data, context }) =>
    YoutubeAudienceService.getVideoTraffic({
      projectId: context.projectId,
      videoId: data.videoId,
      limit: data.limit,
    }),
  );

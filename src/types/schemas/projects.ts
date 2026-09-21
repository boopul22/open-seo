import { z } from "zod";
import {
  isSupportedLanguageCode,
  isSupportedLocationCode,
} from "@/shared/keyword-locations";
import { DEFAULT_PROJECT_TYPE, PROJECT_TYPES } from "@/shared/project-type";

const projectNameField = z
  .string()
  .trim()
  .min(1, "Project name is required")
  .max(120);

const projectDomainField = z
  .string()
  .trim()
  .max(255)
  .transform((value) => value || undefined)
  .optional();

// Default market for the project's data calls. The location/language PAIR is
// validated in the service (an update may change one side and needs the
// stored row for the other).
const projectLocationCodeField = z
  .number()
  .int()
  .refine(isSupportedLocationCode, "Unsupported DataForSEO location code")
  .optional();

const projectLanguageCodeField = z
  .string()
  .refine(isSupportedLanguageCode, "Unsupported language code")
  .optional();

// A language on its own has no location to validate against, and would force a
// read of the stored row to resolve. Callers set the market as a pair, or send
// a location alone and let the service derive its language.
const hasLocationForLanguage = (input: {
  locationCode?: number;
  languageCode?: string;
}) => input.locationCode != null || input.languageCode == null;

const marketPairMessage = {
  message: "A language requires a location.",
  path: ["languageCode"],
};

// A YouTube project is created together with its channel binding: the channel
// picker runs before the project exists, so the binding travels with the create
// call instead of a follow-up project-scoped write.
const youtubeBindingField = z
  .object({
    accountId: z.string().min(1),
    channelId: z.string().regex(/^UC[A-Za-z0-9_-]{22}$/),
  })
  .optional();

export const createProjectSchema = z
  .object({
    name: projectNameField,
    domain: projectDomainField,
    projectType: z.enum(PROJECT_TYPES).optional().default(DEFAULT_PROJECT_TYPE),
    youtube: youtubeBindingField,
    locationCode: projectLocationCodeField,
    languageCode: projectLanguageCodeField,
  })
  .refine(hasLocationForLanguage, marketPairMessage)
  .refine(
    (input) => input.projectType !== "youtube" || input.youtube !== undefined,
    {
      message: "Choose a YouTube channel for this project.",
      path: ["youtube"],
    },
  );

export const updateProjectSchema = z
  .object({
    projectId: z.string().min(1),
    name: projectNameField,
    domain: projectDomainField,
    locationCode: projectLocationCodeField,
    languageCode: projectLanguageCodeField,
  })
  .refine(hasLocationForLanguage, marketPairMessage);

export const setProjectWebsiteSchema = z.object({
  projectId: z.string().min(1),
  domain: z.string().trim().min(1).max(255),
  locationCode: z
    .number()
    .int()
    .refine(isSupportedLocationCode, "Unsupported DataForSEO location code"),
  languageCode: z
    .string()
    .refine(isSupportedLanguageCode, "Unsupported language code"),
});

export const archiveProjectSchema = z.object({
  projectId: z.string().min(1),
});

// Deliberately not named `projectId`: ensureUserMiddleware resolves any
// `projectId` in input data against active projects and 404s on archived
// ones before the handler runs.
export const restoreProjectSchema = z.object({
  archivedProjectId: z.string().min(1),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type ArchiveProjectInput = z.infer<typeof archiveProjectSchema>;
export type RestoreProjectInput = z.infer<typeof restoreProjectSchema>;

export type SetProjectWebsiteInput = z.infer<typeof setProjectWebsiteSchema>;

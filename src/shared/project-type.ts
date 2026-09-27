export const PROJECT_TYPES = ["website", "youtube"] as const;

export type ProjectType = (typeof PROJECT_TYPES)[number];

export const DEFAULT_PROJECT_TYPE: ProjectType = "website";

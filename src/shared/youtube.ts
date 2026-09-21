/** Better Auth provider ID for the dedicated YouTube grant. */
export const YOUTUBE_OAUTH_PROVIDER_ID = "google-youtube";

// Read-only on purpose: youtube.readonly covers channel/video metadata and
// yt-analytics.readonly covers the YouTube Analytics reports. Write scopes
// (youtube.force-ssl, youtube.upload) are deliberately not requested.
export const YOUTUBE_OAUTH_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
] as const;

export const YOUTUBE_SELF_HOSTED_SETUP_DOCS_URL =
  "https://github.com/every-app/open-seo/blob/main/docs/SELF_HOSTING_YOUTUBE.md";

/** YouTube Analytics only serves completed days; the most recent one or two
 *  days are still filling in, so report ranges end here by default. */
export const YOUTUBE_ANALYTICS_LAG_DAYS = 2;

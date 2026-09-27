/** Better Auth providerId for the incremental Google Search Console connection.
 *  Kept in `shared` so both server (auth config, GSC client) and client (connect
 *  button) can reference it without importing the server-only auth config. */
export const GSC_OAUTH_PROVIDER_ID = "google-search-console";

export const GSC_OAUTH_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/webmasters.readonly",
] as const;

export const GSC_SELF_HOSTED_SETUP_DOCS_URL =
  "https://github.com/every-app/open-seo/blob/main/docs/SELF_HOSTING_GOOGLE_SEARCH_CONSOLE.md";

// Opt-in re-consent that lets OpenSEO submit and delete sitemaps. The default
// grant stays read-only; write tools only appear once a grant carries this.
const GSC_WRITE_SCOPE = "https://www.googleapis.com/auth/webmasters";

export const GSC_WRITE_OAUTH_SCOPES = [
  "openid",
  "email",
  "profile",
  GSC_WRITE_SCOPE,
] as const;

/** Better Auth stores granted scopes comma-joined; Google returns them
 *  space-joined. Accept either. */
export function grantAllowsGscWrite(scope: string | null | undefined): boolean {
  if (!scope) return false;
  return scope.split(/[\s,]+/).includes(GSC_WRITE_SCOPE);
}

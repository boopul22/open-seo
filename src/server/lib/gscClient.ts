import { getAuth } from "@/lib/auth";
import { GSC_OAUTH_PROVIDER_ID } from "@/shared/gsc";
import { GscApiError, GscTokenError, isGscDailyQuotaError } from "./gscErrors";

export { GscApiError, GscTokenError } from "./gscErrors";

const GSC_API_BASE = "https://www.googleapis.com/webmasters/v3";
const GSC_INSPECT_URL =
  "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

// Waits before retrying a 429 or 5xx. Google's per-minute limits refill within
// a minute, so three short retries clear a burst; a daily quota error is never
// retried because it cannot clear before midnight Pacific.
const DEFAULT_RETRY_DELAYS_MS = [1_000, 4_000, 15_000];
const MAX_RETRY_AFTER_MS = 60_000;

/** A GSC REST call returned a non-2xx status. `status` drives user-facing messaging. */
export type GscSite = {
  siteUrl: string;
  permissionLevel: string;
};

export type GscSearchAnalyticsRow = {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

export type GscDimensionFilter = {
  dimension: string;
  operator: string;
  expression: string;
};

export type GscSearchAnalyticsRequest = {
  startDate: string;
  endDate: string;
  dimensions?: string[];
  dimensionFilterGroups?: Array<{
    groupType: "and";
    filters: GscDimensionFilter[];
  }>;
  rowLimit?: number;
  startRow?: number;
  type?: string;
  dataState?: string;
  aggregationType?: string;
};

/** Webmasters API `sitemaps` resource. Counts arrive as int64 strings. */
export type GscSitemap = {
  path: string;
  type?: string;
  isPending?: boolean;
  isSitemapsIndex?: boolean;
  lastSubmitted?: string;
  lastDownloaded?: string;
  errors?: string;
  warnings?: string;
  contents?: Array<{ type?: string; submitted?: string; indexed?: string }>;
};

export type GscRichResultIssue = { issueMessage?: string; severity?: string };

/** URL Inspection API `inspectionResult`. Extra wire fields are ignored. */
export type UrlInspectionResult = {
  indexStatusResult?: {
    verdict?: string;
    coverageState?: string;
    robotsTxtState?: string;
    indexingState?: string;
    lastCrawlTime?: string;
    pageFetchState?: string;
    googleCanonical?: string;
    userCanonical?: string;
    crawledAs?: string;
    sitemap?: string[];
    referringUrls?: string[];
  };
  mobileUsabilityResult?: {
    verdict?: string;
    issues?: Array<{ issueType?: string; severity?: string; message?: string }>;
  };
  richResultsResult?: {
    verdict?: string;
    detectedItems?: Array<{
      richResultType?: string;
      items?: Array<{ name?: string; issues?: GscRichResultIssue[] }>;
    }>;
  };
  inspectionResultLink?: string;
};

function messageForStatus(status: number, body: string): string {
  if (status === 401 || status === 403) {
    return "Search Console denied access to this property (no verified permission, or the connection was revoked).";
  }
  if (status === 429) {
    return isGscDailyQuotaError(status, body)
      ? "Search Console daily quota for this property is used up. It resets at midnight Pacific Time."
      : "Search Console rate limit reached. Retry shortly.";
  }
  if (status === 404) {
    return "Search Console property or resource not found. It may have been removed in Search Console.";
  }
  return `Search Console API error (${status}): ${body.slice(0, 300)}`;
}

function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
}

function isRetryable(status: number, body: string): boolean {
  if (status === 429) return !isGscDailyQuotaError(status, body);
  return status >= 500;
}

function sitePath(siteUrl: string): string {
  return `${GSC_API_BASE}/sites/${encodeURIComponent(siteUrl)}`;
}

/** Free Google Search Console client. Unlike the DataForSEO client it does NOT
 *  meter credits — GSC is first-party data with no per-call cost. Access tokens
 *  are minted (and auto-refreshed) by Better Auth from the connector's stored
 *  google-search-console grant. */
export function createGscClient(opts: {
  userId: string;
  gscAccountId?: string;
  /** Backoff schedule for 429/5xx; tests pass zeros. */
  retryDelaysMs?: number[];
}) {
  const retryDelaysMs = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

  async function getToken(): Promise<string> {
    let result: { accessToken?: string } | undefined;
    try {
      // Headerless call: getAccessToken trusts body.userId when no request
      // session is present, and auto-refreshes via the genericOAuth provider.
      // Works in every auth mode — self-hosted builds the same Better Auth
      // instance once BETTER_AUTH_SECRET is set.
      result = await getAuth().api.getAccessToken({
        body: {
          providerId: GSC_OAUTH_PROVIDER_ID,
          userId: opts.userId,
          ...(opts.gscAccountId ? { accountId: opts.gscAccountId } : {}),
        },
      });
    } catch (error) {
      throw new GscTokenError(
        "Could not mint a Search Console access token (grant revoked or expired).",
        error,
      );
    }
    if (!result?.accessToken) {
      throw new GscTokenError(
        "Search Console returned no access token (grant revoked or expired).",
      );
    }
    return result.accessToken;
  }

  /** fetch with auth, 429/5xx backoff, and GscApiError on failure. */
  async function send(
    url: string,
    init?: { method?: string; body?: unknown },
  ): Promise<Response> {
    const token = await getToken();
    const hasBody = init?.body !== undefined;
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, {
        method: init?.method ?? "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(hasBody ? { "Content-Type": "application/json" } : {}),
        },
        body: hasBody ? JSON.stringify(init?.body) : undefined,
      });
      if (response.ok) return response;
      const body = await response.text().catch(() => "");
      const delay = retryDelaysMs[attempt];
      if (delay !== undefined && isRetryable(response.status, body)) {
        const wait = retryAfterMs(response) ?? delay;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw new GscApiError(
        response.status,
        messageForStatus(response.status, body),
        body,
      );
    }
  }

  async function request<T>(
    url: string,
    init?: { method?: string; body?: unknown },
  ): Promise<T> {
    return (await send(url, init)).json<T>();
  }

  return {
    async getUserInfoEmail(): Promise<string | null> {
      const data = await request<{ email?: unknown }>(GOOGLE_USERINFO_URL);
      return typeof data.email === "string" ? data.email : null;
    },

    /** Webmasters API `sites.list` — the verified properties on the grant. */
    async listSites(): Promise<GscSite[]> {
      const data = await request<{ siteEntry?: GscSite[] }>(
        `${GSC_API_BASE}/sites`,
      );
      return data.siteEntry ?? [];
    },

    /** Webmasters API `searchAnalytics.query`. siteUrl is used verbatim. */
    async querySearchAnalytics(
      siteUrl: string,
      body: GscSearchAnalyticsRequest,
    ): Promise<GscSearchAnalyticsRow[]> {
      const data = await request<{ rows?: GscSearchAnalyticsRow[] }>(
        `${sitePath(siteUrl)}/searchAnalytics/query`,
        { method: "POST", body },
      );
      return data.rows ?? [];
    },

    /** `sitemaps.list`. With `sitemapIndex`, lists that index's children. */
    async listSitemaps(
      siteUrl: string,
      sitemapIndex?: string,
    ): Promise<GscSitemap[]> {
      const query = sitemapIndex
        ? `?sitemapIndex=${encodeURIComponent(sitemapIndex)}`
        : "";
      const data = await request<{ sitemap?: GscSitemap[] }>(
        `${sitePath(siteUrl)}/sitemaps${query}`,
      );
      return data.sitemap ?? [];
    },

    async getSitemap(siteUrl: string, feedpath: string): Promise<GscSitemap> {
      return request<GscSitemap>(
        `${sitePath(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`,
      );
    },

    /** Needs the full `webmasters` scope; readonly grants get a 403. */
    async submitSitemap(siteUrl: string, feedpath: string): Promise<void> {
      // sitemaps.submit and sitemaps.delete answer 204 with no body.
      await send(
        `${sitePath(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`,
        { method: "PUT" },
      );
    },

    /** Needs the full `webmasters` scope; readonly grants get a 403. */
    async deleteSitemap(siteUrl: string, feedpath: string): Promise<void> {
      await send(
        `${sitePath(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`,
        { method: "DELETE" },
      );
    },

    /** URL Inspection API `urlInspection.index.inspect`. This lives on a
     *  different host than the Webmasters v3 base, so the full URL is passed to
     *  the request helper. Same `webmasters.readonly` scope. */
    async inspectUrl(
      siteUrl: string,
      inspectionUrl: string,
      languageCode?: string,
    ): Promise<UrlInspectionResult | null> {
      const data = await request<{ inspectionResult?: UrlInspectionResult }>(
        GSC_INSPECT_URL,
        {
          method: "POST",
          body: {
            siteUrl,
            inspectionUrl,
            ...(languageCode ? { languageCode } : {}),
          },
        },
      );
      return data.inspectionResult ?? null;
    },
  };
}

export type GscClient = ReturnType<typeof createGscClient>;

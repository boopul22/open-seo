import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { account } from "@/db/schema";
import { GSC_OAUTH_PROVIDER_ID, grantAllowsGscWrite } from "@/shared/gsc";
import { AppError } from "@/server/lib/errors";
import {
  createGscClient,
  type GscClient,
  type GscSite,
  type UrlInspectionResult,
} from "@/server/lib/gscClient";
import {
  GscApiError,
  GscNotConnectedError,
  GscTokenError,
} from "@/server/lib/gscErrors";
export { GscNotConnectedError } from "@/server/lib/gscErrors";
import {
  buildSearchAnalyticsRequest,
  GSC_API_MAX_ROWS,
  type GscPerformanceInput,
} from "@/server/features/gsc/searchAnalytics";
import {
  GscConnectionRepository,
  type GscConnection,
} from "@/server/features/gsc/repositories/GscConnectionRepository";
import type {
  GscSearchAnalyticsRequest,
  GscSearchAnalyticsRow,
} from "@/server/lib/gscClient";

const SITE_UNVERIFIED_PERMISSION = "siteUnverifiedUser";

type GscPerformanceResult = {
  siteUrl: string;
  connectedBy: string | null;
  request: GscSearchAnalyticsRequest;
  rows: GscSearchAnalyticsRow[];
};

type GscSiteListResult = {
  accounts: Array<{
    accountId: string;
    email: string | null;
    requiresReconnect: boolean;
    propertiesUnavailable: boolean;
    sites: GscSite[];
  }>;
};

/** Thrown when a project has no connected GSC property. */
async function getConnection(projectId: string): Promise<GscConnection | null> {
  return GscConnectionRepository.getByProjectId(projectId);
}

/** Whether this user has linked a google-search-console grant (regardless of
 *  whether they've picked a property yet). Drives the connect-vs-pick UI. */
async function userHasGrant(userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: account.id })
    .from(account)
    .where(
      and(
        eq(account.userId, userId),
        eq(account.providerId, GSC_OAUTH_PROVIDER_ID),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function listGrantsForUser(userId: string) {
  return db
    .select({ id: account.id, accountId: account.accountId })
    .from(account)
    .where(
      and(
        eq(account.userId, userId),
        eq(account.providerId, GSC_OAUTH_PROVIDER_ID),
      ),
    );
}

/** Whether the grant a project's property uses has the opt-in write scope
 *  (sitemap submit/delete). */
async function connectionCanWrite(connection: GscConnection): Promise<boolean> {
  const rows = await db
    .select({ scope: account.scope, accountId: account.accountId })
    .from(account)
    .where(
      and(
        eq(account.userId, connection.connectedByUserId),
        eq(account.providerId, GSC_OAUTH_PROVIDER_ID),
      ),
    );
  const grant = connection.gscAccountId
    ? rows.find((row) => row.accountId === connection.gscAccountId)
    : rows.length === 1
      ? rows[0]
      : undefined;
  return grantAllowsGscWrite(grant?.scope);
}

/** Whether any of this user's Search Console grants can write. Decides if the
 *  MCP server lists the sitemap write tools at all. */
async function userHasWriteGrant(userId: string): Promise<boolean> {
  const rows = await db
    .select({ scope: account.scope })
    .from(account)
    .where(
      and(
        eq(account.userId, userId),
        eq(account.providerId, GSC_OAUTH_PROVIDER_ID),
      ),
    );
  return rows.some((row) => grantAllowsGscWrite(row.scope));
}

/** Expected ways a stored grant fails to reach Search Console: no token could be
 *  minted (refresh token revoked or expired), or Google rejected the call
 *  (401/403). These surface a reconnect prompt without fault logging. */
export function isExpectedGrantFailure(error: unknown): boolean {
  if (error instanceof GscTokenError) return true;
  return (
    error instanceof GscApiError &&
    (error.status === 401 || error.status === 403)
  );
}

async function listSitesForUserWithGrantStatus(
  userId: string,
): Promise<GscSiteListResult> {
  const grants = await listGrantsForUser(userId);
  const accounts = await Promise.all(
    grants.map(async (grant) => {
      const client = createGscClient({
        userId,
        gscAccountId: grant.accountId,
      });

      try {
        const sites = await client.listSites();
        let email: string | null = null;
        try {
          email = await client.getUserInfoEmail();
        } catch {
          email = null;
        }
        return {
          accountId: grant.accountId,
          email,
          requiresReconnect: false,
          propertiesUnavailable: false,
          sites,
        };
      } catch (error) {
        if (!isExpectedGrantFailure(error)) {
          console.error(
            "Failed to list Search Console sites for account",
            grant.accountId,
            error,
          );
        }
        return {
          accountId: grant.accountId,
          email: null,
          requiresReconnect: isExpectedGrantFailure(error),
          propertiesUnavailable: !isExpectedGrantFailure(error),
          sites: [],
        };
      }
    }),
  );
  return { accounts };
}

/** Map a verified property to a project. Rejects unverified properties and
 *  properties not present on the connector's grant. */
async function setSite(input: {
  projectId: string;
  organizationId: string;
  siteUrl: string;
  accountId: string;
  userId: string;
}): Promise<GscConnection> {
  const grants = await listGrantsForUser(input.userId);
  if (!grants.some((grant) => grant.accountId === input.accountId)) {
    throw new AppError(
      "NOT_FOUND",
      "That Google account isn't connected to your OpenSEO account.",
    );
  }

  const client = createGscClient({
    userId: input.userId,
    gscAccountId: input.accountId,
  });
  const sites = await client.listSites();
  const match = sites.find((s) => s.siteUrl === input.siteUrl);
  if (!match) {
    throw new AppError(
      "NOT_FOUND",
      "That Search Console property isn't available on your connected Google account.",
    );
  }
  if (match.permissionLevel === SITE_UNVERIFIED_PERMISSION) {
    throw new AppError(
      "FORBIDDEN",
      "You don't have verified access to that Search Console property.",
    );
  }
  let connectedAccountEmail: string | null = null;
  try {
    connectedAccountEmail = await client.getUserInfoEmail();
  } catch {
    connectedAccountEmail = null;
  }
  return GscConnectionRepository.upsert({
    projectId: input.projectId,
    organizationId: input.organizationId,
    siteUrl: input.siteUrl,
    connectedByUserId: input.userId,
    gscAccountId: input.accountId,
    connectedAccountEmail,
  });
}

async function disconnect(input: { projectId: string }): Promise<void> {
  await GscConnectionRepository.deleteByProjectId(input.projectId);
}

/** The project's connected property and a client on the connector's grant.
 *  Throws GscNotConnectedError when no property is mapped. */
async function getProjectClient(
  projectId: string,
  opts?: { retryDelaysMs?: number[] },
): Promise<{ connection: GscConnection; client: GscClient }> {
  const connection = await GscConnectionRepository.getByProjectId(projectId);
  if (!connection) {
    throw new GscNotConnectedError(projectId);
  }
  const client = createGscClient({
    userId: connection.connectedByUserId,
    gscAccountId: connection.gscAccountId ?? undefined,
    retryDelaysMs: opts?.retryDelaysMs,
  });
  return { connection, client };
}

/** Page through `searchAnalytics.query` in Google's 25,000-row steps until a
 *  short page shows the data ran out, or `maxRows` is reached. */
async function fetchAllRows(
  client: GscClient,
  siteUrl: string,
  request: GscSearchAnalyticsRequest,
  maxRows: number,
): Promise<{ rows: GscSearchAnalyticsRow[]; truncated: boolean }> {
  const rows: GscSearchAnalyticsRow[] = [];
  let startRow = request.startRow ?? 0;
  for (;;) {
    const rowLimit = Math.min(GSC_API_MAX_ROWS, maxRows - rows.length);
    if (rowLimit <= 0) return { rows, truncated: true };
    const page = await client.querySearchAnalytics(siteUrl, {
      ...request,
      rowLimit,
      startRow,
    });
    rows.push(...page);
    if (page.length < rowLimit) return { rows, truncated: false };
    startRow += page.length;
  }
}

/** Pass-through of GSC `searchAnalytics.query` for a project's connected property. */
async function getPerformance(
  input: GscPerformanceInput,
): Promise<GscPerformanceResult> {
  const { connection, client } = await getProjectClient(input.projectId);
  const request = buildSearchAnalyticsRequest(input);
  const rows = await client.querySearchAnalytics(connection.siteUrl, request);
  return {
    siteUrl: connection.siteUrl,
    connectedBy: connection.connectedAccountEmail,
    request,
    rows,
  };
}

/** "All rows" mode: the full result set of a Search Analytics query, paged
 *  server-side, capped at `maxRows`. */
async function getAllPerformanceRows(
  input: GscPerformanceInput,
  maxRows: number,
): Promise<GscPerformanceResult & { truncated: boolean }> {
  const { connection, client } = await getProjectClient(input.projectId);
  const request = buildSearchAnalyticsRequest(input);
  const { rows, truncated } = await fetchAllRows(
    client,
    connection.siteUrl,
    request,
    maxRows,
  );
  return {
    siteUrl: connection.siteUrl,
    connectedBy: connection.connectedAccountEmail,
    request,
    rows,
    truncated,
  };
}

type GscUrlInspection = {
  url: string;
  result: UrlInspectionResult | null;
  error?: string;
};

type GscInspectUrlsResult = {
  siteUrl: string;
  connectedBy: string | null;
  results: GscUrlInspection[];
};

/** Inspect 1–N URLs against a project's connected property. Resolves the
 *  connection once, then inspects each URL; per-URL failures are captured
 *  inline so one bad URL doesn't fail the batch. Token/grant failures
 *  propagate so the caller can prompt a reconnect. */
async function inspectUrls(input: {
  projectId: string;
  urls: string[];
  languageCode?: string;
}): Promise<GscInspectUrlsResult> {
  const { connection, client } = await getProjectClient(input.projectId);
  const results: GscUrlInspection[] = [];
  for (const url of input.urls) {
    try {
      const result = await client.inspectUrl(
        connection.siteUrl,
        url,
        input.languageCode,
      );
      results.push({ url, result });
    } catch (error) {
      if (error instanceof GscTokenError) throw error;
      results.push({
        url,
        result: null,
        error: error instanceof Error ? error.message : "Inspection failed",
      });
    }
  }
  return {
    siteUrl: connection.siteUrl,
    connectedBy: connection.connectedAccountEmail,
    results,
  };
}

export const GscService = {
  getConnection,
  userHasGrant,
  listSitesForUserWithGrantStatus,
  setSite,
  disconnect,
  getProjectClient,
  connectionCanWrite,
  userHasWriteGrant,
  fetchAllRows,
  getPerformance,
  getAllPerformanceRows,
  inspectUrls,
};

import { and, count, eq, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import {
  account,
  ga4Connections,
  gscConnections,
  youtubeConnections,
} from "@/db/schema";
import { GA4_OAUTH_PROVIDER_ID } from "@/shared/ga4";
import { GSC_OAUTH_PROVIDER_ID } from "@/shared/gsc";
import { YOUTUBE_OAUTH_PROVIDER_ID } from "@/shared/youtube";

type AccountInput = {
  userId: string;
  provider: "gsc" | "ga4" | "youtube";
  accountId: string;
};

function scope(input: AccountInput) {
  const providerId =
    input.provider === "gsc"
      ? GSC_OAUTH_PROVIDER_ID
      : input.provider === "ga4"
        ? GA4_OAUTH_PROVIDER_ID
        : YOUTUBE_OAUTH_PROVIDER_ID;
  const connections =
    input.provider === "gsc"
      ? gscConnections
      : input.provider === "ga4"
        ? ga4Connections
        : youtubeConnections;
  return {
    connections,
    grant: and(
      eq(account.userId, input.userId),
      eq(account.providerId, providerId),
      eq(account.accountId, input.accountId),
    ),
    usage:
      input.provider === "gsc"
        ? and(
            eq(gscConnections.connectedByUserId, input.userId),
            // Legacy GSC mappings can use any of this user's grants.
            or(
              eq(gscConnections.gscAccountId, input.accountId),
              isNull(gscConnections.gscAccountId),
            ),
          )
        : input.provider === "ga4"
          ? and(
              eq(ga4Connections.connectedByUserId, input.userId),
              eq(ga4Connections.ga4AccountId, input.accountId),
            )
          : and(
              eq(youtubeConnections.connectedByUserId, input.userId),
              eq(youtubeConnections.youtubeAccountId, input.accountId),
            ),
  };
}

async function getRemovalImpact(input: AccountInput) {
  const { connections, usage } = scope(input);
  const [result] = await db
    .select({ projectCount: count() })
    .from(connections)
    .where(usage);
  return { projectCount: result?.projectCount ?? 0 };
}

async function remove(input: AccountInput) {
  const { connections, grant, usage } = scope(input);
  // Atomic on D1 and Postgres: never leave a partial account removal.
  // Both deletes are scoped to the authenticated owner, including on retries
  // after this Google identity has been linked to a different OpenSEO user.
  await runBatch((tx) => [
    tx.delete(connections).where(usage),
    tx.delete(account).where(grant),
  ]);
}

export const GoogleAccountRepository = { getRemovalImpact, remove };

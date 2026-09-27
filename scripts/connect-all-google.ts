/**
 * Auto-connect every OpenSEO project to its matching GSC property + GA4 property.
 * Single Google login (local-admin) is reused for all projects.
 *
 * Usage (inside the docker container, CWD /app):
 *   pnpm exec tsx scripts/connect-all-google.ts
 *
 * What it does:
 *   1. Reads GOOGLE_CLIENT_ID/SECRET + BETTER_AUTH_SECRET from env.
 *   2. Loads local D1 via wrangler getPlatformProxy (same as seed scripts).
 *   3. Decrypts stored Google grants, refreshes access tokens via Google.
 *   4. GSC: sites.list -> match sc-domain:/https:// variants per project domain.
 *   5. GA4: accountSummaries -> match displayName/dataStream URI per domain.
 *   6. Upserts gsc_connections + ga4_connections (skips already-connected).
 */
import process from "node:process";
import { getPlatformProxy } from "wrangler";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { symmetricDecrypt } from "better-auth/crypto";
// Direct sqlite schema imports (the @/db barrel pulls cloudflare:workers,
// which plain Node can't resolve — same pattern as scripts/seed-projects.ts).
import * as appSchema from "../src/db/app.schema";
import * as gscSchema from "../src/db/gsc.schema";
import * as ga4Schema from "../src/db/ga4.schema";
import { account } from "../src/db/better-auth-schema";

const LOCAL_ADMIN_USER_ID = "local-admin";
const LOCAL_ORG_ID = `delegated-${LOCAL_ADMIN_USER_ID}`;
const GSC_PROVIDER = "google-search-console";
const GA4_PROVIDER = "google-analytics";

const schema = { ...appSchema, ...gscSchema, ...ga4Schema, account };
type Db = ReturnType<typeof drizzle<typeof schema>>;

type GscSite = { siteUrl: string; permissionLevel: string };
type Ga4Prop = {
  propertyId: string;
  displayName: string;
  accountDisplayName: string;
};

async function mintAccessToken(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      refresh_token: input.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`token refresh failed (${res.status})`);
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token)
    throw new Error("token refresh returned no access_token");
  return data.access_token;
}

async function gapi<T>(
  url: string,
  token: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Google API ${res.status} on ${url}: ${body.slice(0, 200)}`,
    );
  }
  return (await res.json()) as T;
}

async function getGrant(db: Db, provider: string) {
  const rows = await db
    .select()
    .from(account)
    .where(
      and(
        eq(account.userId, LOCAL_ADMIN_USER_ID),
        eq(account.providerId, provider),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

function norm(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function gscCandidates(domain: string): string[] {
  return [
    `sc-domain:${domain}`,
    `https://${domain}/`,
    `http://${domain}/`,
    `https://www.${domain}/`,
    `http://www.${domain}/`,
  ];
}

function matchGscSite(domain: string, sites: GscSite[]): GscSite | null {
  for (const c of gscCandidates(domain)) {
    const hit = sites.find((s) => s.siteUrl === c);
    if (hit && hit.permissionLevel !== "siteUnverifiedUser") return hit;
  }
  return null;
}

function matchGa4Prop(
  domain: string,
  props: Ga4Prop[],
  streamHosts: Map<string, string[]>,
): Ga4Prop | null {
  const d = norm(domain);
  // 1. dataStream URI host match (most reliable)
  for (const p of props) {
    for (const h of streamHosts.get(p.propertyId) ?? []) {
      if (norm(h).includes(d) || d.includes(norm(h))) return p;
    }
  }
  // 2. displayName match
  const scored = props
    .map((p) => ({ p, n: norm(p.displayName) }))
    .filter(
      ({ n }) => n && (d.includes(n) || n.includes(d.replace(/^(www)/, ""))),
    );
  if (scored.length === 1) return scored[0]!.p;
  // 3. domain core (without TLD) inside displayName
  const core = norm(domain.split(".")[0] ?? "");
  if (core.length >= 4) {
    const hits = props.filter((p) => norm(p.displayName).includes(core));
    if (hits.length === 1) return hits[0]!;
  }
  return null;
}

async function main() {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const secret = process.env.BETTER_AUTH_SECRET?.trim();
  if (!clientId || !clientSecret)
    throw new Error("GOOGLE_CLIENT_ID/SECRET missing in env");
  if (!secret || secret.length < 32)
    throw new Error("BETTER_AUTH_SECRET missing/short");

  const { env, dispose } = await getPlatformProxy<{ DB: D1Database }>();
  const db = drizzle(env.DB, { schema });
  try {
    const projects = await db.query.projects.findMany({
      where: and(eq(appSchema.projects.organizationId, LOCAL_ORG_ID)),
      columns: { id: true, name: true, domain: true },
    });
    console.log(`Projects: ${projects.length}`);
    for (const p of projects) console.log(` - ${p.domain} (${p.id})`);

    // ---------- GSC ----------
    const gscGrant = await getGrant(db, GSC_PROVIDER);
    if (!gscGrant) {
      console.log(
        "GSC: no google-search-console grant — connect Google in the app first.",
      );
    } else {
      const refresh = await symmetricDecrypt({
        key: secret,
        data: gscGrant.refreshToken!,
      });
      let token: string;
      try {
        token = await mintAccessToken({
          clientId,
          clientSecret,
          refreshToken: refresh,
        });
      } catch (e) {
        console.log(
          `GSC: refresh failed (${(e as Error).message}) — reconnect Google in the app.`,
        );
        token = "";
      }
      if (token) {
        let sites: GscSite[] = [];
        try {
          const data = await gapi<{ siteEntry?: GscSite[] }>(
            "https://www.googleapis.com/webmasters/v3/sites",
            token,
          );
          sites = data.siteEntry ?? [];
        } catch (e) {
          console.log(
            `GSC: sites.list failed (${(e as Error).message}). Is the Search Console API enabled?`,
          );
        }
        console.log(`GSC: ${sites.length} verified properties on the grant.`);
        let email: string | null = null;
        try {
          const me = await gapi<{ email?: string }>(
            "https://openidconnect.googleapis.com/v1/userinfo",
            token,
          );
          email = me.email ?? null;
        } catch {
          email = null;
        }
        for (const p of projects) {
          if (!p.domain) {
            console.log(`GSC skip ${p.name}: no domain`);
            continue;
          }
          const existing = await db.query.gscConnections.findFirst({
            where: eq(gscSchema.gscConnections.projectId, p.id),
          });
          if (existing) {
            console.log(`GSC ok ${p.domain}: already -> ${existing.siteUrl}`);
            continue;
          }
          const hit = matchGscSite(p.domain, sites);
          if (!hit) {
            console.log(
              `GSC miss ${p.domain}: no matching property in sites.list`,
            );
            continue;
          }
          await db
            .insert(gscSchema.gscConnections)
            .values({
              id: crypto.randomUUID(),
              projectId: p.id,
              organizationId: LOCAL_ORG_ID,
              siteUrl: hit.siteUrl,
              connectedByUserId: LOCAL_ADMIN_USER_ID,
              gscAccountId: gscGrant.accountId,
              connectedAccountEmail: email,
            })
            .onConflictDoUpdate({
              target: gscSchema.gscConnections.projectId,
              set: {
                siteUrl: hit.siteUrl,
                connectedByUserId: LOCAL_ADMIN_USER_ID,
                gscAccountId: gscGrant.accountId,
                connectedAccountEmail: email,
              },
            });
          console.log(`GSC linked ${p.domain} -> ${hit.siteUrl}`);
        }
      }
    }

    // ---------- GA4 ----------
    const ga4Grant = await getGrant(db, GA4_PROVIDER);
    if (!ga4Grant) {
      console.log(
        "GA4: no google-analytics grant — connect Google in the app first.",
      );
    } else {
      const refresh = await symmetricDecrypt({
        key: secret,
        data: ga4Grant.refreshToken!,
      });
      let token = "";
      try {
        token = await mintAccessToken({
          clientId,
          clientSecret,
          refreshToken: refresh,
        });
      } catch (e) {
        console.log(
          `GA4: refresh failed (${(e as Error).message}) — reconnect Google in the app.`,
        );
      }
      if (token) {
        const props: Ga4Prop[] = [];
        let pageToken: string | undefined;
        try {
          for (let i = 0; i < 20; i += 1) {
            const u = new URL(
              "https://analyticsadmin.googleapis.com/v1beta/accountSummaries",
            );
            u.searchParams.set("pageSize", "200");
            if (pageToken) u.searchParams.set("pageToken", pageToken);
            const data = await gapi<{
              accountSummaries?: Array<{
                displayName: string;
                propertySummaries?: Array<{
                  property: string;
                  displayName: string;
                }>;
              }>;
              nextPageToken?: string;
            }>(u.toString(), token);
            for (const a of data.accountSummaries ?? []) {
              for (const pr of a.propertySummaries ?? []) {
                props.push({
                  propertyId: pr.property,
                  displayName: pr.displayName,
                  accountDisplayName: a.displayName,
                });
              }
            }
            pageToken = data.nextPageToken || undefined;
            if (!pageToken) break;
          }
        } catch (e) {
          console.log(
            `GA4: accountSummaries failed (${(e as Error).message}). Are the Analytics Admin+Data APIs enabled?`,
          );
        }
        console.log(`GA4: ${props.length} properties on the grant.`);
        // dataStream hosts for precise matching
        const streamHosts = new Map<string, string[]>();
        const details = new Map<
          string,
          { displayName: string; timeZone: string; currencyCode: string }
        >();
        for (const pr of props) {
          try {
            const d = await gapi<{
              displayName: string;
              timeZone: string;
              currencyCode: string;
            }>(
              `https://analyticsadmin.googleapis.com/v1beta/${pr.propertyId}`,
              token,
            );
            details.set(pr.propertyId, d);
          } catch {
            /* keep summary */
          }
          try {
            const s = await gapi<{
              dataStreams?: Array<{ webStreamData?: { defaultUri?: string } }>;
            }>(
              `https://analyticsadmin.googleapis.com/v1alpha/${pr.propertyId}/dataStreams?pageSize=200`,
              token,
            );
            const hosts: string[] = [];
            for (const ds of s.dataStreams ?? []) {
              const uri = ds.webStreamData?.defaultUri;
              if (uri) {
                try {
                  hosts.push(new URL(uri).hostname);
                } catch {
                  hosts.push(uri);
                }
              }
            }
            streamHosts.set(pr.propertyId, hosts);
          } catch {
            streamHosts.set(pr.propertyId, []);
          }
        }
        let email: string | null = null;
        try {
          const me = await gapi<{ email?: string }>(
            "https://openidconnect.googleapis.com/v1/userinfo",
            token,
          );
          email = me.email ?? null;
        } catch {
          email = null;
        }
        for (const p of projects) {
          if (!p.domain) {
            console.log(`GA4 skip ${p.name}: no domain`);
            continue;
          }
          const existing = await db.query.ga4Connections.findFirst({
            where: eq(ga4Schema.ga4Connections.projectId, p.id),
          });
          if (existing) {
            console.log(
              `GA4 ok ${p.domain}: already -> ${existing.propertyDisplayName} (${existing.propertyId})`,
            );
            continue;
          }
          const hit = matchGa4Prop(p.domain, props, streamHosts);
          if (!hit) {
            console.log(`GA4 miss ${p.domain}: no matching property`);
            continue;
          }
          const det = details.get(hit.propertyId) ?? {
            displayName: hit.displayName,
            timeZone: "America/Los_Angeles",
            currencyCode: "USD",
          };
          await db
            .insert(ga4Schema.ga4Connections)
            .values({
              id: crypto.randomUUID(),
              projectId: p.id,
              organizationId: LOCAL_ORG_ID,
              propertyId: hit.propertyId,
              propertyDisplayName: det.displayName,
              propertyTimeZone: det.timeZone,
              propertyCurrencyCode: det.currencyCode,
              connectedByUserId: LOCAL_ADMIN_USER_ID,
              ga4AccountId: ga4Grant.accountId,
              connectedAccountEmail: email,
            })
            .onConflictDoUpdate({
              target: ga4Schema.ga4Connections.projectId,
              set: {
                propertyId: hit.propertyId,
                propertyDisplayName: det.displayName,
                propertyTimeZone: det.timeZone,
                propertyCurrencyCode: det.currencyCode,
                connectedByUserId: LOCAL_ADMIN_USER_ID,
                ga4AccountId: ga4Grant.accountId,
                connectedAccountEmail: email,
              },
            });
          console.log(
            `GA4 linked ${p.domain} -> ${det.displayName} (${hit.propertyId})`,
          );
        }
      }
    }
    console.log("Done.");
  } finally {
    await dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

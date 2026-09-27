import { GscService } from "@/server/features/gsc/services/GscService";
import type { OpenSeoMcpServerOptions } from "@/server/mcp/server";

/** Per-request tool-list options. The sitemap write tools are listed only for
 *  users whose Search Console grant carries the opt-in write scope, so a
 *  read-only connection never advertises them. */
export async function resolveMcpServerOptions(
  userId: string,
): Promise<OpenSeoMcpServerOptions> {
  try {
    return { gscWriteTools: await GscService.userHasWriteGrant(userId) };
  } catch (error) {
    console.error("[mcp] Search Console write-grant lookup failed", error);
    return { gscWriteTools: false };
  }
}

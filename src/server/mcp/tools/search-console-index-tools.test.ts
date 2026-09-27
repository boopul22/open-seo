import { beforeEach, describe, expect, it, vi } from "vitest";
import { objectSchema } from "@/server/mcp/output-schemas";
import { CruxNotConfiguredError } from "@/server/lib/cruxClient";
import * as tools from "./search-console-index-tools";
import { makeToolContext, textContent } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  GscService: {
    getConnection: vi.fn(),
    getProjectClient: vi.fn(),
    connectionCanWrite: vi.fn(),
    listSitesForUserWithGrantStatus: vi.fn(),
  },
  GscIndexService: {
    getCoverage: vi.fn(),
    getSweepStatus: vi.fn(),
    listIssues: vi.fn(),
    startSweep: vi.fn(),
  },
  GscHealthService: { getHealth: vi.fn() },
  getCoreWebVitals: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: async () => true,
  getOptionalEnvValue: async () => undefined,
}));
vi.mock("@/server/features/google/oauth-config", () => ({
  hasSelfHostedGoogleOAuthConfig: async () => false,
}));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock("@/server/features/gsc/services/GscService", () => ({
  GscService: mocks.GscService,
}));
vi.mock("@/server/features/gsc/services/GscIndexService", () => ({
  GscIndexService: mocks.GscIndexService,
}));
vi.mock("@/server/features/gsc/services/GscHealthService", () => ({
  GscHealthService: mocks.GscHealthService,
}));
vi.mock("@/server/features/gsc/services/CruxService", () => ({
  CruxService: { getCoreWebVitals: mocks.getCoreWebVitals },
  MAX_TOP_PAGES: 50,
}));

const context = makeToolContext();

const sweepStatus = {
  active: null,
  lastCompleted: { finishedAt: "2026-09-25T10:00:00.000Z" },
  recent: [],
  pending: 0,
  quota: {
    day: "2026-09-26",
    used: 715,
    limit: 2000,
    remaining: 1285,
    resetsAt: "2026-09-27T07:00:00.000Z",
  },
};

async function expectValidOutput(
  tool: {
    config: { outputSchema: NonNullable<Parameters<typeof objectSchema>[0]> };
  },
  structuredContent: unknown,
) {
  const result = await objectSchema(tool.config.outputSchema).safeParseAsync(
    structuredContent,
  );
  expect(result.success).toBe(true);
}

beforeEach(() => {
  mocks.getProjectForOrganization.mockResolvedValue({ id: "project_1" });
  mocks.GscService.getConnection.mockResolvedValue({
    siteUrl: "sc-domain:x.test",
  });
  mocks.GscIndexService.getSweepStatus.mockResolvedValue(sweepStatus);
});

describe("Search Console index MCP tools", () => {
  it("get_index_coverage reports reasons with samples and how much is inspected", async () => {
    mocks.GscIndexService.getCoverage.mockResolvedValue({
      totalUrls: 715,
      inspectedUrls: 700,
      inspectedPercent: 97.9,
      byStatus: { indexed: 600, not_indexed: 100, error: 0, uninspected: 15 },
      newSince: null,
      reasons: [
        {
          reason: "Crawled - currently not indexed",
          status: "not_indexed",
          count: 100,
          newCount: 4,
        },
      ],
      samples: { "Crawled - currently not indexed": ["https://x.test/a"] },
    });

    const result = await tools.getIndexCoverageTool.handler(
      { projectId: "project_1" },
      context,
    );

    await expectValidOutput(
      tools.getIndexCoverageTool,
      result.structuredContent,
    );
    expect(result.structuredContent).toMatchObject({
      ok: true,
      inspectedPercent: 97.9,
      reasons: [{ sampleUrls: ["https://x.test/a"], newCount: 4 }],
    });
    expect(textContent(result)).toContain("97.9% inspected");
  });

  it("reports a disconnected project instead of empty stored results", async () => {
    mocks.GscService.getConnection.mockResolvedValue(null);

    const result = await tools.getIndexCoverageTool.handler(
      { projectId: "project_1" },
      context,
    );

    expect(result.structuredContent).toMatchObject({
      ok: false,
      reason: "not_connected",
    });
  });

  it("list_index_issues pages with an opaque cursor", async () => {
    mocks.GscIndexService.listIssues.mockResolvedValue({
      urls: [{ url: "https://x.test/a", reason: "Soft 404" }],
      hasMore: true,
      nextOffset: 100,
    });

    const result = await tools.listIndexIssuesTool.handler(
      { projectId: "project_1", reason: "Soft 404", cursor: "50", limit: 50 },
      context,
    );

    expect(mocks.GscIndexService.listIssues).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "Soft 404", offset: 50, limit: 50 }),
    );
    await expectValidOutput(
      tools.listIndexIssuesTool,
      result.structuredContent,
    );
    expect(result.structuredContent).toMatchObject({ nextCursor: "100" });
  });

  it("start_index_sweep queues the requested URLs as an MCP-triggered sweep", async () => {
    mocks.GscIndexService.startSweep.mockResolvedValue({ created: true });

    const result = await tools.startIndexSweepTool.handler(
      { projectId: "project_1", urls: ["https://x.test/a"] },
      context,
    );

    expect(mocks.GscIndexService.startSweep).toHaveBeenCalledWith({
      projectId: "project_1",
      trigger: "mcp",
      urls: ["https://x.test/a"],
    });
    await expectValidOutput(
      tools.startIndexSweepTool,
      result.structuredContent,
    );
  });

  it("get_core_web_vitals explains a missing CrUX key instead of failing", async () => {
    mocks.getCoreWebVitals.mockRejectedValue(new CruxNotConfiguredError());

    const result = await tools.getCoreWebVitalsTool.handler(
      { projectId: "project_1", scope: "origin" },
      context,
    );

    expect(result.structuredContent).toMatchObject({
      ok: false,
      reason: "crux_not_configured",
    });
    expect(textContent(result)).toContain("CRUX_API_KEY");
  });

  it("submit_sitemap refuses a read-only connection", async () => {
    mocks.GscService.getProjectClient.mockResolvedValue({
      connection: { siteUrl: "sc-domain:x.test" },
    });
    mocks.GscService.connectionCanWrite.mockResolvedValue(false);

    const result = await tools.submitSitemapTool.handler(
      { projectId: "project_1", feedpath: "https://x.test/sitemap.xml" },
      context,
    );

    expect(result.structuredContent).toMatchObject({
      ok: false,
      reason: "write_scope_missing",
    });
  });

  it("get_search_console_health returns every section and the no-API report list", async () => {
    mocks.GscHealthService.getHealth.mockResolvedValue({
      property: {
        ok: true,
        data: {
          siteUrl: "sc-domain:x.test",
          propertyType: "domain",
          permissionLevel: "siteOwner",
          connectedBy: null,
          sitemapWriteEnabled: false,
        },
      },
      sitemaps: {
        ok: true,
        data: {
          totals: { sitemaps: 2, errors: 1, warnings: 0, submittedUrls: 715 },
          withIssues: [
            {
              path: "https://x.test/post-sitemap.xml",
              errors: 1,
              warnings: 0,
              isPending: false,
              lastDownloaded: null,
            },
          ],
        },
      },
      indexCoverage: {
        ok: true,
        data: {
          totalUrls: 715,
          inspectedPercent: 50,
          byStatus: {
            indexed: 300,
            not_indexed: 57,
            error: 0,
            uninspected: 358,
          },
          newSince: null,
          newIssues: [],
          topReasons: [
            {
              reason: "Not found (404)",
              status: "not_indexed",
              count: 12,
              newCount: 0,
              sampleUrls: [],
            },
          ],
        },
      },
      sweep: {
        ok: true,
        data: {
          active: null,
          lastCompletedAt: null,
          pendingUrls: 0,
          quota: sweepStatus.quota,
        },
      },
      richResults: { ok: true, data: [] },
      coreWebVitals: { ok: false, error: "CrUX down" },
      performanceDrops: {
        ok: true,
        data: {
          current: { clicks: 10, impressions: 100 },
          previous: { clicks: 20, impressions: 150 },
          clickDrops: [],
          impressionDrops: [],
        },
      },
      notAvailableViaApi: ["Manual actions"],
    });

    const result = await tools.getSearchConsoleHealthTool.handler(
      { projectId: "project_1" },
      context,
    );

    await expectValidOutput(
      tools.getSearchConsoleHealthTool,
      result.structuredContent,
    );
    const text = textContent(result);
    expect(text).toContain("Not found (404): 12");
    expect(text).toContain("Core Web Vitals: unavailable (CrUX down)");
    expect(text).toContain("Manual actions");
  });
});

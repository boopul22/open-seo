import { readFileSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { GscApiError } from "@/server/lib/gscErrors";
import type * as GscIndexServiceModule from "./GscIndexService";

// Real in-memory SQLite built from the production migration: the queue order,
// the "inspected since this sweep started" filter, and the quota upsert are
// SQL, and resuming a sweep is exactly those queries run again later.

const mocks = vi.hoisted(() => ({
  inspectUrl: vi.fn<(siteUrl: string, url: string) => Promise<unknown>>(),
  createWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {
    DATABASE_PROVIDER: "d1",
    INDEX_SWEEP_WORKFLOW: {
      create: mocks.createWorkflow,
      get: mocks.getWorkflow,
    },
  },
}));
vi.mock("@/server/features/gsc/pageMeta", () => ({
  fetchPageMeta: async () => ({
    httpStatus: 200,
    title: "A page",
    metaDescription: null,
  }),
}));
vi.mock("@/server/features/gsc/services/GscService", () => ({
  GscService: {
    getProjectClient: async () => ({
      connection: { siteUrl: "sc-domain:x.test" },
      client: { inspectUrl: mocks.inspectUrl },
    }),
  },
}));

let client: Client;
let GscIndexService: typeof GscIndexServiceModule.GscIndexService;

const SWEEP_STARTED = "2026-09-26T10:00:00.000Z";
// 11:00 Pacific on 2026-09-26; the next quota day starts 07:00 UTC on the 27th.
const TODAY = new Date("2026-09-26T18:00:00Z");
const TOMORROW = new Date("2026-09-27T16:00:00Z");

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  // The repository imports these at module load, so they must be mocked with
  // this test's database before the service is imported.
  vi.doMock("@/db", () => ({ db: testDb }));
  vi.doMock("@/db/runBatch", () => ({
    runBatch: async (build: (tx: typeof testDb) => Promise<unknown>[]) => {
      for (const statement of build(testDb)) await statement;
    },
    executeInBatches: async <T>(
      items: T[],
      build: (tx: typeof testDb, item: T) => Promise<unknown>,
    ) => {
      for (const item of items) await build(testDb, item);
    },
  }));
  await client.executeMultiple(
    [
      `CREATE TABLE projects (id text PRIMARY KEY);`,
      `INSERT INTO projects (id) VALUES ('p1');`,
      // Only the columns the daily-sweep query reads; no project is connected.
      `CREATE TABLE gsc_connections (project_id text, site_url text);`,
      ...readFileSync("drizzle/0053_gsc_index_coverage.sql", "utf8").split(
        "--> statement-breakpoint",
      ),
    ].join("\n"),
  );
  ({ GscIndexService } = await import("./GscIndexService"));
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  mocks.getWorkflow.mockResolvedValue({
    status: async () => ({ status: "running" }),
  });
  mocks.inspectUrl.mockResolvedValue({
    indexStatusResult: {
      verdict: "PASS",
      coverageState: "Submitted and indexed",
    },
  });
  await client.executeMultiple(`
    DELETE FROM gsc_url_inspections;
    DELETE FROM gsc_index_urls;
    DELETE FROM gsc_index_sweeps;
    DELETE FROM gsc_inspection_usage;
    INSERT INTO gsc_index_sweeps (id, project_id, site_url, kind, trigger, status, created_at)
      VALUES ('s1', 'p1', 'sc-domain:x.test', 'full', 'manual', 'running', '${SWEEP_STARTED}');
    INSERT INTO gsc_index_urls (id, project_id, url, impressions, last_inspected_at) VALUES
      ('u1', 'p1', 'https://x.test/stale', 5, '2026-09-20T00:00:00.000Z'),
      ('u2', 'p1', 'https://x.test/stalest', 1, '2026-09-10T00:00:00.000Z'),
      ('u3', 'p1', 'https://x.test/new-popular', 100, NULL),
      ('u4', 'p1', 'https://x.test/new-quiet', 3, NULL),
      ('u5', 'p1', 'https://x.test/already-done', 50, '2026-09-26T11:00:00.000Z');
    INSERT INTO gsc_inspection_usage (id, site_url, day, used)
      VALUES ('q1', 'sc-domain:x.test', '2026-09-26', 1997);
  `);
});

const inspectedUrls = () => mocks.inspectUrl.mock.calls.map((call) => call[1]);

async function sweepRow() {
  const { rows } = await client.execute(
    "SELECT status, resume_at, inspected_count, error_count FROM gsc_index_sweeps WHERE id = 's1'",
  );
  return rows[0];
}

describe("index sweep", () => {
  it("spends the day's remaining quota in priority order, pauses, and resumes the next day", async () => {
    expect(await GscIndexService.processBatch("s1", TODAY)).toEqual({
      state: "continue",
      inspected: 3,
    });
    // Never inspected (most impressions first), then the stalest result.
    expect(inspectedUrls()).toEqual([
      "https://x.test/new-popular",
      "https://x.test/new-quiet",
      "https://x.test/stalest",
    ]);

    expect(await GscIndexService.processBatch("s1", TODAY)).toEqual({
      state: "quota",
      resumeAt: "2026-09-27T07:00:00.000Z",
    });
    expect(await sweepRow()).toMatchObject({ status: "waiting_quota" });

    await GscIndexService.processBatch("s1", TOMORROW);
    expect(inspectedUrls().at(-1)).toBe("https://x.test/stale");
    expect(await GscIndexService.processBatch("s1", TOMORROW)).toEqual({
      state: "done",
    });
    expect(await sweepRow()).toMatchObject({
      status: "completed",
      inspected_count: 4,
    });
  });

  it("stores a failed inspection and moves on without retrying it in the same sweep", async () => {
    await client.execute("UPDATE gsc_inspection_usage SET used = 0");
    mocks.inspectUrl.mockImplementation(async (_site: string, url: string) => {
      if (url.endsWith("new-quiet"))
        throw new GscApiError(500, "Backend error");
      return {
        indexStatusResult: {
          verdict: "PASS",
          coverageState: "Submitted and indexed",
        },
      };
    });

    await GscIndexService.processBatch("s1", TODAY);
    expect(await GscIndexService.processBatch("s1", TODAY)).toEqual({
      state: "done",
    });

    expect(await sweepRow()).toMatchObject({
      inspected_count: 3,
      error_count: 1,
    });
    const { rows } = await client.execute(
      "SELECT i.error FROM gsc_index_urls u JOIN gsc_url_inspections i ON i.id = u.last_inspection_id WHERE u.id = 'u4'",
    );
    expect(rows[0]).toMatchObject({ error: "Backend error" });
  });

  it("relaunches a sweep whose workflow instance is gone", async () => {
    // A restart dropped the instance; the sweep row still says running.
    mocks.getWorkflow.mockRejectedValue(new Error("instance not found"));

    await GscIndexService.runScheduledSweeps(TODAY);

    expect(mocks.createWorkflow).toHaveBeenCalledWith({
      id: "s1-1",
      params: { sweepId: "s1" },
    });
  });

  it("pauses when Google reports the daily quota spent, even if our count disagrees", async () => {
    await client.execute("UPDATE gsc_inspection_usage SET used = 0");
    mocks.inspectUrl.mockRejectedValue(
      new GscApiError(
        429,
        "quota",
        "Quota exceeded for quota metric 'Queries per day'",
      ),
    );

    expect(await GscIndexService.processBatch("s1", TODAY)).toMatchObject({
      state: "quota",
    });
    const { rows } = await client.execute(
      "SELECT used FROM gsc_inspection_usage",
    );
    expect(rows[0]).toMatchObject({ used: 2000 });
    // Nothing was recorded, so every URL is still queued for tomorrow.
    const pending = await client.execute(
      "SELECT count(*) AS n FROM gsc_url_inspections",
    );
    expect(pending.rows[0]).toMatchObject({ n: 0 });
  });
});

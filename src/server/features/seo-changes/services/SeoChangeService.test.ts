import { beforeEach, expect, it, vi } from "vitest";
import { SeoChangeService } from "./SeoChangeService";

// The repository and Search Console are the seams: what's under test is that a
// due checkpoint is measured on read and compared per day against the stored
// baseline and the whole site.
const mocks = vi.hoisted(() => ({
  getChange: vi.fn(),
  listTargets: vi.fn(),
  listCheckpoints: vi.fn(),
  listMetrics: vi.fn(),
  claimCheckpoint: vi.fn(),
  insertMetric: vi.fn(),
  markCheckpointMeasured: vi.fn(),
  recordCheckpointFailure: vi.fn(),
  getPerformance: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock(
  "@/server/features/seo-changes/repositories/SeoChangeRepository",
  () => ({ SeoChangeRepository: mocks }),
);
vi.mock("@/server/features/gsc/services/GscService", () => ({
  GscService: { getPerformance: mocks.getPerformance },
}));
vi.mock("@/db/runBatch", () => ({
  runBatch: async (build: (tx: unknown) => readonly Promise<unknown>[]) => {
    for (const statement of build({})) await statement;
  },
}));

const checkpoint = (
  kind: string,
  start: string,
  end: string,
  status: string,
) => ({
  id: kind,
  changeId: "change_1",
  kind,
  windowStart: start,
  windowEnd: end,
  dueAt: "2026-10-12T00:00:00.000Z",
  status,
  measuredAt: null,
  error: null,
  attempts: 0,
});

const metric = (
  checkpointId: string,
  targetId: string | null,
  clicks: number,
) => ({
  id: `${checkpointId}_${targetId}`,
  checkpointId,
  targetId,
  device: "all",
  clicks,
  impressions: clicks * 20,
  ctr: 0.05,
  position: 6,
});

beforeEach(() => {
  mocks.getChange.mockResolvedValue({
    id: "change_1",
    projectId: "project_1",
    shipDate: "2026-09-25",
    type: "title_meta",
  });
  mocks.listTargets.mockResolvedValue([
    {
      id: "target_1",
      changeId: "change_1",
      kind: "page",
      value: "/image-downloader",
    },
  ]);
  mocks.claimCheckpoint.mockResolvedValue(true);
});

it("measures a settled window on read and compares it per day with the baseline and the site", async () => {
  vi.setSystemTime(new Date("2026-10-23T00:00:00Z"));
  const baseline = checkpoint(
    "baseline",
    "2026-08-26",
    "2026-09-22",
    "measured",
  );
  mocks.listCheckpoints
    .mockResolvedValueOnce([
      baseline,
      checkpoint("day_14", "2026-09-26", "2026-10-09", "pending"),
    ])
    .mockResolvedValueOnce([
      baseline,
      checkpoint("day_14", "2026-09-26", "2026-10-09", "measured"),
    ]);
  // 14 days after: the page doubles from 10/day to 20/day; the site grows 10%.
  mocks.getPerformance.mockImplementation(
    async (input: { filters?: unknown[] }) => ({
      rows: [
        {
          keys: ["MOBILE"],
          clicks: input.filters ? 280 : 15_400,
          impressions: input.filters ? 5600 : 308_000,
          ctr: 0.05,
          position: 4,
        },
      ],
    }),
  );
  const stored: ReturnType<typeof metric>[] = [];
  mocks.insertMetric.mockImplementation(
    async (_tx: unknown, row: ReturnType<typeof metric>) => {
      stored.push(row);
    },
  );
  mocks.listMetrics.mockImplementation(async () => [
    metric("baseline", null, 28_000),
    metric("baseline", "target_1", 280),
    ...stored,
  ]);

  const impact = await SeoChangeService.getChangeImpact(
    "project_1",
    "change_1",
  );

  expect(mocks.getPerformance).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: "project_1",
      startDate: "2026-09-26",
      endDate: "2026-10-09",
      dimensions: ["device"],
      filters: [
        {
          dimension: "page",
          operator: "includingRegex",
          expression: "^https?://[^/]+/image-downloader$",
        },
      ],
    }),
  );
  const [result] = impact.results;
  expect(result.kind).toBe("day_14");
  const page = result.targets.find((row) => row.target?.id === "target_1");
  expect(page?.deltas.find((d) => d.device === "all")).toMatchObject({
    clicksPerDay: { before: 10, after: 20, changePct: 100 },
    position: { before: 6, after: 4, change: -2 },
  });
  expect(page?.clicksVsSitePts).toBeCloseTo(90);
  expect(page?.noise).toEqual([]);
});

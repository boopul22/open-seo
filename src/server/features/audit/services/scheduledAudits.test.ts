import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/lib/errors";
import { runScheduledAudits } from "@/server/features/audit/services/scheduledAudits";

const mocks = vi.hoisted(() => ({
  getDue: vi.fn(),
  claimRun: vi.fn(),
  recordRun: vi.fn(),
  recordSkip: vi.fn(),
  getAuditForProject: vi.fn(),
  resolveAuditLimitTier: vi.fn(),
  remove: vi.fn(),
  startAudit: vi.fn(),
  queueSweep: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/audit/repositories/AuditScheduleRepository", () => ({
  AuditScheduleRepository: mocks,
}));
vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: mocks,
}));
vi.mock("@/server/features/audit/services/AuditService", () => ({
  AuditService: mocks,
}));
vi.mock("@/server/features/pagespeed/services/PageSpeedSweepService", () => ({
  PageSpeedSweepService: mocks,
}));

const schedule = {
  id: "schedule_1",
  projectId: "project_1",
  startUrl: "https://example.com/",
  maxPages: 500,
  createdByUserId: "user_1",
  nextRunAt: "2026-01-01T00:00:00.000Z",
  lastAuditId: "audit_last",
  previousAuditId: "audit_prev",
  organizationId: "org_1",
  userEmail: "a@example.com",
};

beforeEach(() => {
  mocks.getDue.mockResolvedValue([schedule]);
  mocks.claimRun.mockResolvedValue(true);
  mocks.getAuditForProject.mockResolvedValue({
    id: "audit_last",
    status: "completed",
  });
  mocks.resolveAuditLimitTier.mockResolvedValue("free");
  mocks.remove.mockResolvedValue(undefined);
  mocks.startAudit.mockResolvedValue({ auditId: "audit_new" });
});

describe("runScheduledAudits", () => {
  it("drops the audit before last, starts a tier-clamped crawl, and shifts the ids", async () => {
    await runScheduledAudits();

    expect(mocks.remove).toHaveBeenCalledWith("audit_prev", "project_1");
    expect(mocks.startAudit).toHaveBeenCalledWith(
      expect.objectContaining({ maxPages: 50, lighthouseStrategy: "none" }),
    );
    expect(mocks.queueSweep).toHaveBeenCalledWith(
      "project_1",
      "https://example.com/",
    );
    expect(mocks.recordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        lastAuditId: "audit_new",
        previousAuditId: "audit_last",
      }),
    );
  });

  it("waits while last week's crawl is still running", async () => {
    mocks.getAuditForProject.mockResolvedValue({
      id: "audit_last",
      status: "running",
    });

    await runScheduledAudits();

    expect(mocks.claimRun).not.toHaveBeenCalled();
    expect(mocks.recordSkip).toHaveBeenCalledWith(
      "schedule_1",
      "previous_still_running",
    );
  });

  it("records a plan-limit refusal as the skip reason", async () => {
    mocks.startAudit.mockRejectedValue(new AppError("AUDIT_CAPACITY_REACHED"));

    await runScheduledAudits();

    expect(mocks.recordRun).not.toHaveBeenCalled();
    expect(mocks.recordSkip).toHaveBeenCalledWith(
      "schedule_1",
      "AUDIT_CAPACITY_REACHED",
    );
  });
});

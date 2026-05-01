// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * embedding-backfill-worker — audit_logs dual-emit tests (PR-D-5).
 *
 * Verifies that `emitParityCheckFailedIfEnabled` persists to `audit_logs`
 * via `auditLogService.log(...)` AND keeps the logger.warn observability
 * path (dual-emit design). Also verifies the 5-field contract per PR-D-4
 * Amendment 4 and SLO_MARKER catch path (FIND-TPA-PLAN-03).
 *
 * Scope: FIND-PLAN-IO-07 (audit_logs DB landing) + FIND-TPA-PLAN-03 (SLO_MARKER)
 *        + FIND-TPA-PLAN-05 (pickKnownKeys filter).
 *
 * @module tests/workers/embedding-backfill-worker-audit-emit
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { CategoryPendingSnapshot } from "../../src/services/backfill-status.helper";

const FAKE_PAGE_ID = "019bc123-4567-7890-abcd-ef1234500001";

function buildCompleteSnapshot(
  overrides: Partial<CategoryPendingSnapshot> = {}
): CategoryPendingSnapshot {
  return {
    part_text: 0,
    part_visual: 0,
    section_visual: 0,
    motion: 0,
    background: 0,
    js_animation: 0,
    responsive: 0,
    ...overrides,
  };
}

describe("embedding-backfill-worker — audit_logs dual-emit", () => {
  let auditLogSpy: ReturnType<typeof vi.fn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    // Reset singleton so each test sees a freshly wired service.
    const auditModule = await import("../../src/services/audit-log.service");
    auditModule.resetAuditLogService();

    // Wire a mock DI factory. log() becomes a vi.fn for direct assertion.
    auditLogSpy = vi.fn(async () => {});
    auditModule.setAuditLogPrismaClientFactory(
      () =>
        ({
          auditLog: {
            create: async (_args: { data: unknown }) => {
              await auditLogSpy(_args.data);
              return {};
            },
            findMany: async () => [],
            deleteMany: async () => ({ count: 0 }),
            count: async () => 0,
          },
        }) as unknown as Parameters<
          typeof auditModule.setAuditLogPrismaClientFactory
        >[0] extends () => infer T
          ? T
          : never
    );

    const loggerModule = await import("../../src/utils/logger");
    warnSpy = vi.spyOn(loggerModule.logger, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const auditModule = await import("../../src/services/audit-log.service");
    auditModule.resetAuditLogPrismaClientFactory();
    auditModule.resetAuditLogService();
  });

  it("D1: primary emit persists to audit_logs with 5-field contract", async () => {
    const worker = await import("../../src/workers/embedding-backfill-worker");
    const snapshot = buildCompleteSnapshot({ part_text: 3 });

    await worker.emitParityCheckFailedIfEnabled(FAKE_PAGE_ID, snapshot);

    // audit_logs DB write was called exactly once.
    expect(auditLogSpy).toHaveBeenCalledTimes(1);
    const payload = auditLogSpy.mock.calls[0][0] as {
      action: string;
      actor: string;
      targetType: string;
      targetId: string;
      result: string;
      details: Record<string, unknown>;
    };
    // 5-field contract pinning (PR-D-4 Amendment 4 binding).
    expect(payload.action).toBe("embedding_parity_check_failed");
    expect(payload.actor).toBe("system:embedding-backfill-worker");
    expect(payload.targetType).toBe("web_page");
    expect(payload.result).toBe("failure");
    // targetId is persisted as 8-char truncated prefix (PII minimisation,
    // GDPR Art.5(1)(c)). audit-log.service's truncateTargetId runs before
    // prismaClient.auditLog.create, so the spy sees the truncated value.
    expect(payload.targetId).toBe(FAKE_PAGE_ID.slice(0, 8) + "...");
    expect(payload.targetId).not.toBe(FAKE_PAGE_ID);
    // details contains the 5 inner fields.
    expect(payload.details.category).toBeDefined();
    expect(payload.details.skipReason).toBe("parity_check_failed");
    expect(typeof payload.details.timestamp).toBe("string");
    expect(payload.details.pendingSnapshot).toBeDefined();
    expect(payload.details.unexpectedKeys).toEqual([]);
  });

  it("D2: audit-log.service truncateTargetId formats webPageId as 8-char prefix + '...' in DB write", async () => {
    // End-to-end: call emit → verify the actual truncated targetId persisted
    // via the DI factory's `auditLog.create` (not by directly spying the
    // service internal helper, which the Plan permitted but is fragile).
    const auditModule = await import("../../src/services/audit-log.service");
    auditModule.resetAuditLogService();
    const createFn = vi.fn(async (_args: { data: { targetId: string } }) => ({}));
    auditModule.setAuditLogPrismaClientFactory(
      () =>
        ({
          auditLog: {
            create: createFn,
            findMany: async () => [],
            deleteMany: async () => ({ count: 0 }),
            count: async () => 0,
          },
        }) as Parameters<typeof auditModule.setAuditLogPrismaClientFactory>[0] extends () => infer T
          ? T
          : never
    );

    const worker = await import("../../src/workers/embedding-backfill-worker");
    await worker.emitParityCheckFailedIfEnabled(FAKE_PAGE_ID, buildCompleteSnapshot());

    expect(createFn).toHaveBeenCalledTimes(1);
    const persisted = createFn.mock.calls[0][0].data;
    // truncateTargetId: 8 char prefix + "..."
    expect(persisted.targetId).toBe(FAKE_PAGE_ID.slice(0, 8) + "...");
    // Full UUID MUST NOT be persisted (GDPR Art.5(1)(c)).
    expect(persisted.targetId).not.toBe(FAKE_PAGE_ID);
  });

  it("D3: logger.warn dual-emit path still fires with 5-field contract", async () => {
    const worker = await import("../../src/workers/embedding-backfill-worker");
    await worker.emitParityCheckFailedIfEnabled(FAKE_PAGE_ID, buildCompleteSnapshot({ motion: 1 }));

    // Find the emitter's own warn (filter — there may be additional warns
    // from internal paths).
    const emitterCalls = warnSpy.mock.calls.filter(
      (c) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("[EmbeddingBackfillWorker] parity_check_failed emitted")
    );
    expect(emitterCalls).toHaveLength(1);
    const data = emitterCalls[0][1] as Record<string, unknown>;
    expect(typeof data.webPageId).toBe("string");
    expect((data.webPageId as string).endsWith("...")).toBe(true);
    expect((data.webPageId as string).length).toBeLessThanOrEqual(12);
    expect(data.category).toBeDefined();
    expect(data.pendingSnapshot).toBeDefined();
    expect(data.skipReason).toBe("parity_check_failed");
    expect(typeof data.timestamp).toBe("string");
    expect(data.unexpectedKeys).toEqual([]);
  });

  it("D4: dual-emit is fail-independent — primary emit exception triggers SLO_MARKER catch path", async () => {
    // AuditLogService.log() internally graceful-degrades (never throws).
    // The SLO_MARKER catch path handles the defensive case where
    // getAuditLogService() itself throws (DI early-throw). We simulate this
    // by monkey-patching getAuditLogService via its module.
    const auditModule = await import("../../src/services/audit-log.service");
    // Mock the service instance's log method to throw synchronously.
    auditModule.resetAuditLogService();
    const throwingService = {
      log: async () => {
        throw new Error("simulated DI early throw");
      },
      query: async () => [],
      getRetentionPolicy: () => ({ retentionDays: 365, description: "" }),
      cleanup: async () => 0,
    };
    vi.spyOn(auditModule, "getAuditLogService").mockReturnValue(
      throwingService as unknown as ReturnType<typeof auditModule.getAuditLogService>
    );

    const worker = await import("../../src/workers/embedding-backfill-worker");
    await worker.emitParityCheckFailedIfEnabled(FAKE_PAGE_ID, buildCompleteSnapshot());

    // FIND-TPA-PLAN-03 (M): SLO_MARKER log for L1.5 tier monitoring.
    const sloCalls = warnSpy.mock.calls.filter(
      (c) =>
        typeof c[0] === "string" && (c[0] as string).includes("[SLO_MARKER] audit_log_emit_failed")
    );
    expect(sloCalls.length).toBeGreaterThanOrEqual(1);
    const marker = sloCalls[0];
    const markerData = marker[1] as Record<string, unknown>;
    expect(markerData.action).toBe("embedding_parity_check_failed");
    expect((markerData.webPageId as string).endsWith("...")).toBe(true);

    // Despite the primary failure, the dual-emit observability warn still fired.
    const emitterCalls = warnSpy.mock.calls.filter(
      (c) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("[EmbeddingBackfillWorker] parity_check_failed emitted")
    );
    expect(emitterCalls).toHaveLength(1);
  });

  it("D5: payload is numeric-only (PII-free, FIND-PLAN-IO-10)", async () => {
    const worker = await import("../../src/workers/embedding-backfill-worker");
    await worker.emitParityCheckFailedIfEnabled(
      FAKE_PAGE_ID,
      buildCompleteSnapshot({ part_text: 2, motion: 1 })
    );

    const payload = auditLogSpy.mock.calls[0][0] as {
      details: { category: Record<string, unknown> };
    };
    // All category values must be numeric (no IDs, hashes, URLs).
    for (const value of Object.values(payload.details.category)) {
      expect(typeof value).toBe("number");
    }
  });

  it("D6: pickKnownKeys filter strips unknown keys from primary emit payload", async () => {
    const worker = await import("../../src/workers/embedding-backfill-worker");
    const snapshotWithRogue = {
      ...buildCompleteSnapshot({ part_text: 1 }),
      rogue_future_key: 9,
    } as CategoryPendingSnapshot;

    await worker.emitParityCheckFailedIfEnabled(FAKE_PAGE_ID, snapshotWithRogue);

    // Drift path writes 2 audit_logs entries: sentinel (schema_drift) first,
    // then primary (check_failed). Filter for the primary by action.
    const primaryCall = auditLogSpy.mock.calls.find(
      (c) => (c[0] as { action: string }).action === "embedding_parity_check_failed"
    );
    expect(primaryCall).toBeDefined();
    const payload = primaryCall![0] as {
      details: { category: Record<string, unknown>; unexpectedKeys: string[] };
    };
    expect(Object.keys(payload.details.category)).not.toContain("rogue_future_key");
    expect(payload.details.unexpectedKeys).toContain("rogue_future_key");
  });
});

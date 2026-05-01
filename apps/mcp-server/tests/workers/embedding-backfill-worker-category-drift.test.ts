// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * embedding-backfill-worker — category drift sentinel tests (PR-D-5).
 *
 * Verifies runtime Set-equality enforcement (FIND-IMPL-IO-13) + sentinel
 * + continue behavior (Option C, IO Binding Q2) + FIND-TPA-PLAN-05 payload
 * separation (primary emit filtered, sentinel carries unexpectedKeys).
 *
 * @module tests/workers/embedding-backfill-worker-category-drift
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { CategoryPendingSnapshot } from "../../src/services/backfill-status.helper";

const FAKE_PAGE_ID = "019bc123-4567-7890-abcd-ef1234500001";

function fullSnapshot(): CategoryPendingSnapshot {
  return {
    part_text: 0,
    part_visual: 0,
    section_visual: 0,
    motion: 0,
    background: 0,
    js_animation: 0,
    responsive: 0,
  };
}

describe("embedding-backfill-worker — category drift sentinel", () => {
  let createdRecords: Array<Record<string, unknown>>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    createdRecords = [];
    const auditModule = await import("../../src/services/audit-log.service");
    auditModule.resetAuditLogService();
    auditModule.setAuditLogPrismaClientFactory(
      () =>
        ({
          auditLog: {
            create: async (args: { data: Record<string, unknown> }) => {
              createdRecords.push(args.data);
              return {};
            },
            findMany: async () => [],
            deleteMany: async () => ({ count: 0 }),
            count: async () => 0,
          },
        }) as Parameters<typeof auditModule.setAuditLogPrismaClientFactory>[0] extends () => infer T
          ? T
          : never
    );

    const loggerModule = await import("../../src/utils/logger");
    warnSpy = vi.spyOn(loggerModule.logger, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(loggerModule.logger, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const auditModule = await import("../../src/services/audit-log.service");
    auditModule.resetAuditLogPrismaClientFactory();
    auditModule.resetAuditLogService();
  });

  it("drift-1: no drift → single primary emit, no sentinel entry", async () => {
    const worker = await import("../../src/workers/embedding-backfill-worker");
    await worker.emitParityCheckFailedIfEnabled(FAKE_PAGE_ID, fullSnapshot());

    const actions = createdRecords.map((r) => r.action);
    expect(actions).toEqual(["embedding_parity_check_failed"]);
  });

  it("drift-2: unexpected key drift → sentinel + primary emit (Option C continue, separate payloads)", async () => {
    const worker = await import("../../src/workers/embedding-backfill-worker");
    const snapshot = { ...fullSnapshot(), rogue_cat: 5 } as CategoryPendingSnapshot;
    await worker.emitParityCheckFailedIfEnabled(FAKE_PAGE_ID, snapshot);

    const actions = createdRecords.map((r) => r.action);
    // Order: sentinel first, then primary (best evidence preservation).
    expect(actions).toEqual(["embedding_parity_schema_drift", "embedding_parity_check_failed"]);

    // Sentinel payload must carry unexpectedKeys AND NOT raw pendingSnapshot
    // (FIND-TPA-PLAN-05: sentinel schema != primary schema).
    const sentinel = createdRecords[0] as { details: Record<string, unknown> };
    expect(sentinel.details.unexpected).toContain("rogue_cat");
    expect(sentinel.details.unexpectedKeys).toContain("rogue_cat");
    expect("pendingSnapshot" in (sentinel.details as object)).toBe(false);

    // Primary payload has filtered category (rogue stripped) + unexpectedKeys.
    const primary = createdRecords[1] as {
      details: { category: Record<string, unknown>; unexpectedKeys: string[] };
    };
    expect(Object.keys(primary.details.category)).not.toContain("rogue_cat");
    expect(primary.details.unexpectedKeys).toContain("rogue_cat");

    // CRITICAL log for drift (observability).
    const critCalls = errorSpy.mock.calls.filter(
      (c) =>
        typeof c[0] === "string" && (c[0] as string).includes("CRITICAL: category schema drift")
    );
    expect(critCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("drift-3: missing key drift → sentinel reports missing + primary still fires", async () => {
    const worker = await import("../../src/workers/embedding-backfill-worker");
    // Snapshot missing "responsive".
    const snapshot = {
      part_text: 0,
      part_visual: 0,
      section_visual: 0,
      motion: 0,
      background: 0,
      js_animation: 0,
    } as unknown as CategoryPendingSnapshot;
    await worker.emitParityCheckFailedIfEnabled(FAKE_PAGE_ID, snapshot);

    const actions = createdRecords.map((r) => r.action);
    expect(actions).toContain("embedding_parity_schema_drift");
    expect(actions).toContain("embedding_parity_check_failed");

    const sentinel = createdRecords.find((r) => r.action === "embedding_parity_schema_drift") as {
      details: { missing: string[] };
    };
    expect(sentinel.details.missing).toContain("responsive");
  });

  it("drift-4: sentinel exception path triggers SLO_MARKER for schema_drift action", async () => {
    // AuditLogService.log() internally graceful-degrades, so simulate a
    // getAuditLogService() that throws selectively: throw on schema_drift,
    // succeed on check_failed. This pins the defensive SLO_MARKER tag.
    const auditModule = await import("../../src/services/audit-log.service");
    auditModule.resetAuditLogService();
    const selectiveService = {
      log: async (entry: { action: string }) => {
        if (entry.action === "embedding_parity_schema_drift") {
          throw new Error("simulated sentinel DI early throw");
        }
        createdRecords.push(entry as unknown as Record<string, unknown>);
      },
      query: async () => [],
      getRetentionPolicy: () => ({ retentionDays: 365, description: "" }),
      cleanup: async () => 0,
    };
    vi.spyOn(auditModule, "getAuditLogService").mockReturnValue(
      selectiveService as unknown as ReturnType<typeof auditModule.getAuditLogService>
    );

    const worker = await import("../../src/workers/embedding-backfill-worker");
    const snapshot = { ...fullSnapshot(), unexpected_cat: 2 } as CategoryPendingSnapshot;
    await worker.emitParityCheckFailedIfEnabled(FAKE_PAGE_ID, snapshot);

    // Primary emit still succeeded despite sentinel failure.
    expect(createdRecords.map((r) => r.action)).toEqual(["embedding_parity_check_failed"]);

    // SLO_MARKER for sentinel write failure.
    const sloSentinel = warnSpy.mock.calls.filter((c) => {
      if (typeof c[0] !== "string") return false;
      const msg = c[0] as string;
      if (!msg.includes("[SLO_MARKER] audit_log_emit_failed")) return false;
      const data = c[1] as Record<string, unknown> | undefined;
      return data?.action === "embedding_parity_schema_drift";
    });
    expect(sloSentinel.length).toBeGreaterThanOrEqual(1);
  });
});

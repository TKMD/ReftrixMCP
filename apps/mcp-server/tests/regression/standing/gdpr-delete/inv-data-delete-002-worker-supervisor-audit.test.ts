// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — gdpr-delete / INV-DATA-DELETE-002 extension
 *
 * **PR-D-8 cross-reference**: `worker_supervisor_restart` audit_logs row
 * inherits the 365d retention + `truncateTargetId` + PII-minimisation
 * contract of INV-DATA-DELETE-002 (GDPR Art.30 processing activity record).
 *
 * **Binding / 束縛**: FIND-PLAN-LCC-02 M (Finding Registry v2 §10 contract #6)
 *
 * **Scope**:
 *   - action name contract: `worker_supervisor_restart`
 *   - actor contract: `system:worker-supervisor`
 *   - retention_policy: 365d (AUDIT_LOG_CONSTANTS.DEFAULT_RETENTION_DAYS)
 *   - targetId: PII-truncated via `truncateTargetId` (TARGET_ID_TRUNCATE_LENGTH=8)
 *   - details: NO nonce / UUID / boot-token leakage (SEC-V11-01 cross-guard)
 *
 * The primary test body lives in
 * `tests/regression/standing/worker-lifecycle/inv-worker-lock-003-embedding-backfill-supervisor.test.ts`
 * case #11. This file pins the **cross-domain contract** so gdpr-delete
 * domain enforcement (INV-DATA-DELETE-002) also catches regression in the
 * supervisor audit emit path.
 *
 * Per Plan v1.1 §6.1 case #11 comment tag: test also tagged INV-DATA-DELETE-002.
 *
 * @see Plan v1.1 §6.1 case #11 (cross-ref)
 * @see Finding Registry v2 §10 contract #6 (LCC-02 M, 2026-05-30)
 * @see ADR-0011 Amendment (to land in Phase 3: audit_logs emit scope)
 * @see `apps/mcp-server/src/services/audit-log.service.ts` (AUDIT_LOG_CONSTANTS)
 * @module tests/regression/standing/gdpr-delete/inv-data-delete-002-worker-supervisor-audit
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { assertInvName } from "../_setup/inv-assert";
import {
  setAuditLogPrismaClientFactory,
  resetAuditLogPrismaClientFactory,
  resetAuditLogService,
  type AuditLogPrismaClient,
} from "../../../../src/services/audit-log.service";

// ============================================================================
// Stub audit_logs prisma client (shared shape with worker-lifecycle test #11)
// ============================================================================

interface RecordedAuditLog {
  action: string;
  actor: string;
  targetType: string;
  targetId: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  result: string;
}

function createAuditLogStub(): {
  prisma: AuditLogPrismaClient;
  records: RecordedAuditLog[];
} {
  const records: RecordedAuditLog[] = [];
  const prisma: AuditLogPrismaClient = {
    auditLog: {
      create: async (args: {
        data: Record<string, unknown>;
      }): Promise<{ id: string; timestamp: Date }> => {
        const d = args.data as {
          action: string;
          actor: string;
          targetType: string;
          targetId?: string | null;
          details?: Record<string, unknown> | null;
          ipAddress?: string | null;
          result: string;
        };
        records.push({
          action: d.action,
          actor: d.actor,
          targetType: d.targetType,
          targetId: d.targetId ?? null,
          details: d.details ?? null,
          ipAddress: d.ipAddress ?? null,
          result: d.result,
        });
        return { id: randomUUID(), timestamp: new Date() };
      },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      findMany: async (_args: unknown): Promise<unknown[]> => [],
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      count: async (_args?: unknown): Promise<number> => records.length,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      deleteMany: async (_args: unknown): Promise<{ count: number }> => ({
        count: 0,
      }),
    } as unknown as AuditLogPrismaClient["auditLog"],
  };
  return { prisma, records };
}

// ============================================================================
// Test
// ============================================================================

describe("INV-DATA-DELETE-002: worker_supervisor_restart audit_logs contract (PR-D-8 LCC-02 cross-ref)", () => {
  let stub: ReturnType<typeof createAuditLogStub>;

  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-DATA-DELETE-002");
    stub = createAuditLogStub();
    setAuditLogPrismaClientFactory(() => stub.prisma);
    resetAuditLogService();
  });

  afterEach(() => {
    resetAuditLogPrismaClientFactory();
    resetAuditLogService();
  });

  it("INV-DATA-DELETE-002: worker_supervisor_restart inherits 365d retention + truncateTargetId + system:worker-supervisor actor (GDPR Art.30 cross-domain) / 365d + truncate + actor 契約", async () => {
    const { getAuditLogService, AUDIT_LOG_CONSTANTS } =
      await import("../../../../src/services/audit-log.service");
    const service = getAuditLogService();

    // Use a full UUID as targetId so truncation is empirically visible
    // (bare pid is <8 chars and would bypass truncation).
    // lockNonce (36-char UUID) を targetId に指定し truncate を実証。
    const lockNonce = randomUUID();
    expect(lockNonce.length).toBe(36);

    await service.log({
      action: "worker_supervisor_restart",
      actor: "system:worker-supervisor",
      targetType: "worker",
      targetId: lockNonce,
      details: {
        workerType: "embedding-backfill",
        restartReason: "job_count_threshold",
        jobsProcessed: 3,
        pid: 1234,
      },
      result: "success",
    });

    expect(stub.records).toHaveLength(1);
    const row = stub.records[0];

    // Action label locked (CI-failing on rename)
    expect(row?.action).toBe("worker_supervisor_restart");
    // Actor label locked
    expect(row?.actor).toBe("system:worker-supervisor");
    // targetType label locked
    expect(row?.targetType).toBe("worker");
    // result contract
    expect(row?.result).toBe("success");

    // Retention contract (365d inherited from AUDIT_LOG_CONSTANTS)
    expect(AUDIT_LOG_CONSTANTS.DEFAULT_RETENTION_DAYS).toBe(365);
    // Truncation contract (TARGET_ID_TRUNCATE_LENGTH=8 + "..." sentinel)
    expect(AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH).toBe(8);

    // PII minimisation: full nonce NOT leaked into targetId; truncated form only.
    // PII 最小化: 完全 nonce は targetId に出ない (truncate 済み)。
    expect(row?.targetId).not.toBe(lockNonce);
    expect(row?.targetId).toMatch(/^[0-9a-f]{8}\.{3}$/);

    // details accepted as-is (supervisor owns sanitization; test #12 SEC-V11-01
    // ensures no boot-token / nonce leak).
    // details は supervisor 側で sanitize 済みの前提 (SEC-V11-01 で nonce が
    // 含まれないことを確認)。
    expect(row?.details?.workerType).toBe("embedding-backfill");
    expect(row?.details?.restartReason).toBe("job_count_threshold");

    // Cross-guard: details must NOT contain the lockNonce value.
    // cross-guard: details に lockNonce が含まれないこと。
    const detailsJson = JSON.stringify(row?.details ?? {});
    expect(detailsJson.includes(lockNonce)).toBe(false);
  });
});

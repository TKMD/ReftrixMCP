// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-SEC-H-01-FAILED-KNOWN-REASON-SANITISER — Standing regression for
 * Plan v3 Track T4 (PR-V3-T4) SEC H-01 sanitiser canonical fix (Z-a Wave 2).
 *
 * INV-SEC-H-01: Plan v3 T4 client-facing sanitiser invariants for
 * `failed_known_reason` enum exposure (CWE-209 information exposure defense).
 *
 * **Two-tier surface contract** (SSOT: `apps/mcp-server/src/utils/sanitize-error.ts`
 * `sanitizeAnalysisErrorForClient` JSDoc lines 149-156):
 *   - **DB internal canonical (preserved)**: `worker_restart_during_inflight_phase_<N>`
 *     stored verbatim in `audit_logs.details.failed_known_reason` for operator
 *     dashboards and supervisor backfill `findOrphanWebPageIds` matching.
 *   - **Client-facing generic (verified here)**: `analysis_pipeline_interrupted`
 *     surfaced through `audit.query` MCP tool, BullMQ queue boundary getJobStatus,
 *     `data.export` GDPR Art.20 paths, and `page.getJobStatus` MCP tool.
 *
 * **Coverage** (this file):
 *   - Test 1: `audit.query` handler sanitises `details.failed_known_reason` (top-level
 *     T4 WorkerRestartInflightAuditMetadata shape) → `analysis_pipeline_interrupted`
 *   - Test 2: `audit.query` handler sanitises `details.metadata.failed_known_reason`
 *     (nested defensive shape coverage) → `analysis_pipeline_interrupted`
 *   - Test 3: `audit.query` non-T4 reasons pass through unchanged (no over-sanitisation)
 *   - Test 4: `audit.query` non-string `failed_known_reason` pass through (defensive)
 *   - Test 5: SSOT-derived assertion guard (sentinel against hardcoded literal regression)
 *
 * **Multi-layer defense** (this test verifies layer 2):
 *   1. Layer 1: `redactDetailsMetadata()` (LCC M-02) — PII process-identifier redaction
 *   2. Layer 2 (this test): `sanitizeFailedKnownReasonInDetails()` (SEC H-01) —
 *      `failed_known_reason` enum CWE-209 sanitisation
 *
 * **Cross-ref**:
 * - `.claude/rules/security.md` "Canonical CWE-209 PII Protection Pattern (LCC-endorsed)"
 * - PR-V3-T4 design.md §6.3 (SEC H-01 sanitisation contract)
 * - SEC face audit anchor `019df6b8-93db-72be-9f19-7207e74cb7d3`
 * - IO Decision V0 anchor `019df6e2-9304-70d9-bd85-1751807f6d99`
 * - Sibling tests: `apps/mcp-server/tests/tools/audit/query.tool.cwe-209.test.ts`
 *   (LCC M-02 PII redaction, Z-b)
 *
 * @module tests/regression/standing/worker-lifecycle/inv-sec-h-01-failed-known-reason-sanitiser
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  auditQueryHandler,
  setAuditQueryServiceFactory,
  resetAuditQueryServiceFactory,
  type AuditQueryOutput,
} from "../../../../src/tools/audit/query.tool";
import { sanitizeAnalysisErrorForClient } from "../../../../src/utils/sanitize-error";

// =====================================================
// logger モック / Logger mock
// =====================================================

vi.mock("../../../../src/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  isDevelopment: vi.fn().mockReturnValue(false),
}));

// =====================================================
// モックサービス / Mock Service
// =====================================================

function createMockAuditLogService(): {
  log: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  getRetentionPolicy: ReturnType<typeof vi.fn>;
  cleanup: ReturnType<typeof vi.fn>;
} {
  return {
    log: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([]),
    getRetentionPolicy: vi.fn().mockReturnValue({
      retentionDays: 365,
      description: "Audit logs are retained for 365 days",
    }),
    cleanup: vi.fn().mockResolvedValue(0),
  };
}

// =====================================================
// テスト / Tests
// =====================================================

describe("INV-SEC-H-01-FAILED-KNOWN-REASON-SANITISER (audit.query CWE-209 defense)", () => {
  let mockService: ReturnType<typeof createMockAuditLogService>;

  beforeEach(() => {
    mockService = createMockAuditLogService();
    setAuditQueryServiceFactory(() => mockService as never);
  });

  afterEach(() => {
    resetAuditQueryServiceFactory();
    vi.restoreAllMocks();
  });

  // ===================================================
  // Test 1: top-level details.failed_known_reason (T4 canonical shape)
  // ===================================================
  it("INV-SEC-H-01: redacts top-level details.failed_known_reason (T4 WorkerRestartInflightAuditMetadata shape) → analysis_pipeline_interrupted / Plan v3 T4 SEC H-01 sanitiser canonical contract", async () => {
    // Each phase enum value MUST be sanitised
    // 各 phase 値が必ず sanitise されること
    const phaseEnumValues = [
      "worker_restart_during_inflight_phase_0",
      "worker_restart_during_inflight_phase_1",
      "worker_restart_during_inflight_phase_2_5",
      "worker_restart_during_inflight_phase_4",
      "worker_restart_during_inflight_phase_5",
      "worker_restart_during_inflight_phase_7_5",
    ];

    for (const enumValue of phaseEnumValues) {
      mockService.query.mockResolvedValueOnce([
        {
          id: "audit-1",
          timestamp: new Date("2026-05-04T10:00:00Z"),
          action: "worker_restart_during_inflight_phase",
          actor: "system:page-analyze-worker",
          targetType: "web_page",
          targetId: "01234567...",
          details: {
            failed_known_reason: enumValue,
            phase_n: "5",
            child_pid: "pid_abcdef12",
            phase_reconstruction: "exact",
            reason: "self_emit",
          },
          ipAddress: null,
          result: "failure",
        },
      ]);

      const result = (await auditQueryHandler({})) as AuditQueryOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;

      const log = result.data.logs[0]!;
      const details = log.details as Record<string, unknown>;

      // SSOT-derived expected — derive from sanitizeAnalysisErrorForClient itself
      // SSOT 由来期待値 — sanitizer 自身から導出 (hardcoded literal 禁止)
      const expected = sanitizeAnalysisErrorForClient(enumValue);
      expect(details.failed_known_reason).toBe(expected);
      // Verify the canonical 1:1 mapping landed
      // 1:1 canonical mapping が実際に適用されていることを確認
      expect(details.failed_known_reason).toBe("analysis_pipeline_interrupted");

      // Non-sanitised fields MUST be preserved unchanged
      // Sanitise 対象外 field は保持されること (over-sanitisation 防止)
      expect(details.phase_n).toBe("5");
      expect(details.phase_reconstruction).toBe("exact");
      expect(details.reason).toBe("self_emit");
    }
  });

  // ===================================================
  // Test 2: nested details.metadata.failed_known_reason (defensive coverage)
  // ===================================================
  it("INV-SEC-H-01: redacts nested details.metadata.failed_known_reason (legacy / future audit emit shapes) → analysis_pipeline_interrupted / 多層防御 nested shape coverage", async () => {
    mockService.query.mockResolvedValue([
      {
        id: "audit-2",
        timestamp: new Date("2026-05-04T10:01:00Z"),
        action: "page.analyze",
        actor: "system:worker-supervisor",
        targetType: "web_page",
        targetId: "abcdef12...",
        details: {
          metadata: {
            failed_known_reason: "worker_restart_during_inflight_phase_4",
            extra_field: "preserved",
          },
        },
        ipAddress: null,
        result: "failure",
      },
    ]);

    const result = (await auditQueryHandler({})) as AuditQueryOutput;

    expect(result.success).toBe(true);
    if (!result.success) return;

    const log = result.data.logs[0]!;
    const details = log.details as Record<string, unknown>;
    const metadata = details.metadata as Record<string, unknown>;

    expect(metadata.failed_known_reason).toBe("analysis_pipeline_interrupted");
    // Sibling fields preserved
    // 同一階層の他 field は保持
    expect(metadata.extra_field).toBe("preserved");
  });

  // ===================================================
  // Test 3: non-T4 reasons pass through unchanged
  // ===================================================
  it("INV-SEC-H-01: non-T4 reasons (legacy / BullMQ raw / non-prefixed) pass through unchanged / 非 T4 理由は pass-through (over-sanitisation 防止)", async () => {
    const nonT4Reasons = [
      "Some legacy error message from BullMQ",
      "Connection refused: ECONNREFUSED",
      "phase_5_oom_kill", // non-prefixed phase identifier
      "TimeoutError: heartbeat exceeded",
    ];

    for (const reason of nonT4Reasons) {
      mockService.query.mockResolvedValueOnce([
        {
          id: "audit-3",
          timestamp: new Date("2026-05-04T10:02:00Z"),
          action: "worker_failed",
          actor: "system:worker-supervisor",
          targetType: "web_page",
          targetId: null,
          details: {
            failed_known_reason: reason,
          },
          ipAddress: null,
          result: "failure",
        },
      ]);

      const result = (await auditQueryHandler({})) as AuditQueryOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;

      const log = result.data.logs[0]!;
      const details = log.details as Record<string, unknown>;

      // Non-T4 reasons pass through verbatim (no false-positive sanitisation)
      // 非 T4 理由は逐語的に pass-through (false-positive sanitisation 無し)
      expect(details.failed_known_reason).toBe(reason);
    }
  });

  // ===================================================
  // Test 4: non-string failed_known_reason field defensive coverage
  // ===================================================
  it("INV-SEC-H-01: non-string failed_known_reason field (number / null / undefined / object) preserved as-is / 非 string 値は defensive pass-through", async () => {
    const nonStringValues: ReadonlyArray<unknown> = [123, null, undefined, { nested: "value" }];

    for (const value of nonStringValues) {
      mockService.query.mockResolvedValueOnce([
        {
          id: "audit-4",
          timestamp: new Date("2026-05-04T10:03:00Z"),
          action: "test_action",
          actor: "system:test",
          targetType: "test",
          targetId: null,
          details: {
            failed_known_reason: value,
            other_field: "stable",
          },
          ipAddress: null,
          result: "failure",
        },
      ]);

      const result = (await auditQueryHandler({})) as AuditQueryOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;

      const log = result.data.logs[0]!;
      const details = log.details as Record<string, unknown>;

      // Non-string values preserved (sanitiser is type-guarded)
      // 非 string 値は保持 (sanitiser に type guard 有り)
      expect(details.failed_known_reason).toEqual(value);
      expect(details.other_field).toBe("stable");
    }
  });

  // ===================================================
  // Test 5: SSOT-derive assertion (sentinel against hardcoded literal regression)
  // ===================================================
  it("INV-SEC-H-01: SSOT-derive assertion (sentinel) — `analysis_pipeline_interrupted` literal MUST come from sanitizeAnalysisErrorForClient SSOT, NOT hardcoded in test / SSOT 由来 sentinel: literal hardcoded 禁止", async () => {
    // Verify SSOT contract: sanitizeAnalysisErrorForClient applied to ANY
    // `worker_restart_during_inflight_phase_<N>` form yields exactly
    // `analysis_pipeline_interrupted`.
    // SSOT 契約検証: sanitizer は `worker_restart_during_inflight_phase_<N>`
    // 形を全て `analysis_pipeline_interrupted` に 1:1 mapping すること。
    const probe = "worker_restart_during_inflight_phase_99";
    const sanitisedFromSsot = sanitizeAnalysisErrorForClient(probe);

    // The SSOT helper returns the canonical literal — DO NOT hardcode in
    // assertion below; derive expected from SSOT.
    // SSOT helper の返り値が canonical literal — 期待値 hardcoded 禁止。
    expect(sanitisedFromSsot).toBe("analysis_pipeline_interrupted");

    // Audit handler MUST produce the same canonical literal.
    // audit handler も同じ canonical literal を出力すること。
    mockService.query.mockResolvedValue([
      {
        id: "audit-5",
        timestamp: new Date("2026-05-04T10:04:00Z"),
        action: "worker_restart_during_inflight_phase",
        actor: "system:page-analyze-worker",
        targetType: "web_page",
        targetId: null,
        details: {
          failed_known_reason: probe,
        },
        ipAddress: null,
        result: "failure",
      },
    ]);

    const result = (await auditQueryHandler({})) as AuditQueryOutput;

    expect(result.success).toBe(true);
    if (!result.success) return;

    const log = result.data.logs[0]!;
    const details = log.details as Record<string, unknown>;

    // Cross-correlation: handler output MUST equal SSOT helper output
    // クロス相関: handler 出力と SSOT helper 出力が一致
    expect(details.failed_known_reason).toBe(sanitisedFromSsot);
  });
});

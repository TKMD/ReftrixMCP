// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * audit.query MCPツール — CWE-209 PII redaction defense-in-depth テスト (LCC M-02)
 *
 * 検証対象 / Scope:
 *   `audit.query` handler が details.metadata 内の PII (child_pid / workerPid / pid) を
 *   SSOT-derived truncation (`AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH`) で
 *   redact することを検証する (multi-layer defense-in-depth)。
 *
 * Verifies that the `audit.query` handler redacts PII (child_pid / workerPid / pid)
 * inside details.metadata via SSOT-derived truncation
 * (`AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH`) — defense-in-depth.
 *
 * SSOT 由来 / SSOT-derived:
 *   テスト assertion で hardcoded literal (例: `"12345678..."`) を使用せず、
 *   `AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH` から導出する
 *   (canonical Wave 5 PII Protection Pattern, `.claude/rules/security.md` 参照)。
 *
 * Test assertions MUST NOT use hardcoded literals; they derive expected values
 * from `AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH` (canonical Wave 5
 * PII Protection Pattern, see `.claude/rules/security.md`).
 *
 * Cross-ref:
 * - `apps/mcp-server/tests/regression/standing/worker-lifecycle/inv-worker-lock-003-embedding-backfill-supervisor.test.ts`
 *   line ~2317 (Wave 5 fix exemplar — SSOT-derived test assertion canonical)
 * - LCC M-02 audit anchor: `019df6b5-f36c-77dc-88a6-436fd16a7898`
 * - IO Decision V0 anchor: `019df6e2-9304-70d9-bd85-1751807f6d99`
 *
 * @module tests/tools/audit/query.tool.cwe-209.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  auditQueryHandler,
  setAuditQueryServiceFactory,
  resetAuditQueryServiceFactory,
  type AuditQueryOutput,
} from "../../../src/tools/audit/query.tool";
import { AUDIT_LOG_CONSTANTS } from "../../../src/services/audit-log.service";

// =====================================================
// logger モック / Logger mock
// =====================================================

vi.mock("../../../src/utils/logger", () => ({
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
// SSOT-derived expected truncation helper / SSOT 由来期待値ヘルパー
// =====================================================

/**
 * SSOT (`AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH`) から expected truncated 値を導出する。
 * Hardcoded literal は使用禁止 (canonical Wave 5 PII Protection Pattern)。
 *
 * Derives expected truncated value from the SSOT constant.
 * Hardcoded literals are forbidden (canonical Wave 5 PII Protection Pattern).
 */
function expectedTruncatedFromSsot(value: string): string {
  if (value.length <= AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) {
    return value;
  }
  return value.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "...";
}

// =====================================================
// テスト / Tests
// =====================================================

describe("audit.query tool — CWE-209 PII redaction defense-in-depth (LCC M-02)", () => {
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
  // Test 1: child_pid truncation
  // ===================================================
  it("redacts details.metadata.child_pid via SSOT-derived truncation / SSOT由来 truncation で child_pid を redact", async () => {
    const fullChildPid = "1234567890";
    mockService.query.mockResolvedValue([
      {
        id: "audit-1",
        timestamp: new Date("2026-05-04T10:00:00Z"),
        action: "page.analyze",
        actor: "system:worker-supervisor",
        targetType: "worker",
        targetId: null,
        details: {
          metadata: {
            child_pid: fullChildPid,
            workerType: "page",
          },
        },
        ipAddress: null,
        result: "success",
      },
    ]);

    const result = (await auditQueryHandler({})) as AuditQueryOutput;

    expect(result.success).toBe(true);
    if (!result.success) return;

    const log = result.data.logs[0];
    expect(log.details).not.toBeNull();
    const metadata = (log.details as Record<string, unknown>).metadata as Record<string, unknown>;

    // SSOT-derived expected value (NEVER hardcode "12345678...")
    // SSOT 由来期待値 (ハードコード禁止)
    const expected = expectedTruncatedFromSsot(fullChildPid);
    expect(metadata.child_pid).toBe(expected);

    // Non-PII field preserved as-is
    // 非 PII field はそのまま保持
    expect(metadata.workerType).toBe("page");
  });

  // ===================================================
  // Test 2: workerPid (regex coverage)
  // ===================================================
  it("redacts details.metadata.workerPid via SSOT-derived truncation (regex coverage) / regex 適用範囲確認: workerPid も redact", async () => {
    const fullWorkerPid = "abcdefghij";
    mockService.query.mockResolvedValue([
      {
        id: "audit-2",
        timestamp: new Date("2026-05-04T10:01:00Z"),
        action: "worker.restart",
        actor: "system:worker-supervisor",
        targetType: "worker",
        targetId: null,
        details: {
          metadata: {
            workerPid: fullWorkerPid,
          },
        },
        ipAddress: null,
        result: "success",
      },
    ]);

    const result = (await auditQueryHandler({})) as AuditQueryOutput;

    expect(result.success).toBe(true);
    if (!result.success) return;

    const log = result.data.logs[0];
    const metadata = (log.details as Record<string, unknown>).metadata as Record<string, unknown>;

    const expected = expectedTruncatedFromSsot(fullWorkerPid);
    expect(metadata.workerPid).toBe(expected);
  });

  // ===================================================
  // Test 3: no metadata field → details preserved as-is
  // ===================================================
  it("preserves details when metadata field is absent (no false-positive redaction) / metadata field 不在時は details そのまま (false-positive 無し)", async () => {
    const detailsWithoutMetadata = {
      reason: "test reason",
      childCount: 3,
    };
    mockService.query.mockResolvedValue([
      {
        id: "audit-3",
        timestamp: new Date("2026-05-04T10:02:00Z"),
        action: "data.delete",
        actor: "user:test@example.com",
        targetType: "web_page",
        targetId: "01234567...",
        details: detailsWithoutMetadata,
        ipAddress: null,
        result: "success",
      },
    ]);

    const result = (await auditQueryHandler({})) as AuditQueryOutput;

    expect(result.success).toBe(true);
    if (!result.success) return;

    const log = result.data.logs[0];
    expect(log.details).toEqual(detailsWithoutMetadata);
    // Verify reason / childCount unchanged (no over-redaction)
    expect((log.details as Record<string, unknown>).reason).toBe("test reason");
    expect((log.details as Record<string, unknown>).childCount).toBe(3);
  });

  // ===================================================
  // Test 4: SSOT-derive assertion — sentinel guard against hardcoded literals
  // ===================================================
  it("SSOT-derive assertion: TARGET_ID_TRUNCATE_LENGTH integrity (sentinel against hardcoded literals) / SSOT 整合性: TARGET_ID_TRUNCATE_LENGTH 値検証 (ハードコード禁止 sentinel)", async () => {
    // SSOT constant is imported from audit-log.service.ts (canonical CWE-209 source)
    // SSOT 定数は audit-log.service.ts から import (canonical CWE-209 source)
    expect(AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH).toBeGreaterThan(0);
    expect(typeof AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH).toBe("number");

    // Verify the redaction actually uses TARGET_ID_TRUNCATE_LENGTH at runtime by
    // constructing an input whose length exceeds SSOT and asserting the
    // truncated form matches `value.slice(0, SSOT) + "..."` exactly.
    // 実行時に TARGET_ID_TRUNCATE_LENGTH を実際に参照していることを、
    // SSOT 長を超える入力で truncated form が `value.slice(0, SSOT) + "..."`
    // と完全一致することで検証。
    const longPid = "X".repeat(AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH * 3);
    mockService.query.mockResolvedValue([
      {
        id: "audit-4",
        timestamp: new Date("2026-05-04T10:03:00Z"),
        action: "page.analyze",
        actor: "system:worker-supervisor",
        targetType: "worker",
        targetId: null,
        details: {
          metadata: {
            pid: longPid,
          },
        },
        ipAddress: null,
        result: "success",
      },
    ]);

    const result = (await auditQueryHandler({})) as AuditQueryOutput;
    expect(result.success).toBe(true);
    if (!result.success) return;

    const log = result.data.logs[0];
    const metadata = (log.details as Record<string, unknown>).metadata as Record<string, unknown>;

    // SSOT-derived expected (NEVER hardcode literal — coupling-drift detection)
    // SSOT 由来期待値 (literal ハードコード禁止 — coupling drift 検出)
    const expected = longPid.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "...";
    expect(metadata.pid).toBe(expected);

    // Length of truncated form must equal SSOT length + 3 ("...")
    // truncated form の長さは SSOT 長 + 3 ("...") に一致
    expect((metadata.pid as string).length).toBe(AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH + 3);
  });
});

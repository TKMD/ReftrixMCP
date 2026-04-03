// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * audit.query MCPツール テスト
 * 監査ログ検索ツールの検証
 *
 * テストカテゴリ:
 * 1. 入力バリデーション: Zodスキーマ検証
 * 2. 正常系: 各種フィルタ、デフォルトlimit
 * 3. エラー系: サービス未設定、DB障害
 * 4. セキュリティ: PII漏洩防止、エラーメッセージサニタイズ
 *
 * audit.query MCP tool tests
 * Validates audit log query tool
 *
 * @module tests/tools/audit/query.tool.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  auditQueryHandler,
  auditQueryToolDefinition,
  setAuditQueryServiceFactory,
  resetAuditQueryServiceFactory,
  AUDIT_QUERY_ERROR_CODES,
  type AuditQueryOutput,
} from "../../../src/tools/audit/query.tool";

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
// テスト / Tests
// =====================================================

describe("audit.query tool", () => {
  let mockService: ReturnType<typeof createMockAuditLogService>;

  beforeEach(() => {
    mockService = createMockAuditLogService();
    setAuditQueryServiceFactory(() => mockService as never);
  });

  afterEach(() => {
    resetAuditQueryServiceFactory();
    vi.restoreAllMocks();
  });

  // =======================================================
  // ツール定義 / Tool definition
  // =======================================================

  describe("tool definition", () => {
    it("ツール名がaudit.query / tool name is audit.query", () => {
      expect(auditQueryToolDefinition.name).toBe("audit.query");
    });

    it("入力スキーマにaction/targetType/startDate/endDate/limitがある / input schema has expected properties", () => {
      const props = auditQueryToolDefinition.inputSchema.properties;
      expect(props).toHaveProperty("action");
      expect(props).toHaveProperty("target_type");
      expect(props).toHaveProperty("start_date");
      expect(props).toHaveProperty("end_date");
      expect(props).toHaveProperty("limit");
    });
  });

  // =======================================================
  // 入力バリデーション / Input validation
  // =======================================================

  describe("input validation", () => {
    it("空入力は許容される（全フィルタ任意） / accepts empty input", async () => {
      const result = (await auditQueryHandler({})) as AuditQueryOutput;
      expect(result.success).toBe(true);
    });

    it("無効なlimit値でバリデーションエラー / validation error on invalid limit", async () => {
      const result = (await auditQueryHandler({ limit: -1 })) as AuditQueryOutput;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(AUDIT_QUERY_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it("limit > 100 はバリデーションエラー / validation error on limit > 100", async () => {
      const result = (await auditQueryHandler({ limit: 101 })) as AuditQueryOutput;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(AUDIT_QUERY_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it("無効な日付形式でバリデーションエラー / validation error on invalid date format", async () => {
      const result = (await auditQueryHandler({
        start_date: "not-a-date",
      })) as AuditQueryOutput;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(AUDIT_QUERY_ERROR_CODES.VALIDATION_ERROR);
      }
    });
  });

  // =======================================================
  // 正常系 / Success cases
  // =======================================================

  describe("success cases", () => {
    it("フィルタなしでクエリ実行 / queries without filters", async () => {
      mockService.query.mockResolvedValue([
        {
          id: "test-id",
          timestamp: new Date("2026-03-27T10:00:00Z"),
          action: "data.delete",
          actor: "mcp-client",
          targetType: "web_page",
          targetId: "01934567...",
          details: null,
          ipAddress: null,
          result: "success",
        },
      ]);

      const result = (await auditQueryHandler({})) as AuditQueryOutput;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.logs).toHaveLength(1);
        expect(result.data.logs[0].action).toBe("data.delete");
      }
    });

    it("全フィルタ指定でクエリ / queries with all filters", async () => {
      mockService.query.mockResolvedValue([]);

      const result = (await auditQueryHandler({
        action: "preference.reset",
        target_type: "preference_profile",
        start_date: "2026-03-01T00:00:00Z",
        end_date: "2026-03-31T23:59:59Z",
        limit: 50,
      })) as AuditQueryOutput;

      expect(result.success).toBe(true);
      expect(mockService.query).toHaveBeenCalledTimes(1);
      const queryArg = mockService.query.mock.calls[0][0];
      expect(queryArg.action).toBe("preference.reset");
      expect(queryArg.targetType).toBe("preference_profile");
      expect(queryArg.limit).toBe(50);
    });
  });

  // =======================================================
  // エラー系 / Error cases
  // =======================================================

  describe("error cases", () => {
    it("サービスファクトリー未設定 / service factory not set", async () => {
      resetAuditQueryServiceFactory();

      const result = (await auditQueryHandler({})) as AuditQueryOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(AUDIT_QUERY_ERROR_CODES.SERVICE_UNAVAILABLE);
      }
    });

    it("DB障害時のエラーハンドリング / handles DB errors gracefully", async () => {
      mockService.query.mockRejectedValue(new Error("Connection refused"));

      const result = (await auditQueryHandler({})) as AuditQueryOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(AUDIT_QUERY_ERROR_CODES.INTERNAL_ERROR);
        // エラーメッセージにDB内部構造を含まない
        expect(result.error.message).not.toContain("Connection refused");
      }
    });
  });

  // =======================================================
  // セキュリティ / Security
  // =======================================================

  describe("security", () => {
    it("エラーレスポンスにDBの内部構造を含まない / error response hides internal structure", async () => {
      mockService.query.mockRejectedValue(
        new Error("select * from audit_logs where action = 'test'")
      );

      const result = (await auditQueryHandler({})) as AuditQueryOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).not.toContain("select");
        expect(result.error.message).not.toContain("audit_logs");
      }
    });
  });
});

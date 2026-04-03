// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AuditLogService ユニットテスト
 * GDPR Art.30「処理活動記録」+CWE-778「監査不備」対応
 *
 * テストカテゴリ:
 * 1. log(): 監査ログ記録（append-only）
 * 2. query(): ログ検索（フィルタ各種）
 * 3. getRetentionPolicy(): 保持ポリシー取得
 * 4. cleanup(): 古いログの削除
 * 5. PII配慮: targetId truncation、details sanitization
 * 6. セキュリティ: SQLインジェクション防御、ログ改竄防止
 * 7. エッジケース: 大量ログ、空フィルタ、日付範囲不正
 *
 * AuditLogService unit tests
 * GDPR Art.30 "Records of processing activities" + CWE-778 "Insufficient logging"
 *
 * @module tests/services/audit-log.service.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  AuditLogService,
  setAuditLogPrismaClientFactory,
  resetAuditLogPrismaClientFactory,
  getAuditLogService,
  resetAuditLogService,
  type AuditLogPrismaClient,
  type AuditLogEntry,
  type AuditLogFilters,
  AUDIT_LOG_CONSTANTS,
} from "../../src/services/audit-log.service";

// =====================================================
// logger モック / Logger mock
// =====================================================

vi.mock("../../src/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  isDevelopment: vi.fn().mockReturnValue(false),
}));

import { logger } from "../../src/utils/logger";

// =====================================================
// テストデータ / Test data
// =====================================================

const MOCK_LOG_ID = "01934567-89ab-7def-0123-456789abcdef";
const MOCK_TARGET_ID = "01934567-89ab-7def-0123-456789abcde0";

function createMockPrismaClient(overrides?: Partial<AuditLogPrismaClient>): AuditLogPrismaClient {
  return {
    auditLog: {
      create: overrides?.auditLog?.create ?? vi.fn().mockResolvedValue({ id: MOCK_LOG_ID }),
      findMany: overrides?.auditLog?.findMany ?? vi.fn().mockResolvedValue([]),
      deleteMany: overrides?.auditLog?.deleteMany ?? vi.fn().mockResolvedValue({ count: 0 }),
      count: overrides?.auditLog?.count ?? vi.fn().mockResolvedValue(0),
    },
  };
}

// =====================================================
// テスト / Tests
// =====================================================

describe("AuditLogService", () => {
  let service: AuditLogService;
  let mockPrisma: AuditLogPrismaClient;

  beforeEach(() => {
    mockPrisma = createMockPrismaClient();
    setAuditLogPrismaClientFactory(() => mockPrisma);
    resetAuditLogService();
    service = getAuditLogService();
  });

  afterEach(() => {
    resetAuditLogPrismaClientFactory();
    resetAuditLogService();
    vi.restoreAllMocks();
  });

  // =======================================================
  // 1. log() — 監査ログ記録 / Audit log recording
  // =======================================================

  describe("log()", () => {
    it("正常系: 監査ログを記録できる / records an audit log entry", async () => {
      const entry: AuditLogEntry = {
        action: "data.delete",
        actor: "mcp-client",
        targetType: "web_page",
        targetId: MOCK_TARGET_ID,
        result: "success",
      };

      await service.log(entry);

      expect(mockPrisma.auditLog.create).toHaveBeenCalledTimes(1);
      const createArg = (mockPrisma.auditLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createArg.data.action).toBe("data.delete");
      expect(createArg.data.actor).toBe("mcp-client");
      expect(createArg.data.targetType).toBe("web_page");
      expect(createArg.data.result).toBe("success");
    });

    it("PII配慮: targetIdがtruncateされて保存される / truncates targetId for PII", async () => {
      const entry: AuditLogEntry = {
        action: "preference.reset",
        actor: "mcp-client",
        targetType: "preference_profile",
        targetId: MOCK_TARGET_ID,
        result: "success",
      };

      await service.log(entry);

      const createArg = (mockPrisma.auditLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      // targetIdは最大8文字 + "..." = 11文字以下
      expect(createArg.data.targetId.length).toBeLessThanOrEqual(11);
      expect(createArg.data.targetId).toMatch(/^[a-f0-9]{8}\.\.\.$/);
    });

    it("targetIdがnullの場合はそのまま保存 / preserves null targetId", async () => {
      const entry: AuditLogEntry = {
        action: "system.health",
        actor: "system",
        targetType: "system",
        result: "success",
      };

      await service.log(entry);

      const createArg = (mockPrisma.auditLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createArg.data.targetId).toBeNull();
    });

    it("details内の機密情報が除去される / sanitizes sensitive data in details", async () => {
      const entry: AuditLogEntry = {
        action: "page.analyze",
        actor: "worker",
        targetType: "web_page",
        targetId: MOCK_TARGET_ID,
        result: "success",
        details: {
          url: "https://example.com",
          password: "secret123",
          apiKey: "sk-12345",
          token: "bearer-token",
        },
      };

      await service.log(entry);

      const createArg = (mockPrisma.auditLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const savedDetails = createArg.data.details;
      expect(savedDetails.url).toBe("https://example.com");
      expect(savedDetails.password).toBeUndefined();
      expect(savedDetails.apiKey).toBeUndefined();
      expect(savedDetails.token).toBeUndefined();
    });

    it("DB書き込みエラー時もサイレントに失敗しない / logs warning on DB write error", async () => {
      const failPrisma = createMockPrismaClient({
        auditLog: {
          create: vi.fn().mockRejectedValue(new Error("DB write error")),
          findMany: vi.fn(),
          deleteMany: vi.fn(),
          count: vi.fn(),
        },
      });
      setAuditLogPrismaClientFactory(() => failPrisma);
      resetAuditLogService();
      const failService = getAuditLogService();

      const entry: AuditLogEntry = {
        action: "data.delete",
        actor: "mcp-client",
        targetType: "web_page",
        result: "success",
      };

      // log()は例外を投げずにwarningログを出力
      await expect(failService.log(entry)).resolves.not.toThrow();
      expect(logger.warn).toHaveBeenCalled();
    });

    it("result値が正しくバリデーションされる / validates result field", async () => {
      const entry: AuditLogEntry = {
        action: "data.delete",
        actor: "mcp-client",
        targetType: "web_page",
        result: "success",
      };

      await service.log(entry);

      const createArg = (mockPrisma.auditLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(["success", "failure", "denied"]).toContain(createArg.data.result);
    });
  });

  // =======================================================
  // 2. query() — ログ検索 / Log query
  // =======================================================

  describe("query()", () => {
    const mockLogs = [
      {
        id: MOCK_LOG_ID,
        timestamp: new Date("2026-03-27T10:00:00Z"),
        action: "data.delete",
        actor: "mcp-client",
        targetType: "web_page",
        targetId: "01934567...",
        details: null,
        ipAddress: null,
        result: "success",
      },
    ];

    it("正常系: フィルタなしで全ログを取得 / returns all logs without filters", async () => {
      const prisma = createMockPrismaClient({
        auditLog: {
          create: vi.fn(),
          findMany: vi.fn().mockResolvedValue(mockLogs),
          deleteMany: vi.fn(),
          count: vi.fn(),
        },
      });
      setAuditLogPrismaClientFactory(() => prisma);
      resetAuditLogService();
      const svc = getAuditLogService();

      const result = await svc.query({});

      expect(result).toHaveLength(1);
      expect(result[0].action).toBe("data.delete");
    });

    it("actionフィルタで絞り込み / filters by action", async () => {
      const prisma = createMockPrismaClient({
        auditLog: {
          create: vi.fn(),
          findMany: vi.fn().mockResolvedValue(mockLogs),
          deleteMany: vi.fn(),
          count: vi.fn(),
        },
      });
      setAuditLogPrismaClientFactory(() => prisma);
      resetAuditLogService();
      const svc = getAuditLogService();

      await svc.query({ action: "data.delete" });

      const findManyArg = (prisma.auditLog.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(findManyArg.where.action).toBe("data.delete");
    });

    it("targetTypeフィルタで絞り込み / filters by targetType", async () => {
      const prisma = createMockPrismaClient({
        auditLog: {
          create: vi.fn(),
          findMany: vi.fn().mockResolvedValue(mockLogs),
          deleteMany: vi.fn(),
          count: vi.fn(),
        },
      });
      setAuditLogPrismaClientFactory(() => prisma);
      resetAuditLogService();
      const svc = getAuditLogService();

      await svc.query({ targetType: "web_page" });

      const findManyArg = (prisma.auditLog.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(findManyArg.where.targetType).toBe("web_page");
    });

    it("日付範囲フィルタ / filters by date range", async () => {
      const prisma = createMockPrismaClient({
        auditLog: {
          create: vi.fn(),
          findMany: vi.fn().mockResolvedValue(mockLogs),
          deleteMany: vi.fn(),
          count: vi.fn(),
        },
      });
      setAuditLogPrismaClientFactory(() => prisma);
      resetAuditLogService();
      const svc = getAuditLogService();

      await svc.query({
        startDate: new Date("2026-03-01"),
        endDate: new Date("2026-03-31"),
      });

      const findManyArg = (prisma.auditLog.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(findManyArg.where.timestamp).toBeDefined();
      expect(findManyArg.where.timestamp.gte).toEqual(new Date("2026-03-01"));
      expect(findManyArg.where.timestamp.lte).toEqual(new Date("2026-03-31"));
    });

    it("limitがデフォルト20 / default limit is 20", async () => {
      const prisma = createMockPrismaClient({
        auditLog: {
          create: vi.fn(),
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn(),
          count: vi.fn(),
        },
      });
      setAuditLogPrismaClientFactory(() => prisma);
      resetAuditLogService();
      const svc = getAuditLogService();

      await svc.query({});

      const findManyArg = (prisma.auditLog.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(findManyArg.take).toBe(AUDIT_LOG_CONSTANTS.DEFAULT_QUERY_LIMIT);
    });

    it("limit最大100を超えた場合は100に制限 / caps limit at 100", async () => {
      const prisma = createMockPrismaClient({
        auditLog: {
          create: vi.fn(),
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn(),
          count: vi.fn(),
        },
      });
      setAuditLogPrismaClientFactory(() => prisma);
      resetAuditLogService();
      const svc = getAuditLogService();

      await svc.query({ limit: 500 });

      const findManyArg = (prisma.auditLog.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(findManyArg.take).toBe(AUDIT_LOG_CONSTANTS.MAX_QUERY_LIMIT);
    });

    it("結果は timestamp DESC で並ぶ / orders by timestamp desc", async () => {
      const prisma = createMockPrismaClient({
        auditLog: {
          create: vi.fn(),
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn(),
          count: vi.fn(),
        },
      });
      setAuditLogPrismaClientFactory(() => prisma);
      resetAuditLogService();
      const svc = getAuditLogService();

      await svc.query({});

      const findManyArg = (prisma.auditLog.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(findManyArg.orderBy).toEqual({ timestamp: "desc" });
    });
  });

  // =======================================================
  // 3. getRetentionPolicy() — 保持ポリシー / Retention policy
  // =======================================================

  describe("getRetentionPolicy()", () => {
    it("デフォルトポリシーを返す / returns default retention policy", () => {
      const policy = service.getRetentionPolicy();

      expect(policy.retentionDays).toBe(AUDIT_LOG_CONSTANTS.DEFAULT_RETENTION_DAYS);
      expect(policy.description).toBeDefined();
      expect(typeof policy.description).toBe("string");
    });
  });

  // =======================================================
  // 4. cleanup() — 古いログ削除 / Old log cleanup
  // =======================================================

  describe("cleanup()", () => {
    it("正常系: 指定日付より古いログを削除 / deletes logs older than given date", async () => {
      const prisma = createMockPrismaClient({
        auditLog: {
          create: vi.fn(),
          findMany: vi.fn(),
          deleteMany: vi.fn().mockResolvedValue({ count: 5 }),
          count: vi.fn(),
        },
      });
      setAuditLogPrismaClientFactory(() => prisma);
      resetAuditLogService();
      const svc = getAuditLogService();

      const olderThan = new Date("2026-01-01");
      const deletedCount = await svc.cleanup(olderThan);

      expect(deletedCount).toBe(5);
      expect(prisma.auditLog.deleteMany).toHaveBeenCalledWith({
        where: { timestamp: { lt: olderThan } },
      });
    });

    it("削除対象がない場合は0を返す / returns 0 when no logs to delete", async () => {
      const deletedCount = await service.cleanup(new Date("2020-01-01"));
      expect(deletedCount).toBe(0);
    });
  });

  // =======================================================
  // 5. セキュリティ / Security
  // =======================================================

  describe("Security", () => {
    it("SQLインジェクション的な文字列がaction名に入ってもPrismaで安全 / safe from SQL injection in action", async () => {
      const entry: AuditLogEntry = {
        action: "'; DROP TABLE audit_logs; --",
        actor: "mcp-client",
        targetType: "web_page",
        result: "failure",
      };

      await service.log(entry);

      // Prisma ORMがパラメータ化クエリを使用するため安全
      expect(mockPrisma.auditLog.create).toHaveBeenCalledTimes(1);
    });

    it("details内のネストされた機密情報も除去 / removes nested sensitive data", async () => {
      const entry: AuditLogEntry = {
        action: "page.analyze",
        actor: "worker",
        targetType: "web_page",
        result: "success",
        details: {
          nested: {
            password: "secret",
            accessToken: "token-123",
          },
          safe: "value",
        },
      };

      await service.log(entry);

      const createArg = (mockPrisma.auditLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const details = createArg.data.details;
      expect(details.safe).toBe("value");
      // ネストされた機密情報は再帰的に除去
      if (details.nested) {
        expect(details.nested.password).toBeUndefined();
        expect(details.nested.accessToken).toBeUndefined();
      }
    });
  });

  // =======================================================
  // 6. DI / Factory
  // =======================================================

  describe("DI / Factory", () => {
    it("PrismaClientファクトリー未設定時はnull service / returns null when factory not set", () => {
      resetAuditLogPrismaClientFactory();
      resetAuditLogService();
      const svc = getAuditLogService();

      // サービス自体は取得できるが、DB操作時にgraceful degradation
      expect(svc).toBeDefined();
    });
  });
});

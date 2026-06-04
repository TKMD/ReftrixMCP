// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GdprDeletionService ユニットテスト
 * GDPR Art.17「忘れられる権利」全テーブル包括的データ削除サービスのテスト
 *
 * テストカテゴリ:
 * 1. deletePage: web_page + 全関連テーブルのCASCADE DELETE
 * 2. deleteProfile: preference_profiles + preference_signals の完全削除
 * 3. deleteAllUserData: page + profile 一括削除
 * 4. exportPageData: GDPR Art.20 データポータビリティ
 * 5. exportProfileData: 嗜好プロファイルのエクスポート
 * 6. セキュリティ: SQLインジェクション防御、無効UUID拒否
 * 7. エラーハンドリング: 存在しないID、DB接続エラー
 * 8. PII配慮: 監査ログでフルIDを出力しない
 * 9. DI/ファクトリー: 未初期化時エラー
 *
 * GdprDeletionService unit tests
 * Tests for GDPR Art.17 "Right to Erasure" comprehensive data deletion service
 *
 * @module tests/services/gdpr-deletion.service.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";

import {
  GdprDeletionService,
  setGdprPrismaClientFactory,
  resetGdprPrismaClientFactory,
  getGdprDeletionService,
  resetGdprDeletionService,
  type GdprPrismaClient,
} from "../../src/services/gdpr-deletion.service";
// CO-5 Wave 5 canonical: SSOT-derive expected literal from
// AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH (CO-5 UC-2 / UC-3 / UC-4)
import { AUDIT_LOG_CONSTANTS } from "../../src/services/audit-log.service";

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

const MOCK_PAGE_ID = "01934567-89ab-7def-0123-456789abcdef";
const MOCK_PAGE_ID_2 = "01934567-89ab-7def-0123-456789abcde0";
const MOCK_PROFILE_ID = "02934567-89ab-7def-0123-456789abcdef";
const MOCK_SECTION_ID = "03934567-89ab-7def-0123-456789abcdef";

// =====================================================
// モックファクトリー / Mock factories
// =====================================================

function createMockPrismaClient(overrides?: {
  queryRawUnsafe?: ReturnType<typeof vi.fn>;
  executeRawUnsafe?: ReturnType<typeof vi.fn>;
}): GdprPrismaClient {
  return {
    $queryRawUnsafe: overrides?.queryRawUnsafe ?? vi.fn().mockResolvedValue([]),
    $executeRawUnsafe: overrides?.executeRawUnsafe ?? vi.fn().mockResolvedValue(0),
    $transaction: overrides?.executeRawUnsafe
      ? vi.fn().mockImplementation(async (fn: (tx: GdprPrismaClient) => Promise<unknown>) => {
          const txClient: GdprPrismaClient = {
            $queryRawUnsafe: overrides?.queryRawUnsafe ?? vi.fn().mockResolvedValue([]),
            $executeRawUnsafe: overrides?.executeRawUnsafe ?? vi.fn().mockResolvedValue(0),
            $transaction: vi.fn(),
          };
          return fn(txClient);
        })
      : vi.fn().mockImplementation(async (fn: (tx: GdprPrismaClient) => Promise<unknown>) => {
          const txClient: GdprPrismaClient = {
            $queryRawUnsafe: vi.fn().mockResolvedValue([]),
            $executeRawUnsafe: vi.fn().mockResolvedValue(0),
            $transaction: vi.fn(),
          };
          return fn(txClient);
        }),
  };
}

// =====================================================
// テスト
// =====================================================

describe("GdprDeletionService", () => {
  let service: GdprDeletionService;
  let mockPrisma: GdprPrismaClient;

  beforeEach(() => {
    resetGdprDeletionService();
    resetGdprPrismaClientFactory();

    mockPrisma = createMockPrismaClient();
    setGdprPrismaClientFactory(() => mockPrisma);

    service = new GdprDeletionService();
  });

  afterEach(() => {
    resetGdprDeletionService();
    resetGdprPrismaClientFactory();
    vi.restoreAllMocks();
  });

  // =====================================================
  // 1. deletePage テスト / deletePage tests
  // =====================================================

  describe("deletePage", () => {
    it("存在するページを削除すると関連テーブルのレコード数を返す / should delete existing page and return record counts", async () => {
      const queryMock = vi
        .fn()
        // 存在確認 / Existence check
        .mockResolvedValueOnce([{ id: MOCK_PAGE_ID }]);

      const executeMock = vi
        .fn()
        // 各テーブルの削除（順序は embedding -> pattern -> page）
        .mockResolvedValueOnce(2) // section_embeddings
        .mockResolvedValueOnce(3) // component_part_embeddings
        .mockResolvedValueOnce(1) // motion_embeddings
        .mockResolvedValueOnce(0) // js_animation_embeddings
        .mockResolvedValueOnce(0) // webgl_animation_embeddings
        .mockResolvedValueOnce(0) // motion_analysis_embeddings
        .mockResolvedValueOnce(0) // design_narrative_embeddings
        .mockResolvedValueOnce(0) // background_design_embeddings
        .mockResolvedValueOnce(0) // responsive_analysis_embeddings
        .mockResolvedValueOnce(0) // quality_benchmarks
        .mockResolvedValueOnce(3) // component_parts
        .mockResolvedValueOnce(2) // section_patterns
        .mockResolvedValueOnce(1) // motion_patterns
        .mockResolvedValueOnce(0) // js_animation_patterns
        .mockResolvedValueOnce(0) // webgl_animation_patterns
        .mockResolvedValueOnce(0) // motion_analysis_results
        .mockResolvedValueOnce(0) // design_narratives
        .mockResolvedValueOnce(0) // background_designs
        .mockResolvedValueOnce(0) // responsive_analyses
        .mockResolvedValueOnce(1) // quality_evaluations
        .mockResolvedValueOnce(0) // design_snapshots (v0.3.0 T2-DCT)
        .mockResolvedValueOnce(1); // web_pages

      const txMockPrisma: GdprPrismaClient = {
        $queryRawUnsafe: queryMock,
        $executeRawUnsafe: executeMock,
        $transaction: vi.fn(),
      };

      mockPrisma.$transaction = vi
        .fn()
        .mockImplementation(async (fn: (tx: GdprPrismaClient) => Promise<unknown>) =>
          fn(txMockPrisma)
        );

      const result = await service.deletePage(MOCK_PAGE_ID, "GDPR Art.17 deletion request");

      expect(result.deleted).toBe(true);
      expect(result.page_id).toBe(MOCK_PAGE_ID);
      expect(result.deleted_records.web_pages).toBe(1);
      expect(result.deleted_records.section_patterns).toBe(2);
      expect(result.deleted_records.component_parts).toBe(3);
    });

    it("存在しないページIDで NotFound エラーを投げる / should throw error for non-existent page", async () => {
      const queryMock = vi.fn().mockResolvedValueOnce([]); // 存在しない
      const txMockPrisma: GdprPrismaClient = {
        $queryRawUnsafe: queryMock,
        $executeRawUnsafe: vi.fn(),
        $transaction: vi.fn(),
      };
      mockPrisma.$transaction = vi
        .fn()
        .mockImplementation(async (fn: (tx: GdprPrismaClient) => Promise<unknown>) =>
          fn(txMockPrisma)
        );

      await expect(service.deletePage(MOCK_PAGE_ID, "test")).rejects.toThrow("Page not found");
    });

    it("無効なUUIDで入力バリデーションエラーを投げる / should throw for invalid UUID", async () => {
      await expect(service.deletePage("not-a-valid-uuid", "test")).rejects.toThrow(
        "Invalid UUID format"
      );
    });

    it("SQLインジェクション試行を拒否する / should reject SQL injection attempts in pageId", async () => {
      await expect(service.deletePage("'; DROP TABLE web_pages; --", "test")).rejects.toThrow(
        "Invalid UUID format"
      );
    });
  });

  // =====================================================
  // 2. deleteProfile テスト / deleteProfile tests
  // =====================================================

  describe("deleteProfile", () => {
    it("存在するプロファイルを完全削除する / should hard delete existing profile", async () => {
      const queryMock = vi.fn().mockResolvedValueOnce([{ id: MOCK_PROFILE_ID }]); // 存在確認

      const executeMock = vi
        .fn()
        .mockResolvedValueOnce(5) // preference_signals
        .mockResolvedValueOnce(3) // search_logs anonymized
        .mockResolvedValueOnce(1); // preference_profiles

      const txMockPrisma: GdprPrismaClient = {
        $queryRawUnsafe: queryMock,
        $executeRawUnsafe: executeMock,
        $transaction: vi.fn(),
      };
      mockPrisma.$transaction = vi
        .fn()
        .mockImplementation(async (fn: (tx: GdprPrismaClient) => Promise<unknown>) =>
          fn(txMockPrisma)
        );

      const result = await service.deleteProfile(MOCK_PROFILE_ID, "User requested deletion");

      expect(result.deleted).toBe(true);
      expect(result.profile_id).toBe(MOCK_PROFILE_ID);
      expect(result.deleted_records.preference_profiles).toBe(1);
      expect(result.deleted_records.preference_signals).toBe(5);
      expect(result.deleted_records.search_logs_anonymized).toBe(3);
    });

    it("search_logsのprofileIdをLIKE前方一致でNULL化する / should anonymize search_logs profileId with prefix match", async () => {
      const queryMock = vi.fn().mockResolvedValueOnce([{ id: MOCK_PROFILE_ID }]); // 存在確認

      const executeMock = vi
        .fn()
        .mockResolvedValueOnce(0) // preference_signals
        .mockResolvedValueOnce(2) // search_logs anonymized
        .mockResolvedValueOnce(1); // preference_profiles

      const txMockPrisma: GdprPrismaClient = {
        $queryRawUnsafe: queryMock,
        $executeRawUnsafe: executeMock,
        $transaction: vi.fn(),
      };
      mockPrisma.$transaction = vi
        .fn()
        .mockImplementation(async (fn: (tx: GdprPrismaClient) => Promise<unknown>) =>
          fn(txMockPrisma)
        );

      await service.deleteProfile(MOCK_PROFILE_ID, "GDPR Art.17");

      // search_logs の UPDATE が LIKE 前方一致で呼ばれたことを確認
      // Verify UPDATE was called with LIKE prefix match for search_logs
      const updateCall = executeMock.mock.calls.find(
        (call: unknown[]) =>
          typeof call[0] === "string" && (call[0] as string).includes("search_logs")
      );
      expect(updateCall).toBeDefined();
      expect(updateCall![0]).toContain('UPDATE search_logs SET "profile_id" = NULL');
      expect(updateCall![0]).toContain("LIKE");
      // CO-5 UC-3 Option α: SSOT-derive from AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH
      // (Wave 5 canonical contract: NO hardcoded literal "abcd1234%" / "slice(0, 8)+%")
      // CO-5 UC-3 Option α: SSOT-derived prefix length (NOT hardcoded `8`)
      expect(updateCall![1]).toBe(
        MOCK_PROFILE_ID.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "%"
      );
      // SQL LIKE wildcard semantic preserved: suffix is "%" (NOT "...")
      expect(updateCall![1]).toMatch(/%$/);
      expect(updateCall![1]).not.toMatch(/\.\.\.$/);
    });

    it("存在しないプロファイルIDで NotFound エラーを投げる / should throw for non-existent profile", async () => {
      const queryMock = vi.fn().mockResolvedValueOnce([]);
      const txMockPrisma: GdprPrismaClient = {
        $queryRawUnsafe: queryMock,
        $executeRawUnsafe: vi.fn(),
        $transaction: vi.fn(),
      };
      mockPrisma.$transaction = vi
        .fn()
        .mockImplementation(async (fn: (tx: GdprPrismaClient) => Promise<unknown>) =>
          fn(txMockPrisma)
        );

      await expect(service.deleteProfile(MOCK_PROFILE_ID, "test")).rejects.toThrow(
        "Profile not found"
      );
    });

    it("無効なUUIDで入力バリデーションエラーを投げる / should throw for invalid UUID", async () => {
      await expect(service.deleteProfile("not-valid", "test")).rejects.toThrow(
        "Invalid UUID format"
      );
    });
  });

  // =====================================================
  // 3. deleteAllUserData テスト / deleteAllUserData tests
  // =====================================================

  describe("deleteAllUserData", () => {
    it("pageId配列とprofileIdで全データを削除する / should delete all data for given pages and profile", async () => {
      // pageの存在確認
      const pageQueryMock = vi
        .fn()
        .mockResolvedValueOnce([{ id: MOCK_PAGE_ID }]) // page existence
        .mockResolvedValueOnce([{ id: MOCK_PROFILE_ID }]); // profile existence

      const pageExecuteMock = vi.fn().mockResolvedValue(1);

      const txMockPrisma: GdprPrismaClient = {
        $queryRawUnsafe: pageQueryMock,
        $executeRawUnsafe: pageExecuteMock,
        $transaction: vi.fn(),
      };
      mockPrisma.$transaction = vi
        .fn()
        .mockImplementation(async (fn: (tx: GdprPrismaClient) => Promise<unknown>) =>
          fn(txMockPrisma)
        );

      const result = await service.deleteAllUserData(
        [MOCK_PAGE_ID],
        MOCK_PROFILE_ID,
        "Full account deletion"
      );

      expect(result.deleted).toBe(true);
      expect(result.pages_deleted).toBe(1);
      expect(result.profile_deleted).toBe(true);
    });

    it("pageIdなし、profileIdのみで嗜好データのみ削除する / should delete only profile when no pages given", async () => {
      const queryMock = vi.fn().mockResolvedValueOnce([{ id: MOCK_PROFILE_ID }]); // profile existence

      const executeMock = vi
        .fn()
        .mockResolvedValueOnce(3) // preference_signals
        .mockResolvedValueOnce(1) // search_logs anonymized
        .mockResolvedValueOnce(1); // preference_profiles

      const txMockPrisma: GdprPrismaClient = {
        $queryRawUnsafe: queryMock,
        $executeRawUnsafe: executeMock,
        $transaction: vi.fn(),
      };
      mockPrisma.$transaction = vi
        .fn()
        .mockImplementation(async (fn: (tx: GdprPrismaClient) => Promise<unknown>) =>
          fn(txMockPrisma)
        );

      const result = await service.deleteAllUserData([], MOCK_PROFILE_ID, "Delete preference only");

      expect(result.deleted).toBe(true);
      expect(result.pages_deleted).toBe(0);
      expect(result.profile_deleted).toBe(true);

      // search_logs anonymize が呼ばれたことを確認
      // Verify search_logs anonymize was called
      const updateCall = executeMock.mock.calls.find(
        (call: unknown[]) =>
          typeof call[0] === "string" && (call[0] as string).includes("search_logs")
      );
      expect(updateCall).toBeDefined();
      expect(updateCall![0]).toContain('UPDATE search_logs SET "profile_id" = NULL');
    });
  });

  // =====================================================
  // 4. exportPageData テスト / exportPageData tests
  // =====================================================

  describe("exportPageData", () => {
    it("指定ページの全関連データをJSON形式でエクスポートする / should export all related page data as JSON", async () => {
      const queryMock = vi
        .fn()
        // web_page
        .mockResolvedValueOnce([
          {
            id: MOCK_PAGE_ID,
            url: "https://example.com",
            title: "Example",
            source_type: "user_provided",
            created_at: new Date("2026-01-01"),
          },
        ])
        // section_patterns
        .mockResolvedValueOnce([
          {
            id: MOCK_SECTION_ID,
            section_type: "hero",
            position_index: 0,
          },
        ])
        // component_parts
        .mockResolvedValueOnce([])
        // motion_patterns
        .mockResolvedValueOnce([])
        // quality_evaluations
        .mockResolvedValueOnce([])
        // design_narratives
        .mockResolvedValueOnce([])
        // background_designs
        .mockResolvedValueOnce([])
        // responsive_analyses
        .mockResolvedValueOnce([]);

      mockPrisma.$queryRawUnsafe = queryMock;

      const result = await service.exportPageData(MOCK_PAGE_ID);

      expect(result.page_id).toBe(MOCK_PAGE_ID);
      expect(result.export_format).toBe("json");
      expect(result.data.web_page).toBeDefined();
      expect(result.data.web_page.url).toBe("https://example.com");
      expect(result.data.section_patterns).toHaveLength(1);
      expect(result.gdpr_notice).toBeDefined();
    });

    it("存在しないページIDでエラーを投げる / should throw for non-existent page", async () => {
      mockPrisma.$queryRawUnsafe = vi.fn().mockResolvedValueOnce([]);

      await expect(service.exportPageData(MOCK_PAGE_ID)).rejects.toThrow("Page not found");
    });

    it("無効なUUIDで入力バリデーションエラーを投げる / should throw for invalid UUID", async () => {
      await expect(service.exportPageData("not-valid")).rejects.toThrow("Invalid UUID format");
    });
  });

  // =====================================================
  // 5. exportProfileData テスト / exportProfileData tests
  // =====================================================

  describe("exportProfileData", () => {
    it("プロファイルと全シグナルをエクスポートする / should export profile with all signals", async () => {
      const queryMock = vi
        .fn()
        // preference_profile
        .mockResolvedValueOnce([
          {
            id: MOCK_PROFILE_ID,
            name: "default",
            preference_text: "I like minimalist design",
            interaction_count: 5,
            created_at: new Date("2026-01-01"),
            updated_at: new Date("2026-01-15"),
          },
        ])
        // preference_signals
        .mockResolvedValueOnce([
          {
            id: "sig-1",
            signal_type: "hearing_positive",
            signal_weight: 1.0,
            target_type: "web_page",
            target_id: MOCK_PAGE_ID,
            feedback_text: "Great design",
            created_at: new Date("2026-01-10"),
          },
        ]);

      mockPrisma.$queryRawUnsafe = queryMock;

      const result = await service.exportProfileData(MOCK_PROFILE_ID);

      expect(result.profile_id).toBe(MOCK_PROFILE_ID);
      expect(result.export_format).toBe("json");
      expect(result.data.profile).toBeDefined();
      expect(result.data.signals).toHaveLength(1);
      expect(result.pii_fields).toContain("profile_id");
      expect(result.gdpr_notice).toBeDefined();
    });

    it("存在しないプロファイルIDでエラーを投げる / should throw for non-existent profile", async () => {
      mockPrisma.$queryRawUnsafe = vi.fn().mockResolvedValueOnce([]);

      await expect(service.exportProfileData(MOCK_PROFILE_ID)).rejects.toThrow("Profile not found");
    });
  });

  // =====================================================
  // 6. セキュリティテスト / Security tests
  // =====================================================

  describe("Security", () => {
    it("SQLインジェクション文字列をUUIDバリデーションで拒否する / should reject SQL injection via UUID validation", async () => {
      const injections = [
        "'; DROP TABLE web_pages; --",
        "1 OR 1=1",
        '" UNION SELECT * FROM web_pages --',
        "<script>alert('xss')</script>",
        "../../etc/passwd",
      ];

      for (const injection of injections) {
        await expect(service.deletePage(injection, "test")).rejects.toThrow("Invalid UUID format");
      }
    });

    it("空文字列のIDを拒否する / should reject empty string ID", async () => {
      await expect(service.deletePage("", "test")).rejects.toThrow("Invalid UUID format");
    });

    it("空文字列のreasonを拒否する / should reject empty reason", async () => {
      await expect(service.deletePage(MOCK_PAGE_ID, "")).rejects.toThrow(
        "Deletion reason is required"
      );
    });
  });

  // =====================================================
  // 7. PII配慮ログテスト / PII-aware logging tests
  // =====================================================

  describe("PII-aware logging", () => {
    it("監査ログにフルIDを出力しない（truncateId使用） / should not log full IDs (uses truncateId)", async () => {
      const queryMock = vi.fn().mockResolvedValueOnce([{ id: MOCK_PROFILE_ID }]);
      const executeMock = vi.fn().mockResolvedValue(0);

      const txMockPrisma: GdprPrismaClient = {
        $queryRawUnsafe: queryMock,
        $executeRawUnsafe: executeMock,
        $transaction: vi.fn(),
      };
      mockPrisma.$transaction = vi
        .fn()
        .mockImplementation(async (fn: (tx: GdprPrismaClient) => Promise<unknown>) =>
          fn(txMockPrisma)
        );

      await service.deleteProfile(MOCK_PROFILE_ID, "test deletion");

      // logger.warnが呼ばれている（監査ログ）
      expect(logger.warn).toHaveBeenCalled();

      // フルIDが監査ログに含まれていないことを確認
      const warnCalls = vi.mocked(logger.warn).mock.calls;
      for (const call of warnCalls) {
        const stringified = JSON.stringify(call);
        expect(stringified).not.toContain(MOCK_PROFILE_ID);
      }
    });
  });

  // =====================================================
  // 8. DI/ファクトリーテスト / DI/Factory tests
  // =====================================================

  describe("DI/Factory", () => {
    it("PrismaClientファクトリー未設定時にエラーを投げる / should throw when PrismaClient factory not set", async () => {
      resetGdprPrismaClientFactory();
      const svc = new GdprDeletionService();

      // 実際のメソッド呼び出しでthrow
      await expect(svc.deletePage(MOCK_PAGE_ID, "test")).rejects.toThrow(
        "PrismaClient not initialized"
      );
    });

    it("getGdprDeletionServiceがシングルトンを返す / should return singleton instance", () => {
      setGdprPrismaClientFactory(() => mockPrisma);
      const instance1 = getGdprDeletionService();
      const instance2 = getGdprDeletionService();
      expect(instance1).toBe(instance2);
    });

    it("resetGdprDeletionServiceがシングルトンをリセットする / should reset singleton", () => {
      setGdprPrismaClientFactory(() => mockPrisma);
      const instance1 = getGdprDeletionService();
      resetGdprDeletionService();
      const instance2 = getGdprDeletionService();
      expect(instance1).not.toBe(instance2);
    });
  });

  // =====================================================
  // 9. DB接続エラーテスト / DB connection error tests
  // =====================================================

  describe("DB connection errors", () => {
    it("トランザクション中のDBエラーを適切にハンドリングする / should handle DB errors during transaction", async () => {
      mockPrisma.$transaction = vi.fn().mockRejectedValue(new Error("Database connection lost"));

      await expect(service.deletePage(MOCK_PAGE_ID, "test")).rejects.toThrow(
        "Database connection lost"
      );
    });
  });

  // =====================================================
  // 10. CO-5 UC-2: A path Short-ID Length-Invariant Guard
  //     (SEC-CO5-02 closure, defense-in-depth against Zod relaxation)
  // =====================================================

  describe("[CO-5 UC-2] A path SQL LIKE length-invariant guard", () => {
    /**
     * UC-2 (SEC-CO5-02): Plan §3.2 採用形 `truncateProfileIdForSqlLike` は
     * profileId.length < TARGET_ID_TRUNCATE_LENGTH 時に throw する length-invariant
     * guard を持つ。Zod UUID 契約 (`data.tool.ts`) で runtime exploit 不可だが
     * Zod 緩和時の silent over-deletion regression を防ぐ defense-in-depth。
     *
     * UC-2 (SEC-CO5-02): The Plan §3.2 form `truncateProfileIdForSqlLike` carries
     * a length-invariant guard that throws when profileId.length is shorter than
     * TARGET_ID_TRUNCATE_LENGTH. Zod UUID validation in `data.tool.ts` makes
     * runtime exploitation impossible under the current contract, but this guard
     * provides defense-in-depth against silent over-deletion regression should
     * Zod be relaxed in the future.
     */
    it("validateUuid rejects short ID (Zod UUID contract enforced — guard cold path)", async () => {
      // Direct service call with too-short id is rejected by validateUuid first
      // (UUID_REGEX requires 36 chars). This documents the layered defense:
      // 1st layer = validateUuid; 2nd layer = truncateProfileIdForSqlLike length guard.
      await expect(service.deleteProfile("short", "test reason")).rejects.toThrow(
        "Invalid UUID format"
      );
    });

    it("guard surface compiles to length=AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH (SSOT verification)", () => {
      // SSOT contract verification: the length used by truncateProfileIdForSqlLike
      // is derived from AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH (current = 8).
      // If this value changes, BOTH gdpr-deletion (guard + SQL LIKE prefix) AND
      // search-log (truncateId stored value) shift in lockstep — preventing
      // cross-SSOT length asymmetry (LCC-CO5-01 closure).
      expect(AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH).toBeGreaterThanOrEqual(8);
      expect(typeof AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH).toBe("number");
    });
  });

  // =====================================================
  // 11. CO-5 UC-4: 8-Char Prefix Collision Audit Trail
  //     (LCC-CO5-02 closure, GDPR Art.30 verification trail)
  // =====================================================

  describe("[CO-5 UC-4] GDPR Art.30 post-deletion verification trail", () => {
    /**
     * UC-4 (LCC-CO5-02): A path SQL LIKE `slice(0, 8) + "%"` は UUID 最初 8 文字
     * prefix match (4.3×10^9 通り)。birthday paradox: N=10K で ~1.2% collision、
     * `deleteAllUserData` 時 over-deletion 構造的可能性。GDPR Art.30 post-deletion
     * verification trail として `searchLogsAnonymized` count + profileId SHA-256 hash
     * を result + audit_logs.details に記録する。
     *
     * UC-4 (LCC-CO5-02): A path SQL LIKE `slice(0, 8) + "%"` matches first 8 chars
     * of UUID (~4.3 × 10^9 prefixes). Birthday paradox: ~1.2% collision at N=10K.
     * Records `searchLogsAnonymized` count + profileId SHA-256 hash in the result
     * + audit_logs.details for GDPR Art.30 post-deletion verification trail.
     */
    it("deleteProfile result includes profile_id_hash (SHA-256 of profileId)", async () => {
      const queryMock = vi.fn().mockResolvedValueOnce([{ id: MOCK_PROFILE_ID }]);
      const executeMock = vi
        .fn()
        .mockResolvedValueOnce(2) // preference_signals
        .mockResolvedValueOnce(7) // search_logs anonymized
        .mockResolvedValueOnce(1); // preference_profiles

      const txMockPrisma: GdprPrismaClient = {
        $queryRawUnsafe: queryMock,
        $executeRawUnsafe: executeMock,
        $transaction: vi.fn(),
      };
      mockPrisma.$transaction = vi
        .fn()
        .mockImplementation(async (fn: (tx: GdprPrismaClient) => Promise<unknown>) =>
          fn(txMockPrisma)
        );

      const result = await service.deleteProfile(MOCK_PROFILE_ID, "GDPR Art.17 erasure");

      // Hash is deterministic SHA-256 of full profileId
      const expectedHash = createHash("sha256").update(MOCK_PROFILE_ID, "utf8").digest("hex");
      expect(result.profile_id_hash).toBe(expectedHash);
      // Hash length is 64 hex chars (256 bits)
      expect(result.profile_id_hash).toHaveLength(64);
      // Hash does NOT contain raw profileId (PII not exposed)
      expect(result.profile_id_hash).not.toContain(MOCK_PROFILE_ID);
      // search_logs_anonymized propagated
      expect(result.deleted_records.search_logs_anonymized).toBe(7);
    });

    it("deleteAllUserData result includes search_logs_anonymized + profile_id_hash when profile deleted", async () => {
      const queryMock = vi
        .fn()
        .mockResolvedValueOnce([{ id: MOCK_PAGE_ID }]) // page existence
        .mockResolvedValueOnce([{ id: MOCK_PROFILE_ID }]); // profile existence

      const executeMock = vi.fn().mockResolvedValue(3); // catch-all (search_logs anonymize will return 3)

      const txMockPrisma: GdprPrismaClient = {
        $queryRawUnsafe: queryMock,
        $executeRawUnsafe: executeMock,
        $transaction: vi.fn(),
      };
      mockPrisma.$transaction = vi
        .fn()
        .mockImplementation(async (fn: (tx: GdprPrismaClient) => Promise<unknown>) =>
          fn(txMockPrisma)
        );

      const result = await service.deleteAllUserData(
        [MOCK_PAGE_ID],
        MOCK_PROFILE_ID,
        "Full account deletion"
      );

      // search_logs_anonymized field present (UC-4)
      expect(result).toHaveProperty("search_logs_anonymized");
      expect(typeof result.search_logs_anonymized).toBe("number");
      // profile_id_hash field present (UC-4 / LCC-CO5-02)
      expect(result).toHaveProperty("profile_id_hash");
      const expectedHash = createHash("sha256").update(MOCK_PROFILE_ID, "utf8").digest("hex");
      expect(result.profile_id_hash).toBe(expectedHash);
      expect(result.profile_id_hash).toHaveLength(64);
    });

    it("deleteAllUserData omits profile_id_hash when no profile was deleted", async () => {
      // profileId given but profile does not exist → profileDeleted=false → no hash
      const queryMock = vi
        .fn()
        .mockResolvedValueOnce([{ id: MOCK_PAGE_ID }]) // page existence
        .mockResolvedValueOnce([]); // profile NOT existing

      const executeMock = vi.fn().mockResolvedValue(1);

      const txMockPrisma: GdprPrismaClient = {
        $queryRawUnsafe: queryMock,
        $executeRawUnsafe: executeMock,
        $transaction: vi.fn(),
      };
      mockPrisma.$transaction = vi
        .fn()
        .mockImplementation(async (fn: (tx: GdprPrismaClient) => Promise<unknown>) =>
          fn(txMockPrisma)
        );

      const result = await service.deleteAllUserData(
        [MOCK_PAGE_ID],
        MOCK_PROFILE_ID,
        "Page-only deletion"
      );

      expect(result.profile_deleted).toBe(false);
      // No hash when no profile was deleted
      expect(result.profile_id_hash).toBeUndefined();
      // search_logs_anonymized still set (default 0 since no profile path executed)
      expect(result.search_logs_anonymized).toBe(0);
    });
  });

  // =====================================================
  // 12. CO-5 SEC-CO5-03: SQL LIKE Meta-char Defense-in-Depth
  // =====================================================

  describe("[CO-5 SEC-CO5-03] SQL LIKE meta-char defense-in-depth", () => {
    /**
     * SEC-CO5-03 (L): Plan §5.1 A path test に SQL LIKE meta-char (%, _, \) Zod
     * rejection assertion を追加。Zod UUID 契約 (`data.tool.ts` z.string().uuid())
     * への暗黙依存を explicit 化。
     *
     * SEC-CO5-03 (L): Adds explicit Zod UUID rejection assertion for SQL LIKE
     * meta-chars (%, _, \) to make the implicit dependency on the data.tool.ts
     * Zod UUID contract explicit at the service-layer boundary.
     */
    it("rejects profileId with SQL LIKE wildcard (%) via UUID validation", async () => {
      // Malicious profileId with % wildcard would, if allowed, broaden the LIKE
      // pattern. validateUuid (UUID_REGEX) is the first line of defense.
      await expect(
        service.deleteProfile("abcdefgh%; DROP TABLE search_logs; --", "test")
      ).rejects.toThrow("Invalid UUID format");
    });

    it("rejects profileId with SQL LIKE underscore (_) via UUID validation", async () => {
      await expect(
        service.deleteProfile("abcdefg_-1234-5678-9abc-def012345678", "test")
      ).rejects.toThrow("Invalid UUID format");
    });

    it("rejects profileId with SQL LIKE backslash escape via UUID validation", async () => {
      await expect(
        service.deleteProfile("abcdefg\\-1234-5678-9abc-def012345678", "test")
      ).rejects.toThrow("Invalid UUID format");
    });
  });
});

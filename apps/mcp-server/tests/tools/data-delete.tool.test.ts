// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * data.delete / data.export MCPツール テスト
 * GDPR Art.17 データ削除 + Art.20 データポータビリティ MCPツールハンドラーテスト
 *
 * テストカテゴリ:
 * 1. data.delete: 正常系（page/profile/all_user_data削除）
 * 2. data.delete: バリデーション（confirm=false、無効UUID、不正target）
 * 3. data.delete: エラーハンドリング（存在しないID、サービス未設定）
 * 4. data.delete: セキュリティ（エラーメッセージサニタイズ）
 * 5. data.export: 正常系（page/profileエクスポート）
 * 6. data.export: バリデーション（無効UUID、不正target）
 *
 * data.delete / data.export MCP tool tests
 * GDPR Art.17 data deletion + Art.20 data portability MCP tool handler tests
 *
 * @module tests/tools/data-delete.tool.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  dataDeleteHandler,
  setDataDeleteServiceFactory,
  resetDataDeleteServiceFactory,
  dataExportHandler,
  setDataExportServiceFactory,
  resetDataExportServiceFactory,
  DATA_MCP_ERROR_CODES,
  type GdprDeletionServiceForTool,
} from "../../src/tools/data/data.tool";

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

// =====================================================
// テストデータ / Test data
// =====================================================

const MOCK_PAGE_ID = "01934567-89ab-7def-0123-456789abcdef";
const MOCK_PROFILE_ID = "02934567-89ab-7def-0123-456789abcdef";

// =====================================================
// モックサービス / Mock service
// =====================================================

function createMockService(
  overrides?: Partial<GdprDeletionServiceForTool>
): GdprDeletionServiceForTool {
  return {
    deletePage: vi.fn().mockResolvedValue({
      deleted: true,
      page_id: MOCK_PAGE_ID,
      reason: "test",
      deleted_records: {
        web_pages: 1,
        section_patterns: 2,
        section_embeddings: 2,
        component_parts: 3,
        component_part_embeddings: 3,
        motion_patterns: 1,
        motion_embeddings: 1,
        js_animation_patterns: 0,
        js_animation_embeddings: 0,
        webgl_animation_patterns: 0,
        webgl_animation_embeddings: 0,
        motion_analysis_results: 0,
        motion_analysis_embeddings: 0,
        design_narratives: 0,
        design_narrative_embeddings: 0,
        background_designs: 0,
        background_design_embeddings: 0,
        responsive_analyses: 0,
        responsive_analysis_embeddings: 0,
        quality_evaluations: 1,
        quality_benchmarks: 0,
      },
      deleted_at: new Date().toISOString(),
    }),
    deleteProfile: vi.fn().mockResolvedValue({
      deleted: true,
      profile_id: MOCK_PROFILE_ID,
      reason: "test",
      deleted_records: {
        preference_profiles: 1,
        preference_signals: 5,
      },
      deleted_at: new Date().toISOString(),
    }),
    deleteAllUserData: vi.fn().mockResolvedValue({
      deleted: true,
      pages_deleted: 1,
      profile_deleted: true,
      reason: "test",
      deleted_at: new Date().toISOString(),
    }),
    exportPageData: vi.fn().mockResolvedValue({
      page_id: MOCK_PAGE_ID,
      export_format: "json",
      data: {
        web_page: { id: MOCK_PAGE_ID, url: "https://example.com" },
        section_patterns: [],
        component_parts: [],
        motion_patterns: [],
        quality_evaluations: [],
        design_narratives: [],
        background_designs: [],
        responsive_analyses: [],
      },
      pii_fields: ["page_id"],
      gdpr_notice: "Data exported under GDPR Art.20",
      exported_at: new Date().toISOString(),
    }),
    exportProfileData: vi.fn().mockResolvedValue({
      profile_id: MOCK_PROFILE_ID,
      export_format: "json",
      data: {
        profile: { id: MOCK_PROFILE_ID, name: "default" },
        signals: [],
      },
      pii_fields: ["profile_id"],
      gdpr_notice: "Data exported under GDPR Art.20",
      exported_at: new Date().toISOString(),
    }),
    ...overrides,
  };
}

// =====================================================
// テスト
// =====================================================

describe("data.delete MCP Tool", () => {
  let mockService: GdprDeletionServiceForTool;

  beforeEach(() => {
    mockService = createMockService();
    setDataDeleteServiceFactory(() => mockService);
    setDataExportServiceFactory(() => mockService);
  });

  afterEach(() => {
    resetDataDeleteServiceFactory();
    resetDataExportServiceFactory();
    vi.restoreAllMocks();
  });

  // =====================================================
  // 1. data.delete 正常系 / data.delete normal cases
  // =====================================================

  describe("data.delete - normal cases", () => {
    it("target=page でページ削除を実行する / should delete page when target=page", async () => {
      const result = await dataDeleteHandler({
        target: "page",
        id: MOCK_PAGE_ID,
        reason: "GDPR Art.17 deletion request",
        confirm: true,
      });

      expect(result).toHaveProperty("success", true);
      if ("data" in result) {
        expect(result.data.deleted).toBe(true);
      }
      expect(mockService.deletePage).toHaveBeenCalledWith(
        MOCK_PAGE_ID,
        "GDPR Art.17 deletion request"
      );
    });

    it("target=profile でプロファイル削除を実行する / should delete profile when target=profile", async () => {
      const result = await dataDeleteHandler({
        target: "profile",
        id: MOCK_PROFILE_ID,
        reason: "User requested deletion",
        confirm: true,
      });

      expect(result).toHaveProperty("success", true);
      expect(mockService.deleteProfile).toHaveBeenCalledWith(
        MOCK_PROFILE_ID,
        "User requested deletion"
      );
    });

    it("target=all_user_data で全データ削除を実行する / should delete all data when target=all_user_data", async () => {
      const result = await dataDeleteHandler({
        target: "all_user_data",
        id: MOCK_PROFILE_ID,
        reason: "Account deletion",
        confirm: true,
        page_ids: [MOCK_PAGE_ID],
      });

      expect(result).toHaveProperty("success", true);
      expect(mockService.deleteAllUserData).toHaveBeenCalled();
    });
  });

  // =====================================================
  // 2. data.delete バリデーション / data.delete validation
  // =====================================================

  describe("data.delete - validation", () => {
    it("confirm=false で削除を拒否する / should reject when confirm=false", async () => {
      const result = await dataDeleteHandler({
        target: "page",
        id: MOCK_PAGE_ID,
        reason: "test",
        confirm: false,
      });

      expect(result).toHaveProperty("success", false);
      if ("error" in result) {
        expect(result.error.code).toBe(DATA_MCP_ERROR_CODES.DELETE_NOT_CONFIRMED);
      }
    });

    it("無効なUUIDで入力バリデーションエラーを返す / should return validation error for invalid UUID", async () => {
      const result = await dataDeleteHandler({
        target: "page",
        id: "not-a-uuid",
        reason: "test",
        confirm: true,
      });

      expect(result).toHaveProperty("success", false);
      if ("error" in result) {
        expect(result.error.code).toBe(DATA_MCP_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it("不正なtarget値でバリデーションエラーを返す / should return validation error for invalid target", async () => {
      const result = await dataDeleteHandler({
        target: "invalid_target",
        id: MOCK_PAGE_ID,
        reason: "test",
        confirm: true,
      });

      expect(result).toHaveProperty("success", false);
      if ("error" in result) {
        expect(result.error.code).toBe(DATA_MCP_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it("reason未指定でバリデーションエラーを返す / should return validation error when reason is missing", async () => {
      const result = await dataDeleteHandler({
        target: "page",
        id: MOCK_PAGE_ID,
        confirm: true,
      });

      expect(result).toHaveProperty("success", false);
      if ("error" in result) {
        expect(result.error.code).toBe(DATA_MCP_ERROR_CODES.VALIDATION_ERROR);
      }
    });
  });

  // =====================================================
  // 3. data.delete エラーハンドリング / error handling
  // =====================================================

  describe("data.delete - error handling", () => {
    it("存在しないページID で NOT_FOUND エラーを返す / should return NOT_FOUND for non-existent page", async () => {
      mockService.deletePage = vi.fn().mockRejectedValue(new Error("Page not found"));

      const result = await dataDeleteHandler({
        target: "page",
        id: MOCK_PAGE_ID,
        reason: "test",
        confirm: true,
      });

      expect(result).toHaveProperty("success", false);
      if ("error" in result) {
        expect(result.error.code).toBe(DATA_MCP_ERROR_CODES.NOT_FOUND);
      }
    });

    it("サービス未設定で SERVICE_UNAVAILABLE エラーを返す / should return error when service not set", async () => {
      resetDataDeleteServiceFactory();

      const result = await dataDeleteHandler({
        target: "page",
        id: MOCK_PAGE_ID,
        reason: "test",
        confirm: true,
      });

      expect(result).toHaveProperty("success", false);
      if ("error" in result) {
        expect(result.error.code).toBe(DATA_MCP_ERROR_CODES.SERVICE_UNAVAILABLE);
      }
    });

    it("DB接続エラーでサニタイズされたメッセージを返す / should return sanitized message on DB error", async () => {
      mockService.deletePage = vi.fn().mockRejectedValue(
        Object.assign(new Error("column web_pages.secret_field does not exist"), {
          code: "P2003",
        })
      );

      const result = await dataDeleteHandler({
        target: "page",
        id: MOCK_PAGE_ID,
        reason: "test",
        confirm: true,
      });

      expect(result).toHaveProperty("success", false);
      if ("error" in result) {
        // DB構造の詳細が漏れていないことを確認
        expect(result.error.message).not.toContain("web_pages");
        expect(result.error.message).not.toContain("secret_field");
      }
    });
  });

  // =====================================================
  // 4. data.export 正常系 / data.export normal cases
  // =====================================================

  describe("data.export - normal cases", () => {
    it("target=page でページデータをエクスポートする / should export page data", async () => {
      const result = await dataExportHandler({
        target: "page",
        id: MOCK_PAGE_ID,
      });

      expect(result).toHaveProperty("success", true);
      if ("data" in result) {
        expect(result.data.page_id).toBe(MOCK_PAGE_ID);
        expect(result.data.export_format).toBe("json");
      }
      expect(mockService.exportPageData).toHaveBeenCalledWith(MOCK_PAGE_ID);
    });

    it("target=profile でプロファイルデータをエクスポートする / should export profile data", async () => {
      const result = await dataExportHandler({
        target: "profile",
        id: MOCK_PROFILE_ID,
      });

      expect(result).toHaveProperty("success", true);
      if ("data" in result) {
        expect(result.data.profile_id).toBe(MOCK_PROFILE_ID);
      }
      expect(mockService.exportProfileData).toHaveBeenCalledWith(MOCK_PROFILE_ID);
    });
  });

  // =====================================================
  // 5. data.export バリデーション / data.export validation
  // =====================================================

  describe("data.export - validation", () => {
    it("無効なUUIDで入力バリデーションエラーを返す / should return validation error for invalid UUID", async () => {
      const result = await dataExportHandler({
        target: "page",
        id: "not-a-uuid",
      });

      expect(result).toHaveProperty("success", false);
    });

    it("サービス未設定でエラーを返す / should return error when service not set", async () => {
      resetDataExportServiceFactory();

      const result = await dataExportHandler({
        target: "page",
        id: MOCK_PAGE_ID,
      });

      expect(result).toHaveProperty("success", false);
    });
  });
});

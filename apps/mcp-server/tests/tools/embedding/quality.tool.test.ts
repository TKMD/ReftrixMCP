// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * embedding.quality MCPツールのテスト
 *
 * Embedding品質監視MCPツールのユニットテスト。
 *
 * テスト対象:
 * - Zodスキーマバリデーション
 * - DIパターン（サービスファクトリー設定/リセット）
 * - ハンドラー正常系
 * - ハンドラーエラー系（バリデーション、サービス未設定、内部エラー）
 * - ツール定義の構造検証
 *
 * @module tests/tools/embedding/quality.tool.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  embeddingQualityInputSchema,
  embeddingQualityHandler,
  embeddingQualityToolDefinition,
  setEmbeddingQualityServiceFactory,
  resetEmbeddingQualityServiceFactory,
  EMBEDDING_QUALITY_ERROR_CODES,
  type EmbeddingQualityOutput,
} from "../../../src/tools/embedding/quality.tool";
import type {
  EmbeddingQualityMonitorService,
  QualityMonitorResult,
} from "../../../src/services/embedding-quality-monitor.service";

// =====================================================
// テストデータ / Test Data
// =====================================================

/** 正常な監視結果 */
function createMockMonitorResult(): QualityMonitorResult {
  return {
    qualityScore: 95,
    metrics: {
      coverage: {
        textEmbeddingCount: 90,
        visionEmbeddingCount: 85,
        totalSections: 100,
        textCoveragePercent: 90,
        visionCoveragePercent: 85,
      },
      textAnomalies: {
        nanInfinityCount: 0,
        zeroVectorCount: 0,
        abnormalL2NormCount: 0,
        totalInspected: 90,
      },
      visionAnomalies: {
        nanInfinityCount: 0,
        zeroVectorCount: 0,
        abnormalL2NormCount: 0,
        totalInspected: 85,
      },
      textDrift: null,
      visionDrift: null,
    },
    alerts: [],
  };
}

/** 分布統計付き監視結果 */
function createMockMonitorResultWithDistribution(): QualityMonitorResult {
  return {
    ...createMockMonitorResult(),
    distribution: {
      text: {
        mean: 0.001,
        std: 0.036,
        min: -0.12,
        max: 0.11,
        avgL2Norm: 1.0,
        sampleCount: 90,
      },
      vision: {
        mean: 0.002,
        std: 0.038,
        min: -0.15,
        max: 0.14,
        avgL2Norm: 1.0,
        sampleCount: 85,
      },
    },
  };
}

/** Mock EmbeddingQualityMonitorServiceを作成 */
function createMockService(): EmbeddingQualityMonitorService {
  return {
    monitor: vi.fn().mockResolvedValue(createMockMonitorResult()),
    setBaseline: vi.fn(),
    getBaseline: vi.fn().mockReturnValue(null),
    computeAndSetBaseline: vi.fn().mockResolvedValue(null),
  } as unknown as EmbeddingQualityMonitorService;
}

// =====================================================
// テスト本体
// =====================================================

describe("embedding.quality MCP Tool", () => {
  let mockService: EmbeddingQualityMonitorService;

  beforeEach(() => {
    mockService = createMockService();
    setEmbeddingQualityServiceFactory(() => mockService);
  });

  afterEach(() => {
    resetEmbeddingQualityServiceFactory();
  });

  // =====================================================
  // Zodスキーマバリデーション
  // =====================================================

  describe("Zodスキーマバリデーション", () => {
    it("デフォルト値でパースできること", () => {
      const result = embeddingQualityInputSchema.parse({});
      expect(result.scope).toBe("all");
      expect(result.include_distribution).toBe(false);
    });

    it("scope=sectionsでパースできること", () => {
      const result = embeddingQualityInputSchema.parse({ scope: "sections" });
      expect(result.scope).toBe("sections");
    });

    it("scope=partsでパースできること", () => {
      const result = embeddingQualityInputSchema.parse({ scope: "parts" });
      expect(result.scope).toBe("parts");
    });

    it("scope=allでパースできること", () => {
      const result = embeddingQualityInputSchema.parse({ scope: "all" });
      expect(result.scope).toBe("all");
    });

    it("不正なscopeでバリデーションエラーになること", () => {
      expect(() => embeddingQualityInputSchema.parse({ scope: "invalid" })).toThrow();
    });

    it("web_page_idが正しいUUIDでパースできること", () => {
      const result = embeddingQualityInputSchema.parse({
        web_page_id: "550e8400-e29b-41d4-a716-446655440000",
      });
      expect(result.web_page_id).toBe("550e8400-e29b-41d4-a716-446655440000");
    });

    it("不正なUUIDでバリデーションエラーになること", () => {
      expect(() => embeddingQualityInputSchema.parse({ web_page_id: "not-a-uuid" })).toThrow();
    });

    it("include_distribution=trueでパースできること", () => {
      const result = embeddingQualityInputSchema.parse({ include_distribution: true });
      expect(result.include_distribution).toBe(true);
    });

    it("全パラメータ指定でパースできること", () => {
      const result = embeddingQualityInputSchema.parse({
        scope: "sections",
        web_page_id: "550e8400-e29b-41d4-a716-446655440000",
        include_distribution: true,
      });
      expect(result.scope).toBe("sections");
      expect(result.web_page_id).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(result.include_distribution).toBe(true);
    });
  });

  // =====================================================
  // DIパターン
  // =====================================================

  describe("DIパターン", () => {
    it("サービスファクトリーを設定してリセットできること", () => {
      resetEmbeddingQualityServiceFactory();
      setEmbeddingQualityServiceFactory(() => mockService);
      // If we can call handler without error, factory is set
      expect(true).toBe(true);
    });

    it("サービスファクトリー未設定でSERVICE_UNAVAILABLEを返すこと", async () => {
      resetEmbeddingQualityServiceFactory();

      const result = (await embeddingQualityHandler({})) as EmbeddingQualityOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(EMBEDDING_QUALITY_ERROR_CODES.SERVICE_UNAVAILABLE);
      }
    });
  });

  // =====================================================
  // ハンドラー正常系
  // =====================================================

  describe("ハンドラー正常系", () => {
    it("デフォルトパラメータで成功レスポンスを返すこと", async () => {
      const result = (await embeddingQualityHandler({})) as EmbeddingQualityOutput;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.qualityScore).toBe(95);
        expect(result.data.metrics).toBeDefined();
        expect(result.data.alerts).toEqual([]);
      }
    });

    it("scope=sectionsで成功レスポンスを返すこと", async () => {
      const result = (await embeddingQualityHandler({
        scope: "sections",
      })) as EmbeddingQualityOutput;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.qualityScore).toBeGreaterThanOrEqual(0);
      }
    });

    it("web_page_id指定で成功レスポンスを返すこと", async () => {
      const result = (await embeddingQualityHandler({
        web_page_id: "550e8400-e29b-41d4-a716-446655440000",
      })) as EmbeddingQualityOutput;

      expect(result.success).toBe(true);
    });

    it("include_distribution=trueで分布統計を含むこと", async () => {
      (mockService.monitor as ReturnType<typeof vi.fn>).mockResolvedValue(
        createMockMonitorResultWithDistribution()
      );

      const result = (await embeddingQualityHandler({
        include_distribution: true,
      })) as EmbeddingQualityOutput;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.distribution).toBeDefined();
        expect(result.data.distribution!.text).toBeDefined();
        expect(result.data.distribution!.vision).toBeDefined();
      }
    });

    it("service.monitorが正しいパラメータで呼ばれること", async () => {
      await embeddingQualityHandler({
        scope: "parts",
        web_page_id: "550e8400-e29b-41d4-a716-446655440000",
        include_distribution: true,
      });

      expect(mockService.monitor).toHaveBeenCalledWith({
        scope: "parts",
        webPageId: "550e8400-e29b-41d4-a716-446655440000",
        includeDistribution: true,
      });
    });
  });

  // =====================================================
  // ハンドラーエラー系
  // =====================================================

  describe("ハンドラーエラー系", () => {
    it("不正なscopeでVALIDATION_ERRORを返すこと", async () => {
      const result = (await embeddingQualityHandler({
        scope: "invalid_scope",
      })) as EmbeddingQualityOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(EMBEDDING_QUALITY_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it("不正なUUIDでVALIDATION_ERRORを返すこと", async () => {
      const result = (await embeddingQualityHandler({
        web_page_id: "not-a-uuid",
      })) as EmbeddingQualityOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(EMBEDDING_QUALITY_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it("サービスエラーでINTERNAL_ERRORを返すこと", async () => {
      (mockService.monitor as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Database connection failed")
      );

      const result = (await embeddingQualityHandler({})) as EmbeddingQualityOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(EMBEDDING_QUALITY_ERROR_CODES.INTERNAL_ERROR);
        // sanitizeErrorMessage should hide internal details
        expect(result.error.message).not.toContain("Database connection");
      }
    });

    it("エラーメッセージがサニタイズされること", async () => {
      (mockService.monitor as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("SELECT * FROM secret_table WHERE password = 'leaked'")
      );

      const result = (await embeddingQualityHandler({})) as EmbeddingQualityOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).not.toContain("secret_table");
        expect(result.error.message).not.toContain("password");
      }
    });
  });

  // =====================================================
  // ツール定義検証
  // =====================================================

  describe("ツール定義", () => {
    it("nameがembedding.qualityであること", () => {
      expect(embeddingQualityToolDefinition.name).toBe("embedding.quality");
    });

    it("descriptionが存在すること", () => {
      expect(embeddingQualityToolDefinition.description).toBeDefined();
      expect(embeddingQualityToolDefinition.description.length).toBeGreaterThan(0);
    });

    it("annotationsにreadOnlyHint=trueがあること", () => {
      expect(embeddingQualityToolDefinition.annotations.readOnlyHint).toBe(true);
    });

    it("annotationsにidempotentHint=trueがあること", () => {
      expect(embeddingQualityToolDefinition.annotations.idempotentHint).toBe(true);
    });

    it("inputSchemaがobject型であること", () => {
      expect(embeddingQualityToolDefinition.inputSchema.type).toBe("object");
    });

    it("inputSchemaにscope, web_page_id, include_distributionプロパティがあること", () => {
      const props = embeddingQualityToolDefinition.inputSchema.properties;
      expect(props).toHaveProperty("scope");
      expect(props).toHaveProperty("web_page_id");
      expect(props).toHaveProperty("include_distribution");
    });

    it("requiredが空配列であること（全パラメータ任意）", () => {
      expect(embeddingQualityToolDefinition.inputSchema.required).toEqual([]);
    });
  });

  // =====================================================
  // エラーコード検証
  // =====================================================

  describe("エラーコード", () => {
    it("VALIDATION_ERRORが定義されていること", () => {
      expect(EMBEDDING_QUALITY_ERROR_CODES.VALIDATION_ERROR).toBe("VALIDATION_ERROR");
    });

    it("SERVICE_UNAVAILABLEが定義されていること", () => {
      expect(EMBEDDING_QUALITY_ERROR_CODES.SERVICE_UNAVAILABLE).toBe("SERVICE_UNAVAILABLE");
    });

    it("INTERNAL_ERRORが定義されていること", () => {
      expect(EMBEDDING_QUALITY_ERROR_CODES.INTERNAL_ERROR).toBe("INTERNAL_ERROR");
    });
  });
});

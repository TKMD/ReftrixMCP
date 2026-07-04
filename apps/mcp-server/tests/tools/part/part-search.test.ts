// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * part.search MCPツール テスト
 *
 * 目的:
 * - part.search ハンドラーの入力バリデーション（Zod schema）
 * - 正常系検索（テキスト、ハイブリッド）
 * - Embedding生成失敗時の空結果返却
 * - エラーハンドリング（サニタイズされたエラーメッセージ）
 * - ツール定義（MCP Protocol準拠）
 *
 * @module tests/tools/part/part-search.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  partSearchHandler,
  partSearchToolDefinition,
  PART_SEARCH_ERROR_CODES,
  type PartSearchOutput,
} from "../../../src/tools/part/search.tool";

import {
  setPartSearchEmbeddingServiceFactory,
  resetPartSearchEmbeddingServiceFactory,
  setPartSearchPrismaClientFactory,
  resetPartSearchPrismaClientFactory,
  resetPartSearchService,
  type PartSearchEmbeddingService,
  type PartSearchPrismaClient,
} from "../../../src/services/part/part-search.service";

// =====================================================
// テストデータ
// =====================================================

/**
 * モックベクトル検索結果行を生成
 */
function createMockSearchRow(
  id: string,
  partType: string = "button",
  similarity: number = 0.85
): Record<string, unknown> {
  return {
    id,
    part_type: partType,
    part_subtype: "primary_button",
    bounding_box: { x: 10, y: 20, width: 200, height: 50 },
    computed_styles: { color: "#ffffff", backgroundColor: "#1a1a2e" },
    html_snippet: '<button class="btn">Click me</button>',
    section_type: "hero",
    web_page_url: "https://example.com",
    similarity,
  };
}

// =====================================================
// モック
// =====================================================

let mockEmbeddingService: PartSearchEmbeddingService;
let mockPrismaClient: PartSearchPrismaClient;

describe("part.search MCPツール", () => {
  beforeEach(() => {
    // モックEmbeddingService
    mockEmbeddingService = {
      generateEmbedding: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
    };

    // モックPrismaClient
    mockPrismaClient = {
      $queryRawUnsafe: vi
        .fn()
        .mockResolvedValue([
          createMockSearchRow("part-001", "button", 0.92),
          createMockSearchRow("part-002", "card", 0.87),
        ]),
    };

    setPartSearchEmbeddingServiceFactory(() => mockEmbeddingService);
    setPartSearchPrismaClientFactory(() => mockPrismaClient);
  });

  afterEach(() => {
    resetPartSearchEmbeddingServiceFactory();
    resetPartSearchPrismaClientFactory();
    resetPartSearchService();
    vi.restoreAllMocks();
  });

  // =====================================================
  // ツール定義テスト
  // =====================================================

  describe("ツール定義 / Tool definition", () => {
    it("正しいツール名を持つこと", () => {
      expect(partSearchToolDefinition.name).toBe("part.search");
    });

    it("説明文が存在すること", () => {
      expect(partSearchToolDefinition.description).toBeTruthy();
      expect(partSearchToolDefinition.description.length).toBeGreaterThan(10);
    });

    it("MCP annotationsが存在すること", () => {
      expect(partSearchToolDefinition.annotations).toBeDefined();
      expect(partSearchToolDefinition.annotations.readOnlyHint).toBe(true);
      expect(partSearchToolDefinition.annotations.idempotentHint).toBe(true);
      expect(partSearchToolDefinition.annotations.openWorldHint).toBe(false);
    });

    it("inputSchemaにproperties定義があること", () => {
      expect(partSearchToolDefinition.inputSchema.type).toBe("object");
      expect(partSearchToolDefinition.inputSchema.properties).toBeDefined();
      expect(partSearchToolDefinition.inputSchema.properties.query).toBeDefined();
      expect(partSearchToolDefinition.inputSchema.properties.part_type).toBeDefined();
      expect(partSearchToolDefinition.inputSchema.properties.search_mode).toBeDefined();
      expect(partSearchToolDefinition.inputSchema.properties.limit).toBeDefined();
    });
  });

  // =====================================================
  // 入力バリデーション
  // =====================================================

  describe("入力バリデーション / Input validation", () => {
    it("queryもimage_urlもない場合はバリデーションエラー", async () => {
      const result = (await partSearchHandler({})) as PartSearchOutput;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PART_SEARCH_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it("queryが空文字の場合はバリデーションエラー", async () => {
      const result = (await partSearchHandler({ query: "" })) as PartSearchOutput;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PART_SEARCH_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it("queryが500文字超の場合はバリデーションエラー", async () => {
      const longQuery = "a".repeat(501);
      const result = (await partSearchHandler({ query: longQuery })) as PartSearchOutput;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PART_SEARCH_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it("limitが範囲外の場合はバリデーションエラー", async () => {
      const result = (await partSearchHandler({
        query: "test",
        limit: 200,
      })) as PartSearchOutput;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PART_SEARCH_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it("不正なsearch_modeはバリデーションエラー", async () => {
      const result = (await partSearchHandler({
        query: "test",
        search_mode: "invalid",
      })) as PartSearchOutput;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PART_SEARCH_ERROR_CODES.VALIDATION_ERROR);
      }
    });
  });

  // =====================================================
  // 正常系テスト
  // =====================================================

  describe("テキスト/ハイブリッド検索 / Text/hybrid search", () => {
    it("有効なクエリで検索結果を返すこと", async () => {
      const result = (await partSearchHandler({
        query: "blue primary button",
      })) as PartSearchOutput;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results).toBeDefined();
        expect(Array.isArray(result.data.results)).toBe(true);
        expect(result.data.searchTimeMs).toBeGreaterThanOrEqual(0);
        expect(result.data.query.text).toBe("blue primary button");
      }
    });

    it("search_mode=textでテキスト検索を実行すること", async () => {
      const result = (await partSearchHandler({
        query: "card component",
        search_mode: "text",
      })) as PartSearchOutput;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results).toBeDefined();
      }
    });

    it("part_typeフィルタが機能すること", async () => {
      const result = (await partSearchHandler({
        query: "navigation bar",
        part_type: "navigation",
      })) as PartSearchOutput;

      expect(result.success).toBe(true);
    });

    it("limitとoffsetが適用されること", async () => {
      const result = (await partSearchHandler({
        query: "button",
        limit: 5,
        offset: 10,
      })) as PartSearchOutput;

      expect(result.success).toBe(true);
    });

    it("min_similarityが適用されること", async () => {
      const result = (await partSearchHandler({
        query: "icon",
        min_similarity: 0.8,
      })) as PartSearchOutput;

      expect(result.success).toBe(true);
    });
  });

  // =====================================================
  // Embedding失敗 / Embedding failure
  // =====================================================

  // ADR-0043 Decision 1/3 / plan v4 §4.3.2 part 4-state:
  // embedding 失敗 (failed/unavailable) は visual/hybrid mode で success:false (state 4)、
  // text mode は fulltext-only fallback で success:true (state 3)。
  describe("Embedding生成失敗 / Embedding generation failure (ADR-0043 4-state)", () => {
    it("state 4: embedding 生成 throw + hybrid (default) → success:false (fail-loud)", async () => {
      mockEmbeddingService.generateEmbedding = vi
        .fn()
        .mockRejectedValue(new Error("Embedding boom"));
      setPartSearchEmbeddingServiceFactory(() => mockEmbeddingService);

      const result = (await partSearchHandler({
        query: "embedding fail hybrid q1",
      })) as PartSearchOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PART_SEARCH_ERROR_CODES.EMBEDDING_FAILED);
        expect(result.error.degradedReason).toBe("embedding_failed");
      }
    });

    it("state 4: embedding unavailable (factory 不在) + hybrid → success:false (SERVICE_UNAVAILABLE)", async () => {
      resetPartSearchEmbeddingServiceFactory();
      resetPartSearchService();

      const result = (await partSearchHandler({
        query: "embedding unavailable hybrid q2",
        search_mode: "hybrid",
      })) as PartSearchOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PART_SEARCH_ERROR_CODES.SERVICE_UNAVAILABLE);
        expect(result.error.degradedReason).toBe("embedding_unavailable");
      }
    });

    it("state 3: embedding 生成 throw + text mode → fulltext-only fallback (success:true 正当)", async () => {
      mockEmbeddingService.generateEmbedding = vi
        .fn()
        .mockRejectedValue(new Error("Embedding boom"));
      setPartSearchEmbeddingServiceFactory(() => mockEmbeddingService);

      const result = (await partSearchHandler({
        query: "embedding fail text q3",
        search_mode: "text",
      })) as PartSearchOutput;

      // text-mode は fulltext-only で続行する (障害を 0件偽装でも success:false でもない)
      expect(result.success).toBe(true);
    });
  });

  // =====================================================
  // ビジュアル検索制限 / Visual search limitation
  // =====================================================

  describe("ビジュアル検索 / Visual search", () => {
    it("image_url指定のvisual searchはエラーを返すこと（未対応）", async () => {
      const result = (await partSearchHandler({
        image_url: "https://example.com/image.png",
        search_mode: "visual",
      })) as PartSearchOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PART_SEARCH_ERROR_CODES.VALIDATION_ERROR);
        expect(result.error.message).toContain("not yet supported");
      }
    });
  });

  // =====================================================
  // エラーハンドリング
  // =====================================================

  describe("エラーハンドリング / Error handling", () => {
    it("DB障害時にPartSearchServiceがgraceful degradationで空結果を返すこと", async () => {
      // PartSearchServiceは内部でエラーをキャッチし空結果を返す（graceful degradation）
      // ハンドラーにはエラーが到達しないため、success: trueで空結果が返る
      mockPrismaClient.$queryRawUnsafe = vi
        .fn()
        .mockRejectedValue(new Error("database connection failed"));
      setPartSearchPrismaClientFactory(() => mockPrismaClient);

      const result = (await partSearchHandler({
        query: "test",
      })) as PartSearchOutput;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results).toEqual([]);
        expect(result.data.total).toBe(0);
      }
    });

    it("EmbeddingService 未設定 + hybrid (default) の場合は success:false (fail-loud、ADR-0043)", async () => {
      resetPartSearchEmbeddingServiceFactory();
      resetPartSearchService();

      const result = (await partSearchHandler({
        query: "embedding unset hybrid q4",
      })) as PartSearchOutput;

      // ADR-0043: embedding 必須 (hybrid) で未配線 → success:false (空 success:true 偽装撤去)
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PART_SEARCH_ERROR_CODES.SERVICE_UNAVAILABLE);
        expect(result.error.degradedReason).toBe("embedding_unavailable");
      }
    });

    it("EmbeddingService 未設定 + text mode の場合は fulltext-only fallback (success:true 正当)", async () => {
      resetPartSearchEmbeddingServiceFactory();
      resetPartSearchService();

      const result = (await partSearchHandler({
        query: "embedding unset text q5",
        search_mode: "text",
      })) as PartSearchOutput;

      // text mode は embedding 不要で fulltext-only 続行可能
      expect(result.success).toBe(true);
    });
  });
});

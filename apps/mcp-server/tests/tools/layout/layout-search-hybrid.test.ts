// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * layout.search ハイブリッドメソッド テスト
 *
 * LayoutSearchService.searchSectionPatternsHybrid の検証:
 * - ハイブリッド利用可能時: RRFマージ経由で検索
 * - ハイブリッド未設定時: vector-only検索にフォールバック
 * - 全文検索失敗時のgraceful degradation
 * - ツールハンドラーでのオプショナル呼び出し分岐
 *
 * TDA監査 P2-5: Hybrid Search固有テスト欠如の解消
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  layoutSearchHandler,
  setLayoutSearchServiceFactory,
  resetLayoutSearchServiceFactory,
  type ILayoutSearchService,
  type SearchServiceResult,
  type SearchOptions,
} from "../../../src/tools/layout/search.tool";

// =====================================================
// モックサービスファクトリ
// =====================================================

/** テスト用SearchResult生成ヘルパー */
function createMockSearchResult(overrides?: Partial<SearchServiceResult>): SearchServiceResult {
  return {
    results: [
      {
        id: "sp-001",
        webPageId: "wp-001",
        sectionType: "hero",
        similarity: 0.95,
        webPage: {
          id: "wp-001",
          url: "https://example.com",
          sourceType: "award_gallery",
          usageScope: "inspiration_only",
          screenshotDesktopUrl: null,
        },
      },
      {
        id: "sp-002",
        webPageId: "wp-001",
        sectionType: "feature",
        similarity: 0.88,
        webPage: {
          id: "wp-001",
          url: "https://example.com",
          sourceType: "award_gallery",
          usageScope: "inspiration_only",
          screenshotDesktopUrl: null,
        },
      },
    ],
    total: 2,
    ...overrides,
  };
}

/** ハイブリッド検索メソッドを持つモックサービスを生成 */
function createMockServiceWithHybrid(
  hybridResult: SearchServiceResult | null,
  vectorResult: SearchServiceResult | null = null
): ILayoutSearchService {
  return {
    resolveQueryEmbeddingResult: vi
      .fn()
      .mockResolvedValue({ status: "ok", embedding: new Array(768).fill(0.01) }),
    generateQueryEmbedding: vi.fn().mockResolvedValue(new Array(768).fill(0.01)),
    searchSectionPatterns: vi.fn().mockResolvedValue(vectorResult ?? createMockSearchResult()),
    searchSectionPatternsHybrid: vi.fn().mockResolvedValue(hybridResult),
  };
}

/** ハイブリッド検索メソッドを持たないモックサービスを生成 */
function createMockServiceWithoutHybrid(
  vectorResult?: SearchServiceResult | null
): ILayoutSearchService {
  return {
    resolveQueryEmbeddingResult: vi
      .fn()
      .mockResolvedValue({ status: "ok", embedding: new Array(768).fill(0.01) }),
    generateQueryEmbedding: vi.fn().mockResolvedValue(new Array(768).fill(0.01)),
    searchSectionPatterns: vi.fn().mockResolvedValue(vectorResult ?? createMockSearchResult()),
    // searchSectionPatternsHybrid は undefined（未実装）
  };
}

// =====================================================
// テスト
// =====================================================

describe("layout.search ハイブリッド検索分岐", () => {
  beforeEach(() => {
    resetLayoutSearchServiceFactory();
  });

  afterEach(() => {
    resetLayoutSearchServiceFactory();
  });

  // --- ハイブリッド利用可能時 ---

  describe("searchSectionPatternsHybrid が実装されている場合", () => {
    it("ハイブリッド検索メソッドが優先的に呼び出されること", async () => {
      // Arrange
      const hybridResult = createMockSearchResult({
        results: [
          {
            id: "hybrid-001",
            webPageId: "wp-001",
            sectionType: "hero",
            similarity: 0.97,
            webPage: {
              id: "wp-001",
              url: "https://example.com",
              sourceType: "award_gallery",
              usageScope: "inspiration_only",
              screenshotDesktopUrl: null,
            },
          },
        ],
        total: 1,
      });

      const service = createMockServiceWithHybrid(hybridResult);
      setLayoutSearchServiceFactory(() => service);

      // Act
      const result = await layoutSearchHandler({
        query: "modern hero section",
        limit: 10,
        offset: 0,
      });

      // Assert: ハイブリッドメソッドが呼び出された
      expect(service.searchSectionPatternsHybrid).toHaveBeenCalledOnce();
      // vector-onlyメソッドは呼び出されない
      expect(service.searchSectionPatterns).not.toHaveBeenCalled();

      // 結果が返ること
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results).toHaveLength(1);
        expect(result.data.results[0].id).toBe("hybrid-001");
      }
    });

    it("ハイブリッド検索に正しい引数が渡されること", async () => {
      // Arrange
      const service = createMockServiceWithHybrid(createMockSearchResult());
      setLayoutSearchServiceFactory(() => service);

      // Act
      await layoutSearchHandler({
        query: "gradient hero section",
        limit: 5,
        offset: 10,
        filters: { sectionType: "hero" },
      });

      // Assert: 引数を検証
      expect(service.searchSectionPatternsHybrid).toHaveBeenCalledWith(
        "gradient hero section", // rawクエリテキスト
        expect.any(Array), // embedding
        expect.objectContaining({
          limit: 5,
          offset: 10,
          filters: { sectionType: "hero" },
        })
      );
    });

    it("ハイブリッド検索がnullを返した場合に空結果が返ること", async () => {
      // Arrange
      const service = createMockServiceWithHybrid(null);
      setLayoutSearchServiceFactory(() => service);

      // Act
      const result = await layoutSearchHandler({
        query: "test query",
      });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results).toHaveLength(0);
        expect(result.data.total).toBe(0);
      }
    });
  });

  // --- ハイブリッド未設定時のフォールバック ---

  describe("searchSectionPatternsHybrid が未実装の場合", () => {
    it("vector-only検索にフォールバックすること", async () => {
      // Arrange
      const vectorResult = createMockSearchResult({
        results: [
          {
            id: "vector-001",
            webPageId: "wp-001",
            sectionType: "feature",
            similarity: 0.85,
            webPage: {
              id: "wp-001",
              url: "https://example.com",
              sourceType: "user_provided",
              usageScope: "owned_asset",
              screenshotDesktopUrl: null,
            },
          },
        ],
        total: 1,
      });

      const service = createMockServiceWithoutHybrid(vectorResult);
      setLayoutSearchServiceFactory(() => service);

      // Act
      const result = await layoutSearchHandler({
        query: "feature grid layout",
      });

      // Assert: vector-onlyメソッドが呼び出された
      expect(service.searchSectionPatterns).toHaveBeenCalledOnce();
      // ハイブリッドメソッドは存在しない（undefinedなので呼べない）
      expect(service.searchSectionPatternsHybrid).toBeUndefined();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results).toHaveLength(1);
        expect(result.data.results[0].id).toBe("vector-001");
      }
    });

    it("vector-only検索がnullを返した場合に空結果が返ること", async () => {
      // Arrange: searchSectionPatterns が明示的に null を返すサービス
      const service: ILayoutSearchService = {
        resolveQueryEmbeddingResult: vi
          .fn()
          .mockResolvedValue({ status: "ok", embedding: new Array(768).fill(0.01) }),
        generateQueryEmbedding: vi.fn().mockResolvedValue(new Array(768).fill(0.01)),
        searchSectionPatterns: vi.fn().mockResolvedValue(null),
        // searchSectionPatternsHybrid は undefined（未実装）
      };
      setLayoutSearchServiceFactory(() => service);

      // Act
      const result = await layoutSearchHandler({
        query: "test query",
      });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results).toHaveLength(0);
        expect(result.data.total).toBe(0);
      }
    });
  });

  // --- Embedding解決失敗時 (ADR-0043 Decision 1: 案A leaf fail-loud) ---
  // layout は embedding 必須 leaf。embedding 失敗を success:true total:0 で
  // 偽装せず success:false (fail-loud) を返す。旧 fake-empty 契約は撤去 (PR-2a-2)。

  describe("Embedding解決が失敗した場合 (fail-loud)", () => {
    it("embeddingがfailed(生成throw)の場合に success:false + embedding_failed を返すこと", async () => {
      // Arrange: embedding 生成が throw (failed)
      const service: ILayoutSearchService = {
        resolveQueryEmbeddingResult: vi
          .fn()
          .mockResolvedValue({ status: "failed", reason: "Database operation failed" }),
        generateQueryEmbedding: vi.fn(),
        searchSectionPatterns: vi.fn(),
        searchSectionPatternsHybrid: vi.fn(),
      };
      setLayoutSearchServiceFactory(() => service);

      // Act
      const result = await layoutSearchHandler({ query: "test query" });

      // Assert: 検索メソッドは呼び出されない (fail-loud で早期 return)
      expect(service.searchSectionPatterns).not.toHaveBeenCalled();
      expect(service.searchSectionPatternsHybrid).not.toHaveBeenCalled();

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("EMBEDDING_FAILED");
        expect(result.error.degradedReason).toBe("embedding_failed");
        // CWE-209 / GDPR Art.5(1)(c): query 本文・.so を含まない
        expect(result.error.message).not.toContain("test query");
        expect(result.error.message).not.toContain(".so");
      }
    });

    it("embeddingがunavailable(factory不在)の場合に success:false + embedding_unavailable を返すこと", async () => {
      const service: ILayoutSearchService = {
        resolveQueryEmbeddingResult: vi.fn().mockResolvedValue({ status: "unavailable" }),
        generateQueryEmbedding: vi.fn(),
        searchSectionPatterns: vi.fn(),
        searchSectionPatternsHybrid: vi.fn(),
      };
      setLayoutSearchServiceFactory(() => service);

      const result = await layoutSearchHandler({ query: "test query" });

      expect(service.searchSectionPatterns).not.toHaveBeenCalled();
      expect(service.searchSectionPatternsHybrid).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("SERVICE_UNAVAILABLE");
        expect(result.error.degradedReason).toBe("embedding_unavailable");
      }
    });
  });

  // --- search_mode によるルーティング ---

  describe("search_mode=text_only (マルチモーダル分岐)", () => {
    it("search_mode=text_only でもハイブリッドが利用可能ならハイブリッドが使われること", async () => {
      // Arrange
      const service = createMockServiceWithHybrid(createMockSearchResult());
      setLayoutSearchServiceFactory(() => service);

      // Act
      const result = await layoutSearchHandler({
        query: "modern design",
        search_mode: "text_only",
      });

      // Assert: text_only でもベクトル+全文のRRFハイブリッドは使われる
      // （search_mode は vision vs text の選択であり、vector+fulltext RRFとは別）
      expect(service.searchSectionPatternsHybrid).toHaveBeenCalledOnce();
      expect(result.success).toBe(true);
    });
  });
});

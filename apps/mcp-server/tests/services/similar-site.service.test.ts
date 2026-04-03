// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Similar Site Service テスト
 *
 * URL入力から類似デザインをDB内検索するサービスのユニットテスト
 *
 * テスト対象:
 * - mean pooling計算（正常系、空embedding、NaN混入）
 * - RRF fusion（3ソース、重み付け）
 * - 自サイト除外
 * - 存在しないURL
 * - セキュリティ（NaN/Infinity防御）
 *
 * @module tests/services/similar-site.service.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  computeMeanPooling,
  computeRRF3SourceFusion,
  searchSimilarSites,
  setSimilarSitePrismaClientFactory,
  resetSimilarSitePrismaClientFactory,
  setSimilarSiteEmbeddingServiceFactory,
  resetSimilarSiteEmbeddingServiceFactory,
  type SimilarSitePrismaClient,
  type SimilarSiteEmbeddingService,
  type SimilarSiteResult,
  type SimilarSiteSearchInput,
  RRF_K,
} from "../../src/services/similar-site.service";
import { invalidateCache } from "../../src/services/search-cache.service";

// =====================================================
// テストデータ
// =====================================================

/** テスト用768次元のembeddingベクトル */
function createMockEmbedding(seed: number): number[] {
  return Array.from({ length: 768 }, (_, i) => Math.sin(i + seed) * 0.01);
}

/** テスト用mock Prisma Client */
function createMockPrisma(): SimilarSitePrismaClient {
  return {
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
  };
}

/** テスト用mock EmbeddingService */
function createMockEmbeddingService(): SimilarSiteEmbeddingService {
  return {
    generateEmbedding: vi.fn().mockResolvedValue(createMockEmbedding(42)),
  };
}

// =====================================================
// mean pooling テスト
// =====================================================

describe("computeMeanPooling", () => {
  it("正常系: 複数ベクトルの平均を計算する", () => {
    const vectors = [
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ];
    const result = computeMeanPooling(vectors);
    expect(result).toEqual([4, 5, 6]);
  });

  it("正常系: 単一ベクトルはそのまま返す", () => {
    const vectors = [[1, 2, 3]];
    const result = computeMeanPooling(vectors);
    expect(result).toEqual([1, 2, 3]);
  });

  it("空配列の場合はnullを返す", () => {
    const result = computeMeanPooling([]);
    expect(result).toBeNull();
  });

  it("768次元のベクトルで正しく動作する", () => {
    const v1 = createMockEmbedding(1);
    const v2 = createMockEmbedding(2);
    const result = computeMeanPooling([v1, v2]);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(768);
    // 各要素が(v1[i] + v2[i]) / 2であることを検証
    for (let i = 0; i < 768; i++) {
      expect(result![i]).toBeCloseTo((v1[i]! + v2[i]!) / 2, 10);
    }
  });

  it("NaN混入ベクトルをフィルタして計算する", () => {
    const vectors = [
      [1, 2, 3],
      [NaN, NaN, NaN],
      [4, 5, 6],
    ];
    const result = computeMeanPooling(vectors);
    // NaN混入ベクトルはフィルタされ、[1,2,3]と[4,5,6]の平均
    expect(result).toEqual([2.5, 3.5, 4.5]);
  });

  it("全ベクトルがNaNの場合はnullを返す", () => {
    const vectors = [[NaN, NaN, NaN]];
    const result = computeMeanPooling(vectors);
    expect(result).toBeNull();
  });

  it("Infinity混入ベクトルをフィルタして計算する", () => {
    const vectors = [
      [1, 2, 3],
      [Infinity, -Infinity, 0],
    ];
    const result = computeMeanPooling(vectors);
    expect(result).toEqual([1, 2, 3]);
  });
});

// =====================================================
// RRF fusion テスト
// =====================================================

describe("computeRRF3SourceFusion", () => {
  interface FusionItem {
    id: string;
    webPageId: string;
    url: string;
    similarity: number;
  }

  function createFusionItem(id: string, url: string, similarity: number): FusionItem {
    return { id, webPageId: `wp-${id}`, url, similarity };
  }

  it("正常系: 3ソースの結果を融合する", () => {
    const textResults = [
      createFusionItem("a", "https://a.com", 0.9),
      createFusionItem("b", "https://b.com", 0.8),
    ];
    const visionResults = [
      createFusionItem("a", "https://a.com", 0.85),
      createFusionItem("c", "https://c.com", 0.7),
    ];
    const fulltextResults = [createFusionItem("b", "https://b.com", 0.6)];

    const result = computeRRF3SourceFusion(textResults, visionResults, fulltextResults, {
      text: 0.4,
      vision: 0.3,
      fulltext: 0.3,
    });

    // "a" は text(rank=1) + vision(rank=1) の両方に出現するため最高スコア
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!.id).toBe("a");
  });

  it("空ソースがあっても動作する", () => {
    const textResults = [createFusionItem("a", "https://a.com", 0.9)];
    const result = computeRRF3SourceFusion(textResults, [], [], {
      text: 0.4,
      vision: 0.3,
      fulltext: 0.3,
    });
    expect(result.length).toBe(1);
    expect(result[0]!.id).toBe("a");
  });

  it("全ソースが空の場合は空配列を返す", () => {
    const result = computeRRF3SourceFusion([], [], [], {
      text: 0.4,
      vision: 0.3,
      fulltext: 0.3,
    });
    expect(result).toEqual([]);
  });

  it("RRFスコアは weight / (k + rank) で計算される", () => {
    const textResults = [createFusionItem("a", "https://a.com", 0.9)];
    const result = computeRRF3SourceFusion(textResults, [], [], {
      text: 0.4,
      vision: 0.3,
      fulltext: 0.3,
    });
    // rank=1, k=60 → score = 0.4 / (60 + 1) = 0.4 / 61
    const expectedScore = 0.4 / (RRF_K + 1);
    expect(result[0]!.similarity).toBeCloseTo(expectedScore, 8);
  });

  it("重み付けが正しく反映される", () => {
    const textResults = [createFusionItem("a", "https://a.com", 0.9)];
    const visionResults = [createFusionItem("a", "https://a.com", 0.85)];

    const result = computeRRF3SourceFusion(textResults, visionResults, [], {
      text: 0.4,
      vision: 0.3,
      fulltext: 0.3,
    });

    const expectedScore = 0.4 / (RRF_K + 1) + 0.3 / (RRF_K + 1);
    expect(result[0]!.similarity).toBeCloseTo(expectedScore, 8);
  });
});

// =====================================================
// searchSimilarSites 統合テスト
// =====================================================

describe("searchSimilarSites", () => {
  let mockPrisma: SimilarSitePrismaClient;
  let mockEmbeddingService: SimilarSiteEmbeddingService;

  beforeEach(() => {
    mockPrisma = createMockPrisma();
    mockEmbeddingService = createMockEmbeddingService();

    setSimilarSitePrismaClientFactory(() => mockPrisma);
    setSimilarSiteEmbeddingServiceFactory(() => mockEmbeddingService);

    invalidateCache();
  });

  afterEach(() => {
    resetSimilarSitePrismaClientFactory();
    resetSimilarSiteEmbeddingServiceFactory();
  });

  it("存在しないURLの場合はエラーを返す", async () => {
    // web_pagesにURLが存在しない
    (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const result = await searchSimilarSites({ url: "https://nonexistent.com" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("NOT_FOUND");
  });

  it("正常系: 類似サイトを返す", async () => {
    // 1回目: web_page取得
    (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([
        {
          id: "wp-1",
          url: "https://query-site.com",
          title: "Query Site",
        },
      ])
      // 2回目: section_embeddings取得（text_embedding）
      .mockResolvedValueOnce([
        {
          text_embedding: `[${createMockEmbedding(1).join(",")}]`,
          vision_embedding: `[${createMockEmbedding(2).join(",")}]`,
        },
        {
          text_embedding: `[${createMockEmbedding(3).join(",")}]`,
          vision_embedding: null,
        },
      ])
      // 3回目: text vector検索
      .mockResolvedValueOnce([
        {
          web_page_id: "wp-2",
          wp_url: "https://similar-1.com",
          wp_title: "Similar Site 1",
          similarity: 0.9,
          section_types: "hero,feature",
        },
      ])
      // 4回目: vision vector検索
      .mockResolvedValueOnce([
        {
          web_page_id: "wp-2",
          wp_url: "https://similar-1.com",
          wp_title: "Similar Site 1",
          similarity: 0.85,
          section_types: "hero,feature",
        },
      ])
      // 5回目: fulltext検索
      .mockResolvedValueOnce([]);

    const result = await searchSimilarSites({
      url: "https://query-site.com",
      limit: 5,
    });

    expect(result.success).toBe(true);
    expect(result.similar_sites.length).toBeGreaterThan(0);
    expect(result.query_url).toBe("https://query-site.com");
  });

  it("自サイトを除外する", async () => {
    const queryEmbedding = createMockEmbedding(1);

    // web_page取得
    (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([
        {
          id: "wp-1",
          url: "https://my-site.com",
          title: "My Site",
        },
      ])
      // embeddings取得
      .mockResolvedValueOnce([
        {
          text_embedding: `[${queryEmbedding.join(",")}]`,
          vision_embedding: null,
        },
      ])
      // text検索 - 自サイトが含まれる
      .mockResolvedValueOnce([
        {
          web_page_id: "wp-1",
          wp_url: "https://my-site.com",
          wp_title: "My Site",
          similarity: 1.0,
          section_types: "hero",
        },
        {
          web_page_id: "wp-2",
          wp_url: "https://other-site.com",
          wp_title: "Other Site",
          similarity: 0.85,
          section_types: "hero",
        },
      ])
      // vision検索
      .mockResolvedValueOnce([])
      // fulltext検索
      .mockResolvedValueOnce([]);

    const result = await searchSimilarSites({
      url: "https://my-site.com",
      limit: 5,
    });

    expect(result.success).toBe(true);
    // 自サイト（wp-1）が除外されていること
    const hasSelfSite = result.similar_sites.some(
      (s: SimilarSiteResult) => s.url === "https://my-site.com"
    );
    expect(hasSelfSite).toBe(false);
  });

  it("DIファクトリー未設定時にエラーを返す", async () => {
    resetSimilarSitePrismaClientFactory();

    const result = await searchSimilarSites({ url: "https://example.com" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("SERVICE_UNAVAILABLE");
  });

  it("limitパラメータが正しく適用される", async () => {
    (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ id: "wp-1", url: "https://query.com", title: "Query" }])
      .mockResolvedValueOnce([
        {
          text_embedding: `[${createMockEmbedding(1).join(",")}]`,
          vision_embedding: null,
        },
      ])
      .mockResolvedValueOnce(
        Array.from({ length: 10 }, (_, i) => ({
          web_page_id: `wp-${i + 2}`,
          wp_url: `https://site-${i + 2}.com`,
          wp_title: `Site ${i + 2}`,
          similarity: 0.9 - i * 0.05,
          section_types: "hero",
        }))
      )
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await searchSimilarSites({
      url: "https://query.com",
      limit: 3,
    });

    expect(result.success).toBe(true);
    expect(result.similar_sites.length).toBeLessThanOrEqual(3);
  });

  it("include_details=trueで詳細情報が含まれる", async () => {
    (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ id: "wp-1", url: "https://query.com", title: "Query" }])
      .mockResolvedValueOnce([
        {
          text_embedding: `[${createMockEmbedding(1).join(",")}]`,
          vision_embedding: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          web_page_id: "wp-2",
          wp_url: "https://similar.com",
          wp_title: "Similar",
          similarity: 0.9,
          section_types: "hero,feature,cta",
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await searchSimilarSites({
      url: "https://query.com",
      include_details: true,
    });

    expect(result.success).toBe(true);
    if (result.similar_sites.length > 0) {
      expect(result.similar_sites[0]).toHaveProperty("common_patterns");
      expect(result.similar_sites[0]).toHaveProperty("differences");
    }
  });

  it("embeddingが全くないページの場合エラーを返す", async () => {
    (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([
        { id: "wp-1", url: "https://no-embeddings.com", title: "No Embeddings" },
      ])
      // 空のembeddings
      .mockResolvedValueOnce([]);

    const result = await searchSimilarSites({ url: "https://no-embeddings.com" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("NO_EMBEDDINGS");
  });
});

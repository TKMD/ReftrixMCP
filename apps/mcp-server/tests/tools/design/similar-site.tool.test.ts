// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * design.similar_site MCPツールのテスト
 *
 * URL入力から類似デザインをDB内検索するMCPツールのユニットテスト
 *
 * テスト対象:
 * - Zodスキーマバリデーション (7テスト)
 * - ハンドラー統合テスト (6テスト)
 * - ツール定義の検証 (4テスト)
 * - セキュリティ (3テスト)
 *
 * @module tests/tools/design/similar-site.tool.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  designSimilarSiteInputSchema,
  designSimilarSiteHandler,
  designSimilarSiteToolDefinition,
  SIMILAR_SITE_ERROR_CODES,
  type DesignSimilarSiteOutput,
} from "../../../src/tools/design/similar-site.tool";

import {
  setSimilarSitePrismaClientFactory,
  resetSimilarSitePrismaClientFactory,
  setSimilarSiteEmbeddingServiceFactory,
  resetSimilarSiteEmbeddingServiceFactory,
  type SimilarSitePrismaClient,
  type SimilarSiteEmbeddingService,
} from "../../../src/services/similar-site.service";

import { invalidateCache } from "../../../src/services/search-cache.service";

// =====================================================
// テストデータ
// =====================================================

function createMockEmbedding(seed: number): number[] {
  return Array.from({ length: 768 }, (_, i) => Math.sin(i + seed) * 0.01);
}

function createMockPrisma(): SimilarSitePrismaClient {
  return {
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
  };
}

function createMockEmbeddingService(): SimilarSiteEmbeddingService {
  return {
    generateEmbedding: vi.fn().mockResolvedValue(createMockEmbedding(42)),
  };
}

// =====================================================
// Zodスキーマバリデーション
// =====================================================

describe("designSimilarSiteInputSchema", () => {
  it("有効なURL入力を受け付ける", () => {
    const result = designSimilarSiteInputSchema.safeParse({
      url: "https://example.com",
    });
    expect(result.success).toBe(true);
  });

  it("limitパラメータのデフォルトは5", () => {
    const result = designSimilarSiteInputSchema.safeParse({
      url: "https://example.com",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(5);
    }
  });

  it("limitは1-20の範囲", () => {
    const tooLow = designSimilarSiteInputSchema.safeParse({
      url: "https://example.com",
      limit: 0,
    });
    expect(tooLow.success).toBe(false);

    const tooHigh = designSimilarSiteInputSchema.safeParse({
      url: "https://example.com",
      limit: 21,
    });
    expect(tooHigh.success).toBe(false);

    const valid = designSimilarSiteInputSchema.safeParse({
      url: "https://example.com",
      limit: 10,
    });
    expect(valid.success).toBe(true);
  });

  it("include_detailsのデフォルトはfalse", () => {
    const result = designSimilarSiteInputSchema.safeParse({
      url: "https://example.com",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.include_details).toBe(false);
    }
  });

  it("空のURLを拒否する", () => {
    const result = designSimilarSiteInputSchema.safeParse({ url: "" });
    expect(result.success).toBe(false);
  });

  it("URLが必須", () => {
    const result = designSimilarSiteInputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("不正な型を拒否する", () => {
    const result = designSimilarSiteInputSchema.safeParse({ url: 123 });
    expect(result.success).toBe(false);
  });
});

// =====================================================
// ハンドラー統合テスト
// =====================================================

describe("designSimilarSiteHandler", () => {
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

  it("無効な入力でバリデーションエラーを返す", async () => {
    const result = (await designSimilarSiteHandler({})) as DesignSimilarSiteOutput;

    expect(result.success).toBe(false);
    expect(result.error).toContain("INVALID_INPUT");
  });

  it("存在しないURLで404エラーを返す", async () => {
    (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const result = (await designSimilarSiteHandler({
      url: "https://nonexistent.com",
    })) as DesignSimilarSiteOutput;

    expect(result.success).toBe(false);
    expect(result.error).toContain("NOT_FOUND");
  });

  it("正常系: 類似サイトを返す", async () => {
    (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ id: "wp-1", url: "https://query.com", title: "Query" }])
      .mockResolvedValueOnce([
        {
          text_embedding: `[${createMockEmbedding(1).join(",")}]`,
          vision_embedding: `[${createMockEmbedding(2).join(",")}]`,
        },
      ])
      .mockResolvedValueOnce([
        {
          web_page_id: "wp-2",
          wp_url: "https://similar.com",
          wp_title: "Similar",
          similarity: 0.9,
          section_types: "hero,feature",
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = (await designSimilarSiteHandler({
      url: "https://query.com",
    })) as DesignSimilarSiteOutput;

    expect(result.success).toBe(true);
    expect(result.query_url).toBe("https://query.com");
    expect(result.similar_sites.length).toBeGreaterThan(0);
  });

  it("サービス未設定時にSERVICE_UNAVAILABLEを返す", async () => {
    resetSimilarSitePrismaClientFactory();

    const result = (await designSimilarSiteHandler({
      url: "https://example.com",
    })) as DesignSimilarSiteOutput;

    expect(result.success).toBe(false);
    expect(result.error).toContain("SERVICE_UNAVAILABLE");
  });

  it("limit超過の入力をバリデーションで拒否する", async () => {
    const result = (await designSimilarSiteHandler({
      url: "https://example.com",
      limit: 100,
    })) as DesignSimilarSiteOutput;

    expect(result.success).toBe(false);
    expect(result.error).toContain("INVALID_INPUT");
  });

  it("キャッシュが効く: 同一入力の2回目呼び出しはDB検索しない", async () => {
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
          section_types: "hero",
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    // 1回目
    await designSimilarSiteHandler({ url: "https://query.com" });
    const callCountAfterFirst = (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls
      .length;

    // 2回目（キャッシュヒット）
    await designSimilarSiteHandler({ url: "https://query.com" });
    const callCountAfterSecond = (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls
      .length;

    // DB呼び出し回数が増えていないこと
    expect(callCountAfterSecond).toBe(callCountAfterFirst);
  });
});

// =====================================================
// ツール定義の検証
// =====================================================

describe("designSimilarSiteToolDefinition", () => {
  it("ツール名がdesign.similar_siteである", () => {
    expect(designSimilarSiteToolDefinition.name).toBe("design.similar_site");
  });

  it("descriptionが空でない", () => {
    expect(designSimilarSiteToolDefinition.description.length).toBeGreaterThan(0);
  });

  it("inputSchemaがobject型である", () => {
    expect(designSimilarSiteToolDefinition.inputSchema.type).toBe("object");
  });

  it("requiredにurlが含まれる", () => {
    expect(designSimilarSiteToolDefinition.inputSchema.required).toContain("url");
  });
});

// =====================================================
// セキュリティテスト
// =====================================================

describe("セキュリティ", () => {
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

  it("エラーメッセージにDB内部構造が露出しない", async () => {
    (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("relation 'web_pages' does not exist")
    );

    const result = (await designSimilarSiteHandler({
      url: "https://example.com",
    })) as DesignSimilarSiteOutput;

    expect(result.success).toBe(false);
    expect(result.error).not.toContain("relation");
    expect(result.error).not.toContain("web_pages");
  });

  it("SQLインジェクション入力が安全に処理される", async () => {
    (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const result = (await designSimilarSiteHandler({
      url: "https://example.com'; DROP TABLE web_pages; --",
    })) as DesignSimilarSiteOutput;

    // バリデーション通過またはNOT_FOUND（パラメータバインドで安全）
    expect(result.success === false).toBe(true);
  });

  it("超長文字列URLを拒否する", async () => {
    const longUrl = "https://example.com/" + "a".repeat(10000);

    const result = (await designSimilarSiteHandler({
      url: longUrl,
    })) as DesignSimilarSiteOutput;

    expect(result.success).toBe(false);
  });
});

// =====================================================
// エラーコード定義の検証
// =====================================================

describe("SIMILAR_SITE_ERROR_CODES", () => {
  it("必要なエラーコードが定義されている", () => {
    expect(SIMILAR_SITE_ERROR_CODES).toHaveProperty("INVALID_INPUT");
    expect(SIMILAR_SITE_ERROR_CODES).toHaveProperty("NOT_FOUND");
    expect(SIMILAR_SITE_ERROR_CODES).toHaveProperty("NO_EMBEDDINGS");
    expect(SIMILAR_SITE_ERROR_CODES).toHaveProperty("SEARCH_FAILED");
    expect(SIMILAR_SITE_ERROR_CODES).toHaveProperty("SERVICE_UNAVAILABLE");
  });
});

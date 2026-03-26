// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * design.search_by_image MCPツールのテスト
 *
 * 画像入力（Base64/URL）から視覚的に類似したデザインセクションを検索する
 * MCPツールのユニットテスト
 *
 * テスト対象:
 * - Zodスキーマバリデーション (11テスト)
 * - Base64/URL入力判定 (4テスト)
 * - SSRF防止 (6テスト)
 * - Base64デコード (5テスト)
 * - RRF 3-source融合ロジック (7テスト)
 * - NaN/Infinity防御 (3テスト)
 * - Graceful Degradation (4テスト)
 * - Content-Type検証 (3テスト)
 * - DIパターン (4テスト)
 * - ハンドラー統合 (5テスト)
 *
 * @module tests/tools/design/search-by-image.tool.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// =====================================================
// インポート
// =====================================================

import {
  designSearchByImageInputSchema,
  designSearchByImageHandler,
  designSearchByImageToolDefinition,
  setDesignSearchDINOv2ServiceFactory,
  resetDesignSearchDINOv2ServiceFactory,
  setDesignSearchEmbeddingServiceFactory,
  resetDesignSearchEmbeddingServiceFactory,
  setDesignSearchPrismaClientFactory,
  resetDesignSearchPrismaClientFactory,
  DESIGN_SEARCH_ERROR_CODES,
  type IDesignSearchDINOv2Service,
  type IDesignSearchEmbeddingService,
  type IDesignSearchPrismaClient,
  type DesignSearchByImageOutput,
  type DesignSearchResultItem,
} from "../../../src/tools/design/search-by-image.tool";

import { validateExternalUrl } from "../../../src/utils/url-validator";
import { invalidateCache } from "../../../src/services/search-cache.service";

// =====================================================
// テストデータ
// =====================================================

/** 1x1 赤ピクセルのPNG画像（Base64） */
const VALID_BASE64_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

/** data URI形式のBase64 PNG */
const VALID_DATA_URI = `data:image/png;base64,${VALID_BASE64_PNG}`;

/** テスト用768次元のembeddingベクトル */
const MOCK_VISION_EMBEDDING = Array.from({ length: 768 }, (_, i) => Math.sin(i) * 0.01);
const MOCK_TEXT_EMBEDDING = Array.from({ length: 768 }, (_, i) => Math.cos(i) * 0.01);

/** テスト用検索結果レコード */
function createMockSearchRecord(
  id: string,
  similarity: number,
  sectionType = "hero"
): {
  id: string;
  web_page_id: string;
  section_type: string;
  section_name: string | null;
  similarity: number;
  wp_id: string;
  wp_url: string;
  wp_title: string | null;
  wp_source_type: string;
  wp_screenshot_desktop_url: string | null;
} {
  return {
    id,
    web_page_id: `wp-${id}`,
    section_type: sectionType,
    section_name: `Section ${id}`,
    similarity,
    wp_id: `wp-${id}`,
    wp_url: `https://example.com/page-${id}`,
    wp_title: `Page ${id}`,
    wp_source_type: "manual",
    wp_screenshot_desktop_url: null,
  };
}

/** テスト用DesignSearchResultItem */
function createMockResult(
  id: string,
  similarity: number,
  sectionType = "hero"
): DesignSearchResultItem {
  return {
    id,
    webPageId: `wp-${id}`,
    sectionType,
    sectionName: `Section ${id}`,
    similarity,
    webPage: {
      id: `wp-${id}`,
      url: `https://example.com/page-${id}`,
      title: `Page ${id}`,
      sourceType: "manual",
      screenshotDesktopUrl: null,
    },
  };
}

// =====================================================
// モックサービス
// =====================================================

function createMockDINOv2Service(
  overrides: Partial<IDesignSearchDINOv2Service> = {}
): IDesignSearchDINOv2Service {
  return {
    initialized: true,
    initialize: vi.fn().mockResolvedValue(undefined),
    generateEmbedding: vi.fn().mockResolvedValue(MOCK_VISION_EMBEDDING),
    dispose: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createMockEmbeddingService(
  overrides: Partial<IDesignSearchEmbeddingService> = {}
): IDesignSearchEmbeddingService {
  return {
    generateEmbedding: vi.fn().mockResolvedValue(MOCK_TEXT_EMBEDDING),
    ...overrides,
  };
}

function createMockPrismaClient(queryResults: unknown[] = []): IDesignSearchPrismaClient {
  return {
    $queryRawUnsafe: vi.fn().mockResolvedValue(queryResults),
  };
}

// =====================================================
// sharp モック
// =====================================================

vi.mock("sharp", () => {
  const mockSharp = vi.fn().mockReturnValue({
    resize: vi.fn().mockReturnThis(),
    removeAlpha: vi.fn().mockReturnThis(),
    raw: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.alloc(224 * 224 * 3, 128)),
  });
  return { default: mockSharp };
});

// =====================================================
// logger モック
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
// テストスイート
// =====================================================

describe("design.search_by_image", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateCache();
  });

  afterEach(() => {
    resetDesignSearchDINOv2ServiceFactory();
    resetDesignSearchEmbeddingServiceFactory();
    resetDesignSearchPrismaClientFactory();
    vi.restoreAllMocks();
  });

  // =================================================
  // 1. Zodスキーマバリデーション (11テスト)
  // =================================================

  describe("Zodスキーマバリデーション", () => {
    it("should accept valid input with image only", () => {
      const result = designSearchByImageInputSchema.parse({
        image: VALID_BASE64_PNG,
      });
      expect(result.image).toBe(VALID_BASE64_PNG);
      expect(result.limit).toBe(10);
      expect(result.min_similarity).toBe(0.3);
    });

    it("should accept valid input with all fields", () => {
      const result = designSearchByImageInputSchema.parse({
        image: "https://example.com/image.png",
        query: "hero section with gradient",
        limit: 20,
        min_similarity: 0.5,
        section_type: "hero",
      });
      expect(result.query).toBe("hero section with gradient");
      expect(result.limit).toBe(20);
      expect(result.min_similarity).toBe(0.5);
      expect(result.section_type).toBe("hero");
    });

    it("should apply default values for limit and min_similarity", () => {
      const result = designSearchByImageInputSchema.parse({
        image: VALID_BASE64_PNG,
      });
      expect(result.limit).toBe(10);
      expect(result.min_similarity).toBe(0.3);
    });

    it("should reject empty image string", () => {
      expect(() => designSearchByImageInputSchema.parse({ image: "" })).toThrow();
    });

    it("should reject query exceeding 500 characters", () => {
      expect(() =>
        designSearchByImageInputSchema.parse({
          image: VALID_BASE64_PNG,
          query: "a".repeat(501),
        })
      ).toThrow();
    });

    it("should accept query of exactly 500 characters", () => {
      const result = designSearchByImageInputSchema.parse({
        image: VALID_BASE64_PNG,
        query: "a".repeat(500),
      });
      expect(result.query).toHaveLength(500);
    });

    it("should reject limit of 0", () => {
      expect(() =>
        designSearchByImageInputSchema.parse({
          image: VALID_BASE64_PNG,
          limit: 0,
        })
      ).toThrow();
    });

    it("should reject limit exceeding 50", () => {
      expect(() =>
        designSearchByImageInputSchema.parse({
          image: VALID_BASE64_PNG,
          limit: 51,
        })
      ).toThrow();
    });

    it("should reject min_similarity below 0", () => {
      expect(() =>
        designSearchByImageInputSchema.parse({
          image: VALID_BASE64_PNG,
          min_similarity: -0.1,
        })
      ).toThrow();
    });

    it("should reject min_similarity above 1", () => {
      expect(() =>
        designSearchByImageInputSchema.parse({
          image: VALID_BASE64_PNG,
          min_similarity: 1.1,
        })
      ).toThrow();
    });

    it("should accept boundary values for limit (1 and 50)", () => {
      const result1 = designSearchByImageInputSchema.parse({
        image: VALID_BASE64_PNG,
        limit: 1,
      });
      expect(result1.limit).toBe(1);

      const result50 = designSearchByImageInputSchema.parse({
        image: VALID_BASE64_PNG,
        limit: 50,
      });
      expect(result50.limit).toBe(50);
    });
  });

  // =================================================
  // 2. Base64/URL入力判定 (4テスト)
  // =================================================

  describe("isImageUrl判定（ハンドラー経由）", () => {
    // isImageUrl は内部関数のためハンドラー経由でテスト

    it("should treat https URL as image URL", async () => {
      // DINOv2 が未設定→SERVICE_UNAVAILABLEで早期リターンするため
      // URLフェッチまで到達させるにはDINOv2設定が必要
      // ここではSSRF検証を含むURLフェッチパスを通ることを確認
      const mockDinov2 = createMockDINOv2Service();
      const mockPrisma = createMockPrismaClient([]);
      setDesignSearchDINOv2ServiceFactory(() => mockDinov2);
      setDesignSearchPrismaClientFactory(() => mockPrisma);

      // fetchをモックしてURL取得パスを確認
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(Buffer.from(VALID_BASE64_PNG, "base64"), {
          status: 200,
          headers: { "content-type": "image/png" },
        })
      );

      try {
        const result = await designSearchByImageHandler({
          image: "https://example.com/image.png",
        });
        // fetchが呼ばれたことでURL入力パスを通ったことを確認
        expect(globalThis.fetch).toHaveBeenCalled();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should treat data URI as base64 input, not URL", async () => {
      const mockDinov2 = createMockDINOv2Service();
      const mockPrisma = createMockPrismaClient([]);
      setDesignSearchDINOv2ServiceFactory(() => mockDinov2);
      setDesignSearchPrismaClientFactory(() => mockPrisma);

      const result = await designSearchByImageHandler({
        image: VALID_DATA_URI,
      });
      // data:image/...はURLではないためfetchされない
      // DINOv2のgenerateEmbeddingが呼ばれたことでbase64パスを通ったことを確認
      expect(mockDinov2.generateEmbedding).toHaveBeenCalled();
    });

    it("should treat raw base64 string as base64 input", async () => {
      const mockDinov2 = createMockDINOv2Service();
      const mockPrisma = createMockPrismaClient([]);
      setDesignSearchDINOv2ServiceFactory(() => mockDinov2);
      setDesignSearchPrismaClientFactory(() => mockPrisma);

      const result = await designSearchByImageHandler({
        image: VALID_BASE64_PNG,
      });
      expect(result.success).toBe(true);
      expect(mockDinov2.generateEmbedding).toHaveBeenCalled();
    });

    it("should treat http URL as image URL", async () => {
      const mockDinov2 = createMockDINOv2Service();
      const mockPrisma = createMockPrismaClient([]);
      setDesignSearchDINOv2ServiceFactory(() => mockDinov2);
      setDesignSearchPrismaClientFactory(() => mockPrisma);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(Buffer.from(VALID_BASE64_PNG, "base64"), {
          status: 200,
          headers: { "content-type": "image/png" },
        })
      );

      try {
        await designSearchByImageHandler({
          image: "http://example.com/image.png",
        });
        expect(globalThis.fetch).toHaveBeenCalled();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // =================================================
  // 3. SSRF防止 (6テスト)
  // =================================================

  describe("SSRF防止", () => {
    let mockDinov2: IDesignSearchDINOv2Service;
    let mockPrisma: IDesignSearchPrismaClient;

    beforeEach(() => {
      mockDinov2 = createMockDINOv2Service();
      mockPrisma = createMockPrismaClient([]);
      setDesignSearchDINOv2ServiceFactory(() => mockDinov2);
      setDesignSearchPrismaClientFactory(() => mockPrisma);
    });

    it("should block 127.0.0.1 (loopback)", () => {
      const result = validateExternalUrl("https://127.0.0.1/image.png");
      expect(result.valid).toBe(false);
    });

    it("should block 10.x.x.x (class A private)", () => {
      const result = validateExternalUrl("https://10.0.0.1/image.png");
      expect(result.valid).toBe(false);
    });

    it("should block 172.16.x.x (class B private)", () => {
      const result = validateExternalUrl("https://172.16.0.1/image.png");
      expect(result.valid).toBe(false);
    });

    it("should block 192.168.x.x (class C private)", () => {
      const result = validateExternalUrl("https://192.168.1.1/image.png");
      expect(result.valid).toBe(false);
    });

    it("should block 169.254.169.254 (metadata service)", () => {
      const result = validateExternalUrl("http://169.254.169.254/latest/meta-data/");
      expect(result.valid).toBe(false);
    });

    it("should block localhost", () => {
      const result = validateExternalUrl("https://localhost/image.png");
      expect(result.valid).toBe(false);
    });
  });

  // =================================================
  // 4. Base64デコード (5テスト)
  // =================================================

  describe("Base64デコード", () => {
    let mockDinov2: IDesignSearchDINOv2Service;
    let mockPrisma: IDesignSearchPrismaClient;

    beforeEach(() => {
      mockDinov2 = createMockDINOv2Service();
      mockPrisma = createMockPrismaClient([]);
      setDesignSearchDINOv2ServiceFactory(() => mockDinov2);
      setDesignSearchPrismaClientFactory(() => mockPrisma);
    });

    it("should correctly decode data URI format", async () => {
      const result = await designSearchByImageHandler({
        image: VALID_DATA_URI,
      });
      expect(result.success).toBe(true);
      expect(mockDinov2.generateEmbedding).toHaveBeenCalled();
    });

    it("should correctly decode raw base64 string", async () => {
      const result = await designSearchByImageHandler({
        image: VALID_BASE64_PNG,
      });
      expect(result.success).toBe(true);
      expect(mockDinov2.generateEmbedding).toHaveBeenCalled();
    });

    it("should reject data URI without comma separator", async () => {
      const result = await designSearchByImageHandler({
        image: "data:image/pngbase64nocomma",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain(DESIGN_SEARCH_ERROR_CODES.IMAGE_DECODE_FAILED);
    });

    it("should reject image exceeding 10MB", async () => {
      // 10MB超のbase64文字列を生成（14MBのbase64 ≒ ~10.5MBバイナリ）
      const largeBase64 = Buffer.alloc(11 * 1024 * 1024).toString("base64");
      const result = await designSearchByImageHandler({
        image: largeBase64,
      });
      expect(result.success).toBe(false);
      // sanitizeErrorMessageがメッセージをサニタイズするため、エラーコードで検証
      expect(result.error).toContain(DESIGN_SEARCH_ERROR_CODES.IMAGE_DECODE_FAILED);
    });

    it("should reject empty decoded buffer", async () => {
      // 空のbase64（デコード後0バイト）
      const result = await designSearchByImageHandler({
        image: "data:image/png;base64,",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain(DESIGN_SEARCH_ERROR_CODES.IMAGE_DECODE_FAILED);
    });
  });

  // =================================================
  // 5. RRF 3-source融合ロジック (7テスト)
  // =================================================

  describe("RRF 3-source融合ロジック", () => {
    // mergeWithRRF3Source は内部関数のため、ハンドラー経由で
    // ハイブリッド検索パスをテストする

    let mockDinov2: IDesignSearchDINOv2Service;
    let mockPrisma: IDesignSearchPrismaClient;
    let mockEmbedding: IDesignSearchEmbeddingService;

    beforeEach(() => {
      mockDinov2 = createMockDINOv2Service();
      mockEmbedding = createMockEmbeddingService();
      setDesignSearchDINOv2ServiceFactory(() => mockDinov2);
      setDesignSearchEmbeddingServiceFactory(() => mockEmbedding);
    });

    it("should use hybrid_rrf mode when query is provided", async () => {
      const records = [
        createMockSearchRecord("sec-1", 0.95),
        createMockSearchRecord("sec-2", 0.85),
      ];
      mockPrisma = createMockPrismaClient(records);
      setDesignSearchPrismaClientFactory(() => mockPrisma);

      const result = await designSearchByImageHandler({
        image: VALID_BASE64_PNG,
        query: "hero section",
      });

      expect(result.success).toBe(true);
      expect(result.searchMode).toBe("hybrid_rrf");
    });

    it("should use vision_only mode when query is not provided", async () => {
      const records = [createMockSearchRecord("sec-1", 0.95)];
      mockPrisma = createMockPrismaClient(records);
      setDesignSearchPrismaClientFactory(() => mockPrisma);

      const result = await designSearchByImageHandler({
        image: VALID_BASE64_PNG,
      });

      expect(result.success).toBe(true);
      expect(result.searchMode).toBe("vision_only");
    });

    it("should merge results from all 3 sources in hybrid mode", async () => {
      // 3つのクエリに対して異なる結果を返す
      const queryRawMock = vi
        .fn()
        .mockResolvedValueOnce([createMockSearchRecord("sec-text-1", 0.9, "hero")]) // text search
        .mockResolvedValueOnce([createMockSearchRecord("sec-vision-1", 0.85, "feature")]) // vision search
        .mockResolvedValueOnce([createMockSearchRecord("sec-ft-1", 0.8, "cta")]); // fulltext search

      mockPrisma = { $queryRawUnsafe: queryRawMock };
      setDesignSearchPrismaClientFactory(() => mockPrisma);

      const result = await designSearchByImageHandler({
        image: VALID_BASE64_PNG,
        query: "hero section",
        min_similarity: 0, // RRFスコアは小さいため0に設定
      });

      expect(result.success).toBe(true);
      expect(result.searchMode).toBe("hybrid_rrf");
      // 3つのソースからの結果がマージされている
      expect(result.total).toBeGreaterThan(0);
      // 3つの独立した$queryRawUnsafe呼び出しが行われた
      expect(queryRawMock).toHaveBeenCalledTimes(3);
    });

    it("should return empty results when all sources return empty", async () => {
      mockPrisma = createMockPrismaClient([]);
      setDesignSearchPrismaClientFactory(() => mockPrisma);

      const result = await designSearchByImageHandler({
        image: VALID_BASE64_PNG,
        query: "nonexistent design",
      });

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it("should handle single source returning results in hybrid mode", async () => {
      const queryRawMock = vi
        .fn()
        .mockResolvedValueOnce([createMockSearchRecord("sec-1", 0.9)]) // text has results
        .mockResolvedValueOnce([]) // vision empty
        .mockResolvedValueOnce([]); // fulltext empty

      mockPrisma = { $queryRawUnsafe: queryRawMock };
      setDesignSearchPrismaClientFactory(() => mockPrisma);

      const result = await designSearchByImageHandler({
        image: VALID_BASE64_PNG,
        query: "test query",
        min_similarity: 0, // RRFスコアは小さいため0に設定
      });

      expect(result.success).toBe(true);
      expect(result.total).toBeGreaterThan(0);
    });

    it("should respect limit parameter in hybrid mode", async () => {
      const manyRecords = Array.from({ length: 20 }, (_, i) =>
        createMockSearchRecord(`sec-${i}`, 0.9 - i * 0.01)
      );
      mockPrisma = createMockPrismaClient(manyRecords);
      setDesignSearchPrismaClientFactory(() => mockPrisma);

      const result = await designSearchByImageHandler({
        image: VALID_BASE64_PNG,
        query: "test",
        limit: 5,
      });

      expect(result.success).toBe(true);
      expect(result.results.length).toBeLessThanOrEqual(5);
    });

    it("should filter by min_similarity in hybrid mode", async () => {
      // RRFスコアは rank/(RRF_K + rank) * weight で計算される
      // rank=1, weight=0.4: 1/(60+1) * 0.4 ≈ 0.00656
      // 高いmin_similarityを設定するとRRFスコアでフィルタされる
      mockPrisma = createMockPrismaClient([createMockSearchRecord("sec-1", 0.9)]);
      setDesignSearchPrismaClientFactory(() => mockPrisma);

      const result = await designSearchByImageHandler({
        image: VALID_BASE64_PNG,
        query: "test",
        min_similarity: 0.5, // RRFスコアはこれより低い
      });

      expect(result.success).toBe(true);
      // RRFスコアは通常0.01未満なので高閾値でフィルタされる
      expect(result.results).toHaveLength(0);
    });
  });

  // =================================================
  // 6. NaN/Infinity防御 (3テスト)
  // =================================================

  describe("NaN/Infinity防御", () => {
    let mockPrisma: IDesignSearchPrismaClient;

    beforeEach(() => {
      mockPrisma = createMockPrismaClient([]);
      setDesignSearchPrismaClientFactory(() => mockPrisma);
    });

    it("should return error when embedding contains NaN", async () => {
      const nanEmbedding = [...MOCK_VISION_EMBEDDING];
      nanEmbedding[0] = NaN;

      const mockDinov2 = createMockDINOv2Service({
        generateEmbedding: vi.fn().mockResolvedValue(nanEmbedding),
      });
      setDesignSearchDINOv2ServiceFactory(() => mockDinov2);

      const result = await designSearchByImageHandler({
        image: VALID_BASE64_PNG,
      });

      expect(result.success).toBe(false);
      // sanitizeErrorMessageがエラーメッセージをサニタイズするため、
      // エラーコードのみ検証（内部メッセージ "NaN or Infinity" はサニタイズされる）
      expect(result.error).toContain(DESIGN_SEARCH_ERROR_CODES.EMBEDDING_FAILED);
    });

    it("should return error when embedding contains Infinity", async () => {
      const infEmbedding = [...MOCK_VISION_EMBEDDING];
      infEmbedding[5] = Infinity;

      const mockDinov2 = createMockDINOv2Service({
        generateEmbedding: vi.fn().mockResolvedValue(infEmbedding),
      });
      setDesignSearchDINOv2ServiceFactory(() => mockDinov2);

      const result = await designSearchByImageHandler({
        image: VALID_BASE64_PNG,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain(DESIGN_SEARCH_ERROR_CODES.EMBEDDING_FAILED);
    });

    it("should return error when embedding contains -Infinity", async () => {
      const negInfEmbedding = [...MOCK_VISION_EMBEDDING];
      negInfEmbedding[10] = -Infinity;

      const mockDinov2 = createMockDINOv2Service({
        generateEmbedding: vi.fn().mockResolvedValue(negInfEmbedding),
      });
      setDesignSearchDINOv2ServiceFactory(() => mockDinov2);

      const result = await designSearchByImageHandler({
        image: VALID_BASE64_PNG,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain(DESIGN_SEARCH_ERROR_CODES.EMBEDDING_FAILED);
    });
  });

  // =================================================
  // 7. Graceful Degradation (4テスト)
  // =================================================

  describe("Graceful Degradation", () => {
    it("should return SERVICE_UNAVAILABLE when DINOv2 factory is not set", async () => {
      // DINOv2ファクトリーを設定しない
      setDesignSearchPrismaClientFactory(() => createMockPrismaClient([]));

      const result = await designSearchByImageHandler({
        image: VALID_BASE64_PNG,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain(DESIGN_SEARCH_ERROR_CODES.SERVICE_UNAVAILABLE);
      expect(result.error).toContain("DINOv2");
    });

    it("should return SERVICE_UNAVAILABLE when Prisma factory is not set", async () => {
      setDesignSearchDINOv2ServiceFactory(() => createMockDINOv2Service());
      // Prismaファクトリーを設定しない

      const result = await designSearchByImageHandler({
        image: VALID_BASE64_PNG,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain(DESIGN_SEARCH_ERROR_CODES.SERVICE_UNAVAILABLE);
      expect(result.error).toContain("Database");
    });

    it("should fallback to vision-only when EmbeddingService is not available", async () => {
      const mockDinov2 = createMockDINOv2Service();
      const records = [createMockSearchRecord("sec-1", 0.9)];
      const mockPrisma = createMockPrismaClient(records);

      setDesignSearchDINOv2ServiceFactory(() => mockDinov2);
      setDesignSearchPrismaClientFactory(() => mockPrisma);
      // EmbeddingServiceファクトリーを設定しない → vision-onlyフォールバック

      const result = await designSearchByImageHandler({
        image: VALID_BASE64_PNG,
        query: "hero section", // queryあり → 本来はhybrid RRF
      });

      expect(result.success).toBe(true);
      expect(result.searchMode).toBe("vision_only");
    });

    it("should fallback to vision-only when text embedding generation returns null", async () => {
      const mockDinov2 = createMockDINOv2Service();
      const mockEmbedding = createMockEmbeddingService({
        generateEmbedding: vi.fn().mockResolvedValue(null),
      });
      const records = [createMockSearchRecord("sec-1", 0.9)];
      const mockPrisma = createMockPrismaClient(records);

      setDesignSearchDINOv2ServiceFactory(() => mockDinov2);
      setDesignSearchEmbeddingServiceFactory(() => mockEmbedding);
      setDesignSearchPrismaClientFactory(() => mockPrisma);

      const result = await designSearchByImageHandler({
        image: VALID_BASE64_PNG,
        query: "hero section",
      });

      expect(result.success).toBe(true);
      expect(result.searchMode).toBe("vision_only");
    });
  });

  // =================================================
  // 8. Content-Type検証 (3テスト)
  // =================================================

  describe("Content-Type検証", () => {
    let mockDinov2: IDesignSearchDINOv2Service;
    let mockPrisma: IDesignSearchPrismaClient;

    beforeEach(() => {
      mockDinov2 = createMockDINOv2Service();
      mockPrisma = createMockPrismaClient([]);
      setDesignSearchDINOv2ServiceFactory(() => mockDinov2);
      setDesignSearchPrismaClientFactory(() => mockPrisma);
    });

    it("should reject non-image content-type (text/html)", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response("<html></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })
      );

      try {
        const result = await designSearchByImageHandler({
          image: "https://example.com/page.html",
        });
        expect(result.success).toBe(false);
        // sanitizeErrorMessageがメッセージをサニタイズするため、エラーコードで検証
        expect(result.error).toContain(DESIGN_SEARCH_ERROR_CODES.IMAGE_FETCH_FAILED);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should reject application/json content-type", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response('{"key":"value"}', {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );

      try {
        const result = await designSearchByImageHandler({
          image: "https://example.com/data.json",
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain(DESIGN_SEARCH_ERROR_CODES.IMAGE_FETCH_FAILED);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should accept image/jpeg content-type", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(Buffer.from(VALID_BASE64_PNG, "base64"), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        })
      );

      try {
        const result = await designSearchByImageHandler({
          image: "https://example.com/photo.jpg",
        });
        // Content-Type検証をパスしてembedding生成まで到達
        expect(mockDinov2.generateEmbedding).toHaveBeenCalled();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // =================================================
  // 9. DIパターン (4テスト)
  // =================================================

  describe("DIパターン", () => {
    it("should allow setting and resetting DINOv2 factory", () => {
      const mockDinov2 = createMockDINOv2Service();
      setDesignSearchDINOv2ServiceFactory(() => mockDinov2);
      // ファクトリーがセットされた状態でハンドラーを実行すると
      // SERVICE_UNAVAILABLEにならない（Prismaも必要だが別テストで確認）
      resetDesignSearchDINOv2ServiceFactory();
      // リセット後はSERVICE_UNAVAILABLEになるはず
    });

    it("should allow setting and resetting EmbeddingService factory", () => {
      const mockEmbedding = createMockEmbeddingService();
      setDesignSearchEmbeddingServiceFactory(() => mockEmbedding);
      resetDesignSearchEmbeddingServiceFactory();
      // リセット後はhybridモードがvision-onlyにフォールバックする
    });

    it("should allow setting and resetting Prisma factory", () => {
      const mockPrisma = createMockPrismaClient([]);
      setDesignSearchPrismaClientFactory(() => mockPrisma);
      resetDesignSearchPrismaClientFactory();
    });

    it("should initialize DINOv2 when not initialized", async () => {
      const mockDinov2 = createMockDINOv2Service({
        initialized: false,
      });
      const mockPrisma = createMockPrismaClient([]);

      setDesignSearchDINOv2ServiceFactory(() => mockDinov2);
      setDesignSearchPrismaClientFactory(() => mockPrisma);

      await designSearchByImageHandler({
        image: VALID_BASE64_PNG,
      });

      expect(mockDinov2.initialize).toHaveBeenCalled();
    });
  });

  // =================================================
  // 10. ハンドラー統合テスト (5テスト)
  // =================================================

  describe("ハンドラー統合テスト", () => {
    it("should return INVALID_INPUT for malformed input", async () => {
      const result = await designSearchByImageHandler({
        // imageフィールドなし
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain(DESIGN_SEARCH_ERROR_CODES.INVALID_INPUT);
    });

    it("should return embeddingTimeMs on success", async () => {
      const mockDinov2 = createMockDINOv2Service();
      const mockPrisma = createMockPrismaClient([createMockSearchRecord("sec-1", 0.9)]);

      setDesignSearchDINOv2ServiceFactory(() => mockDinov2);
      setDesignSearchPrismaClientFactory(() => mockPrisma);

      const result = await designSearchByImageHandler({
        image: VALID_BASE64_PNG,
      });

      expect(result.success).toBe(true);
      expect(result.embeddingTimeMs).toBeDefined();
      expect(typeof result.embeddingTimeMs).toBe("number");
      expect(result.embeddingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it("should return correct result structure", async () => {
      const mockDinov2 = createMockDINOv2Service();
      const records = [createMockSearchRecord("sec-1", 0.9, "hero")];
      const mockPrisma = createMockPrismaClient(records);

      setDesignSearchDINOv2ServiceFactory(() => mockDinov2);
      setDesignSearchPrismaClientFactory(() => mockPrisma);

      const result = await designSearchByImageHandler({
        image: VALID_BASE64_PNG,
        min_similarity: 0,
      });

      expect(result.success).toBe(true);
      expect(result.results).toBeInstanceOf(Array);
      expect(result.total).toBe(result.results.length);

      if (result.results.length > 0) {
        const item = result.results[0]!;
        expect(item).toHaveProperty("id");
        expect(item).toHaveProperty("webPageId");
        expect(item).toHaveProperty("sectionType");
        expect(item).toHaveProperty("similarity");
        expect(item.webPage).toHaveProperty("id");
        expect(item.webPage).toHaveProperty("url");
        expect(item.webPage).toHaveProperty("sourceType");
      }
    });

    it("should filter results by section_type", async () => {
      const mockDinov2 = createMockDINOv2Service();
      const records = [createMockSearchRecord("sec-1", 0.9, "hero")];
      const mockPrisma = createMockPrismaClient(records);

      setDesignSearchDINOv2ServiceFactory(() => mockDinov2);
      setDesignSearchPrismaClientFactory(() => mockPrisma);

      const result = await designSearchByImageHandler({
        image: VALID_BASE64_PNG,
        section_type: "hero",
      });

      // section_typeパラメータがSQLクエリに含まれることを確認
      const queryCall = (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(queryCall).toBeDefined();
      const queryStr = queryCall[0] as string;
      expect(queryStr).toContain("section_type");
      // section_typeの値がパラメータとして渡されている
      expect(queryCall).toContain("hero");
    });

    it("should handle DINOv2 generateEmbedding failure", async () => {
      const mockDinov2 = createMockDINOv2Service({
        generateEmbedding: vi.fn().mockRejectedValue(new Error("CUDA OOM")),
      });
      const mockPrisma = createMockPrismaClient([]);

      setDesignSearchDINOv2ServiceFactory(() => mockDinov2);
      setDesignSearchPrismaClientFactory(() => mockPrisma);

      const result = await designSearchByImageHandler({
        image: VALID_BASE64_PNG,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain(DESIGN_SEARCH_ERROR_CODES.EMBEDDING_FAILED);
    });
  });

  // =================================================
  // ツール定義テスト (2テスト)
  // =================================================

  describe("ツール定義", () => {
    it("should have correct tool name", () => {
      expect(designSearchByImageToolDefinition.name).toBe("design.search_by_image");
    });

    it("should have required fields in inputSchema", () => {
      expect(designSearchByImageToolDefinition.inputSchema.required).toContain("image");
      expect(designSearchByImageToolDefinition.inputSchema.properties).toHaveProperty("image");
      expect(designSearchByImageToolDefinition.inputSchema.properties).toHaveProperty("query");
      expect(designSearchByImageToolDefinition.inputSchema.properties).toHaveProperty("limit");
      expect(designSearchByImageToolDefinition.inputSchema.properties).toHaveProperty(
        "min_similarity"
      );
      expect(designSearchByImageToolDefinition.inputSchema.properties).toHaveProperty(
        "section_type"
      );
    });
  });
});

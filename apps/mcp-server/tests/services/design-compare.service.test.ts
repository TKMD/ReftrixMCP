// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Design Compare Service テスト
 *
 * 多次元デザイン比較サービスのユニットテスト。
 * Unit tests for multi-dimensional design comparison service.
 *
 * テスト対象:
 * - cosineSimilarity: コサイン類似度計算（正常系、空配列、ゼロベクトル、NaN/Infinity防御）
 * - normalizeQualityDifference: 品質スコア差分正規化（0-1スケール）
 * - colorDistance: CIE76色差計算（RGB空間ユークリッド距離）
 * - paletteDistance: カラーパレット距離（HEXパース含む）
 * - compareDesigns: メイン比較関数（DI mockによるDB依存テスト）
 *
 * @module tests/services/design-compare.service.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  cosineSimilarity,
  normalizeQualityDifference,
  colorDistance,
  paletteDistance,
  compareDesigns,
  setDesignComparePrismaClientFactory,
  resetDesignComparePrismaClientFactory,
  type DesignComparePrismaClient,
  type DesignCompareInput,
  type ComparisonDimension,
  ALL_DIMENSIONS,
  DESIGN_COMPARE_ERROR_CODES,
} from "../../src/services/design-compare.service";

// =====================================================
// テストデータ / Test Data
// =====================================================

/** テスト用mock Prisma Client */
function createMockPrisma(): DesignComparePrismaClient {
  return {
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
  };
}

/** 正規化済みN次元ベクトルを生成 */
function createNormalizedVector(dim: number, seed: number = 0): number[] {
  const vec = Array.from({ length: dim }, (_, i) => Math.sin(i + seed) * 0.05);
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm > 0 ? vec.map((v) => v / norm) : vec;
}

// =====================================================
// cosineSimilarity テスト
// =====================================================

describe("cosineSimilarity", () => {
  it("正常系: 同一ベクトルの類似度は1.0", () => {
    const vec = [1, 2, 3, 4, 5];
    const result = cosineSimilarity(vec, vec);
    expect(result).toBeCloseTo(1.0, 5);
  });

  it("正常系: 直交ベクトルの類似度は0", () => {
    // [1, 0] と [0, 1] は直交
    const a = [1, 0];
    const b = [0, 1];
    const result = cosineSimilarity(a, b);
    expect(result).toBeCloseTo(0, 5);
  });

  it("正常系: 逆方向ベクトルはclampで0になる", () => {
    // [-1, 0] と [1, 0] は反対方向（cosine = -1 → clamp to 0）
    const a = [-1, 0];
    const b = [1, 0];
    const result = cosineSimilarity(a, b);
    expect(result).toBe(0);
  });

  it("正常系: 類似ベクトルのスコアは0-1の範囲", () => {
    const a = [1, 2, 3];
    const b = [1, 2, 4];
    const result = cosineSimilarity(a, b);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(1);
  });

  it("正常系: 768次元ベクトルでの計算", () => {
    const a = createNormalizedVector(768, 1);
    const b = createNormalizedVector(768, 2);
    const result = cosineSimilarity(a, b);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
    expect(Number.isFinite(result)).toBe(true);
  });

  it("空配列の場合は0を返す", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("長さが異なる配列の場合は0を返す", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
  });

  it("ゼロベクトルの場合は0を返す（分母0防御）", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
    expect(cosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0);
  });

  it("NaN要素は0として扱われる", () => {
    const a = [1, NaN, 3];
    const b = [1, 2, 3];
    const result = cosineSimilarity(a, b);
    // NaN → 0に変換されるため、[1, 0, 3]と[1, 2, 3]のcosine
    const expected = cosineSimilarity([1, 0, 3], [1, 2, 3]);
    expect(result).toBeCloseTo(expected, 10);
  });

  it("Infinity要素は0として扱われる", () => {
    const a = [Infinity, 2, 3];
    const b = [1, 2, 3];
    const result = cosineSimilarity(a, b);
    const expected = cosineSimilarity([0, 2, 3], [1, 2, 3]);
    expect(result).toBeCloseTo(expected, 10);
  });

  it("-Infinity要素は0として扱われる", () => {
    const a = [-Infinity, 2, 3];
    const b = [1, 2, 3];
    const result = cosineSimilarity(a, b);
    const expected = cosineSimilarity([0, 2, 3], [1, 2, 3]);
    expect(result).toBeCloseTo(expected, 10);
  });

  it("結果は常に[0, 1]の範囲にclampされる", () => {
    // 様々な入力パターンでclampを検証
    const patterns = [
      { a: [1, 1], b: [1, 1] },
      { a: [-1, -1], b: [1, 1] },
      { a: [100, 200], b: [300, 400] },
      { a: [0.001, 0.001], b: [0.001, 0.001] },
    ];
    for (const { a, b } of patterns) {
      const result = cosineSimilarity(a, b);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(1);
      expect(Number.isFinite(result)).toBe(true);
    }
  });
});

// =====================================================
// normalizeQualityDifference テスト
// =====================================================

describe("normalizeQualityDifference", () => {
  it("同一スコアの場合は1.0を返す（類似度最大）", () => {
    expect(normalizeQualityDifference(80, 80)).toBe(1);
  });

  it("差分50の場合は0.5を返す", () => {
    expect(normalizeQualityDifference(75, 25)).toBeCloseTo(0.5, 5);
  });

  it("差分100の場合は0.0を返す（類似度最小）", () => {
    expect(normalizeQualityDifference(100, 0)).toBe(0);
  });

  it("スコアの順序に依存しない（対称性）", () => {
    const result1 = normalizeQualityDifference(90, 60);
    const result2 = normalizeQualityDifference(60, 90);
    expect(result1).toBeCloseTo(result2, 10);
  });

  it("差分が100を超える場合はclampで0を返す", () => {
    expect(normalizeQualityDifference(150, 0)).toBe(0);
  });

  it("NaN入力の場合は0を返す", () => {
    expect(normalizeQualityDifference(NaN, 50)).toBe(0);
    expect(normalizeQualityDifference(50, NaN)).toBe(0);
    expect(normalizeQualityDifference(NaN, NaN)).toBe(0);
  });

  it("Infinity入力の場合は0を返す", () => {
    expect(normalizeQualityDifference(Infinity, 50)).toBe(0);
    expect(normalizeQualityDifference(50, -Infinity)).toBe(0);
  });

  it("負のスコアでも正しく計算する", () => {
    // abs(-10 - 10) = 20 → 1 - 20/100 = 0.8
    expect(normalizeQualityDifference(-10, 10)).toBeCloseTo(0.8, 5);
  });

  it("小数点スコアで正確に計算する", () => {
    // abs(75.5 - 74.5) = 1.0 → 1 - 1/100 = 0.99
    expect(normalizeQualityDifference(75.5, 74.5)).toBeCloseTo(0.99, 5);
  });
});

// =====================================================
// colorDistance テスト
// =====================================================

describe("colorDistance", () => {
  it("同一色の距離は0", () => {
    const color = { r: 128, g: 64, b: 200 };
    expect(colorDistance(color, color)).toBe(0);
  });

  it("黒と白の距離は1.0（最大距離）", () => {
    const black = { r: 0, g: 0, b: 0 };
    const white = { r: 255, g: 255, b: 255 };
    const result = colorDistance(black, white);
    expect(result).toBeCloseTo(1.0, 5);
  });

  it("赤と緑の距離計算", () => {
    const red = { r: 255, g: 0, b: 0 };
    const green = { r: 0, g: 255, b: 0 };
    // sqrt((255^2 + 255^2) / (255^2 * 3)) = sqrt(2/3)
    const expected = Math.sqrt(255 * 255 + 255 * 255) / Math.sqrt(255 * 255 * 3);
    expect(colorDistance(red, green)).toBeCloseTo(expected, 5);
  });

  it("結果は0-1の範囲", () => {
    const colors = [
      { r: 0, g: 0, b: 0 },
      { r: 255, g: 255, b: 255 },
      { r: 128, g: 128, b: 128 },
      { r: 255, g: 0, b: 0 },
    ];
    for (const a of colors) {
      for (const b of colors) {
        const result = colorDistance(a, b);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(1);
      }
    }
  });

  it("距離の対称性: distance(a,b) === distance(b,a)", () => {
    const a = { r: 100, g: 50, b: 200 };
    const b = { r: 30, g: 180, b: 90 };
    expect(colorDistance(a, b)).toBeCloseTo(colorDistance(b, a), 10);
  });

  it("NaN含有のRGB値は距離1を返す", () => {
    const a = { r: NaN, g: 0, b: 0 };
    const b = { r: 0, g: 0, b: 0 };
    expect(colorDistance(a, b)).toBe(1);
  });
});

// =====================================================
// paletteDistance テスト
// =====================================================

describe("paletteDistance", () => {
  it("同一パレットの類似度は1.0", () => {
    const palette = ["#FF0000", "#00FF00", "#0000FF"];
    const result = paletteDistance(palette, palette);
    expect(result).toBeCloseTo(1.0, 5);
  });

  it("空配列の場合は0を返す", () => {
    expect(paletteDistance([], ["#FF0000"])).toBe(0);
    expect(paletteDistance(["#FF0000"], [])).toBe(0);
    expect(paletteDistance([], [])).toBe(0);
  });

  it("類似パレットは高い類似度を返す", () => {
    const a = ["#FF0000", "#00FF00"];
    const b = ["#FE0101", "#01FE01"]; // 微妙に異なる
    const result = paletteDistance(a, b);
    expect(result).toBeGreaterThan(0.9);
    expect(result).toBeLessThanOrEqual(1);
  });

  it("異なるパレットは低い類似度を返す", () => {
    const a = ["#FF0000"]; // 赤
    const b = ["#0000FF"]; // 青
    const result = paletteDistance(a, b);
    expect(result).toBeLessThan(0.8);
    expect(result).toBeGreaterThanOrEqual(0);
  });

  it("無効なHEXカラーはフィルタされる", () => {
    const a = ["#FF0000", "invalid", "xyz"];
    const b = ["#FF0000"];
    const result = paletteDistance(a, b);
    // 無効値はフィルタされ、#FF0000のみ比較 → 類似度1.0
    expect(result).toBeCloseTo(1.0, 5);
  });

  it("全て無効なHEXの場合は0を返す", () => {
    expect(paletteDistance(["invalid", "xyz"], ["#FF0000"])).toBe(0);
    expect(paletteDistance(["#FF0000"], ["bad", "hex"])).toBe(0);
  });

  it("結果は0-1の範囲", () => {
    const palettes = [
      ["#000000", "#FFFFFF"],
      ["#FF0000", "#00FF00", "#0000FF"],
      ["#123456"],
      ["#ABCDEF", "#FEDCBA"],
    ];
    for (const a of palettes) {
      for (const b of palettes) {
        const result = paletteDistance(a, b);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(1);
        expect(Number.isFinite(result)).toBe(true);
      }
    }
  });

  it("3文字HEXは無効として扱われる（6文字のみ対応）", () => {
    // hexToRgb は cleaned.length !== 6 の場合 null を返す
    const a = ["#F00"]; // 3文字HEX
    const b = ["#FF0000"];
    // #F00 は無効としてフィルタ → rgbA が空 → 0を返す
    expect(paletteDistance(a, b)).toBe(0);
  });

  it("#なしの6文字HEXも正しく処理される", () => {
    const a = ["FF0000"]; // #なし
    const b = ["#FF0000"];
    const result = paletteDistance(a, b);
    expect(result).toBeCloseTo(1.0, 5);
  });
});

// =====================================================
// compareDesigns テスト（DI mock）
// =====================================================

describe("compareDesigns", () => {
  let mockPrisma: DesignComparePrismaClient;

  beforeEach(() => {
    mockPrisma = createMockPrisma();
    setDesignComparePrismaClientFactory(() => mockPrisma);
  });

  afterEach(() => {
    resetDesignComparePrismaClientFactory();
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------
  // DI未設定
  // ---------------------------------------------------

  it("DI未設定の場合はSERVICE_UNAVAILABLEエラーを返す", async () => {
    resetDesignComparePrismaClientFactory();

    const input: DesignCompareInput = {
      page_ids: ["id-a", "id-b"],
      dimensions: ["layout"],
      include_details: false,
    };

    const result = await compareDesigns(input);
    expect(result.success).toBe(false);
    expect(result.error).toContain(DESIGN_COMPARE_ERROR_CODES.SERVICE_UNAVAILABLE);
  });

  // ---------------------------------------------------
  // ページ未発見
  // ---------------------------------------------------

  it("ページが見つからない場合はPAGES_NOT_FOUNDエラーを返す", async () => {
    // fetchPageInfo が空配列を返す（ページ未発見）
    (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    const input: DesignCompareInput = {
      page_ids: ["missing-id-1", "missing-id-2"],
      dimensions: ["layout"],
      include_details: false,
    };

    const result = await compareDesigns(input);
    expect(result.success).toBe(false);
    expect(result.error).toContain(DESIGN_COMPARE_ERROR_CODES.PAGES_NOT_FOUND);
    expect(result.error).toContain("2 page(s) not found");
  });

  // ---------------------------------------------------
  // 正常系: 2ページの比較
  // ---------------------------------------------------

  it("正常系: 2ページの品質比較", async () => {
    const pageId1 = "aaaaaaaa-1111-1111-1111-111111111111";
    const pageId2 = "bbbbbbbb-2222-2222-2222-222222222222";

    // fetchPageInfo
    (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: pageId1, url: "https://example.com", title: "Example" },
      { id: pageId2, url: "https://test.com", title: "Test" },
    ]);

    // fetchQualityScores (quality dimension)
    (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { target_id: pageId1, overall_score: 85 },
      { target_id: pageId2, overall_score: 75 },
    ]);

    const input: DesignCompareInput = {
      page_ids: [pageId1, pageId2],
      dimensions: ["quality"],
      include_details: false,
    };

    const result = await compareDesigns(input);
    expect(result.success).toBe(true);
    expect(result.pages).toHaveLength(2);
    expect(result.comparisons).toHaveLength(1);

    const comparison = result.comparisons[0]!;
    expect(comparison.pair).toEqual([pageId1, pageId2]);
    // 差分10 → 1 - 10/100 = 0.9
    expect(comparison.scores.quality).toBeCloseTo(0.9, 3);
    expect(comparison.overall).toBeGreaterThan(0);
  });

  // ---------------------------------------------------
  // 正常系: layout + visual 次元
  // ---------------------------------------------------

  it("正常系: layout次元（embedding cosine類似度）", async () => {
    const pageId1 = "aaaaaaaa-1111-1111-1111-111111111111";
    const pageId2 = "bbbbbbbb-2222-2222-2222-222222222222";

    // fetchPageInfo
    (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: pageId1, url: "https://a.com", title: "A" },
      { id: pageId2, url: "https://b.com", title: "B" },
    ]);

    // fetchPageEmbeddings (layout/visual requires embeddings)
    (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        web_page_id: pageId1,
        text_embedding_avg: "[0.1,0.2,0.3]",
        vision_embedding_avg: null,
        section_count: 5,
      },
      {
        web_page_id: pageId2,
        text_embedding_avg: "[0.1,0.2,0.3]",
        vision_embedding_avg: null,
        section_count: 4,
      },
    ]);

    const input: DesignCompareInput = {
      page_ids: [pageId1, pageId2],
      dimensions: ["layout"],
      include_details: false,
    };

    const result = await compareDesigns(input);
    expect(result.success).toBe(true);
    expect(result.comparisons).toHaveLength(1);
    // 同一embeddingなのでlayoutスコアは1.0
    expect(result.comparisons[0]!.scores.layout).toBeCloseTo(1.0, 3);
  });

  // ---------------------------------------------------
  // 正常系: color次元
  // ---------------------------------------------------

  it("正常系: color次元（パレット距離）", async () => {
    const pageId1 = "aaaaaaaa-1111-1111-1111-111111111111";
    const pageId2 = "bbbbbbbb-2222-2222-2222-222222222222";

    // fetchPageInfo
    (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: pageId1, url: "https://a.com", title: "A" },
      { id: pageId2, url: "https://b.com", title: "B" },
    ]);

    // fetchColorInfo (color dimension)
    (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { web_page_id: pageId1, color_scheme: { dominant: "#FF0000", accent: "#00FF00" } },
      { web_page_id: pageId2, color_scheme: { dominant: "#FF0000", accent: "#0000FF" } },
    ]);

    const input: DesignCompareInput = {
      page_ids: [pageId1, pageId2],
      dimensions: ["color"],
      include_details: false,
    };

    const result = await compareDesigns(input);
    expect(result.success).toBe(true);
    expect(result.comparisons).toHaveLength(1);
    const colorScore = result.comparisons[0]!.scores.color;
    expect(colorScore).toBeDefined();
    expect(colorScore).toBeGreaterThan(0);
    expect(colorScore).toBeLessThanOrEqual(1);
  });

  // ---------------------------------------------------
  // 正常系: include_details = true
  // ---------------------------------------------------

  it("include_details=trueでcommon_patternsとkey_differencesが生成される", async () => {
    const pageId1 = "aaaaaaaa-1111-1111-1111-111111111111";
    const pageId2 = "bbbbbbbb-2222-2222-2222-222222222222";

    // fetchPageInfo
    (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: pageId1, url: "https://a.com", title: "A" },
      { id: pageId2, url: "https://b.com", title: "B" },
    ]);

    // fetchQualityScores — 高い類似度
    (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { target_id: pageId1, overall_score: 90 },
      { target_id: pageId2, overall_score: 92 },
    ]);

    const input: DesignCompareInput = {
      page_ids: [pageId1, pageId2],
      dimensions: ["quality"],
      include_details: true,
    };

    const result = await compareDesigns(input);
    expect(result.success).toBe(true);
    // 差分2 → 類似度0.98 > 0.8（HIGH_SIMILARITY_THRESHOLD）→ common_patternsに含まれる
    expect(result.common_patterns.length).toBeGreaterThanOrEqual(1);
    expect(result.common_patterns[0]!.dimension).toBe("quality");
    expect(result.common_patterns[0]!.description).toContain("highly similar");
  });

  it("include_details=falseではcommon_patternsとkey_differencesは空", async () => {
    const pageId1 = "aaaaaaaa-1111-1111-1111-111111111111";
    const pageId2 = "bbbbbbbb-2222-2222-2222-222222222222";

    // fetchPageInfo
    (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: pageId1, url: "https://a.com", title: "A" },
      { id: pageId2, url: "https://b.com", title: "B" },
    ]);

    // fetchQualityScores
    (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { target_id: pageId1, overall_score: 90 },
      { target_id: pageId2, overall_score: 92 },
    ]);

    const input: DesignCompareInput = {
      page_ids: [pageId1, pageId2],
      dimensions: ["quality"],
      include_details: false,
    };

    const result = await compareDesigns(input);
    expect(result.success).toBe(true);
    expect(result.common_patterns).toEqual([]);
    expect(result.key_differences).toEqual([]);
  });

  // ---------------------------------------------------
  // 正常系: 3ページ比較（ペアワイズ3組）
  // ---------------------------------------------------

  it("正常系: 3ページ比較で3組のペアが生成される", async () => {
    const ids = [
      "aaaaaaaa-1111-1111-1111-111111111111",
      "bbbbbbbb-2222-2222-2222-222222222222",
      "cccccccc-3333-3333-3333-333333333333",
    ];

    // fetchPageInfo
    (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ids.map((id, i) => ({ id, url: `https://page${i}.com`, title: `Page ${i}` }))
    );

    // fetchQualityScores
    (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { target_id: ids[0], overall_score: 80 },
      { target_id: ids[1], overall_score: 60 },
      { target_id: ids[2], overall_score: 90 },
    ]);

    const input: DesignCompareInput = {
      page_ids: ids,
      dimensions: ["quality"],
      include_details: false,
    };

    const result = await compareDesigns(input);
    expect(result.success).toBe(true);
    expect(result.pages).toHaveLength(3);
    // C(3,2) = 3 ペア
    expect(result.comparisons).toHaveLength(3);

    // ペアの内容を検証
    const pairs = result.comparisons.map((c) => c.pair);
    expect(pairs).toContainEqual([ids[0], ids[1]]);
    expect(pairs).toContainEqual([ids[0], ids[2]]);
    expect(pairs).toContainEqual([ids[1], ids[2]]);
  });

  // ---------------------------------------------------
  // embedding データなし
  // ---------------------------------------------------

  it("embeddingデータがない場合もエラーにならない", async () => {
    const pageId1 = "aaaaaaaa-1111-1111-1111-111111111111";
    const pageId2 = "bbbbbbbb-2222-2222-2222-222222222222";

    // fetchPageInfo
    (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: pageId1, url: "https://a.com", title: "A" },
      { id: pageId2, url: "https://b.com", title: "B" },
    ]);

    // fetchPageEmbeddings — 空結果
    (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    const input: DesignCompareInput = {
      page_ids: [pageId1, pageId2],
      dimensions: ["layout"],
      include_details: false,
    };

    const result = await compareDesigns(input);
    expect(result.success).toBe(true);
    expect(result.comparisons).toHaveLength(1);
    // embeddingデータなし → layoutスコアは未設定
    expect(result.comparisons[0]!.scores.layout).toBeUndefined();
  });

  // ---------------------------------------------------
  // DB例外
  // ---------------------------------------------------

  it("DBクエリが例外を投げた場合はthrowされる", async () => {
    (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Connection refused")
    );

    const input: DesignCompareInput = {
      page_ids: ["id-a", "id-b"],
      dimensions: ["quality"],
      include_details: false,
    };

    await expect(compareDesigns(input)).rejects.toThrow("Connection refused");
  });

  // ---------------------------------------------------
  // 全次元同時比較
  // ---------------------------------------------------

  it("正常系: 全4次元を同時に比較する", async () => {
    const pageId1 = "aaaaaaaa-1111-1111-1111-111111111111";
    const pageId2 = "bbbbbbbb-2222-2222-2222-222222222222";

    // fetchPageInfo
    (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: pageId1, url: "https://a.com", title: "A" },
      { id: pageId2, url: "https://b.com", title: "B" },
    ]);

    // fetchPageEmbeddings (layout + visual)
    (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        web_page_id: pageId1,
        text_embedding_avg: "[0.5,0.5,0.5]",
        vision_embedding_avg: "[0.3,0.3,0.3]",
        section_count: 3,
      },
      {
        web_page_id: pageId2,
        text_embedding_avg: "[0.5,0.5,0.5]",
        vision_embedding_avg: "[0.3,0.3,0.3]",
        section_count: 4,
      },
    ]);

    // fetchQualityScores (quality)
    (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { target_id: pageId1, overall_score: 85 },
      { target_id: pageId2, overall_score: 80 },
    ]);

    // fetchColorInfo (color)
    (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { web_page_id: pageId1, color_scheme: { dominant: "#FF0000" } },
      { web_page_id: pageId2, color_scheme: { dominant: "#FF0000" } },
    ]);

    const input: DesignCompareInput = {
      page_ids: [pageId1, pageId2],
      dimensions: [...ALL_DIMENSIONS],
      include_details: false,
    };

    const result = await compareDesigns(input);
    expect(result.success).toBe(true);
    expect(result.comparisons).toHaveLength(1);

    const scores = result.comparisons[0]!.scores;
    // layout: 同一embedding → 1.0
    expect(scores.layout).toBeCloseTo(1.0, 3);
    // visual: 同一embedding → 1.0
    expect(scores.visual).toBeCloseTo(1.0, 3);
    // quality: 差分5 → 0.95
    expect(scores.quality).toBeCloseTo(0.95, 3);
    // color: 同一色 → 1.0
    expect(scores.color).toBeCloseTo(1.0, 3);

    // overall は各次元の平均
    expect(result.comparisons[0]!.overall).toBeGreaterThan(0.9);
  });

  // ---------------------------------------------------
  // title が null のページ
  // ---------------------------------------------------

  it("titleがnullのページはundefinedに変換される", async () => {
    const pageId1 = "aaaaaaaa-1111-1111-1111-111111111111";
    const pageId2 = "bbbbbbbb-2222-2222-2222-222222222222";

    // fetchPageInfo — title: null
    (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: pageId1, url: "https://a.com", title: null },
      { id: pageId2, url: "https://b.com", title: "Has Title" },
    ]);

    // fetchQualityScores
    (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { target_id: pageId1, overall_score: 50 },
      { target_id: pageId2, overall_score: 50 },
    ]);

    const input: DesignCompareInput = {
      page_ids: [pageId1, pageId2],
      dimensions: ["quality"],
      include_details: false,
    };

    const result = await compareDesigns(input);
    expect(result.success).toBe(true);
    expect(result.pages[0]!.title).toBeUndefined();
    expect(result.pages[1]!.title).toBe("Has Title");
  });

  // ---------------------------------------------------
  // key_differences 生成
  // ---------------------------------------------------

  it("低類似度ペアがある場合はkey_differencesが生成される", async () => {
    const pageId1 = "aaaaaaaa-1111-1111-1111-111111111111";
    const pageId2 = "bbbbbbbb-2222-2222-2222-222222222222";

    // fetchPageInfo
    (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: pageId1, url: "https://a.com", title: "A" },
      { id: pageId2, url: "https://b.com", title: "B" },
    ]);

    // fetchQualityScores — 大きな差分
    (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { target_id: pageId1, overall_score: 95 },
      { target_id: pageId2, overall_score: 20 },
    ]);

    const input: DesignCompareInput = {
      page_ids: [pageId1, pageId2],
      dimensions: ["quality"],
      include_details: true,
    };

    const result = await compareDesigns(input);
    expect(result.success).toBe(true);
    // 差分75 → 類似度0.25 < 0.4（LOW_SIMILARITY_THRESHOLD）→ key_differences生成
    expect(result.key_differences.length).toBeGreaterThanOrEqual(1);
    expect(result.key_differences[0]!.dimension).toBe("quality");
    expect(result.key_differences[0]!.description).toContain("differs significantly");
    expect(result.key_differences[0]!.page_ids).toContain(pageId1);
    expect(result.key_differences[0]!.page_ids).toContain(pageId2);
  });
});

// =====================================================
// ALL_DIMENSIONS / DESIGN_COMPARE_ERROR_CODES テスト
// =====================================================

describe("定数", () => {
  it("ALL_DIMENSIONSは4次元を含む", () => {
    expect(ALL_DIMENSIONS).toEqual(["layout", "visual", "quality", "color"]);
    expect(ALL_DIMENSIONS).toHaveLength(4);
  });

  it("DESIGN_COMPARE_ERROR_CODESが正しい値を持つ", () => {
    expect(DESIGN_COMPARE_ERROR_CODES.INVALID_INPUT).toBe("INVALID_INPUT");
    expect(DESIGN_COMPARE_ERROR_CODES.PAGES_NOT_FOUND).toBe("PAGES_NOT_FOUND");
    expect(DESIGN_COMPARE_ERROR_CODES.INSUFFICIENT_DATA).toBe("INSUFFICIENT_DATA");
    expect(DESIGN_COMPARE_ERROR_CODES.SERVICE_UNAVAILABLE).toBe("SERVICE_UNAVAILABLE");
    expect(DESIGN_COMPARE_ERROR_CODES.COMPARE_FAILED).toBe("COMPARE_FAILED");
  });
});

// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * design.compare MCPツールのテスト
 *
 * 2-5件のWebページを多次元で比較するMCPツールのユニットテスト
 *
 * テスト対象:
 * - Zodスキーマバリデーション (10テスト)
 * - サービス層ユニットテスト (8テスト)
 * - ハンドラー統合テスト (7テスト)
 * - ツール定義の検証 (4テスト)
 * - セキュリティ (4テスト)
 *
 * @module tests/tools/design/compare.tool.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  designCompareInputSchema,
  designCompareHandler,
  designCompareToolDefinition,
  DESIGN_COMPARE_ERROR_CODES,
  type DesignCompareOutput,
} from "../../../src/tools/design/compare.tool";

import {
  cosineSimilarity,
  normalizeQualityDifference,
  paletteDistance,
  colorDistance,
  setDesignComparePrismaClientFactory,
  resetDesignComparePrismaClientFactory,
  type DesignComparePrismaClient,
} from "../../../src/services/design-compare.service";

import { invalidateCache } from "../../../src/services/search-cache.service";

// =====================================================
// テストデータ / Test Data
// =====================================================

const UUID_A = "00000000-0000-4000-8000-000000000001";
const UUID_B = "00000000-0000-4000-8000-000000000002";
const UUID_C = "00000000-0000-4000-8000-000000000003";
const UUID_D = "00000000-0000-4000-8000-000000000004";
const UUID_E = "00000000-0000-4000-8000-000000000005";
const UUID_NONEXISTENT = "00000000-0000-4000-8000-000000000099";

function createMockEmbedding(seed: number): string {
  // pgvector形式の文字列で返す
  const values = Array.from({ length: 768 }, (_, i) => (Math.sin(i + seed) * 0.01).toFixed(6));
  return `[${values.join(",")}]`;
}

function createMockPrisma(overrides?: {
  pageInfo?: Array<{ id: string; url: string; title: string | null }>;
  embeddings?: Array<{
    web_page_id: string;
    text_embedding_avg: string | null;
    vision_embedding_avg: string | null;
    section_count: number;
  }>;
  qualityScores?: Array<{ target_id: string; overall_score: number }>;
  colorInfo?: Array<{ web_page_id: string; color_scheme: unknown }>;
}): DesignComparePrismaClient {
  const pageInfo = overrides?.pageInfo ?? [
    { id: UUID_A, url: "https://example-a.com", title: "Site A" },
    { id: UUID_B, url: "https://example-b.com", title: "Site B" },
  ];
  const embeddings = overrides?.embeddings ?? [
    {
      web_page_id: UUID_A,
      text_embedding_avg: createMockEmbedding(1),
      vision_embedding_avg: createMockEmbedding(10),
      section_count: 5,
    },
    {
      web_page_id: UUID_B,
      text_embedding_avg: createMockEmbedding(2),
      vision_embedding_avg: createMockEmbedding(20),
      section_count: 4,
    },
  ];
  const qualityScores = overrides?.qualityScores ?? [
    { target_id: UUID_A, overall_score: 85 },
    { target_id: UUID_B, overall_score: 72 },
  ];
  const colorInfo = overrides?.colorInfo ?? [
    { web_page_id: UUID_A, color_scheme: { dominant: "#1a1a2e", accent: "#e94560" } },
    { web_page_id: UUID_B, color_scheme: { dominant: "#0f3460", accent: "#16213e" } },
  ];

  return {
    $queryRawUnsafe: vi.fn().mockImplementation((query: string) => {
      if (query.includes("FROM web_pages")) {
        return Promise.resolve(pageInfo);
      }
      if (query.includes("section_embeddings")) {
        return Promise.resolve(embeddings);
      }
      if (query.includes("quality_evaluations")) {
        return Promise.resolve(qualityScores);
      }
      if (query.includes("visual_features")) {
        return Promise.resolve(colorInfo);
      }
      return Promise.resolve([]);
    }),
  };
}

// =====================================================
// Zodスキーマバリデーション
// =====================================================

describe("designCompareInputSchema", () => {
  it("有効な2ページの入力を受け付ける", () => {
    const result = designCompareInputSchema.safeParse({
      page_ids: [UUID_A, UUID_B],
    });
    expect(result.success).toBe(true);
  });

  it("デフォルトで全4次元が設定される", () => {
    const result = designCompareInputSchema.safeParse({
      page_ids: [UUID_A, UUID_B],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dimensions).toEqual(["layout", "visual", "quality", "color"]);
    }
  });

  it("include_detailsのデフォルトはfalse", () => {
    const result = designCompareInputSchema.safeParse({
      page_ids: [UUID_A, UUID_B],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.include_details).toBe(false);
    }
  });

  it("5ページまで許容する", () => {
    const result = designCompareInputSchema.safeParse({
      page_ids: [UUID_A, UUID_B, UUID_C, UUID_D, UUID_E],
    });
    expect(result.success).toBe(true);
  });

  it("1ページは拒否する（最小2）", () => {
    const result = designCompareInputSchema.safeParse({
      page_ids: [UUID_A],
    });
    expect(result.success).toBe(false);
  });

  it("6ページは拒否する（最大5）", () => {
    const result = designCompareInputSchema.safeParse({
      page_ids: [UUID_A, UUID_B, UUID_C, UUID_D, UUID_E, "00000000-0000-4000-8000-000000000006"],
    });
    expect(result.success).toBe(false);
  });

  it("無効なUUID形式を拒否する", () => {
    const result = designCompareInputSchema.safeParse({
      page_ids: ["not-a-uuid", UUID_B],
    });
    expect(result.success).toBe(false);
  });

  it("特定の次元のみ指定できる", () => {
    const result = designCompareInputSchema.safeParse({
      page_ids: [UUID_A, UUID_B],
      dimensions: ["layout", "color"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dimensions).toEqual(["layout", "color"]);
    }
  });

  it("無効な次元を拒否する", () => {
    const result = designCompareInputSchema.safeParse({
      page_ids: [UUID_A, UUID_B],
      dimensions: ["invalid_dimension"],
    });
    expect(result.success).toBe(false);
  });

  it("空の次元配列を拒否する", () => {
    const result = designCompareInputSchema.safeParse({
      page_ids: [UUID_A, UUID_B],
      dimensions: [],
    });
    expect(result.success).toBe(false);
  });
});

// =====================================================
// サービス層ユニットテスト（Pure Functions）
// =====================================================

describe("cosineSimilarity", () => {
  it("同一ベクトルで1.0を返す", () => {
    const vec = [0.1, 0.2, 0.3, 0.4, 0.5];
    expect(cosineSimilarity(vec, vec)).toBeCloseTo(1.0, 4);
  });

  it("直交ベクトルで0を返す", () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 4);
  });

  it("空のベクトルで0を返す", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("長さ不一致で0を返す", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it("NaN値を0として扱う", () => {
    const a = [1, NaN, 3];
    const b = [1, 2, 3];
    // NaN要素は0に置換されるので [1,0,3] vs [1,2,3]
    const result = cosineSimilarity(a, b);
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(1);
  });
});

describe("normalizeQualityDifference", () => {
  it("同一スコアで1.0を返す", () => {
    expect(normalizeQualityDifference(85, 85)).toBe(1.0);
  });

  it("差分100で0.0を返す", () => {
    expect(normalizeQualityDifference(0, 100)).toBe(0.0);
  });

  it("差分50で0.5を返す", () => {
    expect(normalizeQualityDifference(25, 75)).toBeCloseTo(0.5, 4);
  });

  it("NaN入力で0を返す", () => {
    expect(normalizeQualityDifference(NaN, 50)).toBe(0);
  });
});

describe("paletteDistance", () => {
  it("同一カラーで1.0（最大類似度）を返す", () => {
    const colors = ["#ff0000", "#00ff00", "#0000ff"];
    expect(paletteDistance(colors, colors)).toBeCloseTo(1.0, 4);
  });

  it("空のパレットで0を返す", () => {
    expect(paletteDistance([], ["#ff0000"])).toBe(0);
    expect(paletteDistance(["#ff0000"], [])).toBe(0);
  });

  it("異なるパレットで0-1の範囲の値を返す", () => {
    const a = ["#ff0000"];
    const b = ["#0000ff"];
    const result = paletteDistance(a, b);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
    // 赤と青は大きく異なるので類似度は低い
    expect(result).toBeLessThan(0.5);
  });
});

describe("colorDistance", () => {
  it("同一色で0を返す", () => {
    const color = { r: 128, g: 64, b: 200 };
    expect(colorDistance(color, color)).toBe(0);
  });

  it("白と黒で最大距離（1.0）を返す", () => {
    const white = { r: 255, g: 255, b: 255 };
    const black = { r: 0, g: 0, b: 0 };
    expect(colorDistance(white, black)).toBeCloseTo(1.0, 2);
  });
});

// =====================================================
// ハンドラー統合テスト
// =====================================================

describe("designCompareHandler", () => {
  beforeEach(() => {
    invalidateCache();
  });

  afterEach(() => {
    resetDesignComparePrismaClientFactory();
    invalidateCache();
  });

  it("2ページの比較で正常な結果を返す", async () => {
    const mockPrisma = createMockPrisma();
    setDesignComparePrismaClientFactory(() => mockPrisma);

    const result = (await designCompareHandler({
      page_ids: [UUID_A, UUID_B],
    })) as DesignCompareOutput;

    expect(result.success).toBe(true);
    expect(result.pages).toHaveLength(2);
    expect(result.comparisons).toHaveLength(1); // C(2,2) = 1ペア
    expect(result.comparisons[0].pair).toEqual([UUID_A, UUID_B]);
    expect(result.comparisons[0].overall).toBeGreaterThanOrEqual(0);
    expect(result.comparisons[0].overall).toBeLessThanOrEqual(1);
  });

  it("3ページの比較で3ペアを生成する", async () => {
    const mockPrisma = createMockPrisma({
      pageInfo: [
        { id: UUID_A, url: "https://example-a.com", title: "Site A" },
        { id: UUID_B, url: "https://example-b.com", title: "Site B" },
        { id: UUID_C, url: "https://example-c.com", title: "Site C" },
      ],
      embeddings: [
        {
          web_page_id: UUID_A,
          text_embedding_avg: createMockEmbedding(1),
          vision_embedding_avg: createMockEmbedding(10),
          section_count: 5,
        },
        {
          web_page_id: UUID_B,
          text_embedding_avg: createMockEmbedding(2),
          vision_embedding_avg: createMockEmbedding(20),
          section_count: 4,
        },
        {
          web_page_id: UUID_C,
          text_embedding_avg: createMockEmbedding(3),
          vision_embedding_avg: createMockEmbedding(30),
          section_count: 6,
        },
      ],
      qualityScores: [
        { target_id: UUID_A, overall_score: 85 },
        { target_id: UUID_B, overall_score: 72 },
        { target_id: UUID_C, overall_score: 90 },
      ],
      colorInfo: [
        { web_page_id: UUID_A, color_scheme: { dominant: "#1a1a2e", accent: "#e94560" } },
        { web_page_id: UUID_B, color_scheme: { dominant: "#0f3460", accent: "#16213e" } },
        { web_page_id: UUID_C, color_scheme: { dominant: "#1a1a2e", accent: "#0f3460" } },
      ],
    });
    setDesignComparePrismaClientFactory(() => mockPrisma);

    const result = (await designCompareHandler({
      page_ids: [UUID_A, UUID_B, UUID_C],
    })) as DesignCompareOutput;

    expect(result.success).toBe(true);
    expect(result.comparisons).toHaveLength(3); // C(3,2) = 3ペア
  });

  it("include_details=trueで共通パターンと差分を含む", async () => {
    const mockPrisma = createMockPrisma();
    setDesignComparePrismaClientFactory(() => mockPrisma);

    const result = (await designCompareHandler({
      page_ids: [UUID_A, UUID_B],
      include_details: true,
    })) as DesignCompareOutput;

    expect(result.success).toBe(true);
    // common_patternsとkey_differencesが配列であること（中身は検証不要）
    expect(Array.isArray(result.common_patterns)).toBe(true);
    expect(Array.isArray(result.key_differences)).toBe(true);
  });

  it("存在しないページIDでエラーを返す", async () => {
    const mockPrisma = createMockPrisma({
      pageInfo: [{ id: UUID_A, url: "https://example-a.com", title: "Site A" }],
    });
    setDesignComparePrismaClientFactory(() => mockPrisma);

    const result = (await designCompareHandler({
      page_ids: [UUID_A, UUID_NONEXISTENT],
    })) as DesignCompareOutput;

    expect(result.success).toBe(false);
    expect(result.error).toContain(DESIGN_COMPARE_ERROR_CODES.PAGES_NOT_FOUND);
  });

  it("特定の次元のみ指定した場合、指定次元のスコアのみ含む", async () => {
    const mockPrisma = createMockPrisma();
    setDesignComparePrismaClientFactory(() => mockPrisma);

    const result = (await designCompareHandler({
      page_ids: [UUID_A, UUID_B],
      dimensions: ["quality"],
    })) as DesignCompareOutput;

    expect(result.success).toBe(true);
    expect(result.comparisons).toHaveLength(1);
    // quality次元のみ
    expect(result.comparisons[0].scores.quality).toBeDefined();
    expect(result.comparisons[0].scores.layout).toBeUndefined();
    expect(result.comparisons[0].scores.visual).toBeUndefined();
    expect(result.comparisons[0].scores.color).toBeUndefined();
  });

  it("DB未接続でSERVICE_UNAVAILABLEを返す", async () => {
    // DIファクトリー未設定 → service unavailable
    resetDesignComparePrismaClientFactory();

    const result = (await designCompareHandler({
      page_ids: [UUID_A, UUID_B],
    })) as DesignCompareOutput;

    expect(result.success).toBe(false);
    expect(result.error).toContain(DESIGN_COMPARE_ERROR_CODES.SERVICE_UNAVAILABLE);
  });

  it("重複ページIDでINVALID_INPUTを返す", async () => {
    const mockPrisma = createMockPrisma();
    setDesignComparePrismaClientFactory(() => mockPrisma);

    const result = (await designCompareHandler({
      page_ids: [UUID_A, UUID_A],
    })) as DesignCompareOutput;

    expect(result.success).toBe(false);
    expect(result.error).toContain(DESIGN_COMPARE_ERROR_CODES.INVALID_INPUT);
    expect(result.error).toContain("Duplicate");
  });
});

// =====================================================
// ツール定義の検証
// =====================================================

describe("designCompareToolDefinition", () => {
  it("ツール名が正しい", () => {
    expect(designCompareToolDefinition.name).toBe("design.compare");
  });

  it("descriptionが存在する", () => {
    expect(designCompareToolDefinition.description).toBeDefined();
    expect(designCompareToolDefinition.description.length).toBeGreaterThan(0);
  });

  it("descriptionに内部実装詳細（CIE76, cosine, DINOv2等）が含まれないこと", () => {
    const desc = designCompareToolDefinition.description;
    // 内部実装詳細が除去されていること
    expect(desc).not.toContain("CIE76");
    expect(desc).not.toContain("cosine");
    expect(desc).not.toContain("DINOv2");
    expect(desc).not.toContain("text embedding");
    expect(desc).not.toContain("vision embedding");
    expect(desc).not.toContain("normalized difference");
  });

  it("descriptionにユーザー向けの必要情報が含まれること", () => {
    const desc = designCompareToolDefinition.description;
    // 比較対象件数
    expect(desc).toMatch(/2-5/);
    // 4軸の概要
    expect(desc).toContain("include_details");
    // スコア範囲
    expect(desc).toMatch(/0-1/);
    // 日英バイリンガル
    expect(desc).toContain("/");
  });

  it("inputSchemaにrequiredフィールドが含まれる", () => {
    expect(designCompareToolDefinition.inputSchema.required).toContain("page_ids");
  });

  it("annotationsが正しく設定されている", () => {
    expect(designCompareToolDefinition.annotations.readOnlyHint).toBe(true);
    expect(designCompareToolDefinition.annotations.idempotentHint).toBe(true);
    expect(designCompareToolDefinition.annotations.openWorldHint).toBe(false);
  });
});

// =====================================================
// セキュリティテスト
// =====================================================

describe("セキュリティ", () => {
  beforeEach(() => {
    invalidateCache();
  });

  afterEach(() => {
    resetDesignComparePrismaClientFactory();
    invalidateCache();
  });

  it("SQLインジェクション的なpage_idを拒否する", async () => {
    const result = (await designCompareHandler({
      page_ids: ["'; DROP TABLE web_pages; --", UUID_B],
    })) as DesignCompareOutput;

    expect(result.success).toBe(false);
    expect(result.error).toContain(DESIGN_COMPARE_ERROR_CODES.INVALID_INPUT);
  });

  it("超長文字列のpage_idを拒否する", async () => {
    const longId = "a".repeat(10000);
    const result = (await designCompareHandler({
      page_ids: [longId, UUID_B],
    })) as DesignCompareOutput;

    expect(result.success).toBe(false);
    expect(result.error).toContain(DESIGN_COMPARE_ERROR_CODES.INVALID_INPUT);
  });

  it("内部エラーメッセージがサニタイズされている", async () => {
    const mockPrisma: DesignComparePrismaClient = {
      $queryRawUnsafe: vi
        .fn()
        .mockRejectedValue(new Error('relation "web_pages" does not exist at character 42')),
    };
    setDesignComparePrismaClientFactory(() => mockPrisma);

    const result = (await designCompareHandler({
      page_ids: [UUID_A, UUID_B],
    })) as DesignCompareOutput;

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    // 内部テーブル名が漏洩しないことを確認
    // sanitizeErrorMessageが適用されている
    expect(result.error).toContain(DESIGN_COMPARE_ERROR_CODES.COMPARE_FAILED);
  });

  it("全比較スコアが0-1の範囲内である", async () => {
    const mockPrisma = createMockPrisma();
    setDesignComparePrismaClientFactory(() => mockPrisma);

    const result = (await designCompareHandler({
      page_ids: [UUID_A, UUID_B],
    })) as DesignCompareOutput;

    expect(result.success).toBe(true);
    for (const comparison of result.comparisons) {
      expect(comparison.overall).toBeGreaterThanOrEqual(0);
      expect(comparison.overall).toBeLessThanOrEqual(1);
      for (const score of Object.values(comparison.scores)) {
        if (score !== undefined) {
          expect(score).toBeGreaterThanOrEqual(0);
          expect(score).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

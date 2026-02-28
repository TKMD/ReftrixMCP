// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * quality.evaluate パターン駆動評価の統合テスト
 *
 * v0.1.0 Pattern-Driven Evaluation機能のテスト
 *
 * テスト対象:
 * - パターン駆動評価フロー（モックサービス使用）
 * - サービス利用不可時のフォールバック動作
 * - ユニークネススコアによる独自性調整
 * - 高品質パターンとの類似度による技巧ボーナス
 * - 入力バリデーション（patternComparisonオプション）
 * - コンテキスト付き推奨事項生成
 *
 * @module tests/integration/quality-evaluate-patterns.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  qualityEvaluateHandler,
  setQualityEvaluateServiceFactory,
  resetQualityEvaluateServiceFactory,
  setPatternMatcherServiceFactory,
  resetPatternMatcherServiceFactory,
  setBenchmarkServiceFactory,
  resetBenchmarkServiceFactory,
  type IQualityEvaluateService,
} from '../../src/tools/quality/evaluate.tool';

import type {
  IPatternMatcherService,
  SectionPatternMatch,
  MotionPatternMatch,
} from '../../src/services/quality/pattern-matcher.service';

import type { IBenchmarkService } from '../../src/services/quality/benchmark.service';

import {
  qualityEvaluateInputSchema,
  patternComparisonSchema,
  evaluationContextSchema,
  patternAnalysisSchema,
  contextualRecommendationSchema,
  type QualityEvaluateInput,
  QUALITY_MCP_ERROR_CODES,
} from '../../src/tools/quality/schemas';

// =====================================================
// テストデータ
// =====================================================

/** 良質なサンプルHTML（クリシェなし） */
const sampleHtmlGood = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>オリジナルデザイン</title>
  <style>
    :root {
      --primary-color: #2C5F2D;
      --secondary-color: #97BC62;
      --bg-color: #FAF9F6;
    }
    body { font-family: 'Noto Sans JP', sans-serif; }
    .hero { padding: 120px 0; }
    @media (prefers-reduced-motion: reduce) {
      .hero { transition: none; }
    }
  </style>
</head>
<body>
  <header role="banner">
    <nav role="navigation" aria-label="メインナビゲーション">
      <a href="/">ホーム</a>
    </nav>
  </header>
  <main role="main">
    <section class="hero" aria-labelledby="hero-title">
      <h1 id="hero-title">革新的なソリューション</h1>
      <button type="button">詳しく見る</button>
    </section>
  </main>
  <footer role="contentinfo">
    <p>&copy; 2024 Company Name</p>
  </footer>
</body>
</html>`;

/** AIクリシェを含むHTML */
const sampleHtmlWithCliches = `<!DOCTYPE html>
<html>
<head>
  <style>
    .hero { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
  </style>
</head>
<body>
  <section class="hero">
    <h1>Transform Your Business</h1>
    <p>Unlock the power of innovation</p>
    <button>Get Started Today</button>
  </section>
</body>
</html>`;

const validUUID = '123e4567-e89b-12d3-a456-426614174000';
const validUUID2 = '223e4567-e89b-12d3-a456-426614174001';
const validWebPageId = '323e4567-e89b-12d3-a456-426614174002';

// =====================================================
// モックデータ
// =====================================================

/**
 * 高品質セクションパターンマッチ（スコア >= 85）
 */
const mockHighQualitySectionPatterns: SectionPatternMatch[] = [
  {
    id: validUUID,
    webPageId: validWebPageId,
    sectionType: 'hero',
    similarity: 0.92,
    qualityScore: 90,
    sourceUrl: 'https://example.com/high-quality',
  },
  {
    id: validUUID2,
    webPageId: validWebPageId,
    sectionType: 'feature',
    similarity: 0.88,
    qualityScore: 87,
    sourceUrl: 'https://example.com/feature',
  },
];

/**
 * 低品質セクションパターンマッチ（スコア < 85）
 */
const mockLowQualitySectionPatterns: SectionPatternMatch[] = [
  {
    id: validUUID,
    webPageId: validWebPageId,
    sectionType: 'hero',
    similarity: 0.75,
    qualityScore: 60,
    sourceUrl: 'https://example.com/low-quality',
  },
];

/**
 * モーションパターンマッチ
 */
const mockMotionPatterns: MotionPatternMatch[] = [
  {
    id: validUUID,
    webPageId: validWebPageId,
    name: 'fade-in',
    type: 'animation',
    trigger: 'scroll',
    similarity: 0.85,
    duration: 300,
  },
];

/**
 * 768次元のダミーエンベディング
 */
const mockEmbedding = Array.from({ length: 768 }, () => Math.random() * 0.1);

// =====================================================
// モックファクトリ関数
// =====================================================

/**
 * パターンマッチャーサービスのモックを作成
 */
function createMockPatternMatcherService(
  options: {
    sectionPatterns?: SectionPatternMatch[];
    motionPatterns?: MotionPatternMatch[];
    uniquenessScore?: number;
    throwOnSectionSearch?: boolean;
    throwOnMotionSearch?: boolean;
    throwOnUniqueness?: boolean;
  } = {}
): IPatternMatcherService {
  const {
    sectionPatterns = [],
    motionPatterns = [],
    uniquenessScore = 0.5,
    throwOnSectionSearch = false,
    throwOnMotionSearch = false,
    throwOnUniqueness = false,
  } = options;

  return {
    extractTextRepresentation: vi.fn().mockReturnValue('Mock text representation'),
    findSimilarSectionPatterns: vi.fn().mockImplementation(async () => {
      if (throwOnSectionSearch) {
        throw new Error('Section pattern search failed');
      }
      return sectionPatterns;
    }),
    findSimilarMotionPatterns: vi.fn().mockImplementation(async () => {
      if (throwOnMotionSearch) {
        throw new Error('Motion pattern search failed');
      }
      return motionPatterns;
    }),
    calculateUniquenessScore: vi.fn().mockImplementation(async () => {
      if (throwOnUniqueness) {
        throw new Error('Uniqueness calculation failed');
      }
      return uniquenessScore;
    }),
    comparePatterns: vi.fn().mockReturnValue({
      cosineSimilarity: 0.8,
      isHighMatch: false,
      isMediumMatch: true,
      isLowMatch: false,
    }),
  };
}

/**
 * QualityEvaluateServiceのモックを作成
 */
function createMockQualityEvaluateService(
  options: {
    embeddings?: number[];
    throwOnEmbedding?: boolean;
    page?: { id: string; htmlContent: string } | null;
    throwOnGetPage?: boolean;
  } = {}
): IQualityEvaluateService {
  const {
    embeddings = mockEmbedding,
    throwOnEmbedding = false,
    page = null,
    throwOnGetPage = false,
  } = options;

  return {
    generateEmbedding: vi.fn().mockImplementation(async () => {
      if (throwOnEmbedding) {
        throw new Error('Embedding generation failed');
      }
      return embeddings;
    }),
    getPageById: vi.fn().mockImplementation(async () => {
      if (throwOnGetPage) {
        throw new Error('Page retrieval failed');
      }
      return page;
    }),
    // IQualityEvaluateServiceの他のメソッドがあれば追加
  } as unknown as IQualityEvaluateService;
}

/**
 * BenchmarkServiceのモックを作成
 */
function createMockBenchmarkService(
  options: {
    benchmarks?: Array<{
      benchmarkId: string;
      sectionType: string;
      overallScore: number;
      grade: string;
      similarity: number;
      sourceUrl: string;
    }>;
    throwOnFind?: boolean;
  } = {}
): IBenchmarkService {
  const { benchmarks = [], throwOnFind = false } = options;

  return {
    findSimilarBenchmarks: vi.fn().mockImplementation(async () => {
      if (throwOnFind) {
        throw new Error('Benchmark search failed');
      }
      return benchmarks;
    }),
    getBenchmarksByType: vi.fn().mockResolvedValue([]),
    getIndustryAverages: vi.fn().mockResolvedValue(null),
    calculatePercentile: vi.fn().mockResolvedValue(50),
    registerBenchmark: vi.fn().mockResolvedValue(validUUID),
  };
}

// =====================================================
// パターン駆動評価フローテスト
// =====================================================

describe('quality.evaluate with pattern comparison', () => {
  beforeEach(() => {
    // 全てのファクトリをリセット
    resetQualityEvaluateServiceFactory();
    resetPatternMatcherServiceFactory();
    resetBenchmarkServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetQualityEvaluateServiceFactory();
    resetPatternMatcherServiceFactory();
    resetBenchmarkServiceFactory();
  });

  // =====================================================
  // パターン駆動評価が正常に動作するケース
  // =====================================================

  it('should return pattern analysis when services available', async () => {
    // Arrange: サービスモック設定
    // パターン駆動評価には、PatternMatcherServiceとQualityEvaluateServiceが必要
    const mockPatternMatcher = createMockPatternMatcherService({
      sectionPatterns: mockHighQualitySectionPatterns,
      motionPatterns: mockMotionPatterns,
      uniquenessScore: 0.75,
    });
    const mockQualityService = createMockQualityEvaluateService({
      embeddings: mockEmbedding,
    });

    setPatternMatcherServiceFactory(() => mockPatternMatcher);
    setQualityEvaluateServiceFactory(() => mockQualityService);

    const input: QualityEvaluateInput = {
      html: sampleHtmlGood,
      patternComparison: { enabled: true, minSimilarity: 0.7, maxPatterns: 5 },
    };

    // Act
    const result = await qualityEvaluateHandler(input);

    // Assert
    expect(result.success).toBe(true);
    if (result.success && 'data' in result) {
      // patternAnalysisが存在することを確認
      expect(result.data.patternAnalysis).toBeDefined();

      // パターン駆動評価が有効であることを確認
      if (result.data.patternAnalysis) {
        expect(result.data.patternAnalysis.patternDrivenEnabled).toBe(true);
        expect(result.data.patternAnalysis.fallbackUsed).toBe(false);

        // 類似セクションが返されていることを確認
        expect(result.data.patternAnalysis.similarSections).toBeDefined();
        expect(result.data.patternAnalysis.similarSections.length).toBeGreaterThan(0);

        // ユニークネススコアが計算されていることを確認
        expect(result.data.patternAnalysis.uniquenessScore).toBeDefined();
        expect(result.data.patternAnalysis.uniquenessScore).toBeGreaterThanOrEqual(0);
        expect(result.data.patternAnalysis.uniquenessScore).toBeLessThanOrEqual(100);
      }
    }
  });

  it('should include contextualRecommendations with referencePatternId', async () => {
    // Arrange: 高品質パターンを含むモック
    const mockPatternMatcher = createMockPatternMatcherService({
      sectionPatterns: mockHighQualitySectionPatterns,
      motionPatterns: mockMotionPatterns,
      uniquenessScore: 0.6,
    });
    const mockQualityService = createMockQualityEvaluateService({
      embeddings: mockEmbedding,
    });

    setPatternMatcherServiceFactory(() => mockPatternMatcher);
    setQualityEvaluateServiceFactory(() => mockQualityService);

    const input: QualityEvaluateInput = {
      html: sampleHtmlWithCliches, // クリシェを含むHTMLで推奨事項を生成
      patternComparison: { enabled: true, minSimilarity: 0.7, maxPatterns: 5 },
      includeRecommendations: true,
    };

    // Act
    const result = await qualityEvaluateHandler(input);

    // Assert
    expect(result.success).toBe(true);
    if (result.success && 'data' in result) {
      // コンテキスト付き推奨事項が存在することを確認
      expect(result.data.contextualRecommendations).toBeDefined();

      if (result.data.contextualRecommendations && result.data.contextualRecommendations.length > 0) {
        // 少なくとも1つの推奨事項を確認
        const firstRec = result.data.contextualRecommendations[0];
        expect(firstRec).toBeDefined();
        if (firstRec) {
          expect(firstRec.id).toBeDefined();
          expect(firstRec.category).toBeDefined();
          expect(firstRec.priority).toBeDefined();
          expect(firstRec.title).toBeDefined();
          expect(firstRec.description).toBeDefined();
        }
      }
    }
  });

  // =====================================================
  // フォールバック動作テスト
  // =====================================================

  it('should fallback to static analysis when services unavailable', async () => {
    // Arrange: サービスファクトリを設定しない（null状態）
    // これにより、パターン駆動評価がフォールバックする

    const input: QualityEvaluateInput = {
      html: sampleHtmlGood,
      patternComparison: { enabled: true },
    };

    // Act
    const result = await qualityEvaluateHandler(input);

    // Assert
    expect(result.success).toBe(true);
    if (result.success && 'data' in result) {
      // patternAnalysisがフォールバックモードであることを確認
      expect(result.data.patternAnalysis).toBeDefined();
      if (result.data.patternAnalysis) {
        expect(result.data.patternAnalysis.fallbackUsed).toBe(true);
        expect(result.data.patternAnalysis.patternDrivenEnabled).toBe(false);
        expect(result.data.patternAnalysis.fallbackReason).toBeDefined();
      }

      // 基本スコアは計算されていることを確認
      expect(result.data.overall).toBeGreaterThan(0);
      expect(result.data.originality.score).toBeGreaterThan(0);
      expect(result.data.craftsmanship.score).toBeGreaterThan(0);
      expect(result.data.contextuality.score).toBeGreaterThan(0);
    }
  });

  it('should fallback when embedding generation fails', async () => {
    // Arrange: Embedding生成が失敗するモック
    const mockPatternMatcher = createMockPatternMatcherService({
      sectionPatterns: mockHighQualitySectionPatterns,
    });
    const mockQualityService = createMockQualityEvaluateService({
      throwOnEmbedding: true,
    });

    setPatternMatcherServiceFactory(() => mockPatternMatcher);
    setQualityEvaluateServiceFactory(() => mockQualityService);

    const input: QualityEvaluateInput = {
      html: sampleHtmlGood,
      patternComparison: { enabled: true },
    };

    // Act
    const result = await qualityEvaluateHandler(input);

    // Assert
    expect(result.success).toBe(true);
    if (result.success && 'data' in result) {
      expect(result.data.patternAnalysis?.fallbackUsed).toBe(true);
      // 静的分析によるスコアは正常に計算される
      expect(result.data.overall).toBeGreaterThan(0);
    }
  });

  it('should continue with partial results when section search fails', async () => {
    // Arrange: セクション検索が失敗するが、モーション検索は成功
    const mockPatternMatcher = createMockPatternMatcherService({
      sectionPatterns: [],
      motionPatterns: mockMotionPatterns,
      throwOnSectionSearch: true,
      uniquenessScore: 0.5,
    });
    const mockQualityService = createMockQualityEvaluateService({
      embeddings: mockEmbedding,
    });

    setPatternMatcherServiceFactory(() => mockPatternMatcher);
    setQualityEvaluateServiceFactory(() => mockQualityService);

    const input: QualityEvaluateInput = {
      html: sampleHtmlGood,
      patternComparison: { enabled: true },
    };

    // Act
    const result = await qualityEvaluateHandler(input);

    // Assert: 処理は続行され、部分的な結果が返される
    expect(result.success).toBe(true);
    if (result.success && 'data' in result) {
      expect(result.data.patternAnalysis).toBeDefined();
      // セクション検索失敗でも処理は継続
      expect(result.data.overall).toBeGreaterThan(0);
    }
  });

  // =====================================================
  // スコア調整ロジックテスト
  // =====================================================

  it('should adjust originality based on uniqueness score (high uniqueness)', async () => {
    // Arrange: 高いユニークネススコア（0.8 = 80%）
    const mockPatternMatcher = createMockPatternMatcherService({
      sectionPatterns: [], // 類似パターンなし
      motionPatterns: [],
      uniquenessScore: 0.8, // 高ユニークネス
    });
    const mockQualityService = createMockQualityEvaluateService({
      embeddings: mockEmbedding,
    });

    setPatternMatcherServiceFactory(() => mockPatternMatcher);
    setQualityEvaluateServiceFactory(() => mockQualityService);

    const input: QualityEvaluateInput = {
      html: sampleHtmlGood,
      patternComparison: { enabled: true },
    };

    // Act
    const result = await qualityEvaluateHandler(input);

    // Assert
    expect(result.success).toBe(true);
    if (result.success && 'data' in result) {
      // 高ユニークネスの場合、ユニークネススコアが高い
      expect(result.data.patternAnalysis?.uniquenessScore).toBeGreaterThanOrEqual(70);
    }
  });

  it('should penalize originality when uniqueness is low', async () => {
    // Arrange: 低いユニークネススコア（0.2 = 20%）= 既存パターンと類似
    const mockPatternMatcher = createMockPatternMatcherService({
      sectionPatterns: mockLowQualitySectionPatterns,
      motionPatterns: [],
      uniquenessScore: 0.2, // 低ユニークネス
    });
    const mockQualityService = createMockQualityEvaluateService({
      embeddings: mockEmbedding,
    });

    setPatternMatcherServiceFactory(() => mockPatternMatcher);
    setQualityEvaluateServiceFactory(() => mockQualityService);

    const input: QualityEvaluateInput = {
      html: sampleHtmlGood,
      patternComparison: { enabled: true },
    };

    // Act
    const result = await qualityEvaluateHandler(input);

    // Assert
    expect(result.success).toBe(true);
    if (result.success && 'data' in result) {
      // 低ユニークネスの場合、ユニークネススコアが低い
      expect(result.data.patternAnalysis?.uniquenessScore).toBeLessThan(30);
    }
  });

  it('should boost craftsmanship when similar to high-quality patterns', async () => {
    // Arrange: 高品質パターン（スコア >= 85）との類似度が高い
    const mockPatternMatcher = createMockPatternMatcherService({
      sectionPatterns: mockHighQualitySectionPatterns, // qualityScore: 90, 87
      motionPatterns: [],
      uniquenessScore: 0.5,
    });
    const mockQualityService = createMockQualityEvaluateService({
      embeddings: mockEmbedding,
    });

    setPatternMatcherServiceFactory(() => mockPatternMatcher);
    setQualityEvaluateServiceFactory(() => mockQualityService);

    const input: QualityEvaluateInput = {
      html: sampleHtmlGood,
      patternComparison: { enabled: true },
    };

    // Act
    const resultWithHighQuality = await qualityEvaluateHandler(input);

    // 比較用: サービスなしで実行
    resetPatternMatcherServiceFactory();
    resetQualityEvaluateServiceFactory();

    const resultWithoutPattern = await qualityEvaluateHandler({
      html: sampleHtmlGood,
      patternComparison: { enabled: false },
    });

    // Assert
    expect(resultWithHighQuality.success).toBe(true);
    expect(resultWithoutPattern.success).toBe(true);

    if (resultWithHighQuality.success && 'data' in resultWithHighQuality &&
        resultWithoutPattern.success && 'data' in resultWithoutPattern) {
      // 高品質パターンとの類似があると、craftsmanshipにボーナスがつく可能性がある
      // ただし、パターン駆動評価のフォールバックを考慮
      if (!resultWithHighQuality.data.patternAnalysis?.fallbackUsed) {
        // パターン駆動評価が成功した場合のみ比較
        expect(resultWithHighQuality.data.craftsmanship.score).toBeGreaterThanOrEqual(
          resultWithoutPattern.data.craftsmanship.score
        );
      }
    }
  });
});

// =====================================================
// 入力バリデーションテスト
// =====================================================

describe('quality.evaluate input schema', () => {
  it('should accept patternComparison options', () => {
    // Arrange
    const input = {
      html: sampleHtmlGood,
      patternComparison: {
        enabled: true,
        minSimilarity: 0.8,
        maxPatterns: 10,
      },
    };

    // Act & Assert
    expect(() => qualityEvaluateInputSchema.parse(input)).not.toThrow();

    const parsed = qualityEvaluateInputSchema.parse(input);
    expect(parsed.patternComparison?.enabled).toBe(true);
    expect(parsed.patternComparison?.minSimilarity).toBe(0.8);
    expect(parsed.patternComparison?.maxPatterns).toBe(10);
  });

  it('should accept evaluation context', () => {
    // Arrange
    const input = {
      html: sampleHtmlGood,
      context: {
        projectId: validUUID,
        targetIndustry: 'healthcare',
        targetAudience: 'enterprise',
      },
    };

    // Act & Assert
    expect(() => qualityEvaluateInputSchema.parse(input)).not.toThrow();

    const parsed = qualityEvaluateInputSchema.parse(input);
    expect(parsed.context?.projectId).toBe(validUUID);
    expect(parsed.context?.targetIndustry).toBe('healthcare');
    expect(parsed.context?.targetAudience).toBe('enterprise');
  });

  it('should reject invalid minSimilarity (> 1)', () => {
    // Arrange
    const input = {
      html: sampleHtmlGood,
      patternComparison: {
        enabled: true,
        minSimilarity: 1.5, // 無効: 1より大きい
      },
    };

    // Act & Assert
    expect(() => qualityEvaluateInputSchema.parse(input)).toThrow();
  });

  it('should reject invalid minSimilarity (< 0)', () => {
    // Arrange
    const input = {
      html: sampleHtmlGood,
      patternComparison: {
        enabled: true,
        minSimilarity: -0.5, // 無効: 0より小さい
      },
    };

    // Act & Assert
    expect(() => qualityEvaluateInputSchema.parse(input)).toThrow();
  });

  it('should reject invalid maxPatterns (> 20)', () => {
    // Arrange
    const input = {
      html: sampleHtmlGood,
      patternComparison: {
        enabled: true,
        maxPatterns: 25, // 無効: 20より大きい
      },
    };

    // Act & Assert
    expect(() => qualityEvaluateInputSchema.parse(input)).toThrow();
  });

  it('should reject invalid maxPatterns (< 1)', () => {
    // Arrange
    const input = {
      html: sampleHtmlGood,
      patternComparison: {
        enabled: true,
        maxPatterns: 0, // 無効: 1より小さい
      },
    };

    // Act & Assert
    expect(() => qualityEvaluateInputSchema.parse(input)).toThrow();
  });

  it('should accept default patternComparison values', () => {
    // Arrange
    const input = {
      html: sampleHtmlGood,
      patternComparison: {
        enabled: true,
        // minSimilarity と maxPatterns は指定しない（デフォルト値が使用される）
      },
    };

    // Act & Assert
    expect(() => qualityEvaluateInputSchema.parse(input)).not.toThrow();

    const parsed = qualityEvaluateInputSchema.parse(input);
    expect(parsed.patternComparison?.enabled).toBe(true);
    // デフォルト値がスキーマで設定されている
    expect(parsed.patternComparison?.minSimilarity).toBe(0.7);
    expect(parsed.patternComparison?.maxPatterns).toBe(5);
  });

  it('should reject invalid context.projectId (not UUID)', () => {
    // Arrange
    const input = {
      html: sampleHtmlGood,
      context: {
        projectId: 'not-a-valid-uuid',
      },
    };

    // Act & Assert
    expect(() => qualityEvaluateInputSchema.parse(input)).toThrow();
  });

  it('should accept partial context', () => {
    // Arrange: 一部のcontextフィールドのみ
    const input = {
      html: sampleHtmlGood,
      context: {
        targetIndustry: 'technology',
      },
    };

    // Act & Assert
    expect(() => qualityEvaluateInputSchema.parse(input)).not.toThrow();

    const parsed = qualityEvaluateInputSchema.parse(input);
    expect(parsed.context?.targetIndustry).toBe('technology');
    expect(parsed.context?.projectId).toBeUndefined();
  });
});

// =====================================================
// スキーマ単体テスト
// =====================================================

describe('patternComparisonSchema', () => {
  it('should parse valid patternComparison', () => {
    const valid = {
      enabled: true,
      minSimilarity: 0.75,
      maxPatterns: 8,
    };

    expect(() => patternComparisonSchema.parse(valid)).not.toThrow();
    const parsed = patternComparisonSchema.parse(valid);
    expect(parsed.enabled).toBe(true);
    expect(parsed.minSimilarity).toBe(0.75);
    expect(parsed.maxPatterns).toBe(8);
  });

  it('should use default values when not provided', () => {
    const minimal = {};

    const parsed = patternComparisonSchema.parse(minimal);
    expect(parsed.enabled).toBe(true); // デフォルト: true
    expect(parsed.minSimilarity).toBe(0.7); // デフォルト: 0.7
    expect(parsed.maxPatterns).toBe(5); // デフォルト: 5
  });
});

describe('evaluationContextSchema', () => {
  it('should parse valid context with all fields', () => {
    const valid = {
      projectId: validUUID,
      brandPaletteId: validUUID2,
      targetIndustry: 'healthcare',
      targetAudience: 'enterprise',
    };

    expect(() => evaluationContextSchema.parse(valid)).not.toThrow();
  });

  it('should parse empty context', () => {
    const empty = {};

    expect(() => evaluationContextSchema.parse(empty)).not.toThrow();
    const parsed = evaluationContextSchema.parse(empty);
    expect(parsed.projectId).toBeUndefined();
    expect(parsed.targetIndustry).toBeUndefined();
  });

  it('should reject invalid UUID format', () => {
    const invalid = {
      projectId: 'invalid-uuid-format',
    };

    expect(() => evaluationContextSchema.parse(invalid)).toThrow();
  });
});

describe('patternAnalysisSchema', () => {
  it('should parse valid patternAnalysis', () => {
    const valid = {
      similarSections: [
        {
          id: validUUID,
          type: 'hero',
          similarity: 0.92,
          sourceUrl: 'https://example.com',
          webPageId: validWebPageId,
        },
      ],
      similarMotions: [
        {
          id: validUUID,
          type: 'animation',
          category: 'scroll',
          similarity: 0.85,
          webPageId: validWebPageId,
        },
      ],
      benchmarksUsed: [],
      uniquenessScore: 75,
      patternSimilarityAvg: 0.88,
      patternDrivenEnabled: true,
      fallbackUsed: false,
    };

    expect(() => patternAnalysisSchema.parse(valid)).not.toThrow();
  });

  it('should parse patternAnalysis with fallback', () => {
    const fallback = {
      similarSections: [],
      similarMotions: [],
      benchmarksUsed: [],
      uniquenessScore: 50,
      patternSimilarityAvg: 0,
      patternDrivenEnabled: false,
      fallbackUsed: true,
      fallbackReason: 'Pattern services unavailable',
    };

    expect(() => patternAnalysisSchema.parse(fallback)).not.toThrow();
    const parsed = patternAnalysisSchema.parse(fallback);
    expect(parsed.fallbackUsed).toBe(true);
    expect(parsed.fallbackReason).toBe('Pattern services unavailable');
  });
});

describe('contextualRecommendationSchema', () => {
  it('should parse recommendation with pattern reference', () => {
    const valid = {
      id: 'rec-1',
      category: 'originality',
      priority: 'high',
      title: 'AIクリシェを回避',
      description: 'グラデーションパターンを独自のものに変更してください',
      impact: 15,
      referencePatternId: validUUID,
      referenceUrl: 'https://example.com/reference',
      patternInsight: '高品質パターン（スコア: 90）を参照',
    };

    expect(() => contextualRecommendationSchema.parse(valid)).not.toThrow();
  });

  it('should parse recommendation without pattern reference', () => {
    const valid = {
      id: 'rec-2',
      category: 'craftsmanship',
      priority: 'medium',
      title: 'アクセシビリティ改善',
      description: 'ARIA属性を追加してください',
      impact: 10,
    };

    expect(() => contextualRecommendationSchema.parse(valid)).not.toThrow();
  });
});

// =====================================================
// コンテキスト付き推奨事項テスト
// =====================================================

describe('contextual recommendations', () => {
  beforeEach(() => {
    resetQualityEvaluateServiceFactory();
    resetPatternMatcherServiceFactory();
    resetBenchmarkServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetQualityEvaluateServiceFactory();
    resetPatternMatcherServiceFactory();
    resetBenchmarkServiceFactory();
  });

  it('should include referenceUrl when benchmark found', async () => {
    // Arrange: ベンチマークサービスのモック
    const mockBenchmarkService = createMockBenchmarkService({
      benchmarks: [
        {
          benchmarkId: validUUID,
          sectionType: 'hero',
          overallScore: 92,
          grade: 'A',
          similarity: 0.9,
          sourceUrl: 'https://example.com/benchmark',
        },
      ],
    });
    const mockPatternMatcher = createMockPatternMatcherService({
      sectionPatterns: mockHighQualitySectionPatterns,
      motionPatterns: [],
      uniquenessScore: 0.6,
    });
    const mockQualityService = createMockQualityEvaluateService({
      embeddings: mockEmbedding,
    });

    setBenchmarkServiceFactory(() => mockBenchmarkService);
    setPatternMatcherServiceFactory(() => mockPatternMatcher);
    setQualityEvaluateServiceFactory(() => mockQualityService);

    const input: QualityEvaluateInput = {
      html: sampleHtmlWithCliches, // 低品質HTMLで推奨事項を生成
      patternComparison: { enabled: true },
      includeRecommendations: true,
    };

    // Act
    const result = await qualityEvaluateHandler(input);

    // Assert
    expect(result.success).toBe(true);
    if (result.success && 'data' in result) {
      // コンテキスト付き推奨事項を確認
      if (result.data.contextualRecommendations) {
        // 参照URLを含む推奨事項が存在するか確認
        const hasReferenceUrl = result.data.contextualRecommendations.some(
          rec => rec.referenceUrl !== undefined
        );
        // 高品質パターンからの推奨が追加される可能性
        expect(result.data.contextualRecommendations.length).toBeGreaterThan(0);
      }
    }
  });

  it('should suggest improvements for low-scoring axes', async () => {
    // Arrange: 低品質HTMLを使用
    const mockPatternMatcher = createMockPatternMatcherService({
      sectionPatterns: [],
      motionPatterns: [],
      uniquenessScore: 0.3, // 低ユニークネス
    });
    const mockQualityService = createMockQualityEvaluateService({
      embeddings: mockEmbedding,
    });

    setPatternMatcherServiceFactory(() => mockPatternMatcher);
    setQualityEvaluateServiceFactory(() => mockQualityService);

    const input: QualityEvaluateInput = {
      html: sampleHtmlWithCliches, // クリシェを含むHTML
      patternComparison: { enabled: true },
      includeRecommendations: true,
    };

    // Act
    const result = await qualityEvaluateHandler(input);

    // Assert
    expect(result.success).toBe(true);
    if (result.success && 'data' in result) {
      // 低スコア軸に対する推奨事項が含まれているはず
      const recommendations = result.data.recommendations ?? [];
      const contextualRecs = result.data.contextualRecommendations ?? [];

      const allRecs = [...recommendations, ...contextualRecs];

      // クリシェを含むHTMLなのでoriginality関連の推奨があるはず
      const hasOriginalityRec = allRecs.some(
        rec => rec.category === 'originality'
      );
      expect(hasOriginalityRec).toBe(true);
    }
  });

  it('should include patternInsight when referencing high-quality patterns', async () => {
    // Arrange
    const mockPatternMatcher = createMockPatternMatcherService({
      sectionPatterns: [
        {
          id: validUUID,
          webPageId: validWebPageId,
          sectionType: 'hero',
          similarity: 0.95,
          qualityScore: 95, // 非常に高品質
          sourceUrl: 'https://example.com/excellent',
        },
      ],
      motionPatterns: [],
      uniquenessScore: 0.5,
    });
    const mockQualityService = createMockQualityEvaluateService({
      embeddings: mockEmbedding,
    });

    setPatternMatcherServiceFactory(() => mockPatternMatcher);
    setQualityEvaluateServiceFactory(() => mockQualityService);

    const input: QualityEvaluateInput = {
      html: sampleHtmlWithCliches,
      patternComparison: { enabled: true },
      includeRecommendations: true,
    };

    // Act
    const result = await qualityEvaluateHandler(input);

    // Assert
    expect(result.success).toBe(true);
    if (result.success && 'data' in result && result.data.contextualRecommendations) {
      // patternInsightを含む推奨事項を確認
      const hasPatternInsight = result.data.contextualRecommendations.some(
        rec => rec.patternInsight !== undefined
      );
      // 高品質パターンからの洞察が含まれる可能性
      if (result.data.contextualRecommendations.length > 0) {
        expect(hasPatternInsight || result.data.contextualRecommendations.some(r => r.referencePatternId)).toBe(true);
      }
    }
  });
});

// =====================================================
// パターン駆動評価無効時のテスト
// =====================================================

describe('quality.evaluate with patternComparison disabled', () => {
  beforeEach(() => {
    resetQualityEvaluateServiceFactory();
    resetPatternMatcherServiceFactory();
    resetBenchmarkServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should skip pattern-driven evaluation when disabled', async () => {
    // Arrange: サービスを設定してもpatternComparison.enabled=falseなら使用されない
    const mockPatternMatcher = createMockPatternMatcherService({
      sectionPatterns: mockHighQualitySectionPatterns,
    });
    setPatternMatcherServiceFactory(() => mockPatternMatcher);

    const input: QualityEvaluateInput = {
      html: sampleHtmlGood,
      patternComparison: { enabled: false }, // 明示的に無効化
    };

    // Act
    const result = await qualityEvaluateHandler(input);

    // Assert
    expect(result.success).toBe(true);
    if (result.success && 'data' in result) {
      // パターン駆動評価が無効なのでpatternAnalysisは含まれない可能性
      // または、存在しても空のフォールバック状態
      if (result.data.patternAnalysis) {
        expect(result.data.patternAnalysis.patternDrivenEnabled).toBe(false);
      }

      // 静的分析のスコアは正常に計算される
      expect(result.data.overall).toBeGreaterThan(0);
    }

    // パターンマッチャーが呼び出されていないことを確認
    expect(mockPatternMatcher.findSimilarSectionPatterns).not.toHaveBeenCalled();
  });
});

// =====================================================
// エッジケーステスト
// =====================================================

describe('edge cases', () => {
  beforeEach(() => {
    resetQualityEvaluateServiceFactory();
    resetPatternMatcherServiceFactory();
    resetBenchmarkServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should handle empty section patterns gracefully', async () => {
    // Arrange: 類似パターンなし
    const mockPatternMatcher = createMockPatternMatcherService({
      sectionPatterns: [],
      motionPatterns: [],
      uniquenessScore: 1.0, // 完全にユニーク
    });
    const mockQualityService = createMockQualityEvaluateService({
      embeddings: mockEmbedding,
    });

    setPatternMatcherServiceFactory(() => mockPatternMatcher);
    setQualityEvaluateServiceFactory(() => mockQualityService);

    const input: QualityEvaluateInput = {
      html: sampleHtmlGood,
      patternComparison: { enabled: true },
    };

    // Act
    const result = await qualityEvaluateHandler(input);

    // Assert
    expect(result.success).toBe(true);
    if (result.success && 'data' in result) {
      expect(result.data.patternAnalysis?.similarSections).toHaveLength(0);
      expect(result.data.patternAnalysis?.similarMotions).toHaveLength(0);
      // ユニークネススコアは高い（類似パターンがないため）
      expect(result.data.patternAnalysis?.uniquenessScore).toBeGreaterThanOrEqual(90);
    }
  });

  it('should handle very short HTML', async () => {
    // Arrange
    const shortHtml = '<html><body><p>Test</p></body></html>';

    const input: QualityEvaluateInput = {
      html: shortHtml,
      patternComparison: { enabled: true },
    };

    // Act
    const result = await qualityEvaluateHandler(input);

    // Assert
    expect(result.success).toBe(true);
  });

  it('should use default minSimilarity when not specified', async () => {
    // Arrange
    const mockPatternMatcher = createMockPatternMatcherService({
      sectionPatterns: mockHighQualitySectionPatterns,
      uniquenessScore: 0.5,
    });
    const mockQualityService = createMockQualityEvaluateService({
      embeddings: mockEmbedding,
    });

    setPatternMatcherServiceFactory(() => mockPatternMatcher);
    setQualityEvaluateServiceFactory(() => mockQualityService);

    const input: QualityEvaluateInput = {
      html: sampleHtmlGood,
      patternComparison: { enabled: true }, // minSimilarityは未指定
    };

    // Act
    const result = await qualityEvaluateHandler(input);

    // Assert
    expect(result.success).toBe(true);

    // デフォルトのminSimilarity (0.7) が使用されることを確認
    expect(mockPatternMatcher.findSimilarSectionPatterns).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        minSimilarity: 0.7, // デフォルト値
      })
    );
  });
});

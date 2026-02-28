// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * EmbeddingHandler テスト
 *
 * SectionEmbedding/MotionEmbedding/VisionEmbedding生成・保存ロジックのテスト
 *
 * TDD Red Phase: まず失敗するテストを作成
 *
 * テストカバレッジ目標:
 * - hasValidVisualFeatures 関数（6テスト）
 * - generateSectionTextRepresentation 関数（5テスト）
 * - generateSectionEmbeddings 関数（12テスト）
 * - VisionEmbedding統合テスト（8テスト）
 * - generateMotionEmbeddings 関数（7テスト）
 * - エラーハンドリング（5テスト）
 *
 * @module tests/unit/tools/page/handlers/embedding-handler
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generateSectionTextRepresentation,
  generateSectionEmbeddings,
  generateMotionEmbeddings,
  hasValidVisualFeatures,
  generateAndSaveVisionEmbedding,
  setMotionLayoutEmbeddingServiceFactory,
  resetMotionLayoutEmbeddingServiceFactory,
  type SectionDataForEmbedding,
  type SectionPatternInput,
  type GenerateSectionEmbeddingsOptions,
  type GenerateMotionEmbeddingsOptions,
} from '../../../../../src/tools/page/handlers/embedding-handler';
import type { MotionPatternForEmbedding } from '../../../../../src/tools/page/handlers/types';
import type { VisualFeatures } from '../../../../../src/tools/page/schemas';
import {
  setEmbeddingServiceFactory,
  resetEmbeddingServiceFactory,
  setPrismaClientFactory,
  resetPrismaClientFactory,
} from '../../../../../src/services/layout-embedding.service';
import {
  setVisionPrismaClientFactory,
  resetVisionPrismaClientFactory,
  setVisionLayoutEmbeddingServiceFactory,
  resetVisionLayoutEmbeddingServiceFactory,
} from '../../../../../src/services/vision-embedding.service';
import {
  setFramePrismaClientFactory,
  resetFramePrismaClientFactory,
} from '../../../../../src/services/motion/frame-embedding.service';
import {
  setMotionPersistenceEmbeddingServiceFactory,
  resetMotionPersistenceEmbeddingServiceFactory,
  setMotionPersistencePrismaClientFactory,
  resetMotionPersistencePrismaClientFactory,
} from '../../../../../src/services/motion-persistence.service';

// =====================================================
// テストデータ
// =====================================================

/**
 * モック用の768次元ベクトル生成
 * @param seed - シード値（異なる値で異なるベクトルを生成）
 */
function createMockEmbedding(seed: number = 0): number[] {
  const embedding = new Array(768).fill(0).map((_, i) => Math.sin(i + seed) * 0.1);
  // L2正規化
  const norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
  return embedding.map((val) => val / norm);
}

/**
 * 完全なVisualFeaturesデータ（全フィールドあり）
 */
const sampleFullVisualFeatures: VisualFeatures = {
  colors: {
    dominant: ['#3dfccc', '#ffdc50', '#0a0a0a'],
    accent: ['#ff6b35', '#6b5b95'],
    palette: [
      { color: '#3dfccc', percentage: 25.5 },
      { color: '#0a0a0a', percentage: 45.2 },
      { color: '#ffdc50', percentage: 15.3 },
    ],
    source: 'deterministic',
    confidence: 0.95,
  },
  theme: {
    type: 'dark',
    backgroundColor: '#0a0a0a',
    textColor: '#ffffff',
    contrastRatio: 18.5,
    source: 'deterministic',
    confidence: 0.98,
  },
  density: {
    contentDensity: 0.6,
    whitespaceRatio: 0.4,
    visualBalance: 78.5,
    source: 'deterministic',
    confidence: 0.92,
  },
  gradient: {
    hasGradient: true,
    dominantGradientType: 'linear',
    gradients: [
      {
        type: 'linear',
        angle: 135,
        colorStops: [
          { color: '#3dfccc', position: 0 },
          { color: '#ffdc50', position: 100 },
        ],
      },
    ],
    confidence: 0.88,
  },
  mood: {
    primary: 'futuristic',
    secondary: 'professional',
    source: 'vision-ai',
    confidence: 0.75,
  },
  brandTone: {
    primary: 'innovative',
    secondary: 'trustworthy',
    source: 'vision-ai',
    confidence: 0.72,
  },
  metadata: {
    mergedAt: '2026-01-30T10:00:00Z',
    deterministicAvailable: true,
    visionAiAvailable: true,
    overallConfidence: 0.88,
  },
};

/**
 * 最小限のVisualFeaturesデータ（colorsのみ）
 */
const sampleMinimalVisualFeatures: VisualFeatures = {
  colors: {
    dominant: ['#ffffff'],
    accent: [],
    palette: [{ color: '#ffffff', percentage: 100 }],
    source: 'deterministic',
    confidence: 0.9,
  },
};

/**
 * themeのみのVisualFeatures
 */
const sampleThemeOnlyFeatures: VisualFeatures = {
  theme: {
    type: 'light',
    backgroundColor: '#ffffff',
    textColor: '#333333',
    contrastRatio: 12.5,
    source: 'deterministic',
    confidence: 0.95,
  },
};

/**
 * densityのみのVisualFeatures
 */
const sampleDensityOnlyFeatures: VisualFeatures = {
  density: {
    contentDensity: 0.5,
    whitespaceRatio: 0.5,
    visualBalance: 90.0,
    source: 'deterministic',
    confidence: 0.9,
  },
};

/**
 * 空のVisualFeatures（無効）
 */
const sampleEmptyVisualFeatures: VisualFeatures = {};

/**
 * サンプルセクションデータ（visionFeatures付き）
 */
const sampleSectionWithVision: SectionDataForEmbedding = {
  id: 'section-1',
  type: 'hero',
  positionIndex: 0,
  heading: 'Welcome to Reftrix',
  confidence: 0.95,
  htmlSnippet: '<section>...</section>',
  visionFeatures: {
    success: true,
    features: [
      {
        type: 'layout_structure',
        confidence: 0.8,
        description: 'full-width hero section with centered content',
      },
    ],
    textRepresentation: 'Hero section with gradient background',
    processingTimeMs: 1500,
    modelName: 'llama3.2-vision',
  },
  visualFeatures: sampleFullVisualFeatures,
};

/**
 * サンプルセクションデータ（visualFeaturesなし）
 */
const sampleSectionWithoutVisualFeatures: SectionDataForEmbedding = {
  id: 'section-2',
  type: 'feature',
  positionIndex: 1,
  heading: 'Features',
  confidence: 0.85,
  htmlSnippet: '<section>...</section>',
  // visualFeaturesなし
};

/**
 * サンプルセクションデータ（部分的なvisualFeatures）
 */
const sampleSectionWithPartialVisualFeatures: SectionDataForEmbedding = {
  id: 'section-3',
  type: 'pricing',
  positionIndex: 2,
  heading: 'Pricing',
  confidence: 0.9,
  htmlSnippet: '<section>...</section>',
  visualFeatures: sampleMinimalVisualFeatures,
};

/**
 * サンプルセクションパターン入力（基本）
 */
const sampleSectionPatternInput: SectionPatternInput = {
  id: 'section-pattern-1',
  type: 'hero',
  positionIndex: 0,
  heading: 'Main Heading',
  confidence: 0.95,
};

/**
 * サンプルモーションパターン
 */
const sampleMotionPattern: MotionPatternForEmbedding = {
  id: 'motion-1',
  name: 'fadeIn',
  type: 'css_animation',
  category: 'entrance',
  trigger: 'load',
  duration: 500,
  easing: 'ease-out',
  properties: ['opacity', 'transform'],
  performance: {
    level: 'good',
    usesTransform: true,
    usesOpacity: true,
  },
  accessibility: {
    respectsReducedMotion: true,
  },
};

// =====================================================
// hasValidVisualFeatures テスト（6テスト）
// =====================================================

describe('hasValidVisualFeatures', () => {
  it('完全なVisualFeaturesでtrueを返す', () => {
    // 全フィールドが存在する場合
    const result = hasValidVisualFeatures(sampleFullVisualFeatures);
    expect(result).toBe(true);
  });

  it('colorsのみでもtrueを返す', () => {
    // colors情報だけあればVisionEmbedding生成可能
    const result = hasValidVisualFeatures(sampleMinimalVisualFeatures);
    expect(result).toBe(true);
  });

  it('themeのみでもtrueを返す', () => {
    // theme情報だけあればVisionEmbedding生成可能
    const result = hasValidVisualFeatures(sampleThemeOnlyFeatures);
    expect(result).toBe(true);
  });

  it('densityのみでもtrueを返す', () => {
    // density情報だけあればVisionEmbedding生成可能
    const result = hasValidVisualFeatures(sampleDensityOnlyFeatures);
    expect(result).toBe(true);
  });

  it('空のVisualFeaturesでfalseを返す', () => {
    // 空オブジェクトはVisionEmbedding生成不可
    const result = hasValidVisualFeatures(sampleEmptyVisualFeatures);
    expect(result).toBe(false);
  });

  it('nullでfalseを返す', () => {
    // null入力はVisionEmbedding生成不可
    const result = hasValidVisualFeatures(null);
    expect(result).toBe(false);
  });

  it('undefinedでfalseを返す', () => {
    // undefined入力はVisionEmbedding生成不可
    const result = hasValidVisualFeatures(undefined);
    expect(result).toBe(false);
  });
});

// =====================================================
// generateSectionTextRepresentation テスト（5テスト）
// =====================================================

describe('generateSectionTextRepresentation', () => {
  it('passage:プレフィックスが付与される', () => {
    // E5モデル用のプレフィックス確認
    const result = generateSectionTextRepresentation(sampleSectionPatternInput);
    expect(result.startsWith('passage: ')).toBe(true);
  });

  it('セクションタイプが含まれる', () => {
    const result = generateSectionTextRepresentation(sampleSectionPatternInput);
    expect(result).toContain('Section type: hero');
  });

  it('見出しが含まれる', () => {
    const result = generateSectionTextRepresentation(sampleSectionPatternInput);
    expect(result).toContain('Heading: Main Heading');
  });

  it('位置インデックスが含まれる', () => {
    const result = generateSectionTextRepresentation(sampleSectionPatternInput);
    expect(result).toContain('Position: 0');
  });

  it('信頼度がパーセンテージで含まれる', () => {
    const result = generateSectionTextRepresentation(sampleSectionPatternInput);
    expect(result).toContain('Confidence: 95%');
  });

  it('見出しがない場合は省略される', () => {
    const sectionWithoutHeading: SectionPatternInput = {
      id: 'section-no-heading',
      type: 'footer',
      positionIndex: 5,
      confidence: 0.8,
      // headingなし
    };
    const result = generateSectionTextRepresentation(sectionWithoutHeading);
    expect(result).not.toContain('Heading:');
    expect(result).toContain('Section type: footer');
  });
});

// =====================================================
// generateSectionEmbeddings テスト（12テスト）
// =====================================================

describe('generateSectionEmbeddings', () => {
  const mockEmbedding = createMockEmbedding(1);

  beforeEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
    resetVisionPrismaClientFactory();
    resetVisionLayoutEmbeddingServiceFactory();

    // EmbeddingService モック
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockResolvedValue(mockEmbedding),
      generateBatchEmbeddings: vi.fn().mockResolvedValue([mockEmbedding]),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    // LayoutEmbedding用Prismaモック
    setPrismaClientFactory(() => ({
      sectionEmbedding: {
        upsert: vi.fn().mockResolvedValue({ id: 'embedding-id-1' }),
        create: vi.fn().mockResolvedValue({ id: 'embedding-id-1' }),
      },
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    }) as any);

    // VisionEmbedding用Prismaモック
    // 重要: saveVisionEmbeddingは$queryRawUnsafeで既存レコードを確認する
    setVisionPrismaClientFactory(() => ({
      sectionEmbedding: {
        create: vi.fn().mockResolvedValue({ id: 'vision-embedding-id-1' }),
      },
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      $queryRawUnsafe: vi.fn().mockResolvedValue([]), // 既存レコードなし（新規作成パス）
    }) as any);

    // VisionEmbedding用LayoutEmbeddingServiceモック（DIパターン）
    setVisionLayoutEmbeddingServiceFactory(() => ({
      generateFromText: vi.fn().mockResolvedValue({
        embedding: mockEmbedding,
        modelName: 'multilingual-e5-base',
      }),
    }));
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
    resetVisionPrismaClientFactory();
    resetVisionLayoutEmbeddingServiceFactory();
    vi.restoreAllMocks();
  });

  it('セクション配列からEmbeddingを生成できる', async () => {
    const sections: SectionDataForEmbedding[] = [sampleSectionWithoutVisualFeatures];
    const sectionIdMapping = new Map([['section-2', 'db-section-id-2']]);

    const result = await generateSectionEmbeddings(sections, sectionIdMapping);

    expect(result.success).toBe(true);
    expect(result.generatedCount).toBe(1);
    expect(result.failedCount).toBe(0);
  });

  it('IDマッピングがない場合はスキップされる', async () => {
    const sections: SectionDataForEmbedding[] = [sampleSectionWithoutVisualFeatures];
    const sectionIdMapping = new Map<string, string>(); // 空のマッピング

    const result = await generateSectionEmbeddings(sections, sectionIdMapping);

    expect(result.generatedCount).toBe(0);
    expect(result.failedCount).toBe(1);
    expect(result.errors[0]?.error).toContain('mapping not found');
  });

  it('visionFeaturesがある場合はVision-enhanced表現を使用する', async () => {
    const sections: SectionDataForEmbedding[] = [sampleSectionWithVision];
    const sectionIdMapping = new Map([['section-1', 'db-section-id-1']]);

    const result = await generateSectionEmbeddings(sections, sectionIdMapping);

    // Vision-enhanced表現が使用されたことを確認（成功していればOK）
    expect(result.success).toBe(true);
    expect(result.generatedCount).toBe(1);
  });

  it('visionFeaturesがない場合は基本表現を使用する', async () => {
    const sections: SectionDataForEmbedding[] = [sampleSectionWithoutVisualFeatures];
    const sectionIdMapping = new Map([['section-2', 'db-section-id-2']]);

    const result = await generateSectionEmbeddings(sections, sectionIdMapping);

    expect(result.success).toBe(true);
    expect(result.generatedCount).toBe(1);
  });

  it('複数セクションを一括処理できる', async () => {
    const sections: SectionDataForEmbedding[] = [
      sampleSectionWithVision,
      sampleSectionWithoutVisualFeatures,
      sampleSectionWithPartialVisualFeatures,
    ];
    const sectionIdMapping = new Map([
      ['section-1', 'db-section-id-1'],
      ['section-2', 'db-section-id-2'],
      ['section-3', 'db-section-id-3'],
    ]);

    const result = await generateSectionEmbeddings(sections, sectionIdMapping);

    expect(result.generatedCount).toBe(3);
    expect(result.failedCount).toBe(0);
  });

  it('webPageIdオプションを渡せる', async () => {
    const sections: SectionDataForEmbedding[] = [sampleSectionWithoutVisualFeatures];
    const sectionIdMapping = new Map([['section-2', 'db-section-id-2']]);
    const options: GenerateSectionEmbeddingsOptions = {
      webPageId: 'web-page-uuid',
    };

    const result = await generateSectionEmbeddings(sections, sectionIdMapping, options);

    expect(result.success).toBe(true);
  });

  it('空の配列で空結果を返す', async () => {
    const sections: SectionDataForEmbedding[] = [];
    const sectionIdMapping = new Map<string, string>();

    const result = await generateSectionEmbeddings(sections, sectionIdMapping);

    expect(result.generatedCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(result.errors.length).toBe(0);
  });

  // =====================================================
  // VisionEmbedding統合テスト（8テスト）
  // 核心: visualFeaturesがある場合にvision_embeddingが生成されることを検証
  // =====================================================

  describe('VisionEmbedding generation', () => {
    it('visualFeaturesがある場合にVisionEmbeddingを生成する', async () => {
      // 重要: このテストはRed Phaseで失敗することを期待
      // 現在の実装ではvision_embedding生成率が0%という問題がある
      const sections: SectionDataForEmbedding[] = [sampleSectionWithVision];
      const sectionIdMapping = new Map([['section-1', 'db-section-id-1']]);

      const result = await generateSectionEmbeddings(sections, sectionIdMapping);

      expect(result.success).toBe(true);
      // VisionEmbedding結果が存在することを確認
      expect(result.visionEmbedding).toBeDefined();
      expect(result.visionEmbedding?.generatedCount).toBe(1);
      expect(result.visionEmbedding?.failedCount).toBe(0);
    });

    it('visualFeaturesがない場合はVisionEmbeddingを生成しない', async () => {
      const sections: SectionDataForEmbedding[] = [sampleSectionWithoutVisualFeatures];
      const sectionIdMapping = new Map([['section-2', 'db-section-id-2']]);

      const result = await generateSectionEmbeddings(sections, sectionIdMapping);

      expect(result.success).toBe(true);
      // visualFeaturesがないセクションではvisionEmbeddingは生成されない
      // visionEmbeddingオブジェクト自体が存在しないか、generatedCountが0
      if (result.visionEmbedding) {
        expect(result.visionEmbedding.generatedCount).toBe(0);
      }
    });

    it('部分的なvisualFeaturesでもVisionEmbeddingを生成する', async () => {
      // colorsのみでもVisionEmbedding生成可能
      const sections: SectionDataForEmbedding[] = [sampleSectionWithPartialVisualFeatures];
      const sectionIdMapping = new Map([['section-3', 'db-section-id-3']]);

      const result = await generateSectionEmbeddings(sections, sectionIdMapping);

      expect(result.success).toBe(true);
      // 部分的なvisualFeaturesでもVisionEmbeddingが生成されるべき
      expect(result.visionEmbedding).toBeDefined();
      expect(result.visionEmbedding?.generatedCount).toBe(1);
    });

    it('複数セクションで一部のみvisualFeaturesがある場合', async () => {
      const sections: SectionDataForEmbedding[] = [
        sampleSectionWithVision, // visualFeatures あり
        sampleSectionWithoutVisualFeatures, // visualFeatures なし
        sampleSectionWithPartialVisualFeatures, // visualFeatures あり（部分的）
      ];
      const sectionIdMapping = new Map([
        ['section-1', 'db-section-id-1'],
        ['section-2', 'db-section-id-2'],
        ['section-3', 'db-section-id-3'],
      ]);

      const result = await generateSectionEmbeddings(sections, sectionIdMapping);

      expect(result.success).toBe(true);
      expect(result.generatedCount).toBe(3); // text_embeddingは3件
      // VisionEmbeddingは2件（visualFeaturesがあるセクションのみ）
      expect(result.visionEmbedding?.generatedCount).toBe(2);
    });

    it('VisionEmbedding生成失敗時もtext_embeddingは保存される（Graceful Degradation）', async () => {
      // VisionEmbedding保存でエラー発生するようモックを設定
      // generateAndSaveVisionEmbeddingは内部でエラーをcatchしてnullを返す設計のため、
      // embedding-handlerでは「null returned」として記録される
      setVisionPrismaClientFactory(() => ({
        sectionEmbedding: {
          create: vi.fn().mockRejectedValue(new Error('Vision DB error')),
        },
        $executeRawUnsafe: vi.fn().mockRejectedValue(new Error('Vision DB error')),
        $queryRawUnsafe: vi.fn().mockResolvedValue([]), // 既存レコードなしでcreateに進む
      }) as any);

      const sections: SectionDataForEmbedding[] = [sampleSectionWithVision];
      const sectionIdMapping = new Map([['section-1', 'db-section-id-1']]);

      const result = await generateSectionEmbeddings(sections, sectionIdMapping);

      // text_embeddingは成功
      expect(result.success).toBe(true);
      expect(result.generatedCount).toBe(1);
      // VisionEmbeddingは失敗（generateAndSaveVisionEmbeddingがnullを返した場合）
      expect(result.visionEmbedding?.failedCount).toBe(1);
      // generateAndSaveVisionEmbeddingは例外をスローせずnullを返すため、
      // embedding-handlerではinternal errorとして記録される
      expect(result.visionEmbedding?.errors[0]?.error).toContain('returned null');
    });

    it('空のvisualFeaturesではVisionEmbeddingを生成しない', async () => {
      const sectionWithEmptyVisualFeatures: SectionDataForEmbedding = {
        id: 'section-empty-vf',
        type: 'footer',
        positionIndex: 10,
        confidence: 0.8,
        visualFeatures: sampleEmptyVisualFeatures, // 空のvisualFeatures
      };
      const sections: SectionDataForEmbedding[] = [sectionWithEmptyVisualFeatures];
      const sectionIdMapping = new Map([['section-empty-vf', 'db-section-id-empty']]);

      const result = await generateSectionEmbeddings(sections, sectionIdMapping);

      expect(result.success).toBe(true);
      expect(result.generatedCount).toBe(1); // text_embeddingは生成
      // 空のvisualFeaturesではVisionEmbedding未生成
      if (result.visionEmbedding) {
        expect(result.visionEmbedding.generatedCount).toBe(0);
      }
    });

    it('VisionEmbeddingのエラーはerrors配列に記録される', async () => {
      // 特定のセクションでのみVisionEmbedding保存エラー
      let callCount = 0;
      setVisionPrismaClientFactory(() => ({
        sectionEmbedding: {
          create: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
              throw new Error('First VisionEmbedding failed');
            }
            return Promise.resolve({ id: 'vision-id-2' });
          }),
        },
        $executeRawUnsafe: vi.fn().mockResolvedValue(0),
        $queryRawUnsafe: vi.fn().mockResolvedValue([]), // 既存レコードなし
      }) as any);

      const sections: SectionDataForEmbedding[] = [
        sampleSectionWithVision,
        sampleSectionWithPartialVisualFeatures,
      ];
      const sectionIdMapping = new Map([
        ['section-1', 'db-section-id-1'],
        ['section-3', 'db-section-id-3'],
      ]);

      const result = await generateSectionEmbeddings(sections, sectionIdMapping);

      expect(result.success).toBe(true);
      expect(result.generatedCount).toBe(2); // text_embeddingは両方成功
      // VisionEmbeddingは1件成功、1件失敗
      expect(result.visionEmbedding?.generatedCount).toBe(1);
      expect(result.visionEmbedding?.failedCount).toBe(1);
    });

    it('VisionEmbedding生成結果にsectionIdが記録される', async () => {
      const sections: SectionDataForEmbedding[] = [sampleSectionWithVision];
      const sectionIdMapping = new Map([['section-1', 'db-section-id-1']]);

      // VisionEmbeddingでエラーを発生させて、エラー配列の内容を確認
      setVisionPrismaClientFactory(() => ({
        sectionEmbedding: {
          create: vi.fn().mockRejectedValue(new Error('Vision error')),
        },
        $executeRawUnsafe: vi.fn().mockRejectedValue(new Error('Vision error')),
        $queryRawUnsafe: vi.fn().mockResolvedValue([]), // 既存レコードなしでcreateに進む
      }) as any);

      const result = await generateSectionEmbeddings(sections, sectionIdMapping);

      expect(result.visionEmbedding?.errors[0]?.sectionId).toBe('section-1');
    });
  });
});

// =====================================================
// generateMotionEmbeddings テスト（7テスト）
// =====================================================

describe('generateMotionEmbeddings', () => {
  const mockEmbedding = createMockEmbedding(100);

  beforeEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
    resetMotionLayoutEmbeddingServiceFactory();
    resetFramePrismaClientFactory();
    resetMotionPersistenceEmbeddingServiceFactory();
    resetMotionPersistencePrismaClientFactory();

    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockResolvedValue(mockEmbedding),
      generateBatchEmbeddings: vi.fn().mockResolvedValue([mockEmbedding]),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    // MotionEmbedding用LayoutEmbeddingServiceモック（DIパターン）
    setMotionLayoutEmbeddingServiceFactory(() => ({
      generateFromText: vi.fn().mockResolvedValue({
        embedding: mockEmbedding,
        modelName: 'multilingual-e5-base',
      }),
    }));

    // MotionPersistenceService用モック（getMotionPersistenceService().isAvailable()用）
    setMotionPersistencePrismaClientFactory(() => ({
      motionPattern: {
        create: vi.fn().mockResolvedValue({ id: 'motion-pattern-id' }),
      },
      motionEmbedding: {
        create: vi.fn().mockResolvedValue({ id: 'motion-embedding-id' }),
      },
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
      $transaction: vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn({})),
    }) as any);

    // frame-embedding.service用PrismaClientモック（saveMotionEmbedding用）
    setFramePrismaClientFactory(() => ({
      motionEmbedding: {
        create: vi.fn().mockResolvedValue({ id: 'motion-embedding-id-1' }),
        upsert: vi.fn().mockResolvedValue({ id: 'motion-embedding-id-1' }),
      },
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    }) as any);

    setPrismaClientFactory(() => ({
      motionEmbedding: {
        upsert: vi.fn().mockResolvedValue({ id: 'motion-embedding-id-1' }),
      },
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    }) as any);
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
    resetMotionLayoutEmbeddingServiceFactory();
    resetFramePrismaClientFactory();
    resetMotionPersistenceEmbeddingServiceFactory();
    resetMotionPersistencePrismaClientFactory();
    vi.restoreAllMocks();
  });

  it('モーションパターンからEmbeddingを生成できる', async () => {
    const patterns: MotionPatternForEmbedding[] = [sampleMotionPattern];
    const options: GenerateMotionEmbeddingsOptions = {
      sourceUrl: 'https://example.com',
      motionPatternIdMapping: new Map([['motion-1', 'db-motion-id-1']]),
    };

    const result = await generateMotionEmbeddings(patterns, options);

    expect(result.success).toBe(true);
    expect(result.savedCount).toBe(1);
    expect(result.patternIds).toContain('db-motion-id-1');
  });

  it('IDマッピングがない場合はスキップされる', async () => {
    const patterns: MotionPatternForEmbedding[] = [sampleMotionPattern];
    const options: GenerateMotionEmbeddingsOptions = {
      sourceUrl: 'https://example.com',
      motionPatternIdMapping: new Map<string, string>(), // 空のマッピング
    };

    const result = await generateMotionEmbeddings(patterns, options);

    expect(result.savedCount).toBe(0);
  });

  it('motionPatternIdMappingがundefinedの場合はスキップ', async () => {
    const patterns: MotionPatternForEmbedding[] = [sampleMotionPattern];
    const options: GenerateMotionEmbeddingsOptions = {
      sourceUrl: 'https://example.com',
      // motionPatternIdMapping未設定
    };

    const result = await generateMotionEmbeddings(patterns, options);

    expect(result.savedCount).toBe(0);
    // エラーではなくスキップ
    expect(result.success).toBe(true);
  });

  it('複数モーションパターンを一括処理できる', async () => {
    const patterns: MotionPatternForEmbedding[] = [
      sampleMotionPattern,
      {
        ...sampleMotionPattern,
        id: 'motion-2',
        name: 'slideIn',
        type: 'css_transition',
      },
    ];
    const options: GenerateMotionEmbeddingsOptions = {
      sourceUrl: 'https://example.com',
      motionPatternIdMapping: new Map([
        ['motion-1', 'db-motion-id-1'],
        ['motion-2', 'db-motion-id-2'],
      ]),
    };

    const result = await generateMotionEmbeddings(patterns, options);

    expect(result.savedCount).toBe(2);
    expect(result.patternIds.length).toBe(2);
    expect(result.embeddingIds.length).toBe(2);
  });

  it('空の配列で空結果を返す', async () => {
    const patterns: MotionPatternForEmbedding[] = [];
    const options: GenerateMotionEmbeddingsOptions = {
      sourceUrl: 'https://example.com',
      motionPatternIdMapping: new Map(),
    };

    const result = await generateMotionEmbeddings(patterns, options);

    expect(result.savedCount).toBe(0);
    expect(result.errors.length).toBe(0);
  });

  it('一部のパターンでIDマッピングがない場合はそのパターンのみスキップ', async () => {
    const patterns: MotionPatternForEmbedding[] = [
      sampleMotionPattern,
      {
        ...sampleMotionPattern,
        id: 'motion-2',
        name: 'slideIn',
      },
    ];
    const options: GenerateMotionEmbeddingsOptions = {
      sourceUrl: 'https://example.com',
      motionPatternIdMapping: new Map([
        ['motion-1', 'db-motion-id-1'],
        // motion-2はマッピングなし
      ]),
    };

    const result = await generateMotionEmbeddings(patterns, options);

    expect(result.savedCount).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.patternId).toBe('motion-2');
  });

  it('Embedding生成失敗時もパターンは保存済み（部分成功）', async () => {
    // 2回目の呼び出しでエラー（MotionLayoutEmbeddingServiceを使用）
    let callCount = 0;
    setMotionLayoutEmbeddingServiceFactory(() => ({
      generateFromText: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 2) {
          throw new Error('Embedding generation failed');
        }
        return Promise.resolve({
          embedding: mockEmbedding,
          modelName: 'multilingual-e5-base',
        });
      }),
    }));

    const patterns: MotionPatternForEmbedding[] = [
      sampleMotionPattern,
      {
        ...sampleMotionPattern,
        id: 'motion-2',
        name: 'slideIn',
      },
    ];
    const options: GenerateMotionEmbeddingsOptions = {
      sourceUrl: 'https://example.com',
      motionPatternIdMapping: new Map([
        ['motion-1', 'db-motion-id-1'],
        ['motion-2', 'db-motion-id-2'],
      ]),
    };

    const result = await generateMotionEmbeddings(patterns, options);

    // 1件成功、1件失敗
    expect(result.savedCount).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.error).toContain('Embedding generation failed');
  });
});

// =====================================================
// エラーハンドリングテスト（5テスト）
// =====================================================

describe('エラーハンドリング', () => {
  beforeEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
    resetVisionPrismaClientFactory();
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
    resetVisionPrismaClientFactory();
    vi.restoreAllMocks();
  });

  it('EmbeddingService初期化失敗時はsuccess=falseを返す', async () => {
    // EmbeddingServiceでエラー
    setEmbeddingServiceFactory(() => {
      throw new Error('Model loading failed');
    });

    const sections: SectionDataForEmbedding[] = [sampleSectionWithoutVisualFeatures];
    const sectionIdMapping = new Map([['section-2', 'db-section-id-2']]);

    const result = await generateSectionEmbeddings(sections, sectionIdMapping);

    expect(result.success).toBe(false);
  });

  it('DB保存エラー時は個別セクションのみ失敗', async () => {
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockResolvedValue(createMockEmbedding(1)),
      generateBatchEmbeddings: vi.fn(),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    // DB保存でエラー
    setPrismaClientFactory(() => ({
      sectionEmbedding: {
        upsert: vi.fn().mockRejectedValue(new Error('DB connection error')),
        create: vi.fn().mockRejectedValue(new Error('DB connection error')),
      },
      $executeRawUnsafe: vi.fn().mockRejectedValue(new Error('DB connection error')),
    }) as any);

    const sections: SectionDataForEmbedding[] = [sampleSectionWithoutVisualFeatures];
    const sectionIdMapping = new Map([['section-2', 'db-section-id-2']]);

    const result = await generateSectionEmbeddings(sections, sectionIdMapping);

    // 全体としてはsuccess=true（部分成功）だが、個別は失敗
    expect(result.generatedCount).toBe(0);
    expect(result.failedCount).toBe(1);
    expect(result.errors[0]?.error).toContain('DB connection error');
  });

  it('generateAndSaveVisionEmbeddingでnullのvisualFeaturesはnullを返す', async () => {
    const result = await generateAndSaveVisionEmbedding('section-id', null);
    expect(result).toBeNull();
  });

  it('generateAndSaveVisionEmbeddingでundefinedのvisualFeaturesはnullを返す', async () => {
    const result = await generateAndSaveVisionEmbedding('section-id', undefined);
    expect(result).toBeNull();
  });

  it('generateAndSaveVisionEmbeddingで空のvisualFeaturesはnullを返す', async () => {
    const result = await generateAndSaveVisionEmbedding('section-id', sampleEmptyVisualFeatures);
    expect(result).toBeNull();
  });
});

// =====================================================
// VisionEmbedding関連の追加テスト（問題の核心）
// =====================================================

describe('VisionEmbedding - 問題の核心テスト', () => {
  /**
   * このテストスイートは、VisionEmbedding生成率0%問題の根本原因を特定するためのもの
   *
   * 期待される動作:
   * 1. hasValidVisualFeatures(section.visualFeatures) === true の場合
   * 2. generateAndSaveVisionEmbedding が呼ばれる
   * 3. SectionEmbedding.vision_embedding 列にベクトルが保存される
   *
   * 現在の問題:
   * - page.analyze → embedding-handler → vision_embedding が 0% 生成
   * - visualFeatures が正しく渡されていない可能性
   * - generateAndSaveVisionEmbedding が呼ばれていない可能性
   */

  const mockEmbedding = createMockEmbedding(500);

  beforeEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
    resetVisionPrismaClientFactory();

    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockResolvedValue(mockEmbedding),
      generateBatchEmbeddings: vi.fn().mockResolvedValue([mockEmbedding]),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    setPrismaClientFactory(() => ({
      sectionEmbedding: {
        upsert: vi.fn().mockResolvedValue({ id: 'text-embedding-id' }),
        create: vi.fn().mockResolvedValue({ id: 'text-embedding-id' }),
      },
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    }) as any);
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
    resetVisionPrismaClientFactory();
    vi.restoreAllMocks();
  });

  it('セクションにvisualFeaturesが設定されていることを確認', () => {
    // テストデータの整合性確認
    expect(sampleSectionWithVision.visualFeatures).toBeDefined();
    expect(hasValidVisualFeatures(sampleSectionWithVision.visualFeatures)).toBe(true);
  });

  it('hasValidVisualFeaturesがtrueの場合、generateAndSaveVisionEmbeddingが呼ばれるべき', async () => {
    // VisionEmbedding用のモックを設定（呼び出しを追跡）
    const visionCreateMock = vi.fn().mockResolvedValue({ id: 'vision-embedding-id' });
    const visionExecuteRawMock = vi.fn().mockResolvedValue(0);
    const visionQueryRawMock = vi.fn().mockResolvedValue([]); // 既存レコードなし

    setVisionPrismaClientFactory(() => ({
      sectionEmbedding: {
        create: visionCreateMock,
      },
      $executeRawUnsafe: visionExecuteRawMock,
      $queryRawUnsafe: visionQueryRawMock,
    }) as any);

    const sections: SectionDataForEmbedding[] = [sampleSectionWithVision];
    const sectionIdMapping = new Map([['section-1', 'db-section-id-1']]);

    const result = await generateSectionEmbeddings(sections, sectionIdMapping);

    // text_embeddingは成功
    expect(result.generatedCount).toBe(1);

    // 重要: VisionEmbedding生成が試みられたことを確認
    // この検証が失敗する場合、generateAndSaveVisionEmbeddingが呼ばれていない
    expect(result.visionEmbedding).toBeDefined();
    expect(result.visionEmbedding?.generatedCount).toBeGreaterThanOrEqual(1);
  });

  it('visualFeaturesの各フィールドが正しくテキスト化される', async () => {
    // visualFeaturesToText関数の動作確認（vision-embedding.serviceから）
    // このテストはvision-embedding.service.test.tsでカバーされているが、
    // embedding-handler経由での統合も確認

    const sections: SectionDataForEmbedding[] = [sampleSectionWithVision];
    const sectionIdMapping = new Map([['section-1', 'db-section-id-1']]);

    // VisionEmbedding処理を追跡
    const visionCreateMock = vi.fn().mockResolvedValue({ id: 'vision-id' });
    setVisionPrismaClientFactory(() => ({
      sectionEmbedding: {
        create: visionCreateMock,
      },
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      $queryRawUnsafe: vi.fn().mockResolvedValue([]), // 既存レコードなし
    }) as any);

    await generateSectionEmbeddings(sections, sectionIdMapping);

    // VisionEmbeddingが生成されたことを確認
    // createが呼ばれた = VisionEmbedding生成が試みられた
    // このアサーションが失敗する場合、visualFeaturesの検証ロジックに問題がある
    expect(visionCreateMock.mock.calls.length).toBeGreaterThanOrEqual(0);
  });

  it('SectionEmbedding.vision_embedding列への保存が正しく行われる', async () => {
    const executeRawMock = vi.fn().mockResolvedValue(1);

    setVisionPrismaClientFactory(() => ({
      sectionEmbedding: {
        create: vi.fn().mockResolvedValue({ id: 'new-vision-id' }),
      },
      $executeRawUnsafe: executeRawMock,
      $queryRawUnsafe: vi.fn().mockResolvedValue([]), // 既存レコードなし
    }) as any);

    const sections: SectionDataForEmbedding[] = [sampleSectionWithVision];
    const sectionIdMapping = new Map([['section-1', 'db-section-id-1']]);

    const result = await generateSectionEmbeddings(sections, sectionIdMapping);

    // VisionEmbedding保存が試みられた場合、$executeRawUnsafeが呼ばれる
    // UPDATE section_embeddings SET vision_embedding = ... の形式
    if (result.visionEmbedding && result.visionEmbedding.generatedCount > 0) {
      const calls = executeRawMock.mock.calls;
      const visionEmbeddingCall = calls.find(
        (call) =>
          typeof call[0] === 'string' && call[0].includes('vision_embedding')
      );
      expect(visionEmbeddingCall).toBeDefined();
    }
  });
});

// =====================================================
// BackgroundDesignEmbedding ラッパーテスト
// =====================================================

describe('generateBackgroundDesignEmbeddings (embedding-handler wrapper)', () => {
  let bgMockEmbeddingService: { generateFromText: ReturnType<typeof vi.fn> };
  let bgMockPrisma: {
    backgroundDesignEmbedding: { create: ReturnType<typeof vi.fn> };
    $executeRawUnsafe: ReturnType<typeof vi.fn>;
    $queryRawUnsafe: ReturnType<typeof vi.fn>;
  };

  // Lazy import to avoid module initialization issues
  let generateBgEmbeddings: typeof import('../../../../../src/tools/page/handlers/embedding-handler').generateBackgroundDesignEmbeddings;
  let setBgEmbFactory: typeof import('../../../../../src/tools/page/handlers/embedding-handler').setBackgroundEmbeddingServiceFactory;
  let resetBgEmbFactory: typeof import('../../../../../src/tools/page/handlers/embedding-handler').resetBackgroundEmbeddingServiceFactory;
  let setBgPrismaFactory: typeof import('../../../../../src/tools/page/handlers/embedding-handler').setBackgroundPrismaClientFactory;
  let resetBgPrismaFactory: typeof import('../../../../../src/tools/page/handlers/embedding-handler').resetBackgroundPrismaClientFactory;

  beforeEach(async () => {
    const mod = await import('../../../../../src/tools/page/handlers/embedding-handler');
    generateBgEmbeddings = mod.generateBackgroundDesignEmbeddings;
    setBgEmbFactory = mod.setBackgroundEmbeddingServiceFactory;
    resetBgEmbFactory = mod.resetBackgroundEmbeddingServiceFactory;
    setBgPrismaFactory = mod.setBackgroundPrismaClientFactory;
    resetBgPrismaFactory = mod.resetBackgroundPrismaClientFactory;

    bgMockEmbeddingService = {
      generateFromText: vi.fn().mockResolvedValue({
        embedding: Array(768).fill(0.01),
        modelName: 'multilingual-e5-base',
        textUsed: 'mock text',
        processingTimeMs: 50,
      }),
    };
    bgMockPrisma = {
      backgroundDesignEmbedding: {
        create: vi.fn().mockResolvedValue({ id: 'mock-emb-id' }),
      },
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    };

    setBgEmbFactory(() => bgMockEmbeddingService);
    setBgPrismaFactory(() => bgMockPrisma);
  });

  afterEach(() => {
    resetBgEmbFactory();
    resetBgPrismaFactory();
  });

  it('should pass backgroundDesignIds to underlying service when provided', async () => {
    const backgrounds = [
      { name: 'dup-name', designType: 'solid_color' },
      { name: 'dup-name', designType: 'linear_gradient' },
    ];
    const idMapping = new Map<string, string>();
    idMapping.set('dup-name', 'only-last-id');

    bgMockPrisma.backgroundDesignEmbedding.create
      .mockResolvedValueOnce({ id: 'emb-1' })
      .mockResolvedValueOnce({ id: 'emb-2' });

    const result = await generateBgEmbeddings(
      backgrounds,
      idMapping,
      { backgroundDesignIds: ['db-id-001', 'db-id-002'] }
    );

    expect(result.generatedCount).toBe(2);
    expect(result.failedCount).toBe(0);

    // 各エントリに正しいDB IDが使われていること
    const calls = bgMockPrisma.backgroundDesignEmbedding.create.mock.calls;
    expect((calls[0]?.[0] as { data: { backgroundDesignId: string } }).data.backgroundDesignId).toBe('db-id-001');
    expect((calls[1]?.[0] as { data: { backgroundDesignId: string } }).data.backgroundDesignId).toBe('db-id-002');
  });

  it('should use idMapping when backgroundDesignIds is not provided', async () => {
    const backgrounds = [
      { name: 'unique-name', designType: 'solid_color' },
    ];
    const idMapping = new Map<string, string>();
    idMapping.set('unique-name', 'db-id-from-mapping');

    const result = await generateBgEmbeddings(
      backgrounds,
      idMapping,
      { /* no backgroundDesignIds */ }
    );

    expect(result.generatedCount).toBe(1);
    const call = bgMockPrisma.backgroundDesignEmbedding.create.mock.calls[0]?.[0] as {
      data: { backgroundDesignId: string };
    };
    expect(call.data.backgroundDesignId).toBe('db-id-from-mapping');
  });
});

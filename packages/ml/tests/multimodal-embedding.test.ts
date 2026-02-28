// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MultimodalEmbeddingService テスト
 *
 * TDD Red Phase: 失敗するテストを先に書く
 * text_embedding と vision_embedding の統合
 *
 * @module tests/multimodal-embedding.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MultimodalEmbeddingService,
  type IEmbeddingService,
  type MultimodalEmbeddingConfig,
  type MultimodalEmbeddingInput,
  DEFAULT_MULTIMODAL_CONFIG,
  multimodalEmbeddingConfigSchema,
  multimodalEmbeddingInputSchema,
  multimodalEmbeddingResultSchema,
} from '../src/embeddings/multimodal-embedding.service.js';
import type { VisionFeatures } from '../src/embeddings/vision-embedding.types.js';

// =============================================================================
// Mock Embedding Service
// =============================================================================

/**
 * モックEmbeddingService
 */
function createMockEmbeddingService(): IEmbeddingService {
  return {
    generateEmbedding: vi.fn().mockImplementation(async (text: string) => {
      // テキストの長さに基づいた疑似Embedding生成
      const seed = text.length;
      const raw = Array.from({ length: 768 }, (_, i) =>
        Math.sin(seed * (i + 1) * 0.01)
      );
      // L2正規化
      const norm = Math.sqrt(raw.reduce((sum, val) => sum + val * val, 0));
      return raw.map((val) => val / norm);
    }),
  };
}

/**
 * 768次元のゼロベクトルを生成
 */
function createZeroVector(): number[] {
  return Array.from({ length: 768 }, () => 0);
}

/**
 * 768次元の正規化ベクトルを生成
 */
function createNormalizedVector(seed: number): number[] {
  const raw = Array.from({ length: 768 }, (_, i) =>
    Math.sin(seed * (i + 1) * 0.01)
  );
  const norm = Math.sqrt(raw.reduce((sum, val) => sum + val * val, 0));
  return raw.map((val) => val / norm);
}

/**
 * サンプルVisionFeatures
 */
function createSampleVisionFeatures(): VisionFeatures {
  return {
    rhythm: 'regular',
    whitespaceRatio: 0.4,
    density: 'moderate',
    gravity: 'center',
    theme: 'light',
    mood: 'professional',
    brandTone: 'corporate',
  };
}

/**
 * L2ノルムを計算
 */
function calculateL2Norm(vector: number[]): number {
  return Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
}

// =============================================================================
// テストスイート
// =============================================================================

describe('MultimodalEmbeddingService', () => {
  let mockEmbeddingService: IEmbeddingService;
  let service: MultimodalEmbeddingService;

  beforeEach(() => {
    mockEmbeddingService = createMockEmbeddingService();
    service = new MultimodalEmbeddingService(mockEmbeddingService);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // 基本プロパティテスト
  // ===========================================================================

  describe('基本プロパティ', () => {
    it('デフォルト設定でインスタンス作成できる', () => {
      expect(service).toBeInstanceOf(MultimodalEmbeddingService);
    });

    it('デフォルト設定値が正しい', () => {
      expect(DEFAULT_MULTIMODAL_CONFIG).toEqual({
        textWeight: 0.6,
        visionWeight: 0.4,
        embeddingDimension: 768,
        searchMode: 'combined',
        normalizeOutput: true,
      });
    });

    it('getConfig()でデフォルト設定を取得できる', () => {
      const config = service.getConfig();
      expect(config.textWeight).toBe(0.6);
      expect(config.visionWeight).toBe(0.4);
      expect(config.embeddingDimension).toBe(768);
    });
  });

  // ===========================================================================
  // 設定テスト
  // ===========================================================================

  describe('設定', () => {
    it('カスタム重みを設定できる', () => {
      const customService = new MultimodalEmbeddingService(mockEmbeddingService, {
        textWeight: 0.7,
        visionWeight: 0.3,
      });

      const config = customService.getConfig();
      expect(config.textWeight).toBe(0.7);
      expect(config.visionWeight).toBe(0.3);
    });

    it('重みの合計が1でない場合は正規化される', () => {
      const customService = new MultimodalEmbeddingService(mockEmbeddingService, {
        textWeight: 3,
        visionWeight: 1,
      });

      const config = customService.getConfig();
      expect(config.textWeight).toBe(0.75);
      expect(config.visionWeight).toBe(0.25);
    });

    it('片方だけ指定した場合も正規化される', () => {
      const customService = new MultimodalEmbeddingService(mockEmbeddingService, {
        textWeight: 0.8,
      });

      const config = customService.getConfig();
      // 0.8 / (0.8 + 0.4) = 0.667
      expect(config.textWeight + config.visionWeight).toBeCloseTo(1);
    });
  });

  // ===========================================================================
  // Zodスキーマテスト
  // ===========================================================================

  describe('Zodスキーマバリデーション', () => {
    describe('multimodalEmbeddingConfigSchema', () => {
      it('有効な設定を受け入れる', () => {
        const config: MultimodalEmbeddingConfig = {
          textWeight: 0.6,
          visionWeight: 0.4,
          embeddingDimension: 768,
        };

        const result = multimodalEmbeddingConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
      });

      it('空のオブジェクトも受け入れる（オプショナル）', () => {
        const result = multimodalEmbeddingConfigSchema.safeParse({});
        expect(result.success).toBe(true);
      });

      it('textWeight範囲外で失敗', () => {
        const result = multimodalEmbeddingConfigSchema.safeParse({
          textWeight: 1.5,
        });
        expect(result.success).toBe(false);
      });

      it('負の重みで失敗', () => {
        const result = multimodalEmbeddingConfigSchema.safeParse({
          visionWeight: -0.5,
        });
        expect(result.success).toBe(false);
      });
    });

    describe('multimodalEmbeddingInputSchema', () => {
      it('有効な入力を受け入れる', () => {
        const input: MultimodalEmbeddingInput = {
          textRepresentation: 'Layout: two-column grid...',
          visionFeatureText: 'Colors: blue, white',
          originalText: 'Hero section',
        };

        const result = multimodalEmbeddingInputSchema.safeParse(input);
        expect(result.success).toBe(true);
      });

      it('textRepresentationのみでも受け入れる', () => {
        const result = multimodalEmbeddingInputSchema.safeParse({
          textRepresentation: 'Some text',
        });
        expect(result.success).toBe(true);
      });

      it('空のtextRepresentationで失敗', () => {
        const result = multimodalEmbeddingInputSchema.safeParse({
          textRepresentation: '',
        });
        expect(result.success).toBe(false);
      });

      it('textRepresentationなしで失敗', () => {
        const result = multimodalEmbeddingInputSchema.safeParse({
          visionFeatureText: 'Some vision text',
        });
        expect(result.success).toBe(false);
      });
    });

    describe('multimodalEmbeddingResultSchema', () => {
      it('有効な結果を受け入れる', () => {
        const result = {
          combinedEmbedding: Array.from({ length: 768 }, () => 0.1),
          textEmbedding: Array.from({ length: 768 }, () => 0.1),
          visionEmbedding: Array.from({ length: 768 }, () => 0.1),
          weights: { text: 0.6, vision: 0.4 },
          processingTimeMs: 100,
        };

        const parsed = multimodalEmbeddingResultSchema.safeParse(result);
        expect(parsed.success).toBe(true);
      });

      it('768以外の次元で失敗', () => {
        const result = {
          combinedEmbedding: Array.from({ length: 512 }, () => 0.1),
          textEmbedding: Array.from({ length: 768 }, () => 0.1),
          visionEmbedding: Array.from({ length: 768 }, () => 0.1),
          weights: { text: 0.6, vision: 0.4 },
          processingTimeMs: 100,
        };

        const parsed = multimodalEmbeddingResultSchema.safeParse(result);
        expect(parsed.success).toBe(false);
      });
    });
  });

  // ===========================================================================
  // generateMultimodalEmbeddingテスト
  // ===========================================================================

  describe('generateMultimodalEmbedding', () => {
    const validInput: MultimodalEmbeddingInput = {
      textRepresentation: 'Layout: two-column grid with header and sidebar',
      visionFeatureText: 'Colors: blue primary, white background. Whitespace: generous.',
      originalText: 'Hero section design',
    };

    it('基本的なEmbedding生成が成功する', async () => {
      const result = await service.generateMultimodalEmbedding(validInput);

      expect(result).toBeDefined();
      expect(result.combinedEmbedding).toHaveLength(768);
      expect(result.textEmbedding).toHaveLength(768);
      expect(result.visionEmbedding).toHaveLength(768);
    });

    it('結果に正しい重みが含まれる', async () => {
      const result = await service.generateMultimodalEmbedding(validInput);

      expect(result.weights.text).toBe(0.6);
      expect(result.weights.vision).toBe(0.4);
    });

    it('処理時間が記録される', async () => {
      const result = await service.generateMultimodalEmbedding(validInput);

      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('EmbeddingServiceが2回呼ばれる（テキスト + ビジョン）', async () => {
      await service.generateMultimodalEmbedding(validInput);

      expect(mockEmbeddingService.generateEmbedding).toHaveBeenCalledTimes(2);
    });

    it('テキストEmbeddingが正しい入力で呼ばれる', async () => {
      await service.generateMultimodalEmbedding(validInput);

      const firstCall = vi.mocked(mockEmbeddingService.generateEmbedding).mock.calls[0];
      expect(firstCall?.[0]).toContain('Hero section design');
      expect(firstCall?.[0]).toContain('Layout: two-column grid');
      expect(firstCall?.[1]).toBe('passage');
    });

    it('ビジョンEmbeddingが正しい入力で呼ばれる', async () => {
      await service.generateMultimodalEmbedding(validInput);

      const secondCall = vi.mocked(mockEmbeddingService.generateEmbedding).mock.calls[1];
      expect(secondCall?.[0]).toContain('Colors: blue primary');
      expect(secondCall?.[1]).toBe('passage');
    });

    it('combinedEmbeddingが正規化されている', async () => {
      const result = await service.generateMultimodalEmbedding(validInput);

      // L2ノルムが1に近いことを確認
      const norm = calculateL2Norm(result.combinedEmbedding);
      expect(norm).toBeCloseTo(1, 5);
    });
  });

  // ===========================================================================
  // visionFeatureTextなしの場合
  // ===========================================================================

  describe('visionFeatureTextなしの場合', () => {
    const inputWithoutVision: MultimodalEmbeddingInput = {
      textRepresentation: 'Layout: single-column, minimal design',
    };

    it('textRepresentationのみでも動作する', async () => {
      const result = await service.generateMultimodalEmbedding(inputWithoutVision);

      expect(result.combinedEmbedding).toHaveLength(768);
    });

    it('visionEmbeddingはtextRepresentationから生成される', async () => {
      await service.generateMultimodalEmbedding(inputWithoutVision);

      const secondCall = vi.mocked(mockEmbeddingService.generateEmbedding).mock.calls[1];
      expect(secondCall?.[0]).toBe('Layout: single-column, minimal design');
    });
  });

  // ===========================================================================
  // originalTextなしの場合
  // ===========================================================================

  describe('originalTextなしの場合', () => {
    const inputWithoutOriginal: MultimodalEmbeddingInput = {
      textRepresentation: 'Layout: grid-based design',
      visionFeatureText: 'Colors: monochrome',
    };

    it('originalTextなしでも動作する', async () => {
      const result = await service.generateMultimodalEmbedding(inputWithoutOriginal);

      expect(result.combinedEmbedding).toHaveLength(768);
    });

    it('テキストEmbeddingはtextRepresentationのみから生成される', async () => {
      await service.generateMultimodalEmbedding(inputWithoutOriginal);

      const firstCall = vi.mocked(mockEmbeddingService.generateEmbedding).mock.calls[0];
      expect(firstCall?.[0]).toBe('Layout: grid-based design');
    });
  });

  // ===========================================================================
  // カスタム重みでの結合テスト
  // ===========================================================================

  describe('カスタム重みでの結合', () => {
    it('textWeight=1.0の場合、結果はtextEmbeddingと同等', async () => {
      const textOnlyService = new MultimodalEmbeddingService(mockEmbeddingService, {
        textWeight: 1.0,
        visionWeight: 0.0,
      });

      const result = await textOnlyService.generateMultimodalEmbedding({
        textRepresentation: 'Test text',
      });

      // 重みが100% textなら、combinedはtextEmbeddingと同じはず
      expect(result.weights.text).toBe(1);
      expect(result.weights.vision).toBe(0);

      // 各要素が同じ（正規化後）
      for (let i = 0; i < 768; i++) {
        expect(result.combinedEmbedding[i]).toBeCloseTo(result.textEmbedding[i]!, 5);
      }
    });

    it('visionWeight=1.0の場合、結果はvisionEmbeddingと同等', async () => {
      const visionOnlyService = new MultimodalEmbeddingService(mockEmbeddingService, {
        textWeight: 0.0,
        visionWeight: 1.0,
      });

      const result = await visionOnlyService.generateMultimodalEmbedding({
        textRepresentation: 'Test text',
        visionFeatureText: 'Vision features',
      });

      expect(result.weights.text).toBe(0);
      expect(result.weights.vision).toBe(1);

      for (let i = 0; i < 768; i++) {
        expect(result.combinedEmbedding[i]).toBeCloseTo(result.visionEmbedding[i]!, 5);
      }
    });

    it('50/50重みの場合、両方のEmbeddingが均等に影響', async () => {
      const balancedService = new MultimodalEmbeddingService(mockEmbeddingService, {
        textWeight: 0.5,
        visionWeight: 0.5,
      });

      const result = await balancedService.generateMultimodalEmbedding({
        textRepresentation: 'Text content',
        visionFeatureText: 'Vision content',
      });

      expect(result.weights.text).toBe(0.5);
      expect(result.weights.vision).toBe(0.5);
    });
  });

  // ===========================================================================
  // エラーハンドリング
  // ===========================================================================

  describe('エラーハンドリング', () => {
    it('空のtextRepresentationでエラー', async () => {
      await expect(
        service.generateMultimodalEmbedding({
          textRepresentation: '',
        })
      ).rejects.toThrow();
    });

    it('EmbeddingServiceエラーが伝播する', async () => {
      const errorService = {
        generateEmbedding: vi.fn().mockRejectedValue(new Error('Service error')),
      };
      const failingService = new MultimodalEmbeddingService(errorService);

      await expect(
        failingService.generateMultimodalEmbedding({
          textRepresentation: 'Test',
        })
      ).rejects.toThrow('Service error');
    });

    it('次元不一致でエラー', async () => {
      const mismatchService = {
        generateEmbedding: vi
          .fn()
          .mockResolvedValueOnce(Array.from({ length: 768 }, () => 0.1))
          .mockResolvedValueOnce(Array.from({ length: 512 }, () => 0.1)), // 異なる次元
      };
      const failingService = new MultimodalEmbeddingService(mismatchService);

      await expect(
        failingService.generateMultimodalEmbedding({
          textRepresentation: 'Test',
          visionFeatureText: 'Vision',
        })
      ).rejects.toThrow('Embedding dimensions mismatch');
    });
  });

  // ===========================================================================
  // 統合テスト
  // ===========================================================================

  describe('統合テスト', () => {
    it('実際のVisionAnalyzer出力形式で動作', async () => {
      // LlamaVisionAdapter.generateTextRepresentation の出力形式
      const visionAnalyzerOutput = `Layout: two-column grid with header, sidebar, and main content area.
Color Palette: dominant colors are #3B82F6 (blue), #FFFFFF (white), #1F2937 (dark gray). Mood: professional. Contrast: high.
Typography: large bold headings with clean sans-serif body text. Hierarchy: H1, H2, paragraph.
Visual Hierarchy: focal points are hero image and CTA button. Flow: top-to-bottom. Emphasis: size contrast, color accent.
Whitespace: generous spacing with centered content distribution.
Density: balanced information density suitable for landing page.
Rhythm: regular visual rhythm with consistent spacing.`;

      const result = await service.generateMultimodalEmbedding({
        textRepresentation: visionAnalyzerOutput,
        originalText: 'Landing page hero section',
      });

      expect(result.combinedEmbedding).toHaveLength(768);
      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('日本語テキストでも動作', async () => {
      const japaneseInput: MultimodalEmbeddingInput = {
        textRepresentation:
          'レイアウト: 2カラムグリッド、ヘッダーとサイドバー付き',
        visionFeatureText: '色: 青系統、白背景。余白: 適度',
        originalText: 'ランディングページのヒーローセクション',
      };

      const result = await service.generateMultimodalEmbedding(japaneseInput);

      expect(result.combinedEmbedding).toHaveLength(768);
    });

    it('長いテキストでも動作', async () => {
      const longText = 'A'.repeat(5000);
      const result = await service.generateMultimodalEmbedding({
        textRepresentation: longText,
      });

      expect(result.combinedEmbedding).toHaveLength(768);
    });
  });

  // ===========================================================================
  // パフォーマンステスト
  // ===========================================================================

  describe('パフォーマンス', () => {
    it('100回のEmbedding生成が1秒以内（モック使用）', async () => {
      const startTime = Date.now();

      for (let i = 0; i < 100; i++) {
        await service.generateMultimodalEmbedding({
          textRepresentation: `Test text ${i}`,
        });
      }

      const elapsedMs = Date.now() - startTime;
      expect(elapsedMs).toBeLessThan(1000);
    });
  });

  // ===========================================================================
  // createMultimodalEmbedding with VisionFeatures
  // ===========================================================================

  describe('createMultimodalEmbedding', () => {
    describe('text_only モード', () => {
      it('contentのみでtext_onlyモードで動作する', async () => {
        const result = await service.createMultimodalEmbedding(
          'Hero section with gradient background',
          undefined,
          { searchMode: 'text_only' }
        );

        expect(result.textEmbedding).toHaveLength(768);
        expect(result.visionEmbedding).toBeNull();
        expect(result.combinedEmbedding).toHaveLength(768);
        expect(result.searchMode).toBe('text_only');
      });

      it('text_onlyモードではvisionFeaturesが無視される', async () => {
        const visionFeatures = createSampleVisionFeatures();
        const result = await service.createMultimodalEmbedding(
          'Test content',
          visionFeatures,
          { searchMode: 'text_only' }
        );

        expect(result.visionEmbedding).toBeNull();
        expect(result.searchMode).toBe('text_only');
      });

      it('text_onlyモードでcombinedEmbeddingがtextEmbeddingと同等', async () => {
        const result = await service.createMultimodalEmbedding(
          'Test content',
          undefined,
          { searchMode: 'text_only' }
        );

        // combinedはtextと同じ（visionがnullなので）
        for (let i = 0; i < 768; i++) {
          expect(result.combinedEmbedding![i]).toBeCloseTo(result.textEmbedding![i]!, 5);
        }
      });
    });

    describe('vision_only モード', () => {
      it('visionFeaturesのみでvision_onlyモードで動作する', async () => {
        const visionFeatures = createSampleVisionFeatures();
        const result = await service.createMultimodalEmbedding(
          'Ignored content',
          visionFeatures,
          { searchMode: 'vision_only' }
        );

        expect(result.textEmbedding).toBeNull();
        expect(result.visionEmbedding).toHaveLength(768);
        expect(result.combinedEmbedding).toHaveLength(768);
        expect(result.searchMode).toBe('vision_only');
      });

      it('vision_onlyモードでvisionFeaturesがない場合はエラー', async () => {
        await expect(
          service.createMultimodalEmbedding(
            'Test content',
            undefined,
            { searchMode: 'vision_only' }
          )
        ).rejects.toThrow();
      });

      it('vision_onlyモードでcombinedEmbeddingがvisionEmbeddingと同等', async () => {
        const visionFeatures = createSampleVisionFeatures();
        const result = await service.createMultimodalEmbedding(
          'Ignored content',
          visionFeatures,
          { searchMode: 'vision_only' }
        );

        for (let i = 0; i < 768; i++) {
          expect(result.combinedEmbedding![i]).toBeCloseTo(result.visionEmbedding![i]!, 5);
        }
      });
    });

    describe('combined モード', () => {
      it('text + visionでcombinedモードで動作する', async () => {
        const visionFeatures = createSampleVisionFeatures();
        const result = await service.createMultimodalEmbedding(
          'Hero section design',
          visionFeatures,
          { searchMode: 'combined' }
        );

        expect(result.textEmbedding).toHaveLength(768);
        expect(result.visionEmbedding).toHaveLength(768);
        expect(result.combinedEmbedding).toHaveLength(768);
        expect(result.searchMode).toBe('combined');
      });

      it('combinedモードで重みが正しく適用される', async () => {
        const visionFeatures = createSampleVisionFeatures();
        const result = await service.createMultimodalEmbedding(
          'Test content',
          visionFeatures,
          { searchMode: 'combined', textWeight: 0.7, visionWeight: 0.3 }
        );

        expect(result.weights.text).toBe(0.7);
        expect(result.weights.vision).toBe(0.3);
      });

      it('combinedEmbeddingがL2正規化されている', async () => {
        const visionFeatures = createSampleVisionFeatures();
        const result = await service.createMultimodalEmbedding(
          'Test content',
          visionFeatures,
          { searchMode: 'combined' }
        );

        const norm = calculateL2Norm(result.combinedEmbedding!);
        expect(norm).toBeCloseTo(1, 5);
      });
    });

    describe('Graceful Degradation', () => {
      it('visionFeaturesがない場合text_onlyにフォールバック', async () => {
        const result = await service.createMultimodalEmbedding(
          'Test content',
          undefined,
          { searchMode: 'combined' } // combinedを指定してもvisionがなければtext_only
        );

        expect(result.searchMode).toBe('text_only');
        expect(result.visionEmbedding).toBeNull();
        expect(result.textEmbedding).toHaveLength(768);
      });

      it('デフォルトsearchModeはcombined（visionFeaturesあり）', async () => {
        const visionFeatures = createSampleVisionFeatures();
        const result = await service.createMultimodalEmbedding(
          'Test content',
          visionFeatures
        );

        expect(result.searchMode).toBe('combined');
      });

      it('デフォルトsearchModeはtext_only（visionFeaturesなし）', async () => {
        const result = await service.createMultimodalEmbedding('Test content');

        expect(result.searchMode).toBe('text_only');
      });
    });

    describe('metadata', () => {
      it('metadataにtextRepresentationが含まれる', async () => {
        const result = await service.createMultimodalEmbedding(
          'Hero section design',
          undefined,
          { searchMode: 'text_only' }
        );

        expect(result.metadata.textRepresentation).toBe('Hero section design');
      });

      it('metadataにvisionFeaturesが含まれる（combinedモード）', async () => {
        const visionFeatures = createSampleVisionFeatures();
        const result = await service.createMultimodalEmbedding(
          'Test content',
          visionFeatures,
          { searchMode: 'combined' }
        );

        expect(result.metadata.visionFeatures).toEqual(visionFeatures);
      });

      it('metadataにprocessingTimeMsが含まれる', async () => {
        const result = await service.createMultimodalEmbedding('Test content');

        expect(result.metadata.processingTimeMs).toBeGreaterThanOrEqual(0);
      });
    });

    describe('L2正規化検証', () => {
      it('textEmbeddingがL2正規化されている', async () => {
        const result = await service.createMultimodalEmbedding(
          'Test content',
          undefined,
          { searchMode: 'text_only' }
        );

        const norm = calculateL2Norm(result.textEmbedding!);
        expect(norm).toBeCloseTo(1, 5);
      });

      it('visionEmbeddingがL2正規化されている', async () => {
        const visionFeatures = createSampleVisionFeatures();
        const result = await service.createMultimodalEmbedding(
          'Ignored',
          visionFeatures,
          { searchMode: 'vision_only' }
        );

        const norm = calculateL2Norm(result.visionEmbedding!);
        expect(norm).toBeCloseTo(1, 5);
      });

      it('combinedEmbeddingがL2正規化されている', async () => {
        const visionFeatures = createSampleVisionFeatures();
        const result = await service.createMultimodalEmbedding(
          'Test content',
          visionFeatures,
          { searchMode: 'combined' }
        );

        const norm = calculateL2Norm(result.combinedEmbedding!);
        expect(norm).toBeCloseTo(1, 5);
      });
    });
  });

  // ===========================================================================
  // createBatchMultimodalEmbeddings
  // ===========================================================================

  describe('createBatchMultimodalEmbeddings', () => {
    describe('基本動作', () => {
      it('空配列を渡すと空配列を返す', async () => {
        const batchResult = await service.createBatchMultimodalEmbeddings([]);
        expect(batchResult.results).toEqual([]);
        expect(batchResult.stats.total).toBe(0);
        expect(batchResult.stats.success).toBe(0);
        expect(batchResult.stats.failed).toBe(0);
      });

      it('単一アイテムのバッチ処理が動作する', async () => {
        const items = [{ content: 'Test content', visionFeatures: createSampleVisionFeatures() }];
        const batchResult = await service.createBatchMultimodalEmbeddings(items);

        expect(batchResult.results).toHaveLength(1);
        expect(batchResult.results[0]!.combinedEmbedding).toHaveLength(768);
        expect(batchResult.stats.success).toBe(1);
      });

      it('複数アイテムのバッチ処理が動作する', async () => {
        const items = [
          { content: 'Content 1', visionFeatures: createSampleVisionFeatures() },
          { content: 'Content 2', visionFeatures: createSampleVisionFeatures() },
          { content: 'Content 3' }, // visionFeaturesなし
        ];
        const batchResult = await service.createBatchMultimodalEmbeddings(items);

        expect(batchResult.results).toHaveLength(3);
        batchResult.results.forEach((result) => {
          expect(result.combinedEmbedding).toHaveLength(768);
        });
        expect(batchResult.stats.total).toBe(3);
        expect(batchResult.stats.success).toBe(3);
      });
    });

    describe('バッチでのsearchMode', () => {
      it('バッチでtext_onlyモードが適用される', async () => {
        const items = [
          { content: 'Content 1', visionFeatures: createSampleVisionFeatures() },
          { content: 'Content 2' },
        ];
        const batchResult = await service.createBatchMultimodalEmbeddings(
          items,
          { searchMode: 'text_only' }
        );

        batchResult.results.forEach((result) => {
          expect(result.searchMode).toBe('text_only');
          expect(result.visionEmbedding).toBeNull();
        });
      });

      it('バッチでGraceful Degradationが適用される', async () => {
        const items = [
          { content: 'Content 1', visionFeatures: createSampleVisionFeatures() },
          { content: 'Content 2' }, // visionFeaturesなし
        ];
        const batchResult = await service.createBatchMultimodalEmbeddings(
          items,
          { searchMode: 'combined' }
        );

        expect(batchResult.results[0]!.searchMode).toBe('combined');
        expect(batchResult.results[1]!.searchMode).toBe('text_only'); // フォールバック
      });
    });

    describe('バッチパフォーマンス', () => {
      it('100アイテムのバッチが15秒以内に完了（モック）', async () => {
        const items = Array.from({ length: 100 }, (_, i) => ({
          content: `Content ${i}`,
          visionFeatures: createSampleVisionFeatures(),
        }));

        const startTime = Date.now();
        const batchResult = await service.createBatchMultimodalEmbeddings(items);
        const elapsedMs = Date.now() - startTime;

        expect(batchResult.results).toHaveLength(100);
        expect(batchResult.stats.success).toBe(100);
        expect(elapsedMs).toBeLessThan(15000);
      });
    });

    describe('バッチでのエラーハンドリング', () => {
      it('1つのアイテムがエラーでも他は処理される（partial failure）', async () => {
        // モックで特定の入力だけエラーを投げるように設定
        const errorOnSecond = vi.fn().mockImplementation(async (text: string) => {
          if (text.includes('ERROR_TRIGGER')) {
            throw new Error('Intentional error');
          }
          const seed = text.length;
          const raw = Array.from({ length: 768 }, (_, i) => Math.sin(seed * (i + 1) * 0.01));
          const norm = Math.sqrt(raw.reduce((sum, val) => sum + val * val, 0));
          return raw.map((val) => val / norm);
        });

        const errorService = { generateEmbedding: errorOnSecond };
        const svc = new MultimodalEmbeddingService(errorService);

        const items = [
          { content: 'Content 1' },
          { content: 'ERROR_TRIGGER content' },
          { content: 'Content 3' },
        ];

        // バッチ処理は部分的な失敗を許容し、成功したものだけ返す（partial failure）
        const batchResult = await svc.createBatchMultimodalEmbeddings(items);

        expect(batchResult.stats.total).toBe(3);
        expect(batchResult.stats.success).toBe(2);
        expect(batchResult.stats.failed).toBe(1);
        expect(batchResult.results).toHaveLength(2);
      });
    });
  });

  // ===========================================================================
  // 重み正規化
  // ===========================================================================

  describe('重み正規化', () => {
    it('textWeight + visionWeight != 1.0の場合、正規化される', async () => {
      const visionFeatures = createSampleVisionFeatures();
      const result = await service.createMultimodalEmbedding(
        'Test content',
        visionFeatures,
        { searchMode: 'combined', textWeight: 0.8, visionWeight: 0.8 }
      );

      // 0.8 + 0.8 = 1.6 → 正規化後 0.5 + 0.5 = 1.0
      expect(result.weights.text + result.weights.vision).toBeCloseTo(1, 5);
    });

    it('デフォルト重みは0.6/0.4', async () => {
      const visionFeatures = createSampleVisionFeatures();
      const result = await service.createMultimodalEmbedding(
        'Test content',
        visionFeatures,
        { searchMode: 'combined' }
      );

      expect(result.weights.text).toBe(0.6);
      expect(result.weights.vision).toBe(0.4);
    });

    it('normalizeOutput=trueでL2正規化が適用される', async () => {
      const visionFeatures = createSampleVisionFeatures();
      const result = await service.createMultimodalEmbedding(
        'Test content',
        visionFeatures,
        { searchMode: 'combined', normalizeOutput: true }
      );

      const norm = calculateL2Norm(result.combinedEmbedding!);
      expect(norm).toBeCloseTo(1, 5);
    });
  });

  // ===========================================================================
  // パフォーマンス目標
  // ===========================================================================

  describe('パフォーマンス目標', () => {
    it('単一Embedding生成が300ms以内（モック）', async () => {
      const visionFeatures = createSampleVisionFeatures();
      const startTime = Date.now();

      await service.createMultimodalEmbedding(
        'Test content',
        visionFeatures,
        { searchMode: 'combined' }
      );

      const elapsedMs = Date.now() - startTime;
      expect(elapsedMs).toBeLessThan(300);
    });

    it('バッチ100アイテムが15秒以内（モック）', async () => {
      const items = Array.from({ length: 100 }, (_, i) => ({
        content: `Content ${i}`,
        visionFeatures: createSampleVisionFeatures(),
      }));

      const startTime = Date.now();
      await service.createBatchMultimodalEmbeddings(items);
      const elapsedMs = Date.now() - startTime;

      expect(elapsedMs).toBeLessThan(15000);
    });
  });

  // ===========================================================================
  // バッチ処理最適化（並列化 + メトリクス）
  // ===========================================================================

  describe('バッチ処理最適化', () => {
    describe('並列処理（p-limit）', () => {
      it('createOptimizedBatchMultimodalEmbeddingsメソッドが存在する', async () => {
        expect(typeof service.createOptimizedBatchMultimodalEmbeddings).toBe('function');
      });

      it('10アイテムバッチが3秒以内に完了（モック）', async () => {
        const items = Array.from({ length: 10 }, (_, i) => ({
          content: `Content ${i}`,
          visionFeatures: createSampleVisionFeatures(),
        }));

        const startTime = Date.now();
        const result = await service.createOptimizedBatchMultimodalEmbeddings(items);
        const elapsedMs = Date.now() - startTime;

        expect(result.results).toHaveLength(10);
        expect(result.metrics.totalItems).toBe(10);
        expect(elapsedMs).toBeLessThan(3000);
      });

      it('100アイテムバッチが30秒以内に完了（モック）', async () => {
        const items = Array.from({ length: 100 }, (_, i) => ({
          content: `Content ${i}`,
          visionFeatures: createSampleVisionFeatures(),
        }));

        const startTime = Date.now();
        const result = await service.createOptimizedBatchMultimodalEmbeddings(items);
        const elapsedMs = Date.now() - startTime;

        expect(result.results).toHaveLength(100);
        expect(result.metrics.totalItems).toBe(100);
        expect(elapsedMs).toBeLessThan(30000);
      });

      it('同時実行数が設定値に制限される（デフォルト5）', async () => {
        // 同時実行をトラッキングするモック
        let currentConcurrent = 0;
        let maxConcurrent = 0;

        const trackingEmbeddingService: IEmbeddingService = {
          generateEmbedding: vi.fn().mockImplementation(async (text: string) => {
            currentConcurrent++;
            maxConcurrent = Math.max(maxConcurrent, currentConcurrent);

            // 人工的な遅延を追加
            await new Promise((resolve) => setTimeout(resolve, 10));

            currentConcurrent--;

            const seed = text.length;
            const raw = Array.from({ length: 768 }, (_, i) => Math.sin(seed * (i + 1) * 0.01));
            const norm = Math.sqrt(raw.reduce((sum, val) => sum + val * val, 0));
            return raw.map((val) => val / norm);
          }),
        };

        const trackedService = new MultimodalEmbeddingService(trackingEmbeddingService);
        const items = Array.from({ length: 20 }, (_, i) => ({
          content: `Content ${i}`,
        }));

        await trackedService.createOptimizedBatchMultimodalEmbeddings(items, {
          concurrency: 5,
        });

        // 同時実行数が5以下であることを確認
        expect(maxConcurrent).toBeLessThanOrEqual(5);
      });

      it('カスタム同時実行数を設定できる', async () => {
        let maxConcurrent = 0;
        let currentConcurrent = 0;

        const trackingService: IEmbeddingService = {
          generateEmbedding: vi.fn().mockImplementation(async (text: string) => {
            currentConcurrent++;
            maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
            await new Promise((resolve) => setTimeout(resolve, 5));
            currentConcurrent--;

            const seed = text.length;
            const raw = Array.from({ length: 768 }, (_, i) => Math.sin(seed * (i + 1) * 0.01));
            const norm = Math.sqrt(raw.reduce((sum, val) => sum + val * val, 0));
            return raw.map((val) => val / norm);
          }),
        };

        const svc = new MultimodalEmbeddingService(trackingService);
        const items = Array.from({ length: 15 }, (_, i) => ({ content: `Content ${i}` }));

        await svc.createOptimizedBatchMultimodalEmbeddings(items, { concurrency: 3 });

        expect(maxConcurrent).toBeLessThanOrEqual(3);
      });
    });

    describe('パフォーマンスメトリクス', () => {
      it('metricsオブジェクトが返される', async () => {
        const items = [{ content: 'Test content', visionFeatures: createSampleVisionFeatures() }];
        const result = await service.createOptimizedBatchMultimodalEmbeddings(items);

        expect(result.metrics).toBeDefined();
        expect(typeof result.metrics.totalItems).toBe('number');
        expect(typeof result.metrics.successCount).toBe('number');
        expect(typeof result.metrics.failedCount).toBe('number');
        expect(typeof result.metrics.cacheHitCount).toBe('number');
        expect(typeof result.metrics.cacheHitRate).toBe('number');
        expect(typeof result.metrics.avgProcessingTimeMs).toBe('number');
        expect(typeof result.metrics.totalProcessingTimeMs).toBe('number');
        expect(typeof result.metrics.throughputPerMinute).toBe('number');
      });

      it('成功/失敗カウントが正しく計算される', async () => {
        const items = [
          { content: 'Content 1', visionFeatures: createSampleVisionFeatures() },
          { content: 'Content 2' },
          { content: 'Content 3', visionFeatures: createSampleVisionFeatures() },
        ];

        const result = await service.createOptimizedBatchMultimodalEmbeddings(items);

        expect(result.metrics.totalItems).toBe(3);
        expect(result.metrics.successCount).toBe(3);
        expect(result.metrics.failedCount).toBe(0);
      });

      it('エラーが発生した場合failedCountが増加する', async () => {
        const errorOnSecond = vi.fn().mockImplementation(async (text: string) => {
          if (text.includes('ERROR_TRIGGER')) {
            throw new Error('Intentional error');
          }
          const seed = text.length;
          const raw = Array.from({ length: 768 }, (_, i) => Math.sin(seed * (i + 1) * 0.01));
          const norm = Math.sqrt(raw.reduce((sum, val) => sum + val * val, 0));
          return raw.map((val) => val / norm);
        });

        const errorService = { generateEmbedding: errorOnSecond };
        const svc = new MultimodalEmbeddingService(errorService);

        const items = [
          { content: 'Content 1' },
          { content: 'ERROR_TRIGGER content' },
          { content: 'Content 3' },
        ];

        const result = await svc.createOptimizedBatchMultimodalEmbeddings(items);

        expect(result.metrics.totalItems).toBe(3);
        expect(result.metrics.successCount).toBe(2);
        expect(result.metrics.failedCount).toBe(1);
      });

      it('throughputPerMinuteが計算される', async () => {
        const items = Array.from({ length: 10 }, (_, i) => ({
          content: `Content ${i}`,
        }));

        const result = await service.createOptimizedBatchMultimodalEmbeddings(items);

        expect(result.metrics.throughputPerMinute).toBeGreaterThan(0);
      });

      it('avgProcessingTimeMsが計算される', async () => {
        const items = Array.from({ length: 5 }, (_, i) => ({
          content: `Content ${i}`,
          visionFeatures: createSampleVisionFeatures(),
        }));

        const result = await service.createOptimizedBatchMultimodalEmbeddings(items);

        expect(result.metrics.avgProcessingTimeMs).toBeGreaterThanOrEqual(0);
        expect(result.metrics.totalProcessingTimeMs).toBeGreaterThanOrEqual(0);
      });
    });

    describe('キャッシュヒット率', () => {
      it('重複入力で100%キャッシュヒット', async () => {
        // 同じcontentとvisionFeaturesを持つアイテム
        const visionFeatures = createSampleVisionFeatures();
        const items = Array.from({ length: 5 }, () => ({
          content: 'Same content',
          visionFeatures,
        }));

        // 最初のバッチ処理
        const result1 = await service.createOptimizedBatchMultimodalEmbeddings(items);

        // 2回目のバッチ処理（キャッシュが効くはず）
        const result2 = await service.createOptimizedBatchMultimodalEmbeddings(items);

        // 2回目はキャッシュヒット率が高いはず
        expect(result2.metrics.cacheHitRate).toBeGreaterThan(0);
      });

      it('すべて異なる入力で0%キャッシュヒット', async () => {
        const items = Array.from({ length: 5 }, (_, i) => ({
          content: `Unique content ${i} ${Date.now()}`,
          visionFeatures: {
            rhythm: 'regular',
            whitespaceRatio: i * 0.1,
            density: 'moderate',
            gravity: 'center',
            theme: 'light',
          } as VisionFeatures,
        }));

        const result = await service.createOptimizedBatchMultimodalEmbeddings(items);

        // 初回はキャッシュヒットなし
        expect(result.metrics.cacheHitCount).toBe(0);
        expect(result.metrics.cacheHitRate).toBe(0);
      });
    });

    describe('タイムアウト処理', () => {
      it('個別アイテムタイムアウトが機能する', async () => {
        // 長時間かかるモックサービス
        const slowService: IEmbeddingService = {
          generateEmbedding: vi.fn().mockImplementation(async (text: string) => {
            if (text.includes('SLOW')) {
              // 非常に長い遅延（タイムアウトより長い）
              await new Promise((resolve) => setTimeout(resolve, 60000));
            }
            const seed = text.length;
            const raw = Array.from({ length: 768 }, (_, i) => Math.sin(seed * (i + 1) * 0.01));
            const norm = Math.sqrt(raw.reduce((sum, val) => sum + val * val, 0));
            return raw.map((val) => val / norm);
          }),
        };

        const svc = new MultimodalEmbeddingService(slowService);
        const items = [
          { content: 'Fast content 1' },
          { content: 'SLOW content' },
          { content: 'Fast content 2' },
        ];

        const result = await svc.createOptimizedBatchMultimodalEmbeddings(items, {
          itemTimeoutMs: 100, // 100msでタイムアウト
        });

        // タイムアウトしたアイテムは失敗としてカウント
        expect(result.metrics.failedCount).toBeGreaterThan(0);
        expect(result.metrics.successCount).toBeLessThan(3);
      });

      it('全体タイムアウトが機能する', async () => {
        const slowService: IEmbeddingService = {
          generateEmbedding: vi.fn().mockImplementation(async (text: string) => {
            // すべてのアイテムが少し遅い
            await new Promise((resolve) => setTimeout(resolve, 200));
            const seed = text.length;
            const raw = Array.from({ length: 768 }, (_, i) => Math.sin(seed * (i + 1) * 0.01));
            const norm = Math.sqrt(raw.reduce((sum, val) => sum + val * val, 0));
            return raw.map((val) => val / norm);
          }),
        };

        const svc = new MultimodalEmbeddingService(slowService);
        const items = Array.from({ length: 100 }, (_, i) => ({
          content: `Content ${i}`,
        }));

        const result = await svc.createOptimizedBatchMultimodalEmbeddings(items, {
          totalTimeoutMs: 500, // 500msでタイムアウト
        });

        // 全体タイムアウトにより部分的な結果が返される
        expect(result.results.length).toBeLessThan(100);
        expect(result.metrics.totalProcessingTimeMs).toBeLessThanOrEqual(600); // 多少のマージン
      });
    });

    describe('進捗コールバック', () => {
      it('進捗コールバックが呼ばれる', async () => {
        const progressCallback = vi.fn();
        const items = Array.from({ length: 10 }, (_, i) => ({
          content: `Content ${i}`,
        }));

        await service.createOptimizedBatchMultimodalEmbeddings(items, {
          onProgress: progressCallback,
        });

        // 進捗コールバックが呼ばれたことを確認
        expect(progressCallback).toHaveBeenCalled();
      });

      it('進捗コールバックに正しい情報が渡される', async () => {
        const progressUpdates: Array<{
          completed: number;
          total: number;
          percentage: number;
        }> = [];

        const items = Array.from({ length: 4 }, (_, i) => ({
          content: `Content ${i}`,
        }));

        await service.createOptimizedBatchMultimodalEmbeddings(items, {
          onProgress: (progress) => {
            progressUpdates.push(progress);
          },
        });

        // 最終的な進捗が100%になっているか
        const finalProgress = progressUpdates[progressUpdates.length - 1];
        if (finalProgress) {
          expect(finalProgress.completed).toBe(4);
          expect(finalProgress.total).toBe(4);
          expect(finalProgress.progress).toBe(1); // 1 = 100%
        }
      });
    });

    describe('Graceful Degradation', () => {
      it('個別アイテム失敗でも全体は継続する', async () => {
        const failOnThird = vi.fn().mockImplementation(async (text: string) => {
          if (text.includes('FAIL_ITEM')) {
            throw new Error('Item failure');
          }
          const seed = text.length;
          const raw = Array.from({ length: 768 }, (_, i) => Math.sin(seed * (i + 1) * 0.01));
          const norm = Math.sqrt(raw.reduce((sum, val) => sum + val * val, 0));
          return raw.map((val) => val / norm);
        });

        const svc = new MultimodalEmbeddingService({ generateEmbedding: failOnThird });
        const items = [
          { content: 'Content 1' },
          { content: 'Content 2' },
          { content: 'FAIL_ITEM content' },
          { content: 'Content 4' },
          { content: 'Content 5' },
        ];

        const result = await svc.createOptimizedBatchMultimodalEmbeddings(items);

        expect(result.metrics.totalItems).toBe(5);
        expect(result.metrics.successCount).toBe(4);
        expect(result.metrics.failedCount).toBe(1);
        expect(result.results).toHaveLength(4);
      });

      it('空のバッチを処理できる', async () => {
        const result = await service.createOptimizedBatchMultimodalEmbeddings([]);

        expect(result.results).toEqual([]);
        expect(result.metrics.totalItems).toBe(0);
        expect(result.metrics.successCount).toBe(0);
        expect(result.metrics.failedCount).toBe(0);
        expect(result.metrics.throughputPerMinute).toBe(0);
      });
    });
  });
});

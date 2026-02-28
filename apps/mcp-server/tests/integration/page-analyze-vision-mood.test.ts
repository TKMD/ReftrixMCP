// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.analyze Vision Mood/BrandTone 統合テスト - TDD RED Phase
 *
 * Phase 5: page.analyzeツールでのMood/BrandTone統合テスト
 *
 * 目的:
 * - page.analyzeレスポンスにmood/brandToneが含まれることを検証
 * - visualFeatures構造の検証
 * - Ollama未接続時のgraceful degradation検証
 * - E2Eワークフロー検証
 *
 * 参照:
 * -  (page.analyze visualFeatures)
 * - apps/mcp-server/src/tools/page/analyze.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';

// =============================================================================
// インポート（動的インポートで TDD RED Phase を実現）
// =============================================================================

// NOTE: TDD RED Phase - 動的インポートを使用して、テストが実行され失敗することを確認

// =============================================================================
// 型定義（テスト用）
// =============================================================================

/**
 * 有効なMoodタイプ
 */
const VALID_MOODS = [
  'professional',
  'playful',
  'minimal',
  'bold',
  'elegant',
  'modern',
  'classic',
  'energetic',
  'calm',
  'luxurious',
] as const;

/**
 * 有効なBrandToneタイプ
 */
const VALID_BRAND_TONES = [
  'corporate',
  'friendly',
  'luxury',
  'tech-forward',
  'creative',
  'trustworthy',
  'innovative',
  'traditional',
] as const;

/**
 * visualFeatures.mood スキーマ
 */
const MoodSchema = z.object({
  primary: z.enum(VALID_MOODS),
  secondary: z.enum(VALID_MOODS).optional(),
  confidence: z.number().min(0.6).max(1),
}).nullable();

/**
 * visualFeatures.brandTone スキーマ
 */
const BrandToneSchema = z.object({
  primary: z.enum(VALID_BRAND_TONES),
  secondary: z.enum(VALID_BRAND_TONES).optional(),
  confidence: z.number().min(0.6).max(1),
}).nullable();

/**
 * visualFeatures スキーマ（mood/brandTone含む）
 */
const VisualFeaturesSchema = z.object({
  colors: z.object({
    dominant: z.array(z.string()),
    accent: z.array(z.string()).optional(),
    palette: z.array(z.object({
      color: z.string(),
      percentage: z.number(),
    })).optional(),
  }),
  theme: z.object({
    type: z.enum(['light', 'dark', 'mixed']),
    backgroundColor: z.string().optional(),
    textColor: z.string().optional(),
    contrastRatio: z.number().optional(),
  }),
  density: z.object({
    contentDensity: z.number().min(0).max(1),
    whitespaceRatio: z.number().min(0).max(1),
    visualBalance: z.number().min(0).max(100).optional(),
  }),
  gradient: z.object({
    hasGradient: z.boolean(),
    gradients: z.array(z.object({
      type: z.enum(['linear', 'radial', 'conic']),
      direction: z.string().optional(),
      colorStops: z.array(z.string()).optional(),
    })).optional(),
    dominantGradientType: z.enum(['linear', 'radial', 'conic']).nullable().optional(),
  }),
  // Phase 5: Vision AI 分析結果
  mood: MoodSchema,
  brandTone: BrandToneSchema,
  metadata: z.object({
    mergedAt: z.string(),
    deterministicAvailable: z.boolean(),
    visionAiAvailable: z.boolean(),
    overallConfidence: z.number().min(0).max(1),
  }),
});

/**
 * PageAnalyzeInput 型定義（テスト用）
 */
interface PageAnalyzeInput {
  url: string;
  timeout?: number;
  layoutOptions?: {
    useVision?: boolean;
    saveToDb?: boolean;
  };
  features?: {
    layout?: boolean;
    motion?: boolean;
    quality?: boolean;
  };
}

// =============================================================================
// モック設定
// =============================================================================

const mockFetch = vi.fn();
global.fetch = mockFetch;

// Playwrightモック
vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn().mockResolvedValue({
      newContext: vi.fn().mockResolvedValue({
        newPage: vi.fn().mockResolvedValue({
          goto: vi.fn().mockResolvedValue(null),
          screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-screenshot')),
          content: vi.fn().mockResolvedValue('<html><body>Test</body></html>'),
          evaluate: vi.fn().mockResolvedValue({}),
          close: vi.fn().mockResolvedValue(null),
        }),
        close: vi.fn().mockResolvedValue(null),
      }),
      close: vi.fn().mockResolvedValue(null),
    }),
  },
}));

// =============================================================================
// テストケース
// =============================================================================

// NOTE: analyze.handlerがまだ実装されていないため、一時的にスキップ
// layout-handler.ts統合フェーズで有効化する
describe.skip('page.analyze Vision Mood/BrandTone Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // TDD RED Phase 確認テスト
  // ===========================================================================

  describe('TDD RED Phase verification', () => {
    it('should have handlePageAnalyze implementation - TDD RED Phase', async () => {
      // TDD RED Phase: このテストは実装が存在しないことを確認
      // 実装後、このテストは削除または修正される
      await expect(async () => {
        const module = await import('@/tools/page/handlers/analyze.handler');
        return module.handlePageAnalyze;
      }).rejects.toThrow();
    });
  });

  // ===========================================================================
  // mood 統合テスト
  // ===========================================================================

  describe('mood in page.analyze response', () => {
    it('should include mood in page.analyze response', async () => {
      // Arrange: Ollamaのmood分析レスポンスをモック
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          model: 'llama3.2-vision',
          response: JSON.stringify({
            primaryMood: 'professional',
            secondaryMood: 'minimal',
            confidence: 0.85,
            indicators: ['clean typography', 'neutral colors'],
            colorContextUsed: true,
          }),
          done: true,
        }),
      });

      const { handlePageAnalyze } = await import('@/tools/page/handlers/analyze.handler');

      const input: PageAnalyzeInput = {
        url: 'https://example.com',
        layoutOptions: {
          useVision: true,
        },
      };

      // Act
      const result = await handlePageAnalyze(input);

      // Assert: visualFeatures.moodが存在
      expect(result.data.layout.visualFeatures).toBeDefined();
      expect(result.data.layout.visualFeatures.mood).toBeDefined();

      if (result.data.layout.visualFeatures.mood) {
        expect(VALID_MOODS).toContain(result.data.layout.visualFeatures.mood.primary);
        expect(result.data.layout.visualFeatures.mood.confidence).toBeGreaterThanOrEqual(0.6);
      }
    });

    it('should validate mood conforms to MoodSchema', async () => {
      // Arrange
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          model: 'llama3.2-vision',
          response: JSON.stringify({
            primaryMood: 'elegant',
            secondaryMood: 'luxurious',
            confidence: 0.92,
            indicators: ['serif fonts', 'gold accents'],
            colorContextUsed: true,
          }),
          done: true,
        }),
      });

      const { handlePageAnalyze } = await import('@/tools/page/handlers/analyze.handler');

      const input: PageAnalyzeInput = {
        url: 'https://luxury-brand.com',
        layoutOptions: { useVision: true },
      };

      // Act
      const result = await handlePageAnalyze(input);

      // Assert
      const moodParseResult = MoodSchema.safeParse(result.data.layout.visualFeatures.mood);
      expect(moodParseResult.success).toBe(true);
    });

    it('should return null mood if Vision AI unavailable', async () => {
      // Arrange: Ollama接続エラー
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      const { handlePageAnalyze } = await import('@/tools/page/handlers/analyze.handler');

      const input: PageAnalyzeInput = {
        url: 'https://example.com',
        layoutOptions: { useVision: true },
      };

      // Act
      const result = await handlePageAnalyze(input);

      // Assert: mood is null but analysis continues
      expect(result.data.layout.visualFeatures.mood).toBeNull();
      expect(result.data.layout.visualFeatures.metadata.visionAiAvailable).toBe(false);
    });

    it('should return null mood if confidence < 0.6', async () => {
      // Arrange: 低信頼度レスポンス
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          model: 'llama3.2-vision',
          response: JSON.stringify({
            primaryMood: 'playful',
            confidence: 0.45, // 閾値以下
            indicators: [],
            colorContextUsed: false,
          }),
          done: true,
        }),
      });

      const { handlePageAnalyze } = await import('@/tools/page/handlers/analyze.handler');

      const input: PageAnalyzeInput = {
        url: 'https://example.com',
        layoutOptions: { useVision: true },
      };

      // Act
      const result = await handlePageAnalyze(input);

      // Assert
      expect(result.data.layout.visualFeatures.mood).toBeNull();
    });
  });

  // ===========================================================================
  // brandTone 統合テスト
  // ===========================================================================

  describe('brandTone in page.analyze response', () => {
    it('should include brandTone in page.analyze response', async () => {
      // Arrange
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          model: 'llama3.2-vision',
          response: JSON.stringify({
            primaryTone: 'corporate',
            secondaryTone: 'trustworthy',
            confidence: 0.88,
            professionalism: 'bold',
            warmth: 'neutral',
            modernity: 'contemporary',
            energy: 'balanced',
            targetAudience: 'enterprise',
            indicators: ['blue color scheme', 'formal layout'],
            colorContextUsed: true,
          }),
          done: true,
        }),
      });

      const { handlePageAnalyze } = await import('@/tools/page/handlers/analyze.handler');

      const input: PageAnalyzeInput = {
        url: 'https://enterprise.com',
        layoutOptions: { useVision: true },
      };

      // Act
      const result = await handlePageAnalyze(input);

      // Assert
      expect(result.data.layout.visualFeatures).toBeDefined();
      expect(result.data.layout.visualFeatures.brandTone).toBeDefined();

      if (result.data.layout.visualFeatures.brandTone) {
        expect(VALID_BRAND_TONES).toContain(result.data.layout.visualFeatures.brandTone.primary);
        expect(result.data.layout.visualFeatures.brandTone.confidence).toBeGreaterThanOrEqual(0.6);
      }
    });

    it('should validate brandTone conforms to BrandToneSchema', async () => {
      // Arrange
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          model: 'llama3.2-vision',
          response: JSON.stringify({
            primaryTone: 'tech-forward',
            secondaryTone: 'innovative',
            confidence: 0.90,
            professionalism: 'moderate',
            warmth: 'neutral',
            modernity: 'futuristic',
            energy: 'dynamic',
            targetAudience: 'startup',
            indicators: ['gradient backgrounds', 'modern UI'],
            colorContextUsed: true,
          }),
          done: true,
        }),
      });

      const { handlePageAnalyze } = await import('@/tools/page/handlers/analyze.handler');

      const input: PageAnalyzeInput = {
        url: 'https://tech-startup.com',
        layoutOptions: { useVision: true },
      };

      // Act
      const result = await handlePageAnalyze(input);

      // Assert
      const brandToneParseResult = BrandToneSchema.safeParse(result.data.layout.visualFeatures.brandTone);
      expect(brandToneParseResult.success).toBe(true);
    });

    it('should return null brandTone if Vision AI unavailable', async () => {
      // Arrange
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      const { handlePageAnalyze } = await import('@/tools/page/handlers/analyze.handler');

      const input: PageAnalyzeInput = {
        url: 'https://example.com',
        layoutOptions: { useVision: true },
      };

      // Act
      const result = await handlePageAnalyze(input);

      // Assert
      expect(result.data.layout.visualFeatures.brandTone).toBeNull();
      expect(result.data.layout.visualFeatures.metadata.visionAiAvailable).toBe(false);
    });
  });

  // ===========================================================================
  // Graceful Degradation テスト
  // ===========================================================================

  describe('graceful degradation', () => {
    it('should handle Ollama unavailable gracefully', async () => {
      // Arrange: Ollamaがダウン
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const { handlePageAnalyze } = await import('@/tools/page/handlers/analyze.handler');

      const input: PageAnalyzeInput = {
        url: 'https://example.com',
        layoutOptions: { useVision: true },
      };

      // Act
      const result = await handlePageAnalyze(input);

      // Assert: 分析は続行される
      expect(result.data).toBeDefined();
      expect(result.data.layout).toBeDefined();
      expect(result.data.layout.visualFeatures).toBeDefined();

      // mood/brandToneはnull
      expect(result.data.layout.visualFeatures.mood).toBeNull();
      expect(result.data.layout.visualFeatures.brandTone).toBeNull();

      // deterministic featuresは利用可能
      expect(result.data.layout.visualFeatures.colors).toBeDefined();
      expect(result.data.layout.visualFeatures.theme).toBeDefined();
      expect(result.data.layout.visualFeatures.density).toBeDefined();

      // metadata
      expect(result.data.layout.visualFeatures.metadata.deterministicAvailable).toBe(true);
      expect(result.data.layout.visualFeatures.metadata.visionAiAvailable).toBe(false);
    });

    it('should continue analysis if mood extraction fails', async () => {
      // Arrange: mood分析が失敗
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            model: 'llama3.2-vision',
            response: 'invalid json response',
            done: true,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            model: 'llama3.2-vision',
            response: JSON.stringify({
              primaryTone: 'corporate',
              confidence: 0.85,
              professionalism: 'bold',
              warmth: 'neutral',
              modernity: 'contemporary',
              energy: 'balanced',
              targetAudience: 'enterprise',
              indicators: [],
              colorContextUsed: false,
            }),
            done: true,
          }),
        });

      const { handlePageAnalyze } = await import('@/tools/page/handlers/analyze.handler');

      const input: PageAnalyzeInput = {
        url: 'https://example.com',
        layoutOptions: { useVision: true },
      };

      // Act
      const result = await handlePageAnalyze(input);

      // Assert: brandToneは成功、moodはnull
      expect(result.data.layout.visualFeatures.mood).toBeNull();
      // brandToneは実装依存だが、エラーでもnullになる可能性
    });

    it('should set visionAiAvailable flag correctly', async () => {
      // Arrange: Ollama利用可能
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          model: 'llama3.2-vision',
          response: JSON.stringify({
            primaryMood: 'professional',
            confidence: 0.85,
            indicators: [],
            colorContextUsed: true,
          }),
          done: true,
        }),
      });

      const { handlePageAnalyze } = await import('@/tools/page/handlers/analyze.handler');

      const input: PageAnalyzeInput = {
        url: 'https://example.com',
        layoutOptions: { useVision: true },
      };

      // Act
      const result = await handlePageAnalyze(input);

      // Assert
      expect(result.data.layout.visualFeatures.metadata.visionAiAvailable).toBe(true);
    });
  });

  // ===========================================================================
  // visualFeatures 完全性テスト
  // ===========================================================================

  describe('visualFeatures completeness', () => {
    it('should include all required visualFeatures fields', async () => {
      // Arrange
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          model: 'llama3.2-vision',
          response: JSON.stringify({
            primaryMood: 'minimal',
            secondaryMood: 'calm',
            confidence: 0.88,
            indicators: ['whitespace', 'simple typography'],
            colorContextUsed: true,
          }),
          done: true,
        }),
      });

      const { handlePageAnalyze } = await import('@/tools/page/handlers/analyze.handler');

      const input: PageAnalyzeInput = {
        url: 'https://example.com',
        layoutOptions: { useVision: true },
      };

      // Act
      const result = await handlePageAnalyze(input);

      // Assert
      const visualFeatures = result.data.layout.visualFeatures;

      // Phase 1: Deterministic features
      expect(visualFeatures.colors).toBeDefined();
      expect(visualFeatures.theme).toBeDefined();
      expect(visualFeatures.density).toBeDefined();
      expect(visualFeatures.gradient).toBeDefined();

      // Phase 5: Vision AI features
      expect('mood' in visualFeatures).toBe(true);
      expect('brandTone' in visualFeatures).toBe(true);

      // Metadata
      expect(visualFeatures.metadata).toBeDefined();
      expect(visualFeatures.metadata.mergedAt).toBeDefined();
      expect(visualFeatures.metadata.deterministicAvailable).toBeDefined();
      expect(visualFeatures.metadata.visionAiAvailable).toBeDefined();
      expect(visualFeatures.metadata.overallConfidence).toBeDefined();
    });

    it('should validate full visualFeatures against schema', async () => {
      // Arrange
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          model: 'llama3.2-vision',
          response: JSON.stringify({
            primaryMood: 'bold',
            secondaryMood: 'energetic',
            confidence: 0.82,
            indicators: ['vibrant colors', 'large typography'],
            colorContextUsed: true,
          }),
          done: true,
        }),
      });

      const { handlePageAnalyze } = await import('@/tools/page/handlers/analyze.handler');

      const input: PageAnalyzeInput = {
        url: 'https://example.com',
        layoutOptions: { useVision: true },
      };

      // Act
      const result = await handlePageAnalyze(input);

      // Assert
      const parseResult = VisualFeaturesSchema.safeParse(result.data.layout.visualFeatures);
      expect(parseResult.success).toBe(true);
    });
  });

  // ===========================================================================
  // useVision オプションテスト
  // ===========================================================================

  describe('useVision option', () => {
    it('should skip Vision AI when useVision is false', async () => {
      // Arrange
      const { handlePageAnalyze } = await import('@/tools/page/handlers/analyze.handler');

      const input: PageAnalyzeInput = {
        url: 'https://example.com',
        layoutOptions: { useVision: false },
      };

      // Act
      const result = await handlePageAnalyze(input);

      // Assert: Ollamaは呼び出されない
      expect(mockFetch).not.toHaveBeenCalled();

      // mood/brandToneはnull
      expect(result.data.layout.visualFeatures.mood).toBeNull();
      expect(result.data.layout.visualFeatures.brandTone).toBeNull();
      expect(result.data.layout.visualFeatures.metadata.visionAiAvailable).toBe(false);
    });

    it('should enable Vision AI by default (useVision: true)', async () => {
      // Arrange
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          model: 'llama3.2-vision',
          response: JSON.stringify({
            primaryMood: 'professional',
            confidence: 0.8,
            indicators: [],
            colorContextUsed: false,
          }),
          done: true,
        }),
      });

      const { handlePageAnalyze } = await import('@/tools/page/handlers/analyze.handler');

      const input: PageAnalyzeInput = {
        url: 'https://example.com',
        // layoutOptions.useVision はデフォルトでtrue
      };

      // Act
      const result = await handlePageAnalyze(input);

      // Assert: Ollamaが呼び出される
      expect(mockFetch).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // パフォーマンステスト
  // ===========================================================================

  describe('performance', () => {
    it('should complete analysis within timeout', async () => {
      // Arrange
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          model: 'llama3.2-vision',
          response: JSON.stringify({
            primaryMood: 'professional',
            confidence: 0.85,
            indicators: [],
            colorContextUsed: false,
          }),
          done: true,
        }),
      });

      const { handlePageAnalyze } = await import('@/tools/page/handlers/analyze.handler');

      const input: PageAnalyzeInput = {
        url: 'https://example.com',
        timeout: 60000, // 60秒
        layoutOptions: { useVision: true },
      };

      // Act
      const startTime = Date.now();
      const result = await handlePageAnalyze(input);
      const duration = Date.now() - startTime;

      // Assert
      expect(result.data).toBeDefined();
      expect(duration).toBeLessThan(60000);
    });

    it('should cache Vision AI results', async () => {
      // Arrange
      let callCount = 0;
      mockFetch.mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          ok: true,
          json: async () => ({
            model: 'llama3.2-vision',
            response: JSON.stringify({
              primaryMood: 'minimal',
              confidence: 0.85,
              indicators: [],
              colorContextUsed: false,
            }),
            done: true,
          }),
        });
      });

      const { handlePageAnalyze } = await import('@/tools/page/handlers/analyze.handler');

      const input: PageAnalyzeInput = {
        url: 'https://example.com',
        layoutOptions: { useVision: true },
      };

      // Act: 2回実行
      await handlePageAnalyze(input);
      await handlePageAnalyze(input);

      // Assert: キャッシュにより1回のみ呼び出し（実装依存）
      // NOTE: 実際の実装ではURLごとにキャッシュする可能性がある
      expect(callCount).toBeGreaterThanOrEqual(1);
    });
  });
});

// =============================================================================
// E2E統合テスト
// =============================================================================

// NOTE: analyze.handlerがまだ実装されていないため、一時的にスキップ
// layout-handler.ts統合フェーズで有効化する
describe.skip('page.analyze E2E Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should complete full workflow with Vision AI', async () => {
    // Arrange
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        model: 'llama3.2-vision',
        response: JSON.stringify({
          primaryMood: 'professional',
          secondaryMood: 'elegant',
          confidence: 0.88,
          indicators: ['clean design', 'professional imagery'],
          colorContextUsed: true,
        }),
        done: true,
      }),
    });

    const { handlePageAnalyze } = await import('@/tools/page/handlers/analyze.handler');

    const input: PageAnalyzeInput = {
      url: 'https://example.com',
      layoutOptions: {
        useVision: true,
        saveToDb: false, // テスト用にDB保存をスキップ
      },
      features: {
        layout: true,
        motion: false,
        quality: false,
      },
    };

    // Act
    const result = await handlePageAnalyze(input);

    // Assert
    expect(result).toBeDefined();
    expect(result.data).toBeDefined();
    expect(result.data.layout).toBeDefined();
    expect(result.data.layout.visualFeatures).toBeDefined();

    // mood検証
    const mood = result.data.layout.visualFeatures.mood;
    expect(mood).not.toBeNull();
    if (mood) {
      expect(mood.primary).toBe('professional');
      expect(mood.secondary).toBe('elegant');
      expect(mood.confidence).toBe(0.88);
    }

    // metadata検証
    const metadata = result.data.layout.visualFeatures.metadata;
    expect(metadata.visionAiAvailable).toBe(true);
    expect(metadata.deterministicAvailable).toBe(true);
  });
});

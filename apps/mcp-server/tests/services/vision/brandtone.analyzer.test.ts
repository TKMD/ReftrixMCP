// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BrandToneAnalyzer テスト - TDD RED Phase
 *
 * Phase 5: BrandTone分析サービスのユニットテスト
 *
 * 目的:
 * - Base64スクリーンショットからブランドトーンを抽出
 * - primary/secondary tone検出
 * - 各属性（professionalism, warmth, modernity, energy）検出
 * - confidence スコア検証（0.6以上が有効）
 * - Ollama未接続時のgraceful degradation
 * - LRUキャッシュ検証
 * - セキュリティ検証（サイズ制限、入力バリデーション）
 *
 * 参照:
 * -  (page.analyze visualFeatures)
 * - apps/mcp-server/src/services/vision-adapter/interface.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';

// =============================================================================
// BrandToneAnalyzer インポート（動的インポートで TDD RED Phase を実現）
// =============================================================================

// NOTE: TDD RED Phase - 動的インポートを使用して、テストが実行され失敗することを確認
// 実装ファイル: apps/mcp-server/src/services/vision/brandtone.analyzer.ts

// =============================================================================
// 型定義（テスト用）
// =============================================================================

/**
 * 有効なBrandToneタイプ一覧
 * - corporate: コーポレート
 * - friendly: フレンドリー
 * - luxury: ラグジュアリー
 * - tech-forward: テックフォワード
 * - creative: クリエイティブ
 * - trustworthy: 信頼性
 * - innovative: 革新的
 * - traditional: トラディショナル
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
 * Professionalism レベル
 */
const PROFESSIONALISM_LEVELS = ['minimal', 'moderate', 'bold'] as const;

/**
 * Warmth レベル
 */
const WARMTH_LEVELS = ['cold', 'neutral', 'warm'] as const;

/**
 * Modernity レベル
 */
const MODERNITY_LEVELS = ['classic', 'contemporary', 'futuristic'] as const;

/**
 * Energy レベル
 */
const ENERGY_LEVELS = ['calm', 'balanced', 'dynamic'] as const;

/**
 * Target Audience
 */
const TARGET_AUDIENCES = ['enterprise', 'startup', 'creative', 'consumer'] as const;

/**
 * EnhancedBrandToneResultのZodスキーマ（テスト検証用）
 */
const BrandToneResultSchema = z.object({
  primaryTone: z.enum(VALID_BRAND_TONES),
  secondaryTone: z.enum(VALID_BRAND_TONES).optional(),
  confidence: z.number().min(0.6).max(1),
  professionalism: z.enum(PROFESSIONALISM_LEVELS),
  warmth: z.enum(WARMTH_LEVELS),
  modernity: z.enum(MODERNITY_LEVELS),
  energy: z.enum(ENERGY_LEVELS),
  targetAudience: z.enum(TARGET_AUDIENCES),
  indicators: z.array(z.string()),
  colorContextUsed: z.boolean(),
});

// =============================================================================
// ヘルパー関数
// =============================================================================

/**
 * テスト用の有効なBase64画像データを生成
 */
function createTestBase64Image(sizeBytes = 1000): string {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const data = Buffer.alloc(Math.max(0, sizeBytes - header.length));
  return Buffer.concat([header, data]).toString('base64');
}

/**
 * 無効なBase64文字列を生成
 */
function createInvalidBase64(): string {
  return '!!!not-valid-base64!!!@#$%^&*()';
}

/**
 * 5MB超の大きなBase64画像を生成
 */
function createOversizedBase64(): string {
  const largeBuffer = Buffer.alloc(10 * 1024 * 1024); // 10MB
  return largeBuffer.toString('base64');
}

// =============================================================================
// グローバルモック
// =============================================================================

const mockFetch = vi.fn();
global.fetch = mockFetch;

// =============================================================================
// テストケース
// =============================================================================

describe('BrandToneAnalyzer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // 実装存在確認テスト（TDD GREEN Phase）
  // ===========================================================================

  describe('implementation verification', () => {
    it('should have BrandToneAnalyzer implementation', async () => {
      // TDD GREEN Phase: 実装が存在することを確認
      const module = await import('@/services/vision/brandtone.analyzer');
      expect(module.BrandToneAnalyzer).toBeDefined();
      expect(typeof module.BrandToneAnalyzer).toBe('function');
    });
  });

  // ===========================================================================
  // Brand Tone抽出テスト
  // ===========================================================================

  describe('brand tone extraction', () => {
    it('should extract primary brand tone from screenshot', async () => {
      // Arrange
      const { BrandToneAnalyzer } = await import('@/services/vision/brandtone.analyzer');
      const analyzer = new BrandToneAnalyzer();
      const screenshot = createTestBase64Image();

      // Mock fetch to return valid response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryTone: 'corporate',
            secondaryTone: 'trustworthy',
            confidence: 0.85,
            professionalism: 'bold',
            warmth: 'neutral',
            modernity: 'contemporary',
            energy: 'balanced',
            targetAudience: 'enterprise',
            indicators: ['formal typography', 'professional imagery'],
            colorContextUsed: false,
          }),
        }),
      });

      // Act
      const result = await analyzer.analyze(screenshot);

      // Assert
      expect(result).toBeDefined();
      expect(result?.primaryTone).toBeDefined();
      expect(VALID_BRAND_TONES).toContain(result?.primaryTone);
    });

    it('should extract secondary brand tone from screenshot', async () => {
      // Arrange
      const { BrandToneAnalyzer } = await import('@/services/vision/brandtone.analyzer');
      const analyzer = new BrandToneAnalyzer();
      const screenshot = createTestBase64Image();

      // Mock fetch to return valid response with secondary tone
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryTone: 'luxury',
            secondaryTone: 'innovative',
            confidence: 0.88,
            professionalism: 'bold',
            warmth: 'warm',
            modernity: 'contemporary',
            energy: 'calm',
            targetAudience: 'consumer',
            indicators: ['elegant design', 'premium feel'],
            colorContextUsed: false,
          }),
        }),
      });

      // Act
      const result = await analyzer.analyze(screenshot);

      // Assert
      expect(result?.secondaryTone).toBeDefined();
      if (result?.secondaryTone) {
        expect(VALID_BRAND_TONES).toContain(result.secondaryTone);
      }
    });

    it('should return confidence score between 0.6 and 1', async () => {
      // Arrange
      const { BrandToneAnalyzer } = await import('@/services/vision/brandtone.analyzer');
      const analyzer = new BrandToneAnalyzer();
      const screenshot = createTestBase64Image();

      // Mock fetch to return valid response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryTone: 'tech-forward',
            confidence: 0.78,
            professionalism: 'moderate',
            warmth: 'neutral',
            modernity: 'futuristic',
            energy: 'dynamic',
            targetAudience: 'startup',
            indicators: ['modern UI patterns'],
            colorContextUsed: false,
          }),
        }),
      });

      // Act
      const result = await analyzer.analyze(screenshot);

      // Assert
      expect(result?.confidence).toBeGreaterThanOrEqual(0.6);
      expect(result?.confidence).toBeLessThanOrEqual(1);
    });

    it('should extract professionalism level', async () => {
      // Arrange
      const { BrandToneAnalyzer } = await import('@/services/vision/brandtone.analyzer');
      const analyzer = new BrandToneAnalyzer();
      const screenshot = createTestBase64Image();

      // Mock fetch to return valid response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryTone: 'corporate',
            confidence: 0.82,
            professionalism: 'bold',
            warmth: 'cold',
            modernity: 'contemporary',
            energy: 'calm',
            targetAudience: 'enterprise',
            indicators: ['structured layout'],
            colorContextUsed: false,
          }),
        }),
      });

      // Act
      const result = await analyzer.analyze(screenshot);

      // Assert
      expect(result?.professionalism).toBeDefined();
      expect(PROFESSIONALISM_LEVELS).toContain(result?.professionalism);
    });

    it('should extract warmth level', async () => {
      // Arrange
      const { BrandToneAnalyzer } = await import('@/services/vision/brandtone.analyzer');
      const analyzer = new BrandToneAnalyzer();
      const screenshot = createTestBase64Image();

      // Mock fetch to return valid response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryTone: 'friendly',
            confidence: 0.80,
            professionalism: 'minimal',
            warmth: 'warm',
            modernity: 'contemporary',
            energy: 'balanced',
            targetAudience: 'consumer',
            indicators: ['warm colors', 'friendly tone'],
            colorContextUsed: false,
          }),
        }),
      });

      // Act
      const result = await analyzer.analyze(screenshot);

      // Assert
      expect(result?.warmth).toBeDefined();
      expect(WARMTH_LEVELS).toContain(result?.warmth);
    });

    it('should extract modernity level', async () => {
      // Arrange
      const { BrandToneAnalyzer } = await import('@/services/vision/brandtone.analyzer');
      const analyzer = new BrandToneAnalyzer();
      const screenshot = createTestBase64Image();

      // Mock fetch to return valid response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryTone: 'innovative',
            confidence: 0.85,
            professionalism: 'moderate',
            warmth: 'neutral',
            modernity: 'futuristic',
            energy: 'dynamic',
            targetAudience: 'startup',
            indicators: ['cutting-edge design'],
            colorContextUsed: false,
          }),
        }),
      });

      // Act
      const result = await analyzer.analyze(screenshot);

      // Assert
      expect(result?.modernity).toBeDefined();
      expect(MODERNITY_LEVELS).toContain(result?.modernity);
    });

    it('should extract energy level', async () => {
      // Arrange
      const { BrandToneAnalyzer } = await import('@/services/vision/brandtone.analyzer');
      const analyzer = new BrandToneAnalyzer();
      const screenshot = createTestBase64Image();

      // Mock fetch to return valid response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryTone: 'creative',
            confidence: 0.83,
            professionalism: 'minimal',
            warmth: 'warm',
            modernity: 'contemporary',
            energy: 'dynamic',
            targetAudience: 'creative',
            indicators: ['bold colors', 'dynamic layout'],
            colorContextUsed: false,
          }),
        }),
      });

      // Act
      const result = await analyzer.analyze(screenshot);

      // Assert
      expect(result?.energy).toBeDefined();
      expect(ENERGY_LEVELS).toContain(result?.energy);
    });

    it('should extract target audience', async () => {
      // Arrange
      const { BrandToneAnalyzer } = await import('@/services/vision/brandtone.analyzer');
      const analyzer = new BrandToneAnalyzer();
      const screenshot = createTestBase64Image();

      // Mock fetch to return valid response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryTone: 'tech-forward',
            confidence: 0.87,
            professionalism: 'moderate',
            warmth: 'neutral',
            modernity: 'futuristic',
            energy: 'dynamic',
            targetAudience: 'startup',
            indicators: ['tech aesthetics', 'startup vibe'],
            colorContextUsed: false,
          }),
        }),
      });

      // Act
      const result = await analyzer.analyze(screenshot);

      // Assert
      expect(result?.targetAudience).toBeDefined();
      expect(TARGET_AUDIENCES).toContain(result?.targetAudience);
    });

    it('should return indicators array', async () => {
      // Arrange
      const { BrandToneAnalyzer } = await import('@/services/vision/brandtone.analyzer');
      const analyzer = new BrandToneAnalyzer();
      const screenshot = createTestBase64Image();

      // Mock fetch to return valid response with indicators
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryTone: 'trustworthy',
            confidence: 0.90,
            professionalism: 'bold',
            warmth: 'neutral',
            modernity: 'contemporary',
            energy: 'calm',
            targetAudience: 'enterprise',
            indicators: ['blue color scheme', 'clean layout', 'professional imagery'],
            colorContextUsed: false,
          }),
        }),
      });

      // Act
      const result = await analyzer.analyze(screenshot);

      // Assert
      expect(result?.indicators).toBeDefined();
      expect(Array.isArray(result?.indicators)).toBe(true);
    });

    it('should conform to EnhancedBrandToneResult schema', async () => {
      // Arrange
      const { BrandToneAnalyzer } = await import('@/services/vision/brandtone.analyzer');
      const analyzer = new BrandToneAnalyzer();
      const screenshot = createTestBase64Image();

      // Mock fetch to return valid response conforming to schema
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryTone: 'corporate',
            secondaryTone: 'trustworthy',
            confidence: 0.88,
            professionalism: 'bold',
            warmth: 'neutral',
            modernity: 'contemporary',
            energy: 'balanced',
            targetAudience: 'enterprise',
            indicators: ['formal typography', 'structured layout', 'professional colors'],
            colorContextUsed: false,
          }),
        }),
      });

      // Act
      const result = await analyzer.analyze(screenshot);

      // Assert
      expect(result).not.toBeNull();
      const parseResult = BrandToneResultSchema.safeParse(result);
      expect(parseResult.success).toBe(true);
    });
  });

  // ===========================================================================
  // 信頼度閾値テスト
  // ===========================================================================

  describe('confidence threshold', () => {
    it('should return null if confidence < 0.6', async () => {
      // Arrange
      const { BrandToneAnalyzer } = await import('@/services/vision/brandtone.analyzer');
      const analyzer = new BrandToneAnalyzer();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryTone: 'corporate',
            secondaryTone: 'trustworthy',
            confidence: 0.45, // 閾値以下
            professionalism: 'moderate',
            warmth: 'neutral',
            modernity: 'contemporary',
            energy: 'balanced',
            targetAudience: 'enterprise',
            indicators: ['test'],
            colorContextUsed: false,
          }),
        }),
      });

      const screenshot = createTestBase64Image();

      // Act
      const result = await analyzer.analyze(screenshot);

      // Assert
      expect(result).toBeNull();
    });

    it('should return result if confidence >= 0.6', async () => {
      // Arrange
      const { BrandToneAnalyzer } = await import('@/services/vision/brandtone.analyzer');
      const analyzer = new BrandToneAnalyzer();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryTone: 'luxury',
            secondaryTone: 'innovative',
            confidence: 0.75,
            professionalism: 'bold',
            warmth: 'warm',
            modernity: 'futuristic',
            energy: 'dynamic',
            targetAudience: 'creative',
            indicators: ['premium materials', 'high contrast'],
            colorContextUsed: false,
          }),
        }),
      });

      const screenshot = createTestBase64Image();

      // Act
      const result = await analyzer.analyze(screenshot);

      // Assert
      expect(result).not.toBeNull();
      expect(result?.confidence).toBeGreaterThanOrEqual(0.6);
    });
  });

  // ===========================================================================
  // エラーハンドリングテスト
  // ===========================================================================

  describe('error handling', () => {
    it('should return null if Ollama unavailable', async () => {
      // Arrange
      const { BrandToneAnalyzer } = await import('@/services/vision/brandtone.analyzer');
      const analyzer = new BrandToneAnalyzer();
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      const screenshot = createTestBase64Image();

      // Act
      const result = await analyzer.analyze(screenshot);

      // Assert
      expect(result).toBeNull();
    });

    it('should timeout after 30 seconds', async () => {
      // Arrange
      const { BrandToneAnalyzer } = await import('@/services/vision/brandtone.analyzer');
      // リトライを無効化してタイムアウト動作を正確にテスト
      const analyzer = new BrandToneAnalyzer({ enableRetry: false });
      // AbortSignalを尊重するモック（タイムアウトをシミュレート）
      mockFetch.mockImplementation(
        (_url: string, options?: { signal?: AbortSignal }) => {
          return new Promise((_resolve, reject) => {
            const timeoutId = setTimeout(() => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            }, 35000);

            // AbortSignalがabortされたらreject
            if (options?.signal) {
              options.signal.addEventListener('abort', () => {
                clearTimeout(timeoutId);
                reject(new DOMException('The operation was aborted.', 'AbortError'));
              });
            }
          });
        }
      );

      const screenshot = createTestBase64Image();

      // Act
      const startTime = Date.now();
      const result = await analyzer.analyze(screenshot);
      const elapsed = Date.now() - startTime;

      // Assert
      expect(result).toBeNull();
      // 40秒未満（CI環境のリソース競合を考慮: 30秒タイムアウト + テスト実行オーバーヘッド）
      expect(elapsed).toBeLessThan(40000);
    }, 40000);

    it('should validate Base64 input', async () => {
      // Arrange
      const { BrandToneAnalyzer } = await import('@/services/vision/brandtone.analyzer');
      const analyzer = new BrandToneAnalyzer();
      const invalidBase64 = createInvalidBase64();

      // Act & Assert
      await expect(async () => {
        await analyzer.analyze(invalidBase64);
      }).rejects.toThrow();
    });

    it('should handle HTTP 500 errors gracefully', async () => {
      // Arrange
      const { BrandToneAnalyzer } = await import('@/services/vision/brandtone.analyzer');
      // リトライを無効化してエラーハンドリングを正確にテスト
      const analyzer = new BrandToneAnalyzer({ enableRetry: false });
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const screenshot = createTestBase64Image();

      // Act
      const result = await analyzer.analyze(screenshot);

      // Assert
      expect(result).toBeNull();
    });

    it('should handle malformed JSON response', async () => {
      // Arrange
      const { BrandToneAnalyzer } = await import('@/services/vision/brandtone.analyzer');
      const analyzer = new BrandToneAnalyzer();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: 'not a valid json object',
        }),
      });

      const screenshot = createTestBase64Image();

      // Act
      const result = await analyzer.analyze(screenshot);

      // Assert
      expect(result).toBeNull();
    });
  });

  // ===========================================================================
  // キャッシュテスト
  // ===========================================================================

  describe('caching', () => {
    it('should cache results for identical screenshots', async () => {
      // Arrange
      const { BrandToneAnalyzer } = await import('@/services/vision/brandtone.analyzer');
      const analyzer = new BrandToneAnalyzer();
      const screenshot = createTestBase64Image();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryTone: 'tech-forward',
            secondaryTone: 'innovative',
            confidence: 0.85,
            professionalism: 'moderate',
            warmth: 'neutral',
            modernity: 'futuristic',
            energy: 'dynamic',
            targetAudience: 'startup',
            indicators: ['modern UI', 'gradient backgrounds'],
            colorContextUsed: false,
          }),
        }),
      });

      // Act
      await analyzer.analyze(screenshot);
      await analyzer.analyze(screenshot);

      // Assert
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should return cached result faster', async () => {
      // Arrange
      const { BrandToneAnalyzer } = await import('@/services/vision/brandtone.analyzer');
      const analyzer = new BrandToneAnalyzer();
      const screenshot = createTestBase64Image();
      mockFetch.mockImplementationOnce(
        () =>
          new Promise(resolve =>
            setTimeout(
              () =>
                resolve({
                  ok: true,
                  json: async () => ({
                    response: JSON.stringify({
                      primaryTone: 'creative',
                      confidence: 0.8,
                      professionalism: 'minimal',
                      warmth: 'warm',
                      modernity: 'contemporary',
                      energy: 'dynamic',
                      targetAudience: 'creative',
                      indicators: [],
                      colorContextUsed: false,
                    }),
                  }),
                }),
              100
            )
          )
      );

      // Act
      const startFirst = Date.now();
      await analyzer.analyze(screenshot);
      const firstDuration = Date.now() - startFirst;

      const startSecond = Date.now();
      await analyzer.analyze(screenshot);
      const secondDuration = Date.now() - startSecond;

      // Assert
      expect(secondDuration).toBeLessThan(firstDuration / 2);
    });

    it('should use different cache keys for different screenshots', async () => {
      // Arrange
      const { BrandToneAnalyzer } = await import('@/services/vision/brandtone.analyzer');
      const analyzer = new BrandToneAnalyzer();
      const screenshot1 = createTestBase64Image(1000);
      const screenshot2 = createTestBase64Image(2000);
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            response: JSON.stringify({
              primaryTone: 'friendly',
              confidence: 0.9,
              professionalism: 'minimal',
              warmth: 'warm',
              modernity: 'contemporary',
              energy: 'balanced',
              targetAudience: 'consumer',
              indicators: [],
              colorContextUsed: false,
            }),
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            response: JSON.stringify({
              primaryTone: 'friendly',
              confidence: 0.9,
              professionalism: 'minimal',
              warmth: 'warm',
              modernity: 'contemporary',
              energy: 'balanced',
              targetAudience: 'consumer',
              indicators: [],
              colorContextUsed: false,
            }),
          }),
        });

      // Act
      await analyzer.analyze(screenshot1);
      await analyzer.analyze(screenshot2);

      // Assert
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  // ===========================================================================
  // セキュリティテスト
  // ===========================================================================

  describe('security', () => {
    it('should reject oversized Base64 input (> 5MB)', async () => {
      // Arrange
      const { BrandToneAnalyzer } = await import('@/services/vision/brandtone.analyzer');
      const analyzer = new BrandToneAnalyzer();
      const largeBase64 = createOversizedBase64();

      // Act & Assert
      await expect(async () => {
        await analyzer.analyze(largeBase64);
      }).rejects.toThrow('Input exceeds 5MB limit');
    });

    it('should log all Ollama API calls for audit', async () => {
      // Arrange
      const { BrandToneAnalyzer } = await import('@/services/vision/brandtone.analyzer');
      const { logger } = await import('@/utils/logger');
      const analyzer = new BrandToneAnalyzer();
      const loggerSpy = vi.spyOn(logger, 'info');
      const screenshot = createTestBase64Image();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryTone: 'corporate',
            confidence: 0.8,
            professionalism: 'bold',
            warmth: 'cold',
            modernity: 'contemporary',
            energy: 'calm',
            targetAudience: 'enterprise',
            indicators: [],
            colorContextUsed: false,
          }),
        }),
      });

      // Act
      await analyzer.analyze(screenshot);

      // Assert
      expect(loggerSpy).toHaveBeenCalledWith(
        expect.stringContaining('[BrandToneAnalyzer] Ollama API call')
      );
    });

    it('should sanitize Ollama response for injection attacks', async () => {
      // Arrange
      const { BrandToneAnalyzer } = await import('@/services/vision/brandtone.analyzer');
      const analyzer = new BrandToneAnalyzer();
      const maliciousResponse = '"; DROP TABLE sections; --';
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryTone: maliciousResponse,
            confidence: 0.8,
            professionalism: 'moderate',
            warmth: 'neutral',
            modernity: 'contemporary',
            energy: 'balanced',
            targetAudience: 'enterprise',
            indicators: [],
            colorContextUsed: false,
          }),
        }),
      });

      const screenshot = createTestBase64Image();

      // Act
      const result = await analyzer.analyze(screenshot);

      // Assert
      expect(result).toBeNull();
    });

    it('should reject XSS in indicators', async () => {
      // Arrange
      const { BrandToneAnalyzer } = await import('@/services/vision/brandtone.analyzer');
      const analyzer = new BrandToneAnalyzer();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryTone: 'corporate',
            confidence: 0.8,
            professionalism: 'moderate',
            warmth: 'neutral',
            modernity: 'contemporary',
            energy: 'balanced',
            targetAudience: 'enterprise',
            indicators: ['<script>alert("xss")</script>'],
            colorContextUsed: false,
          }),
        }),
      });

      const screenshot = createTestBase64Image();

      // Act
      const result = await analyzer.analyze(screenshot);

      // Assert
      if (result?.indicators) {
        result.indicators.forEach(indicator => {
          expect(indicator).not.toContain('<script>');
        });
      }
    });
  });

  // ===========================================================================
  // カラーコンテキスト統合テスト
  // ===========================================================================

  describe('color context integration', () => {
    it('should accept color context for enhanced analysis', async () => {
      // Arrange
      const { BrandToneAnalyzer } = await import('@/services/vision/brandtone.analyzer');
      const analyzer = new BrandToneAnalyzer();
      const screenshot = createTestBase64Image();
      const colorContext = {
        dominantColors: ['#000000', '#1a1a1a', '#333333'],
        theme: 'dark' as const,
        contentDensity: 0.3,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryTone: 'luxury',
            secondaryTone: 'innovative',
            confidence: 0.9,
            professionalism: 'bold',
            warmth: 'cold',
            modernity: 'futuristic',
            energy: 'calm',
            targetAudience: 'enterprise',
            indicators: ['dark theme', 'minimal content'],
            colorContextUsed: true,
          }),
        }),
      });

      // Act
      const result = await analyzer.analyzeWithContext(screenshot, colorContext);

      // Assert
      expect(result?.colorContextUsed).toBe(true);
    });

    it('should work without color context', async () => {
      // Arrange
      const { BrandToneAnalyzer } = await import('@/services/vision/brandtone.analyzer');
      const analyzer = new BrandToneAnalyzer();
      const screenshot = createTestBase64Image();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryTone: 'friendly',
            confidence: 0.75,
            professionalism: 'minimal',
            warmth: 'warm',
            modernity: 'contemporary',
            energy: 'balanced',
            targetAudience: 'consumer',
            indicators: [],
            colorContextUsed: false,
          }),
        }),
      });

      // Act
      const result = await analyzer.analyze(screenshot);

      // Assert
      expect(result?.colorContextUsed).toBe(false);
    });
  });

  // ===========================================================================
  // 特定のBrand Tone検出テスト
  // ===========================================================================

  describe('specific brand tone detection', () => {
    it('should detect corporate tone for enterprise websites', async () => {
      // Arrange
      const { BrandToneAnalyzer } = await import('@/services/vision/brandtone.analyzer');
      const analyzer = new BrandToneAnalyzer();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryTone: 'corporate',
            secondaryTone: 'trustworthy',
            confidence: 0.92,
            professionalism: 'bold',
            warmth: 'cold',
            modernity: 'contemporary',
            energy: 'calm',
            targetAudience: 'enterprise',
            indicators: ['formal typography', 'blue color scheme', 'structured layout'],
            colorContextUsed: false,
          }),
        }),
      });

      const screenshot = createTestBase64Image();

      // Act
      const result = await analyzer.analyze(screenshot);

      // Assert
      expect(result?.primaryTone).toBe('corporate');
      expect(result?.targetAudience).toBe('enterprise');
    });

    it('should detect creative tone for design agencies', async () => {
      // Arrange
      const { BrandToneAnalyzer } = await import('@/services/vision/brandtone.analyzer');
      const analyzer = new BrandToneAnalyzer();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryTone: 'creative',
            secondaryTone: 'innovative',
            confidence: 0.88,
            professionalism: 'minimal',
            warmth: 'warm',
            modernity: 'contemporary',
            energy: 'dynamic',
            targetAudience: 'creative',
            indicators: ['bold typography', 'vibrant colors', 'unconventional layout'],
            colorContextUsed: false,
          }),
        }),
      });

      const screenshot = createTestBase64Image();

      // Act
      const result = await analyzer.analyze(screenshot);

      // Assert
      expect(result?.primaryTone).toBe('creative');
      expect(result?.targetAudience).toBe('creative');
    });

    it('should detect luxury tone for premium brands', async () => {
      // Arrange
      const { BrandToneAnalyzer } = await import('@/services/vision/brandtone.analyzer');
      const analyzer = new BrandToneAnalyzer();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryTone: 'luxury',
            secondaryTone: 'traditional',
            confidence: 0.90,
            professionalism: 'bold',
            warmth: 'neutral',
            modernity: 'classic',
            energy: 'calm',
            targetAudience: 'consumer',
            indicators: ['elegant serif fonts', 'gold accents', 'generous whitespace'],
            colorContextUsed: false,
          }),
        }),
      });

      const screenshot = createTestBase64Image();

      // Act
      const result = await analyzer.analyze(screenshot);

      // Assert
      expect(result?.primaryTone).toBe('luxury');
      expect(result?.professionalism).toBe('bold');
    });
  });

  // ===========================================================================
  // エッジケーステスト
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle empty screenshot gracefully', async () => {
      // Arrange
      const { BrandToneAnalyzer } = await import('@/services/vision/brandtone.analyzer');
      const analyzer = new BrandToneAnalyzer();
      const emptyBase64 = '';

      // Act & Assert
      await expect(async () => {
        await analyzer.analyze(emptyBase64);
      }).rejects.toThrow();
    });

    it('should handle concurrent requests', async () => {
      // Arrange
      const { BrandToneAnalyzer } = await import('@/services/vision/brandtone.analyzer');
      const analyzer = new BrandToneAnalyzer();
      const screenshots = Array(5).fill(null).map((_, i) => createTestBase64Image(1000 + i * 100));

      // 5回分のモックを設定
      for (let i = 0; i < 5; i++) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            response: JSON.stringify({
              primaryTone: 'tech-forward',
              confidence: 0.8,
              professionalism: 'moderate',
              warmth: 'neutral',
              modernity: 'futuristic',
              energy: 'dynamic',
              targetAudience: 'startup',
              indicators: [],
              colorContextUsed: false,
            }),
          }),
        });
      }

      // Act
      const results = await Promise.all(
        screenshots.map(s => analyzer.analyze(s))
      );

      // Assert
      results.forEach(result => {
        expect(result).not.toBeNull();
      });
    });

    it('should return consistent results for identical input', async () => {
      // Arrange
      const { BrandToneAnalyzer } = await import('@/services/vision/brandtone.analyzer');
      const analyzer = new BrandToneAnalyzer();
      const screenshot = createTestBase64Image();

      // 最初の呼び出しのみモック（キャッシュにより2回目は呼ばれない）
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryTone: 'innovative',
            secondaryTone: 'tech-forward',
            confidence: 0.85,
            professionalism: 'moderate',
            warmth: 'neutral',
            modernity: 'futuristic',
            energy: 'dynamic',
            targetAudience: 'startup',
            indicators: ['modern design patterns'],
            colorContextUsed: false,
          }),
        }),
      });

      // Act
      const result1 = await analyzer.analyze(screenshot);
      const result2 = await analyzer.analyze(screenshot);

      // Assert
      expect(result1).toEqual(result2);
    });
  });
});

// =============================================================================
// 統合テスト
// =============================================================================

describe('BrandToneAnalyzer Integration', () => {
  it('should complete full workflow: analyze -> validate -> cache', async () => {
    // Arrange
    const { BrandToneAnalyzer } = await import('@/services/vision/brandtone.analyzer');
    const analyzer = new BrandToneAnalyzer();
    const screenshot = createTestBase64Image();

    // 最初の呼び出しのみモック（キャッシュにより2回目は呼ばれない）
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        response: JSON.stringify({
          primaryTone: 'trustworthy',
          secondaryTone: 'corporate',
          confidence: 0.88,
          professionalism: 'bold',
          warmth: 'neutral',
          modernity: 'contemporary',
          energy: 'balanced',
          targetAudience: 'enterprise',
          indicators: ['blue color scheme', 'clean layout', 'professional imagery'],
          colorContextUsed: false,
        }),
      }),
    });

    // Act
    const result1 = await analyzer.analyze(screenshot);

    // Assert
    expect(result1).not.toBeNull();
    expect(result1?.primaryTone).toBe('trustworthy');
    expect(result1?.secondaryTone).toBe('corporate');
    expect(result1?.confidence).toBe(0.88);
    expect(result1?.indicators).toHaveLength(3);

    // Act: キャッシュテスト
    const result2 = await analyzer.analyze(screenshot);

    // Assert
    expect(result2).toEqual(result1);
  });
});

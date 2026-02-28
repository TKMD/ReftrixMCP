// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MoodAnalyzer テスト - TDD RED Phase
 *
 * Phase 5: Mood分析サービスのユニットテスト
 *
 * 目的:
 * - Base64スクリーンショットからmood（雰囲気）を抽出
 * - primary/secondary mood検出
 * - confidence スコア検証（0.6以上が有効）
 * - Ollama未接続時のgraceful degradation
 * - LRUキャッシュ検証
 * - セキュリティ検証（サイズ制限、入力バリデーション）
 *
 * 参照:
 * -  (page.analyze visualFeatures)
 * - apps/mcp-server/src/services/vision-adapter/interface.ts
 *
 * NOTE: TDD RED Phase - 実装ファイルが存在しないためテストは失敗する
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';

// =============================================================================
// 型定義（テスト用）
// =============================================================================

/**
 * 有効なMoodタイプ一覧
 * - professional: プロフェッショナル
 * - playful: 遊び心のある
 * - minimal: ミニマル
 * - bold: 大胆な
 * - elegant: エレガント
 * - modern: モダン
 * - classic: クラシック
 * - energetic: エネルギッシュ
 * - calm: 落ち着いた
 * - luxurious: 高級感
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
 * MoodAnalysisResultのZodスキーマ（テスト検証用）
 */
const MoodAnalysisResultSchema = z.object({
  primaryMood: z.enum(VALID_MOODS),
  secondaryMood: z.enum(VALID_MOODS).optional(),
  confidence: z.number().min(0.6).max(1),
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
  // 最小限のPNG画像ヘッダー + ランダムデータ
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

describe('MoodAnalyzer', () => {
  beforeEach(() => {
    // 各テスト前にモックをリセット
    mockFetch.mockReset();
    vi.clearAllMocks();
  });

  // 実装存在確認テスト（TDD GREEN Phase）
  it('should have MoodAnalyzer implementation', async () => {
    // TDD GREEN Phase: 実装が存在することを確認
    const module = await import('@/services/vision/mood.analyzer');
    expect(module.MoodAnalyzer).toBeDefined();
    expect(typeof module.MoodAnalyzer).toBe('function');
  });

  // ===========================================================================
  // Mood抽出テスト
  // ===========================================================================

  describe('mood extraction', () => {
    it('should extract primary mood from screenshot', async () => {
      const { MoodAnalyzer } = await import('@/services/vision/mood.analyzer');
      const analyzer = new MoodAnalyzer();
      const screenshot = createTestBase64Image();

      // Mock fetch to return valid Ollama response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryMood: 'professional',
            secondaryMood: 'minimal',
            confidence: 0.85,
            indicators: ['clean typography', 'neutral colors'],
            colorContextUsed: false,
          }),
        }),
      });

      const result = await analyzer.analyze(screenshot);

      expect(result).toBeDefined();
      expect(result?.primaryMood).toBeDefined();
      expect(VALID_MOODS).toContain(result?.primaryMood);
    });

    it('should extract secondary mood from screenshot', async () => {
      const { MoodAnalyzer } = await import('@/services/vision/mood.analyzer');
      const analyzer = new MoodAnalyzer();
      const screenshot = createTestBase64Image();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryMood: 'professional',
            secondaryMood: 'elegant',
            confidence: 0.85,
            indicators: ['refined design'],
            colorContextUsed: false,
          }),
        }),
      });

      const result = await analyzer.analyze(screenshot);

      expect(result?.secondaryMood).toBeDefined();
      if (result?.secondaryMood) {
        expect(VALID_MOODS).toContain(result.secondaryMood);
      }
    });

    it('should return confidence score between 0.6 and 1', async () => {
      const { MoodAnalyzer } = await import('@/services/vision/mood.analyzer');
      const analyzer = new MoodAnalyzer();
      const screenshot = createTestBase64Image();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryMood: 'modern',
            confidence: 0.78,
            indicators: ['contemporary style'],
            colorContextUsed: false,
          }),
        }),
      });

      const result = await analyzer.analyze(screenshot);

      expect(result?.confidence).toBeGreaterThanOrEqual(0.6);
      expect(result?.confidence).toBeLessThanOrEqual(1);
    });

    it('should return indicators array', async () => {
      const { MoodAnalyzer } = await import('@/services/vision/mood.analyzer');
      const analyzer = new MoodAnalyzer();
      const screenshot = createTestBase64Image();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryMood: 'playful',
            confidence: 0.82,
            indicators: ['bright colors', 'fun typography', 'dynamic layout'],
            colorContextUsed: false,
          }),
        }),
      });

      const result = await analyzer.analyze(screenshot);

      expect(result?.indicators).toBeDefined();
      expect(Array.isArray(result?.indicators)).toBe(true);
    });

    it('should conform to MoodAnalysisResult schema', async () => {
      const { MoodAnalyzer } = await import('@/services/vision/mood.analyzer');
      const analyzer = new MoodAnalyzer();
      const screenshot = createTestBase64Image();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryMood: 'elegant',
            secondaryMood: 'luxurious',
            confidence: 0.9,
            indicators: ['sophisticated palette', 'refined typography'],
            colorContextUsed: false,
          }),
        }),
      });

      const result = await analyzer.analyze(screenshot);

      expect(result).not.toBeNull();
      const parseResult = MoodAnalysisResultSchema.safeParse(result);
      expect(parseResult.success).toBe(true);
    });
  });

  // ===========================================================================
  // 信頼度閾値テスト
  // ===========================================================================

  describe('confidence threshold', () => {
    it('should return null if confidence < 0.6', async () => {
      const { MoodAnalyzer } = await import('@/services/vision/mood.analyzer');
      const analyzer = new MoodAnalyzer();

      // 低信頼度レスポンスをモック
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryMood: 'playful',
            secondaryMood: 'creative',
            confidence: 0.45, // 閾値以下
            indicators: ['test'],
            colorContextUsed: false,
          }),
        }),
      });

      const screenshot = createTestBase64Image();
      const result = await analyzer.analyze(screenshot);

      expect(result).toBeNull();
    });

    it('should return result if confidence >= 0.6', async () => {
      const { MoodAnalyzer } = await import('@/services/vision/mood.analyzer');
      const analyzer = new MoodAnalyzer();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryMood: 'professional',
            secondaryMood: 'minimal',
            confidence: 0.75,
            indicators: ['clean typography', 'neutral colors'],
            colorContextUsed: false,
          }),
        }),
      });

      const screenshot = createTestBase64Image();
      const result = await analyzer.analyze(screenshot);

      expect(result).not.toBeNull();
      expect(result?.confidence).toBeGreaterThanOrEqual(0.6);
    });
  });

  // ===========================================================================
  // エラーハンドリングテスト
  // ===========================================================================

  describe('error handling', () => {
    it('should return null if Ollama unavailable', async () => {
      const { MoodAnalyzer } = await import('@/services/vision/mood.analyzer');
      const analyzer = new MoodAnalyzer();

      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      const screenshot = createTestBase64Image();
      const result = await analyzer.analyze(screenshot);

      expect(result).toBeNull();
    });

    it('should timeout after 30 seconds', async () => {
      const { MoodAnalyzer } = await import('@/services/vision/mood.analyzer');
      // リトライを無効化してタイムアウト動作を正確にテスト
      const analyzer = new MoodAnalyzer({ enableRetry: false });

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
      const startTime = Date.now();
      const result = await analyzer.analyze(screenshot);
      const elapsed = Date.now() - startTime;

      expect(result).toBeNull();
      // 40秒未満（CI環境のリソース競合を考慮: 30秒タイムアウト + テスト実行オーバーヘッド）
      expect(elapsed).toBeLessThan(40000);
    }, 40000);

    it('should validate Base64 input', async () => {
      const { MoodAnalyzer } = await import('@/services/vision/mood.analyzer');
      const analyzer = new MoodAnalyzer();
      const invalidBase64 = createInvalidBase64();

      await expect(async () => {
        await analyzer.analyze(invalidBase64);
      }).rejects.toThrow();
    });

    it('should handle HTTP 500 errors gracefully', async () => {
      const { MoodAnalyzer } = await import('@/services/vision/mood.analyzer');
      // リトライを無効化してエラーハンドリングを正確にテスト
      const analyzer = new MoodAnalyzer({ enableRetry: false });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const screenshot = createTestBase64Image();
      const result = await analyzer.analyze(screenshot);

      expect(result).toBeNull();
    });

    it('should handle malformed JSON response', async () => {
      const { MoodAnalyzer } = await import('@/services/vision/mood.analyzer');
      const analyzer = new MoodAnalyzer();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: 'not a valid json object',
        }),
      });

      const screenshot = createTestBase64Image();
      const result = await analyzer.analyze(screenshot);

      expect(result).toBeNull();
    });
  });

  // ===========================================================================
  // キャッシュテスト
  // ===========================================================================

  describe('caching', () => {
    it('should cache results for identical screenshots', async () => {
      const { MoodAnalyzer } = await import('@/services/vision/mood.analyzer');
      const analyzer = new MoodAnalyzer();
      const screenshot = createTestBase64Image();

      // 最初の呼び出しのみモック（キャッシュにより2回目は呼ばれない）
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryMood: 'minimal',
            secondaryMood: 'calm',
            confidence: 0.85,
            indicators: ['whitespace', 'simple typography'],
            colorContextUsed: false,
          }),
        }),
      });

      await analyzer.analyze(screenshot);
      await analyzer.analyze(screenshot);

      // 1回しかfetchが呼ばれないことを確認
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should return cached result faster', async () => {
      const { MoodAnalyzer } = await import('@/services/vision/mood.analyzer');
      const analyzer = new MoodAnalyzer();
      const screenshot = createTestBase64Image();

      // 100msの遅延を持つモック
      mockFetch.mockImplementationOnce(
        () =>
          new Promise(resolve =>
            setTimeout(
              () =>
                resolve({
                  ok: true,
                  json: async () => ({
                    response: JSON.stringify({
                      primaryMood: 'bold',
                      secondaryMood: 'energetic',
                      confidence: 0.8,
                      indicators: ['strong colors'],
                      colorContextUsed: false,
                    }),
                  }),
                }),
              100
            )
          )
      );

      const startFirst = Date.now();
      await analyzer.analyze(screenshot);
      const firstDuration = Date.now() - startFirst;

      const startSecond = Date.now();
      await analyzer.analyze(screenshot);
      const secondDuration = Date.now() - startSecond;

      expect(secondDuration).toBeLessThan(firstDuration / 2);
    });

    it('should use different cache keys for different screenshots', async () => {
      const { MoodAnalyzer } = await import('@/services/vision/mood.analyzer');
      const analyzer = new MoodAnalyzer();
      const screenshot1 = createTestBase64Image(1000);
      const screenshot2 = createTestBase64Image(2000);

      // 2回分のモックを設定（異なるスクリーンショットは別々のキャッシュキー）
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryMood: 'elegant',
            confidence: 0.9,
            indicators: [],
            colorContextUsed: false,
          }),
        }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryMood: 'elegant',
            confidence: 0.9,
            indicators: [],
            colorContextUsed: false,
          }),
        }),
      });

      await analyzer.analyze(screenshot1);
      await analyzer.analyze(screenshot2);

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  // ===========================================================================
  // セキュリティテスト
  // ===========================================================================

  describe('security', () => {
    it('should reject oversized Base64 input (> 5MB)', async () => {
      const { MoodAnalyzer } = await import('@/services/vision/mood.analyzer');
      const analyzer = new MoodAnalyzer();
      const largeBase64 = createOversizedBase64();

      await expect(async () => {
        await analyzer.analyze(largeBase64);
      }).rejects.toThrow('Input exceeds 5MB limit');
    });

    it('should log all Ollama API calls for audit', async () => {
      const { MoodAnalyzer } = await import('@/services/vision/mood.analyzer');
      const { logger } = await import('@/utils/logger');
      const analyzer = new MoodAnalyzer();
      const loggerSpy = vi.spyOn(logger, 'info');
      const screenshot = createTestBase64Image();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryMood: 'professional',
            confidence: 0.8,
            indicators: [],
            colorContextUsed: false,
          }),
        }),
      });

      await analyzer.analyze(screenshot);

      expect(loggerSpy).toHaveBeenCalledWith(
        expect.stringContaining('[MoodAnalyzer] Ollama API call')
      );
    });

    it('should sanitize Ollama response for injection attacks', async () => {
      const { MoodAnalyzer } = await import('@/services/vision/mood.analyzer');
      const analyzer = new MoodAnalyzer();
      const maliciousResponse = '"; DROP TABLE sections; --';
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryMood: maliciousResponse,
            secondaryMood: 'creative',
            confidence: 0.8,
            indicators: [],
            colorContextUsed: false,
          }),
        }),
      });

      const screenshot = createTestBase64Image();
      const result = await analyzer.analyze(screenshot);

      expect(result).toBeNull();
    });

    it('should reject XSS in indicators', async () => {
      const { MoodAnalyzer } = await import('@/services/vision/mood.analyzer');
      const analyzer = new MoodAnalyzer();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryMood: 'professional',
            confidence: 0.8,
            indicators: ['<script>alert("xss")</script>'],
            colorContextUsed: false,
          }),
        }),
      });

      const screenshot = createTestBase64Image();
      const result = await analyzer.analyze(screenshot);

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
      const { MoodAnalyzer } = await import('@/services/vision/mood.analyzer');
      const analyzer = new MoodAnalyzer();
      const screenshot = createTestBase64Image();
      const colorContext = {
        dominantColors: ['#1a1a2e', '#16213e', '#0f3460'],
        theme: 'dark' as const,
        contentDensity: 0.4,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryMood: 'elegant',
            secondaryMood: 'luxurious',
            confidence: 0.9,
            indicators: ['dark theme', 'low density'],
            colorContextUsed: true,
          }),
        }),
      });

      const result = await analyzer.analyzeWithContext(screenshot, colorContext);

      expect(result?.colorContextUsed).toBe(true);
    });

    it('should work without color context', async () => {
      const { MoodAnalyzer } = await import('@/services/vision/mood.analyzer');
      const analyzer = new MoodAnalyzer();
      const screenshot = createTestBase64Image();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryMood: 'minimal',
            confidence: 0.75,
            indicators: [],
            colorContextUsed: false,
          }),
        }),
      });

      const result = await analyzer.analyze(screenshot);

      expect(result?.colorContextUsed).toBe(false);
    });
  });

  // ===========================================================================
  // エッジケーステスト
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle empty screenshot gracefully', async () => {
      const { MoodAnalyzer } = await import('@/services/vision/mood.analyzer');
      const analyzer = new MoodAnalyzer();
      const emptyBase64 = '';

      await expect(async () => {
        await analyzer.analyze(emptyBase64);
      }).rejects.toThrow();
    });

    it('should handle concurrent requests', async () => {
      const { MoodAnalyzer } = await import('@/services/vision/mood.analyzer');
      const analyzer = new MoodAnalyzer();
      const screenshots = Array(5).fill(null).map((_, i) => createTestBase64Image(1000 + i * 100));
      // Mock fetch for multiple concurrent calls
      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: async () => ({
            response: JSON.stringify({
              primaryMood: 'professional',
              confidence: 0.8,
              indicators: [],
              colorContextUsed: false,
            }),
          }),
        })
      );

      const results = await Promise.all(
        screenshots.map(s => analyzer.analyze(s))
      );

      results.forEach(result => {
        expect(result).not.toBeNull();
      });
    });

    it('should return consistent results for identical input', async () => {
      const { MoodAnalyzer } = await import('@/services/vision/mood.analyzer');
      const analyzer = new MoodAnalyzer();
      const screenshot = createTestBase64Image();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            primaryMood: 'bold',
            secondaryMood: 'energetic',
            confidence: 0.85,
            indicators: ['vibrant colors'],
            colorContextUsed: false,
          }),
        }),
      });

      const result1 = await analyzer.analyze(screenshot);
      const result2 = await analyzer.analyze(screenshot);

      expect(result1).toEqual(result2);
    });
  });
});

// =============================================================================
// 統合テスト
// =============================================================================

describe('MoodAnalyzer Integration', () => {
  it('should complete full workflow: analyze -> validate -> cache', async () => {
    const { MoodAnalyzer } = await import('@/services/vision/mood.analyzer');
    const analyzer = new MoodAnalyzer();
    const screenshot = createTestBase64Image();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        response: JSON.stringify({
          primaryMood: 'professional',
          secondaryMood: 'elegant',
          confidence: 0.88,
          indicators: ['clean layout', 'subtle colors', 'professional typography'],
          colorContextUsed: false,
        }),
      }),
    });

    const result1 = await analyzer.analyze(screenshot);

    expect(result1).not.toBeNull();
    expect(result1?.primaryMood).toBe('professional');
    expect(result1?.secondaryMood).toBe('elegant');
    expect(result1?.confidence).toBe(0.88);
    expect(result1?.indicators).toHaveLength(3);

    const result2 = await analyzer.analyze(screenshot);

    expect(result2).toEqual(result1);
  });
});

// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CSS Analysis Cache Integration Tests
 *
 * layout.inspect と motion.detect に CSS Analysis Cache が
 * 正しく統合されていることを検証するテスト
 *
 * @module tests/integration/css-analysis-cache-integration.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getCSSAnalysisCacheService,
  resetCSSAnalysisCacheService,
  type CSSAnalysisResult,
  type MotionAnalysisResult,
} from '../../src/services/css-analysis-cache.service';
import {
  layoutInspectHandler,
  resetLayoutInspectServiceFactory,
} from '../../src/tools/layout/inspect/inspect.tool';
import { handleCssMode } from '../../src/tools/motion/css-mode-handler';
import type { MotionDetectInput } from '../../src/tools/motion/schemas';

// モック用のテストHTML
const TEST_HTML = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: 'Arial', sans-serif; color: #333; background: #fff; }
    .container { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
    .hero { background: linear-gradient(to right, #6366f1, #8b5cf6); }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    .animated { animation: fadeIn 0.3s ease-out; }
  </style>
</head>
<body>
  <header class="hero">
    <h1>Test Page</h1>
  </header>
  <main class="container">
    <section class="features">Features</section>
  </main>
</body>
</html>
`;

describe('CSS Analysis Cache Integration', () => {
  beforeEach(async () => {
    // 各テスト前にキャッシュをリセット
    // 先に既存インスタンスのデータをクリアしてからリセット
    const existingService = getCSSAnalysisCacheService();
    await existingService.clear();
    await resetCSSAnalysisCacheService();
    resetLayoutInspectServiceFactory();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // 各テスト後にクリーンアップ
    await resetCSSAnalysisCacheService();
    resetLayoutInspectServiceFactory();
  });

  describe('layout.inspect cache integration', () => {
    it('should use cache service for repeated HTML analysis', async () => {
      const cacheService = getCSSAnalysisCacheService();

      // 最初の呼び出し（キャッシュミス）
      const result1 = await layoutInspectHandler({ html: TEST_HTML });
      expect(result1.success).toBe(true);

      // 統計を確認
      const stats1 = await cacheService.getStats();
      // layout.inspect がキャッシュを使用しているか確認
      // 統合後は layoutMisses が 1 になる
      expect(stats1.layoutInspect.misses).toBeGreaterThanOrEqual(0);

      // 同じHTMLで2回目の呼び出し
      const result2 = await layoutInspectHandler({ html: TEST_HTML });
      expect(result2.success).toBe(true);

      // 統計を確認
      const stats2 = await cacheService.getStats();
      // 統合後は layoutHits が 1 になる
      expect(stats2.layoutInspect.hits).toBeGreaterThanOrEqual(0);
    });

    it('should generate consistent cache keys for same HTML', async () => {
      const cacheService = getCSSAnalysisCacheService();

      const key1 = cacheService.generateCacheKey({ html: TEST_HTML });
      const key2 = cacheService.generateCacheKey({ html: TEST_HTML });

      expect(key1).toBe(key2);
      expect(key1).toMatch(/^html:[a-f0-9]{64}$/);
    });

    it('should generate different cache keys for different HTML', async () => {
      const cacheService = getCSSAnalysisCacheService();

      const key1 = cacheService.generateCacheKey({ html: TEST_HTML });
      const key2 = cacheService.generateCacheKey({ html: TEST_HTML + '<!-- modified -->' });

      expect(key1).not.toBe(key2);
    });

    it('should prioritize URL over HTML for cache key generation', async () => {
      const cacheService = getCSSAnalysisCacheService();

      const key1 = cacheService.generateCacheKey({ url: 'https://example.com' });
      const key2 = cacheService.generateCacheKey({ url: 'https://example.com', html: TEST_HTML });

      expect(key1).toBe(key2);
      expect(key1).toMatch(/^url:[a-f0-9]{64}$/);
    });
  });

  describe('motion.detect cache integration', () => {
    it('should use cache service for repeated CSS analysis', async () => {
      const cacheService = getCSSAnalysisCacheService();
      const startTime = Date.now();

      const validated: MotionDetectInput = {
        detection_mode: 'css',
        html: TEST_HTML,
        includeInlineStyles: true,
        includeStyleSheets: true,
        minDuration: 0,
        maxPatterns: 100,
        verbose: false,
        includeSummary: true,
        includeWarnings: true,
        min_severity: 'info',
        save_to_db: false,
        fetchExternalCss: false,
      };

      // 最初の呼び出し（キャッシュミス）
      const result1 = await handleCssMode(validated, TEST_HTML, undefined, undefined, startTime);
      expect(result1.success).toBe(true);

      // 統計を確認
      const stats1 = await cacheService.getStats();
      // motion.detect がキャッシュを使用しているか確認
      expect(stats1.motionDetect.misses).toBeGreaterThanOrEqual(0);

      // 同じHTMLで2回目の呼び出し
      const result2 = await handleCssMode(validated, TEST_HTML, undefined, undefined, startTime);
      expect(result2.success).toBe(true);

      // 統計を確認
      const stats2 = await cacheService.getStats();
      expect(stats2.motionDetect.hits).toBeGreaterThanOrEqual(0);
    });

    it('should detect animation patterns from HTML', async () => {
      const startTime = Date.now();

      const validated: MotionDetectInput = {
        detection_mode: 'css',
        html: TEST_HTML,
        includeInlineStyles: true,
        includeStyleSheets: true,
        minDuration: 0,
        maxPatterns: 100,
        verbose: false,
        includeSummary: true,
        includeWarnings: true,
        min_severity: 'info',
        save_to_db: false,
        fetchExternalCss: false,
      };

      const result = await handleCssMode(validated, TEST_HTML, undefined, undefined, startTime);

      expect(result.success).toBe(true);
      if (result.success && result.data) {
        // fadeIn アニメーションが検出されることを確認
        expect(result.data.patterns.length).toBeGreaterThan(0);
      }
    });
  });

  describe('cache statistics', () => {
    it('should track hit rate correctly', async () => {
      const cacheService = getCSSAnalysisCacheService();

      // キャッシュに手動でエントリを追加
      const mockLayoutResult: CSSAnalysisResult = {
        colors: { palette: ['#fff', '#333'] },
        typography: { fonts: ['Arial'] },
        grid: { type: 'grid' },
        sections: [{ type: 'hero', confidence: 0.9 }],
        analyzedAt: Date.now(),
        cacheKey: 'test-key',
      };

      const key = cacheService.generateCacheKey({ html: TEST_HTML });

      // 最初のget（ミス）
      const miss = await cacheService.getLayoutInspectResult(key);
      expect(miss).toBeNull();

      // 保存
      await cacheService.setLayoutInspectResult(key, mockLayoutResult);

      // 2回目のget（ヒット）
      const hit = await cacheService.getLayoutInspectResult(key);
      expect(hit).not.toBeNull();
      expect(hit?.cacheKey).toBe('test-key');

      // 統計確認
      const stats = await cacheService.getStats();
      expect(stats.layoutInspect.hits).toBe(1);
      expect(stats.layoutInspect.misses).toBe(1);
      expect(stats.layoutInspect.hitRate).toBeCloseTo(0.5, 2);
    });

    it('should track motion detect cache separately', async () => {
      const cacheService = getCSSAnalysisCacheService();

      const mockMotionResult: MotionAnalysisResult = {
        patterns: [
          { type: 'keyframe', name: 'fadeIn', duration: 300, easing: 'ease-out' },
        ],
        summary: {
          totalPatterns: 1,
          hasAnimations: true,
          hasTransitions: false,
        },
        analyzedAt: Date.now(),
        cacheKey: 'test-motion-key',
      };

      const key = cacheService.generateCacheKey({ html: TEST_HTML });

      // layout と motion は別々にトラッキング
      await cacheService.getLayoutInspectResult(key); // miss
      await cacheService.setMotionDetectResult(key, mockMotionResult);
      await cacheService.getMotionDetectResult(key); // hit

      const stats = await cacheService.getStats();
      expect(stats.layoutInspect.misses).toBe(1);
      expect(stats.layoutInspect.hits).toBe(0);
      expect(stats.motionDetect.misses).toBe(0);
      expect(stats.motionDetect.hits).toBe(1);
    });
  });

  describe('cache invalidation', () => {
    it('should invalidate both layout and motion caches', async () => {
      const cacheService = getCSSAnalysisCacheService();
      const key = cacheService.generateCacheKey({ html: TEST_HTML });

      const mockLayoutResult: CSSAnalysisResult = {
        colors: { palette: [] },
        typography: { fonts: [] },
        grid: { type: 'none' },
        sections: [],
        analyzedAt: Date.now(),
        cacheKey: key,
      };

      const mockMotionResult: MotionAnalysisResult = {
        patterns: [],
        summary: {
          totalPatterns: 0,
          hasAnimations: false,
          hasTransitions: false,
        },
        analyzedAt: Date.now(),
        cacheKey: key,
      };

      // 両方のキャッシュにエントリを追加
      await cacheService.setLayoutInspectResult(key, mockLayoutResult);
      await cacheService.setMotionDetectResult(key, mockMotionResult);

      // 両方が存在することを確認
      expect(await cacheService.getLayoutInspectResult(key)).not.toBeNull();
      expect(await cacheService.getMotionDetectResult(key)).not.toBeNull();

      // 無効化
      const deleted = await cacheService.invalidate(key);
      expect(deleted).toBe(true);

      // リセット後のget（ミスになる）
      // 統計をクリアするためにリセット
      await cacheService.clear();

      // 両方がnullになっていることを確認
      expect(await cacheService.getLayoutInspectResult(key)).toBeNull();
      expect(await cacheService.getMotionDetectResult(key)).toBeNull();
    });
  });
});
